const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize Firebase Admin
let firebaseInitialized = false;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin initialized');
    } else {
        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set, Firestore writes disabled');
    }
} catch (err) {
    console.error('Failed to initialize Firebase Admin:', err.message);
}

const db = firebaseInitialized ? admin.firestore() : null;

// Initialize Google Gen AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * Generate an embedding for the given text.
 */
async function generateEmbedding(text) {
    if (!text || text.trim() === '') {
        throw new Error('Cannot embed empty text');
    }

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [text],
        config: {
            outputDimensionality: 768
        }
    });

    if (response.embeddings && response.embeddings.length > 0) {
        return response.embeddings[0].values;
    } else {
        throw new Error('No embeddings returned');
    }
}

/**
 * Generate a unique ID for new user questions.
 */
function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

/**
 * Add a new question to Pinecone and Firestore.
 */
async function addNewQuestion(queryText, extractedText = '') {
    const fullText = [queryText, extractedText].filter(Boolean).join(' ').trim();
    if (!fullText) throw new Error('No text to add');

    const vector = await generateEmbedding(fullText);
    const newId = generateQuestionId();

    await index.upsert([{
        id: newId,
        values: vector
    }]);

    if (db) {
        await db.collection('questions').doc(newId).set({
            question: fullText,
            comment: "Thank you for your question. Our team will provide an answer soon.",
            videoUrl: "",
            imageUrl: "",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Added new question to Firestore with ID: ${newId}`);
    } else {
        console.log(`⚠️ Firestore not available, question not saved to DB. ID: ${newId}`);
    }

    return newId;
}

/**
 * Send a base64 image to the EasyOCR endpoint and return extracted text.
 * Supports PNG, JPEG, JPG, WebP, etc.
 */
async function sendImageToOCR(base64Image) {
    try {
        // Clean base64 string (remove data URL prefix if present)
        const cleanBase64 = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;
        const imageBuffer = Buffer.from(cleanBase64, 'base64');

        // Auto-detect MIME type and extension
        let ext = 'png';
        let contentType = 'image/png';
        if (base64Image.startsWith('data:')) {
            const matches = base64Image.match(/^data:([^;]+);/);
            if (matches) {
                contentType = matches[1];             // e.g., 'image/jpeg'
                ext = contentType.split('/')[1];      // e.g., 'jpeg'
            }
        }

        const form = new FormData();
        form.append('file', imageBuffer, {
            filename: `upload.${ext}`,
            contentType: contentType
        });

        const response = await axios.post(
            'https://ocr-service-kiea.onrender.com/image-to-text',
            form,
            { headers: form.getHeaders() }
        );

        return response.data.text || '';
    } catch (error) {
        console.error('OCR extraction failed:', error.message);
        return '';
    }
}

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";
        let extractedText = "";

        if (imageBase64) {
            extractedText = await sendImageToOCR(imageBase64);
            if (extractedText.trim()) {
                finalQueryText += " " + extractedText;
            }
            console.log("OCR extraction completed.");
        }

        if (!finalQueryText || finalQueryText.trim() === '') {
            return res.json([{ id: "#0000" }]);
        }

        const vector = await generateEmbedding(finalQueryText);

        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            const matchId = queryResponse.matches[0].id;
            console.log(`✅ Found match: ${matchId} (score: ${queryResponse.matches[0].score})`);
            return res.json([{ id: matchId }]);
        }

        console.log("No sufficient match found, adding as new question...");
        const newId = await addNewQuestion(text || "", extractedText);
        console.log(`✅ New question added with ID: ${newId}`);
        return res.json([{ id: newId }]);

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
