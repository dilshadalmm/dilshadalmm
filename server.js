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
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ===================== FIREBASE SETUP =====================
let firebaseInitialized = false;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin initialized');
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
    for (let i = 0; i < 2; i++) { // ✅ Reduced to 2 workers for memory
        const worker = await Tesseract.createWorker();
        scheduler.addWorker(worker);
    }
    console.log("🚀 OCR Workers Online");
})();

// ===================== UTILITY FUNCTIONS =====================
function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

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
const BATCH_SIZE = 100; // ✅ smaller batch for low memory
async function embedPendingQuestions() {
    if (!db) return;

    const snapshot = await db.collection("questions")
        .where("embedded", "==", false)
        .limit(BATCH_SIZE)
        .get();

    if (snapshot.empty) return;

    const docs = snapshot.docs;

    for (let i = 0; i < docs.length; i += 50) { // further split to 50 per Gemini call
        const chunk = docs.slice(i, i + 50);
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
setInterval(embedPendingQuestions, 15000); // every 15s

// ===================== MAIN SEARCH API =====================
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let queryText = text || "";

        // OCR
        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            const tempPath = `${uploadDir}/img_${Date.now()}.png`;
            fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));

            const { data } = await scheduler.addJob('recognize', tempPath);
            queryText += " " + (data.text || "");

            fs.unlink(tempPath, () => {});
        }

        if (!queryText.trim()) return res.json([{ id: "#0000" }]);

        // Fast-path search
        const vector = await generateEmbedding(queryText);
        const results = await index.query({ vector, topK: 1 });

        if (results.matches?.[0]?.score > 0.7) {
            return res.json([{ id: results.matches[0].id }]);
        }

        // New question (Surge path)
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

// ===================== HEALTH CHECK =====================
app.get('/health', (req, res) => res.send('Active'));

// ===================== START SERVER =====================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
