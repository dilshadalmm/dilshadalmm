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
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

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
    } else console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
} catch (err) {
    console.error('Failed to initialize Firebase Admin:', err.message);
}
const db = firebaseInitialized ? admin.firestore() : null;

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
// Ensure your Pinecone index is configured with dimension 3072
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * Extract mime type and clean base64 data from a possible data URL
 */
function parseImageBase64(imageBase64) {
    if (!imageBase64) return null;
    const matches = imageBase64.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
        return {
            mimeType: `image/${matches[1]}`,
            data: matches[2]
        };
    }
    return { mimeType: 'image/png', data: imageBase64 };
}

/**
 * Generate multimodal embedding from text and/or image base64
 * @param {string} text - optional text
 * @param {string} imageBase64 - optional base64 image
 * @returns {Promise<number[]>} embedding vector (3072 dimensions)
 */
async function generateEmbedding(text, imageBase64) {
    const parts = [];

    if (text && text.trim() !== '') {
        parts.push({ text: text.trim() });
    }

    if (imageBase64) {
        const { mimeType, data } = parseImageBase64(imageBase64);
        parts.push({
            inlineData: { mimeType, data }
        });
    }

    if (parts.length === 0) {
        throw new Error('No content provided for embedding');
    }

    // No outputDimensionality config → defaults to 3072
    const response = await ai.models.embedContent({
        model: 'gemini-embedding-2-preview',
        contents: [{ parts }]
    });

    if (response.embeddings && response.embeddings.length > 0) {
        return response.embeddings[0].values;
    }
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
 * Add new multimodal question to Pinecone + Firestore
 */
async function addNewQuestion(text = '', imageBase64 = '') {
    const vector = await generateEmbedding(text, imageBase64);
    const newId = generateQuestionId();

    await index.upsert([{ id: newId, values: vector }]);

    if (db) {
        let questionText = text.trim();
        if (!questionText && imageBase64) {
            questionText = "[Image query]";
        }
        await db.collection('questions').doc(newId).set({
            question: questionText || "",
            comment: "Thank you for your question. Our team will provide an answer soon.",
            videoUrl: "",
            imageUrl: "",
            embedded: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Added new question to Firestore: ${newId}`);
    } else {
        console.log(`⚠️ Firestore not available. ID: ${newId}`);
    }

    return newId;
}

/**
 * Watcher: auto-embed pending questions in Firestore (legacy support)
 */
async function embedPendingQuestions() {
    if (!db) return;
    try {
        const snapshot = await db.collection("questions")
            .where("embedded", "==", false)
            .limit(50)
            .get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (!data.question) continue;

            try {
                // Note: this only embeds the text field, not any associated image
                const vector = await generateEmbedding(data.question, null);
                await index.upsert([{ id: doc.id, values: vector, metadata: { text: data.question } }]);
                await doc.ref.update({ embedded: true });
                console.log(`✅ Auto-embedded question: ${doc.id}`);
            } catch (err) {
                console.error(`Failed embedding question ${doc.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error("Error fetching pending questions:", err.message);
    }
}

// Run watcher every 1 minute
setInterval(embedPendingQuestions, 60 * 1000);

/**
 * Main API: text + imageBase64 input
 */
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalText = text || "";

        if (!finalText.trim() && !imageBase64) {
            return res.json([{ id: "#0000" }]);
        }

        const vector = await generateEmbedding(finalText, imageBase64);

        const queryResponse = await index.query({
            vector,
            topK: 1,
            includeMetadata: false
        });

        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            return res.json([{ id: queryResponse.matches[0].id }]);
        }

        const newId = await addNewQuestion(finalText, imageBase64);
        return res.json([{ id: newId }]);

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
