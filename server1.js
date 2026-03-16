const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

// ---- Configuration ----
const BATCH_SIZE = 20;
const MAX_CONCURRENT_BATCHES = 5;
const MAX_WAIT_MS = 100;
const RESPONSE_TIMEOUT_MS = 10000;

// ---- AI Solve batch configuration ----
const AI_BATCH_SIZE = 5;
const AI_BATCH_DELAY = 200;

// ---- Queues ----
const requestQueue = [];
let activeBatches = 0;
let partialBatchTimeoutId = null;
const aiSolveQueue = [];

// ---- Utilities ----
function generateQuestionId(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function setupTimeout(item) {
    item.timeout = setTimeout(() => {
        if (!item.sent) {
            item.sent = true;
            item.res.json({ error: "timeout" });
        }
    }, RESPONSE_TIMEOUT_MS);
}

function clearTimeoutItem(item) {
    if (item.timeout) {
        clearTimeout(item.timeout);
        item.timeout = null;
    }
}

// ---- Normalize + Validate (handles text + image together) ----
async function normalizeAndValidate(input) {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: [{
            role: "user",
            parts: [
                {
                    text: `
Rewrite the question clearly without changing meaning.
(Note: if an educational diagram is present, describe it as well.)
Also classify if the question is a VALID academic question.

Return JSON:
{
  "normalized_question": "...",
  "validity": "VALID or INVALID"
}

Question:
${input.text || ""}
`
                },
                ...(input.imageBase64
                    ? [{ inlineData: { mimeType: "image/png", data: input.imageBase64.split(',')[1] } }]
                    : [])
            ]
        }],
        config: { temperature: 0 }
    });

    let output = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    try {
        return JSON.parse(output);
    } catch {
        return { normalized_question: input.text || "", validity: "VALID" };
    }
}

// ---- Generate Embeddings ----
async function generateEmbeddingsBatch(texts) {
    const response = await ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: texts,
        config: { outputDimensionality: 768 }
    });
    return response.embeddings.map(e => e.values);
}

// ---- AI Solve ----
async function generateSolution(question) {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
            role: "user",
            parts: [{
                text: `
Provide a concise, exam-oriented, structured solution to the following question. 
Use LaTeX formatting for all mathematical expressions, physics formulas, and chemistry equations. 
Keep the explanation step-by-step, clear, and do not exceed 2000 characters. 
Do not write unnecessary long explanations.

Question:
${question}
`
            }]
        }]
    });
    return response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ---- Save Question to Pinecone ----
async function saveQuestion(vector, question, solution) {
    const id = generateQuestionId(question);
    const metadata = { question, solution, videoUrl: "", imageUrl: "" };
    await index.upsert([{ id, values: vector, metadata }]);
    return metadata;
}

// ---- Batch Processor ----
async function processBatch(batch) {
    const validItems = [];
    const texts = [];

    for (const item of batch) {
        const normalized = await normalizeAndValidate(item);
        if (normalized.validity === "INVALID") {
            if (!item.sent) { item.sent = true; clearTimeoutItem(item); item.res.json({ error: "invalid_question" }); }
            continue;
        }
        texts.push(normalized.normalized_question);
        validItems.push({ ...item, normalizedText: normalized.normalized_question });
    }

    if (!texts.length) return;

    const vectors = await generateEmbeddingsBatch(texts);
    const queries = validItems.map((item, i) => index.query({ vector: vectors[i], topK: 1, includeMetadata: true }));
    const results = await Promise.all(queries);

    for (let i = 0; i < results.length; i++) {
        const item = validItems[i];
        const vector = vectors[i];
        const bestMatch = results[i].matches?.[0];

        if (bestMatch && bestMatch.score >= 0.85) {
            const metadata = bestMatch.metadata;
            if (!item.sent) { item.sent = true; clearTimeoutItem(item); item.res.json(metadata); }
        } else {
            aiSolveQueue.push({ item, vector, question: item.normalizedText });
        }
    }
}

// ---- Scheduler ----
function tryStartBatch() {
    if (activeBatches >= MAX_CONCURRENT_BATCHES || requestQueue.length === 0) return;
    const batchSize = Math.min(BATCH_SIZE, requestQueue.length);
    const batch = requestQueue.splice(0, batchSize);
    activeBatches++;
    processBatch(batch)
        .catch(console.error)
        .finally(() => { activeBatches--; scheduleProcessing(); });
}

function scheduleProcessing() {
    while (activeBatches < MAX_CONCURRENT_BATCHES && requestQueue.length >= BATCH_SIZE) tryStartBatch();
    if (requestQueue.length > 0 && requestQueue.length < BATCH_SIZE && !partialBatchTimeoutId) {
        partialBatchTimeoutId = setTimeout(() => { partialBatchTimeoutId = null; tryStartBatch(); }, MAX_WAIT_MS);
    }
}

// ---- AI Solve Worker ----
async function processAISolveQueue() {
    while (true) {
        if (!aiSolveQueue.length) { await new Promise(r => setTimeout(r, 50)); continue; }

        const batch = aiSolveQueue.splice(0, AI_BATCH_SIZE);
        await Promise.all(batch.map(async job => {
            try {
                const solution = await generateSolution(job.question);
                const metadata = await saveQuestion(job.vector, job.question, solution);
                if (!job.item.sent) { job.item.sent = true; clearTimeoutItem(job.item); job.item.res.json(metadata); }
            } catch (err) {
                console.error("AI solve failed", err);
                if (!job.item.sent) { job.item.sent = true; clearTimeoutItem(job.item); job.item.res.json({ error: "solve_failed" }); }
            }
        }));

        await new Promise(r => setTimeout(r, AI_BATCH_DELAY));
    }
}
processAISolveQueue();

// ---- API ----
app.post('/api/search', (req, res) => {
    const { text, imageBase64 } = req.body;
    const item = { res, text, imageBase64, sent: false, timeout: null };
    setupTimeout(item);
    requestQueue.push(item);
    scheduleProcessing();
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
