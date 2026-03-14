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
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * Generate embedding using gemini-embedding-2-preview (3072 dimensions)
 */
async function generateEmbedding(text) {
    if (!text || text.trim() === '') throw new Error('Cannot embed empty text');

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-2-preview',
        contents: [text],
        config: { outputDimensionality: 3072 }
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
 * Describe an image using Gemini 2.5 Flash
 * @param {string} base64Image - raw base64 string (without data URL prefix)
 * @returns {Promise<string>} detailed description
 */
async function describeImage(base64Image) {
    try {
        const prompt = "Provide a highly detailed technical description of this image. If it contains text, transcribe it exactly. If it contains a diagram or math, explain the logic and formulas in detail.";

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: 'image/png',  // adjust if you know the actual type
                                data: base64Image
                            }
                        }
                    ]
                }
            ]
        });

        // Extract text from response
        return response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } catch (error) {
        console.error("Image description failed:", error.message);
        return "";  // fallback to empty description
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
 * Watcher: auto-embed pending questions in Firestore
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
                const vector = await generateEmbedding(data.question);

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
        let finalQueryText = text || "";
        let extractedText = "";

        if (imageBase64) {
            // Remove data URL prefix if present (e.g., "data:image/png;base64,")
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            extractedText = await describeImage(base64Data);
            if (extractedText.trim()) finalQueryText += " " + extractedText;
        }

        if (!finalQueryText || finalQueryText.trim() === '') return res.json([{ id: "#0000" }]);

        const vector = await generateEmbedding(finalQueryText);
        const queryResponse = await index.query({ vector, topK: 1, includeMetadata: false });

        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            return res.json([{ id: queryResponse.matches[0].id }]);
        }

        const newId = await addNewQuestion(text || "", extractedText);
        return res.json([{ id: newId }]);

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
