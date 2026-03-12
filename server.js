const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const crypto = require('crypto');
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
    // Combine original text and extracted image text
    const fullText = [queryText, extractedText].filter(Boolean).join(' ').trim();
    if (!fullText) {
        throw new Error('No text to add');
    }

    // Generate embedding
    const vector = await generateEmbedding(fullText);

    // Generate unique ID
    const newId = generateQuestionId();

    // Upsert to Pinecone
    await index.upsert([{
        id: newId,
        values: vector
    }]);

    // Create Firestore document if available
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

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";
        let extractedText = "";

        // 1. Vision extraction (if image provided)
        if (imageBase64) {
            try {
                const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                const visionResponse = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [{
                        role: 'user',
                        parts: [
                            { text: "Extract all text and any mathematical expressions from this image for a search query. Return only the extracted content." },
                            { inlineData: { mimeType: 'image/png', data: cleanBase64 } }
                        ]
                    }]
                });
                extractedText = visionResponse.text || "";
                if (extractedText.trim()) {
                    finalQueryText += " " + extractedText;
                }
                console.log("Vision extraction completed.");
            } catch (vErr) {
                console.error("Vision failed, using text only:", vErr.message);
            }
        }

        // Ensure we have some text to work with
        if (!finalQueryText || finalQueryText.trim() === '') {
            // Nothing to search or add – return fallback
            return res.json([{ id: "#0000" }]);
        }

        // 2. Generate embedding for search
        const vector = await generateEmbedding(finalQueryText);

        // 3. Query Pinecone
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        // 4. If good match found, return its ID
        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            const matchId = queryResponse.matches[0].id;
            console.log(`✅ Found match: ${matchId} (score: ${queryResponse.matches[0].score})`);
            return res.json([{ id: matchId }]);
        }

        // 5. No good match – add as new question
        console.log("No sufficient match found, adding as new question...");
        const newId = await addNewQuestion(text || "", extractedText);
        console.log(`✅ New question added with ID: ${newId}`);
        return res.json([{ id: newId }]);

    } catch (error) {
        console.error("Critical Backend Error:", error);
        // Fallback to safe ID
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
