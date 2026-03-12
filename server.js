const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const Tesseract = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Ensure uploads folder exists
const uploadDir = "uploads";
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`✅ Created uploads folder at ${uploadDir}`);
}

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
        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
    }
} catch (err) {
    console.error('Failed to initialize Firebase Admin:', err.message);
}
const db = firebaseInitialized ? admin.firestore() : null;

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * Generate embedding
 */
async function generateEmbedding(text) {
    if (!text || text.trim() === '') throw new Error('Cannot embed empty text');

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [text],
        config: { outputDimensionality: 768 }
    });

    if (response.embeddings && response.embeddings.length > 0) return response.embeddings[0].values;

    throw new Error("No embeddings returned");
}

/**
 * Generate unique question ID
 */
function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

/**
 * Run OCR using Tesseract on a local file
 */
async function runTesseractOCR(imagePath) {
    try {
        const result = await Tesseract.recognize(imagePath, "eng");
        return result.data.text || "";
    } catch (error) {
        console.error("OCR extraction failed:", error.message);
        return "";
    }
}

/**
 * Add new question to Pinecone + Firestore
 */
async function addNewQuestion(queryText, extractedText = '') {
    const fullText = [queryText, extractedText].filter(Boolean).join(' ').trim();
    if (!fullText) throw new Error('No text to add');

    const vector = await generateEmbedding(fullText);
    const newId = generateQuestionId();

    await index.upsert([{ id: newId, values: vector }]);

    if (db) {
        await db.collection('questions').doc(newId).set({
            question: fullText,
            comment: "Thank you for your question. Our team will provide an answer soon.",
            videoUrl: "",
            imageUrl: "",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Added new question to Firestore: ${newId}`);
    } else {
        console.log(`⚠️ Firestore not available. ID: ${newId}`);
    }

    return newId;
}

/**
 * Main API: text + imageBase64 input
 */
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";
        let extractedText = "";

        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

            const tempPath = `${uploadDir}/temp_${Date.now()}.png`;
            fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));

            extractedText = await runTesseractOCR(tempPath);

            fs.unlink(tempPath, () => {}); // delete temp file

            if (extractedText.trim()) finalQueryText += " " + extractedText;

            console.log("✅ OCR extraction completed");
            console.log("Extracted Text:", extractedText.substring(0, 200)); // first 200 chars
        }

        if (!finalQueryText || finalQueryText.trim() === '') {
            return res.json([{ id: "#0000" }]);
        }

        // Generate embedding
        const vector = await generateEmbedding(finalQueryText);

        // Query Pinecone
        const queryResponse = await index.query({ vector, topK: 1, includeMetadata: false });

        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            const matchId = queryResponse.matches[0].id;
            console.log(`✅ Found match: ${matchId}`);
            return res.json([{ id: matchId }]);
        }

        // No match → add new question
        console.log("No match found, adding new question...");
        const newId = await addNewQuestion(text || "", extractedText);
        return res.json([{ id: newId }]);

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
