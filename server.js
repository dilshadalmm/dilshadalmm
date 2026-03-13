// server.js

// ===================== IMPORTS =====================
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const Tesseract = require('tesseract.js'); // ✅ Must include

require('dotenv').config();

// ===================== EXPRESS SETUP =====================
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

// ===================== FIREBASE SETUP =====================
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

// ===================== GEMINI & PINECONE =====================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

// ===================== OCR WORKER POOL =====================
const scheduler = Tesseract.createScheduler();
(async () => {
    for (let i = 0; i < 4; i++) {
        const worker = await Tesseract.createWorker('eng');
        await worker.load();
        await worker.loadLanguage('eng');
        await worker.initialize('eng');
        scheduler.addWorker(worker);
    }
    console.log("🚀 OCR Workers Online");
})();

// ===================== UTILITY FUNCTIONS =====================

// Generate unique question ID
function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

// Generate embedding for a single text
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

// Batch embedding
async function generateEmbeddingsBatch(textList) {
    if (!textList.length) return [];
    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: textList,
        config: { outputDimensionality: 768 }
    });
    return response.embeddings.map(e => e.values);
}

// ===================== BACKGROUND WATCHER =====================
async function embedPendingQuestions() {
    if (!db) return;
    const snapshot = await db.collection("questions")
        .where("embedded", "==", false).limit(1000).get();

    if (snapshot.empty) return;

    const docs = snapshot.docs;

    // Process in batches of 250
    for (let i = 0; i < docs.length; i += 250) {
        const chunk = docs.slice(i, i + 250);
        const texts = chunk.map(d => d.data().question);

        try {
            const vectors = await generateEmbeddingsBatch(texts);
            const firestoreBatch = db.batch();

            const upsertData = vectors.map((v, idx) => {
                firestoreBatch.update(chunk[idx].ref, { embedded: true });
                return { id: chunk[idx].id, values: v, metadata: { text: texts[idx] } };
            });

            await index.upsert(upsertData);
            await firestoreBatch.commit();

            console.log(`✅ Batch processed: ${chunk.length} items`);
        } catch (err) {
            console.error("Batch Error:", err.message);
        }
    }
}
setInterval(embedPendingQuestions, 15000); // Every 15 seconds

// ===================== MAIN SEARCH API =====================
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let queryText = text || "";

        // OCR if image provided
        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            const tempPath = `${uploadDir}/img_${Date.now()}.png`;
            fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));

            const { data } = await scheduler.addJob('recognize', tempPath);
            queryText += " " + (data.text || "");

            fs.unlink(tempPath, () => {});
        }

        if (!queryText.trim()) return res.json([{ id: "#0000" }]);

        // Real-time search (fast path)
        const vector = await generateEmbedding(queryText);
        const results = await index.query({ vector, topK: 1 });

        if (results.matches?.[0]?.score > 0.7) {
            return res.json([{ id: results.matches[0].id }]);
        }

        // New question (surge path)
        const newId = generateQuestionId();
        await db.collection('questions').doc(newId).set({
            question: queryText,
            embedded: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json([{ id: newId }]);
    } catch (err) {
        console.error("Critical Backend Error:", err);
        res.json([{ id: "#0000" }]);
    }
});

// Health check
app.get('/health', (req, res) => res.send('Active'));

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
