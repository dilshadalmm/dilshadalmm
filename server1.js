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
const NORMALIZATION_SYSTEM_PROMPT = `You are a helpful assistant. Rewrite the question clearly without changing meaning. (Note: if an educational diagram is present, describe it as well.) Also classify if the question is a VALID academic question. Return JSON in the format: { "normalized_question": "...", "validity": "VALID or INVALID" }`;

const SOLUTION_PROMPT = `Provide a **concise, exam-oriented, structured solution** to the following question. Use LaTeX formatting for all mathematical expressions, physics formulas, and chemistry equations. Keep the explanation step-by-step, clear, and **do not exceed 2000 characters**. Do not write unnecessary long explanations.

Question:
[Normalized question]`;

// ---- Utility Functions ----

function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

function getMimeTypeFromBase64(base64) {
    const match = base64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
    return match ? match[1] : 'image/png';
}

async function generateEmbeddingsBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error('Cannot embed empty text array');
    }

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

// ---- Normalization ----
async function normalizeQuestion(text, imageBase64) {
    try {
        const parts = [];
        if (text && text.trim()) {
            parts.push({ text: `Question: ${text}` });
        }
        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            const mimeType = getMimeTypeFromBase64(imageBase64);
            parts.push({ inlineData: { mimeType, data: base64Data } });
        }
        if (parts.length === 0) {
            throw new Error('No input provided');
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: { parts: [{ text: NORMALIZATION_SYSTEM_PROMPT }] },
                generationConfig: { temperature: 0.2, topP: 0.95 },
                thinkingConfig: { thinkingBudget: 0 }
            }
        });

        let textResponse = "";
        if (response?.candidates?.length > 0) {
            textResponse = response.candidates[0]?.content?.parts?.[0]?.text || "";
        }

        // Extract JSON from response
        const jsonMatch = textResponse.match(/\{.*\}/s);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.normalized_question && parsed.validity) {
                return parsed;
            }
        }
        throw new Error('Invalid JSON response from normalization');
    } catch (err) {
        console.error("Normalization failed:", err.message);
        return null;
    }
}

// ---- AI Solving ----
async function solveQuestion(normalizedQuestion) {
    try {
        const prompt = SOLUTION_PROMPT.replace('[Normalized question]', normalizedQuestion);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                generationConfig: { temperature: 0.4, topP: 0.95, maxOutputTokens: 2000 },
                thinkingConfig: { thinkingBudget: 0 }
            }
        });

        let solution = "";
        if (response?.candidates?.length > 0) {
            solution = response.candidates[0]?.content?.parts?.[0]?.text || "";
        }
        return solution.trim();
    } catch (err) {
        console.error("AI solve failed:", err.message);
        return null;
    }
}

// ---- Knowledge Base Storage ----
async function addToKnowledgeBase(normalizedQuestion, solution, videoUrl = '', imageUrl = '') {
    if (!normalizedQuestion || !solution) throw new Error('Missing question or solution');

    // Generate embedding
    const vector = (await generateEmbeddingsBatch([normalizedQuestion]))[0];
    const newId = generateQuestionId();

    // Upsert to Pinecone with metadata
    await index.upsert([{
        id: newId,
        values: vector,
        metadata: { has_solution: true }
    }]);

    // Store in Firestore if available
    if (db) {
        await db.collection('questions').doc(newId).set({
            question: normalizedQuestion,
            solution: solution,
            videoUrl: videoUrl || '',
            imageUrl: imageUrl || '',
            embedded: true,
            has_solution: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Added solved question to Firestore: ${newId}`);
    }

    return newId;
}

// ---- Legacy: Add unsolved question (used by background watcher) ----
async function addNewQuestion(queryText, extractedText = '') {
    const fullText = extractedText || queryText;
    if (!fullText) throw new Error('No text to add');

    const vector = (await generateEmbeddingsBatch([fullText]))[0];
    const newId = generateQuestionId();

    await index.upsert([{
        id: newId,
        values: vector,
        metadata: { has_solution: false }
    }]);

    if (db) {
        await db.collection('questions').doc(newId).set({
            question: fullText,
            comment: "Thank you for your question. Our team will provide an answer soon.",
            videoUrl: "",
            imageUrl: "",
            embedded: true,
            has_solution: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Added unsolved question to Firestore: ${newId}`);
    }

    return newId;
}

// ---- Firestore Watcher (for legacy unsolved questions) ----
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
                    metadata: { text: texts[idx], has_solution: false }
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

setInterval(embedPendingQuestions, 60 * 1000);

// ---- API Endpoint ----
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;

        // Step 1: Normalize and validate
        const normResult = await normalizeQuestion(text, imageBase64);
        if (!normResult) {
            return res.status(500).json({ error: "Normalization failed" });
        }
        if (normResult.validity !== "VALID") {
            return res.status(400).json({ error: "Invalid academic question" });
        }
        const normalizedQuestion = normResult.normalized_question;

        // Step 2: Generate embedding
        const vector = (await generateEmbeddingsBatch([normalizedQuestion]))[0];

        // Step 3: Query Pinecone for solved questions only
        const queryResponse = await index.query({
            vector,
            topK: 3,
            includeMetadata: false,
            filter: { has_solution: true }
        });

        // Step 4: Find best match with score >= 0.85
        let bestMatch = null;
        if (queryResponse.matches && queryResponse.matches.length > 0) {
            const sorted = queryResponse.matches.sort((a, b) => b.score - a.score);
            bestMatch = sorted.find(m => m.score >= 0.85);
        }

        if (bestMatch) {
            // Fetch full metadata from Firestore
            if (!db) {
                return res.status(500).json({ error: "Database not available" });
            }
            const doc = await db.collection('questions').doc(bestMatch.id).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.solution) {
                    return res.json({
                        question: data.question,
                        solution: data.solution,
                        videoUrl: data.videoUrl || '',
                        imageUrl: data.imageUrl || ''
                    });
                } else {
                    console.warn(`Match ID ${bestMatch.id} has no solution, falling back to AI solve`);
                }
            } else {
                console.warn(`Match ID ${bestMatch.id} not found in Firestore, falling back to AI solve`);
            }
        }

        // Step 5: No good match – solve with AI
        const solution = await solveQuestion(normalizedQuestion);
        if (!solution) {
            return res.status(500).json({ error: "AI solving failed" });
        }

        // Step 6: Store in knowledge base
        await addToKnowledgeBase(normalizedQuestion, solution);

        // Step 7: Return metadata
        return res.json({
            question: normalizedQuestion,
            solution: solution,
            videoUrl: '',
            imageUrl: ''
        });

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Health check
app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
