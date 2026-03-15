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

// ---- Utility Functions ----

function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

async function runGeminiOCR(imageBase64) {
    console.log(`[OCR] Calling Gemini at ${new Date().toISOString()}`);
    try {
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
                generationConfig: { temperature: 0.6, topP: 0.95 },
                thinkingConfig: { thinkingBudget: 0 }
            }
        });

        let fullText = "";
        if (response?.candidates?.length > 0) {
            const candidate = response.candidates[0];
            fullText = candidate?.content?.parts?.[0]?.text || "";
        }
        return fullText.trim();
    } catch (err) {
        console.error("Gemini OCR extraction failed:", err.message);
        return "";
    }
}

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

// NEW FUNCTION: Add question with pre-generated vector
async function addNewQuestionWithVector(queryText, extractedText = '', vector) {
    const fullText = extractedText || queryText;
    if (!fullText) throw new Error('No text to add');

    const newId = generateQuestionId();

    await index.upsert([{ 
        id: newId, 
        values: vector,
        metadata: { text: fullText }  // Store text in metadata for future reference
    }]);

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

// Keep original for backward compatibility or other uses
async function addNewQuestion(queryText, extractedText = '') {
    const fullText = extractedText || queryText;
    if (!fullText) throw new Error('No text to add');
    const vector = (await generateEmbeddingsBatch([fullText]))[0];
    return addNewQuestionWithVector(queryText, extractedText, vector);
}

// ---- Firestore Watcher: Batch Embedding ----

async function embedPendingQuestions() {
    if (!db) return;
    try {
        const snapshot = await db.collection("questions")
            .where("embedded", "==", false)
            .limit(5000)
            .get();

        if (snapshot.empty) return;

        const docs = snapshot.docs;
        const BATCH_SIZE = 10;
        const CONCURRENCY = 50;
        const batches = [];

        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
            batches.push(docs.slice(i, i + BATCH_SIZE));
        }

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
                await Promise.all(batch.map(doc => doc.ref.update({ embedded: true })));

                console.log(`✅ Embedded batch: ${batch.map(d => d.id).join(', ')}`);
            } catch (err) {
                console.error("Failed embedding batch:", err.message);
            }

            await processNextBatch();
        }

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

// ---- Real-Time Concurrent Request Batching for /api/search ----

const requestQueue = [];
const BATCH_SIZE = 10;
const MAX_WAIT_MS = 100;
let batchTimeout = null;

async function processRequestQueue() {
    if (batchTimeout) {
        clearTimeout(batchTimeout);
        batchTimeout = null;
    }

    if (requestQueue.length === 0) return;

    const batch = requestQueue.splice(0, BATCH_SIZE);
    const texts = batch.map(item => item.finalQueryText);

    try {
        // ✅ Generate embeddings ONCE for the entire batch
        const vectors = await generateEmbeddingsBatch(texts);

        // Process each request using pre-generated vectors
        for (let i = 0; i < batch.length; i++) {
            const vector = vectors[i];
            const queryResponse = await index.query({ 
                vector, 
                topK: 1, 
                includeMetadata: true  // Include metadata to get stored text
            });
            
            const reqObj = batch[i];

            if (queryResponse.matches?.[0]?.score > 0.6) {
                // Found existing question
                reqObj.res.json([{ id: queryResponse.matches[0].id }]);
            } else {
                // ✅ No match found - create new question using EXISTING vector
                const newId = await addNewQuestionWithVector(
                    reqObj.text || "", 
                    reqObj.extractedText,
                    vector  // Pass the pre-generated vector!
                );
                reqObj.res.json([{ id: newId }]);
            }
        }
    } catch (err) {
        console.error("Batch processing failed:", err.message);
        batch.forEach(item => item.res.json([{ id: "#0000" }]));
    }

    // Continue processing remaining queue items
    if (requestQueue.length > 0) {
        if (requestQueue.length >= BATCH_SIZE) {
            setImmediate(processRequestQueue);
        } else {
            batchTimeout = setTimeout(() => {
                batchTimeout = null;
                processRequestQueue();
            }, MAX_WAIT_MS);
        }
    }
}

// ---- API Endpoint ----

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

        // Push request to in-memory queue
        requestQueue.push({ res, text, extractedText, finalQueryText });

        // Trigger batch processing
        if (requestQueue.length >= BATCH_SIZE) {
            if (batchTimeout) {
                clearTimeout(batchTimeout);
                batchTimeout = null;
            }
            setImmediate(processRequestQueue);
        } else if (!batchTimeout) {
            batchTimeout = setTimeout(() => {
                batchTimeout = null;
                processRequestQueue();
            }, MAX_WAIT_MS);
        }

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
