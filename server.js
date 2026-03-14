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

// Exact system prompt
const OCR_SYSTEM_PROMPT = `
Just let me no what is the questions in the image and if any diagram is present then also let me know what is the diagram saying.
Don't explain and don't provide solution.
`;

/**
 * Generate embedding (updated for batching)
 */
async function generateEmbeddingsBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) throw new Error('Cannot embed empty text array');

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: texts,
        config: { outputDimensionality: 768 }
    });

    if (response.embeddings && response.embeddings.length === texts.length) {
        return response.embeddings.map(e => e.values);
    }
    throw new Error("No embeddings returned or mismatch in count");
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
 * Run OCR using Gemini 2.5 Flash Lite
 */
async function runGeminiOCR(imageBase64) {
    try {
        // Remove data URL prefix if present
        const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Extract all text from this image." },
                        { inlineData: { mimeType: 'image/png', data: base64Data } }
                    ]
                }
            ],
            config: {
                systemInstruction: { parts: [{ text: OCR_SYSTEM_PROMPT }] },
                generationConfig: {
                    temperature: 0.6,
                    topP: 0.95
                },
                thinkingConfig: { thinkingBudget: 0 }
            }
        });

        // Extract full response text (do NOT discard diagram/options)
        let fullText = "";
        if (response && response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                fullText = candidate.content.parts[0].text || "";
            }
        }

        return fullText.trim();
    } catch (error) {
        console.error("Gemini OCR extraction failed:", error.message);
        return "";
    }
}

/**
 * Add new question to Pinecone + Firestore
 */
async function addNewQuestion(queryText, extractedText = '') {
    const fullText = extractedText || queryText;
    if (!fullText) throw new Error('No text to add');

    const vector = (await generateEmbeddingsBatch([fullText]))[0];
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
 * Embed pending questions in batches concurrently
 */
async function embedPendingQuestions() {
    if (!db) return;
    try {
        const snapshot = await db.collection("questions")
            .where("embedded", "==", false)
            .limit(5000) // fetch up to 5000 pending requests
            .get();

        if (snapshot.empty) return;

        const docs = snapshot.docs;
        const BATCH_SIZE = 10; // number of questions per batch
        const CONCURRENCY = 50; // max concurrent batches
        const batches = [];

        // Split docs into batches
        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
            batches.push(docs.slice(i, i + BATCH_SIZE));
        }

        // Process batches in controlled concurrency
        let current = 0;
        async function processNextBatch() {
            if (current >= batches.length) return;
            const batch = batches[current++];
            const texts = batch.map(doc => doc.data().question || "");

            try {
                const vectors = await generateEmbeddingsBatch(texts);

                const upserts = batch.map((doc, idx) => ({
                    id: doc.id,
                    values: vectors[idx],
                    metadata: { text: texts[idx] }
                }));

                await index.upsert(upserts);

                // Mark all docs in batch as embedded
                const updates = batch.map(doc => doc.ref.update({ embedded: true }));
                await Promise.all(updates);

                console.log(`✅ Embedded batch: ${batch.map(d => d.id).join(', ')}`);
            } catch (err) {
                console.error("Failed embedding batch:", err.message);
            }

            // Recursively process next batch
            await processNextBatch();
        }

        // Launch concurrent batch processors
        const workers = [];
        for (let i = 0; i < CONCURRENCY && i < batches.length; i++) {
            workers.push(processNextBatch());
        }

        await Promise.all(workers);

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
            extractedText = await runGeminiOCR(imageBase64);
            if (extractedText.trim()) finalQueryText += " " + extractedText;
        }

        if (!finalQueryText || finalQueryText.trim() === '') return res.json([{ id: "#0000" }]);

        const vector = (await generateEmbeddingsBatch([finalQueryText]))[0];
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
