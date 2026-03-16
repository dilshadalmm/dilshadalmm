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

// ---- Configuration Constants ----
const BATCH_SIZE = 20;                    // Number of requests per batch
const MAX_CONCURRENT_BATCHES = 5;          // Maximum parallel batch workers
const MAX_WAIT_MS = 100;                   // Time to wait before processing a partial batch
const RESPONSE_TIMEOUT_MS = 5000;          // Timeout for each request

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

async function addNewQuestionWithVector(queryText, extractedText = '', vector) {
    const fullText = extractedText || queryText;
    if (!fullText) throw new Error('No text to add');

    const newId = generateQuestionId();

    await index.upsert([{ 
        id: newId, 
        values: vector,
        metadata: { text: fullText }
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

async function addNewQuestion(queryText, extractedText = '') {
    const fullText = extractedText || queryText;
    if (!fullText) throw new Error('No text to add');
    const vector = (await generateEmbeddingsBatch([fullText]))[0];
    return addNewQuestionWithVector(queryText, extractedText, vector);
}

// ---- Firestore Watcher with Lock ----

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
        const EMBED_BATCH_SIZE = 20;               // Match new batch size
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

// ---- Queue Processing Helpers ----

/**
 * Sends a timeout response for a request if not already sent.
 */
function setupRequestTimeout(item) {
    item.timeout = setTimeout(() => {
        if (!item.sent) {
            item.sent = true;
            item.res.json([{ id: "#0000" }]);
            console.log('⏰ Request timeout, sent #0000');
        }
    }, RESPONSE_TIMEOUT_MS);
}

/**
 * Clears the timeout for a request.
 */
function clearRequestTimeout(item) {
    if (item.timeout) {
        clearTimeout(item.timeout);
        item.timeout = null;
    }
}

/**
 * Attempts to start a new batch worker if conditions allow.
 * Takes a batch of up to BATCH_SIZE items from the queue and processes them.
 */
async function tryStartBatch() {
    // Cannot start if already at max concurrency or queue empty
    if (activeBatches >= MAX_CONCURRENT_BATCHES || requestQueue.length === 0) return;

    // Determine batch size: if queue length >= BATCH_SIZE, take full batch; otherwise take all (partial)
    const batchSize = Math.min(BATCH_SIZE, requestQueue.length);
    const batch = requestQueue.splice(0, batchSize);

    activeBatches++;
    try {
        await processBatch(batch);
    } catch (err) {
        console.error('Unexpected error in batch processing:', err);
        // On catastrophic failure, send fallback to all items in this batch
        batch.forEach(item => {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json([{ id: "#0000" }]);
            }
        });
    } finally {
        activeBatches--;
        // After finishing, try to start more batches (both full and partial)
        scheduleProcessing();
    }
}

/**
 * Processes a single batch of requests.
 * Handles OCR, embedding, Pinecone search, and response.
 */
async function processBatch(batch) {
    // Step 1: Perform OCR for any images and build final texts
    const validItems = [];
    const validTexts = [];

    for (const item of batch) {
        let finalText = item.text || '';
        if (item.imageBase64) {
            const extracted = await runGeminiOCR(item.imageBase64);
            if (extracted) finalText += ' ' + extracted;
        }
        finalText = finalText.trim();

        if (!finalText) {
            // Empty query -> return #0000 immediately
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json([{ id: "#0000" }]);
            }
            continue;
        }

        validItems.push(item);
        validTexts.push(finalText);
    }

    if (validItems.length === 0) return; // All were empty

    // Step 2: Generate embeddings for all valid texts in one batch call
    let vectors;
    try {
        vectors = await generateEmbeddingsBatch(validTexts);
    } catch (err) {
        console.error('Embedding generation failed:', err.message);
        // Fail all valid items
        validItems.forEach(item => {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json([{ id: "#0000" }]);
            }
        });
        return;
    }

    // Step 3: Run all Pinecone queries in parallel
    const queryPromises = validItems.map(async (item, idx) => {
        const vector = vectors[idx];
        try {
            const queryResponse = await index.query({
                vector,
                topK: 1,
                includeMetadata: true
            });
            return { item, vector, queryResponse };
        } catch (err) {
            console.error('Pinecone query failed:', err.message);
            return { item, vector, error: err };
        }
    });

    const results = await Promise.all(queryPromises);

    // Step 4: Handle each result (send response or create new question)
    const creationPromises = [];
    for (const res of results) {
        const { item, vector, queryResponse, error } = res;
        if (error || !queryResponse?.matches?.[0]) {
            // No match or error -> create new question
            creationPromises.push(
                addNewQuestionWithVector(item.text || '', item.imageBase64 ? '(image)' : '', vector)
                    .then(newId => {
                        if (!item.sent) {
                            item.sent = true;
                            clearRequestTimeout(item);
                            item.res.json([{ id: newId }]);
                        }
                    })
                    .catch(err => {
                        console.error('Failed to create new question:', err);
                        if (!item.sent) {
                            item.sent = true;
                            clearRequestTimeout(item);
                            item.res.json([{ id: "#0000" }]);
                        }
                    })
            );
        } else {
            // Match found
            const match = queryResponse.matches[0];
            if (match.score > 0.6) {
                if (!item.sent) {
                    item.sent = true;
                    clearRequestTimeout(item);
                    item.res.json([{ id: match.id }]);
                }
            } else {
                // Score too low -> create new
                creationPromises.push(
                    addNewQuestionWithVector(item.text || '', item.imageBase64 ? '(image)' : '', vector)
                        .then(newId => {
                            if (!item.sent) {
                                item.sent = true;
                                clearRequestTimeout(item);
                                item.res.json([{ id: newId }]);
                            }
                        })
                        .catch(err => {
                            console.error('Failed to create new question:', err);
                            if (!item.sent) {
                                item.sent = true;
                                clearRequestTimeout(item);
                                item.res.json([{ id: "#0000" }]);
                            }
                        })
                );
            }
        }
    }

    // Wait for all creations to complete (though responses are already sent)
    await Promise.allSettled(creationPromises);
}

/**
 * Schedules processing of the queue:
 * - Starts as many full batches as allowed.
 * - Sets a timeout for a partial batch if needed and no timeout pending.
 */
function scheduleProcessing() {
    // Start full batches while possible
    while (activeBatches < MAX_CONCURRENT_BATCHES && requestQueue.length >= BATCH_SIZE) {
        // Fire and forget (async but we don't await)
        tryStartBatch();
    }

    // Handle partial batch (queue not empty but less than BATCH_SIZE)
    if (requestQueue.length > 0 && requestQueue.length < BATCH_SIZE) {
        if (!partialBatchTimeoutId) {
            partialBatchTimeoutId = setTimeout(() => {
                partialBatchTimeoutId = null;
                // When timeout fires, try to start a batch (it will be partial)
                tryStartBatch();
            }, MAX_WAIT_MS);
        }
    } else {
        // If queue is empty or full, clear any pending timeout
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
        
        // Create queue item with timeout protection
        const item = {
            res,
            text: text || '',
            imageBase64,
            sent: false,
            timeout: null
        };
        setupRequestTimeout(item);

        // Push to queue
        requestQueue.push(item);

        // Trigger queue processing
        scheduleProcessing();

    } catch (error) {
        console.error("Critical Backend Error:", error);
        // If we haven't sent anything yet, send fallback
        if (!res.headersSent) {
            res.json([{ id: "#0000" }]);
        }
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
