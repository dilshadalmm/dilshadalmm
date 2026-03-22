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

// ---- Prompts ----
const NORMALIZATION_PROMPT = `
You are an assistant that always responds in valid JSON format. 
Given the following question text and possibly an image, rewrite the question clearly without changing meaning. 
If the image contains an educational diagram, describe it as well. 
Also classify if the question is a VALID academic question.

Respond ONLY with a JSON object in this exact format:
{
  "normalized_question": "...",
  "validity": "VALID" or "INVALID"
}

Do not include any other text, explanations, or markdown formatting.
`;

// ---- Configuration Constants ----
const BATCH_SIZE = 20;                    // Number of requests per batch
const MAX_CONCURRENT_BATCHES = 5;          // Maximum parallel batch workers
const MAX_WAIT_MS = 100;                   // Time to wait before processing a partial batch
const RESPONSE_TIMEOUT_MS = 30000;          // Timeout for each request (30s for AI calls)

// ---- Queue and Concurrency State ----
const requestQueue = [];                    // { res, text, imageBase64, timeout, sent }
let activeBatches = 0;                      // Number of currently processing batches
let partialBatchTimeoutId = null;           // Timeout ID for partial batch

// ---- Background Job Lock ----
let isEmbeddingRunning = false;

// ---- Utility Functions ----

function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

// ---- Token Logging Helper ----
function logTokenUsage(response, callType) {
    try {
        if (response?.usageMetadata) {
            const usage = response.usageMetadata;
            console.log(`[Token Usage][${callType}] input: ${usage.promptTokenCount || 0}, output: ${usage.candidatesTokenCount || 0}, total: ${usage.totalTokenCount || 0}`);
        } else {
            console.log(`[Token Usage][${callType}] Token usage data not available for this request`);
        }
    } catch (err) {
        console.log(`[Token Usage][${callType}] Failed to log token usage: ${err.message}`);
    }
}

// ---- AI Functions ----

async function normalizeAndValidate(text, imageBase64) {
    console.log(`[Normalize] Calling Gemini at ${new Date().toISOString()}`);
    try {
        const parts = [];
        if (text) {
            parts.push({ text: `Question text: ${text}` });
        }
        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            parts.push({ inlineData: { mimeType: 'image/png', data: base64Data } });
        }
        if (parts.length === 0) {
            return { normalized_question: "", validity: "INVALID" };
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: { parts: [{ text: NORMALIZATION_PROMPT }] },
                generationConfig: { 
                    temperature: 0.6, 
                    topP: 0.95,
                    responseMimeType: 'application/json'   // Force JSON output
                },
                thinkingConfig: { thinkingBudget: 0 }
            }
        });

        // Log token usage for normalization call
        logTokenUsage(response, 'normalization');

        let fullText = "";
        if (response?.candidates?.length > 0) {
            fullText = response.candidates[0]?.content?.parts?.[0]?.text || "";
        }

        // Strip possible markdown code fences (```json ... ```)
        const jsonString = fullText.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();

        // Attempt to parse JSON
        try {
            const parsed = JSON.parse(jsonString);
            return {
                normalized_question: parsed.normalized_question || "",
                validity: parsed.validity === "VALID" ? "VALID" : "INVALID"
            };
        } catch (parseErr) {
            console.error("JSON parse error, raw response:", fullText);
            return { normalized_question: "", validity: "INVALID" };
        }
    } catch (err) {
        console.error("Normalization failed:", err.message);
        return { normalized_question: "", validity: "INVALID" };
    }
}

async function generateEmbeddingsBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) throw new Error('Cannot embed empty text array');

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: texts,
        config: { outputDimensionality: 768 }
    });

    // Log token usage for embedding call
    logTokenUsage(response, 'embedding');

    if (response.embeddings && response.embeddings.length === texts.length) {
        return response.embeddings.map(e => e.values);
    }
    throw new Error("No embeddings returned or mismatch in count");
}

// ---- Firestore Watcher with Lock (unchanged) ----

async function embedPendingQuestions() {
    if (!db) return;
    if (isEmbeddingRunning) {
        console.log('⚠️ Previous embedPendingQuestions still running, skipping...');
        return;
    }
    isEmbeddingRunning = true;
    try {
        const snapshot = await db.collection("questions")
            .where("embedded", "==", false)
            .limit(5000)
            .get();

        if (snapshot.empty) return;

        const docs = snapshot.docs;
        const EMBED_BATCH_SIZE = 20;
        const CONCURRENCY = 50;
        const batches = [];

        for (let i = 0; i < docs.length; i += EMBED_BATCH_SIZE) {
            batches.push(docs.slice(i, i + EMBED_BATCH_SIZE));
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
    } finally {
        isEmbeddingRunning = false;
    }
}

// Run watcher every 1 minute
setInterval(embedPendingQuestions, 60 * 1000);

// ---- Queue Processing Helpers (unchanged) ----

function setupRequestTimeout(item) {
    item.timeout = setTimeout(() => {
        if (!item.sent) {
            item.sent = true;
            item.res.json({
                question: "Timeout",
                solution: "Request took too long. Please try again.",
                videoUrl: "",
                imageUrl: ""
            });
            console.log('⏰ Request timeout');
        }
    }, RESPONSE_TIMEOUT_MS);
}

function clearRequestTimeout(item) {
    if (item.timeout) {
        clearTimeout(item.timeout);
        item.timeout = null;
    }
}

async function tryStartBatch() {
    if (activeBatches >= MAX_CONCURRENT_BATCHES || requestQueue.length === 0) return;

    const batchSize = Math.min(BATCH_SIZE, requestQueue.length);
    const batch = requestQueue.splice(0, batchSize);

    activeBatches++;
    try {
        await processBatch(batch);
    } catch (err) {
        console.error('Unexpected error in batch processing:', err);
        batch.forEach(item => {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    question: "Error",
                    solution: "An internal error occurred.",
                    videoUrl: "",
                    imageUrl: ""
                });
            }
        });
    } finally {
        activeBatches--;
        scheduleProcessing();
    }
}

async function processBatch(batch) {
    // Step 1: Normalize each item (sequentially)
    const validItems = [];
    const normalizedTexts = [];

    for (const item of batch) {
        const { text, imageBase64 } = item;
        const { normalized_question, validity } = await normalizeAndValidate(text, imageBase64);

        if (validity !== "VALID" || !normalized_question) {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    question: text || "Question",
                    solution: "The question is not a valid academic question.",
                    videoUrl: "",
                    imageUrl: ""
                });
            }
            continue;
        }

        validItems.push(item);
        normalizedTexts.push(normalized_question);
    }

    if (validItems.length === 0) return;

    // Step 2: Generate embeddings for all normalized texts in one batch
    let vectors;
    try {
        vectors = await generateEmbeddingsBatch(normalizedTexts);
    } catch (err) {
        console.error('Embedding generation failed:', err.message);
        validItems.forEach(item => {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    question: "Error",
                    solution: "Unable to process question.",
                    videoUrl: "",
                    imageUrl: ""
                });
            }
        });
        return;
    }

    // Step 3: Run Pinecone queries (topK=3) in parallel
    const queryPromises = validItems.map(async (item, idx) => {
        const vector = vectors[idx];
        const normalized = normalizedTexts[idx];
        try {
            const queryResponse = await index.query({
                vector,
                topK: 3,
                includeMetadata: true
            });
            return { item, vector, normalized, queryResponse };
        } catch (err) {
            console.error('Pinecone query failed:', err.message);
            return { item, vector, normalized, error: err };
        }
    });

    const results = await Promise.all(queryPromises);

    // Step 4: Process each result (NO SOLUTION GENERATION, NO STORAGE)
    for (const res of results) {
        const { item, normalized, queryResponse, error } = res;

        // If error or no matches at all → return empty solution
        if (error || !queryResponse?.matches?.length) {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    question: normalized,
                    solution: "",
                    videoUrl: "",
                    imageUrl: ""
                });
            }
            continue;
        }

        // Find best match with score >= 0.85
        const matches = queryResponse.matches;
        const bestMatch = matches.find(m => m.score >= 0.85) || null;

        if (bestMatch) {
            const metadata = bestMatch.metadata || {};
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    question: metadata.question || normalized,
                    solution: metadata.solution || "",          // empty if missing
                    videoUrl: metadata.videoUrl || "",
                    imageUrl: metadata.imageUrl || ""
                });
            }
        } else {
            // No match with sufficient score → return empty solution, no storage
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    question: normalized,
                    solution: "",
                    videoUrl: "",
                    imageUrl: ""
                });
            }
        }
    }
}

function scheduleProcessing() {
    while (activeBatches < MAX_CONCURRENT_BATCHES && requestQueue.length >= BATCH_SIZE) {
        tryStartBatch();
    }

    if (requestQueue.length > 0 && requestQueue.length < BATCH_SIZE) {
        if (!partialBatchTimeoutId) {
            partialBatchTimeoutId = setTimeout(() => {
                partialBatchTimeoutId = null;
                tryStartBatch();
            }, MAX_WAIT_MS);
        }
    } else {
        if (partialBatchTimeoutId) {
            clearTimeout(partialBatchTimeoutId);
            partialBatchTimeoutId = null;
        }
    }
}

// ---- API Endpoint ----

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;

        const item = {
            res,
            text: text || '',
            imageBase64,
            sent: false,
            timeout: null
        };
        setupRequestTimeout(item);

        requestQueue.push(item);
        scheduleProcessing();

    } catch (error) {
        console.error("Critical Backend Error:", error);
        if (!res.headersSent) {
            res.json({
                question: "Error",
                solution: "A critical error occurred.",
                videoUrl: "",
                imageUrl: ""
            });
        }
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
