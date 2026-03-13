const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const Tesseract = require("tesseract.js"); // 1. Correct import
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// 2. SURGE PROTECTION: OCR Worker Pool (Corrected Syntax)
const scheduler = Tesseract.createScheduler(); 
(async () => {
    // We use 2 workers for Render Free Tier to avoid memory crashes
    for (let i = 0; i < 2; i++) {
        const worker = await Tesseract.createWorker('eng');
        scheduler.addWorker(worker);
    }
    console.log("🚀 OCR Workers Online");
})();

// Initialize Gemini & Pinecone
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * SINGLE EMBEDDING (For real-time search)
 */
async function generateEmbedding(text) {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const result = await model.embedContent({
        content: { parts: [{ text }] },
        config: { outputDimensionality: 768 }
    });
    return result.embedding.values;
}

/**
 * BATCH EMBEDDING (For the 10k Surge)
 * Sends up to 250 strings in ONE request
 */
async function generateEmbeddingsBatch(textList) {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const result = await model.batchEmbedContents({
        requests: textList.map(t => ({
            content: { parts: [{ text: t }] },
            model: "models/gemini-embedding-001",
            config: { outputDimensionality: 768 }
        }))
    });
    return result.embeddings.map(e => e.values);
}

/**
 * BACKGROUND WATCHER: Sweeps 1,000 pending questions every 15s
 */
async function embedPendingQuestions() {
    const db = admin.firestore();
    const snapshot = await db.collection("questions")
        .where("embedded", "==", false).limit(1000).get();

    if (snapshot.empty) return;

    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += 250) {
        const chunk = docs.slice(i, i + 250);
        const texts = chunk.map(d => d.data().question);
        
        try {
            const vectors = await generateEmbeddingsBatch(texts);
            const fbBatch = db.batch();
            const upserts = vectors.map((v, idx) => {
                fbBatch.update(chunk[idx].ref, { embedded: true });
                return { id: chunk[idx].id, values: v, metadata: { text: texts[idx] } };
            });

            await index.upsert(upserts);
            await fbBatch.commit();
            console.log(`✅ Processed surge: ${chunk.length} items`);
        } catch (e) { console.error("Batching failed:", e.message); }
    }
}
setInterval(embedPendingQuestions, 15000);

/**
 * SEARCH API: Survives the surge by returning ID instantly
 */
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let queryText = text || "";

        if (imageBase64) {
            const base64Data = imageBase64.split(',')[1] || imageBase64;
            const tempPath = `./uploads/img_${Date.now()}.png`;
            fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
            
            // Scheduler puts student in line for OCR
            const { data } = await scheduler.addJob('recognize', tempPath);
            queryText += " " + (data.text || "");
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }

        if (!queryText.trim()) return res.json([{ id: "#0000" }]);

        // Fast path: Check for existing answer
        const vector = await generateEmbedding(queryText);
        const results = await index.query({ vector, topK: 1 });

        if (results.matches?.[0]?.score > 0.7) {
            return res.json([{ id: results.matches[0].id }]);
        }

        // Surge Path: Return ID now, process in background
        const newId = `q-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
        await admin.firestore().collection('questions').doc(newId).set({
            question: queryText,
            embedded: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json([{ id: newId }]);
    } catch (e) {
        console.error(e);
        res.json([{ id: "#0000" }]);
    }
});

app.listen(PORT, () => console.log(`Surge-proof server on ${PORT}`));
