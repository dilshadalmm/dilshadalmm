require('dotenv').config();

const express = require('express'); const cors = require('cors'); const crypto = require('crypto');

const { GoogleGenAI } = require('@google/genai'); const { Pinecone } = require('@pinecone-database/pinecone'); const { Queue, Worker } = require('bullmq'); const IORedis = require('ioredis'); const admin = require('firebase-admin');

const app = express(); const PORT = process.env.PORT || 3000;

app.use(cors()); app.use(express.json({ limit: '20mb' }));

/* ---------------- REDIS ---------------- */ const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379'); const connection = redis; const searchQueue = new Queue('searchQueue', { connection });

/* ---------------- FIREBASE ---------------- */ let db = null; let firebaseInitialized = false; try { if (process.env.FIREBASE_SERVICE_ACCOUNT) { const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); db = admin.firestore(); firebaseInitialized = true; console.log('Firebase initialized'); } } catch (err) { console.error('Firebase init failed:', err.message); }

/* ---------------- GEMINI ---------------- */ const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/* ---------------- PINECONE ---------------- */ const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY }); const index = pc.index(process.env.PINECONE_INDEX_NAME);

/* ---------------- PROMPT ---------------- */ const OCR_SYSTEM_PROMPT = 
Just let me no what is the questions in the image and if any diagram is present then also let me know what is the diagram saying.
Don't explain and don't provide solution;

/* ---------------- UTILS ---------------- */ function generateQuestionId() { const timestamp = Date.now(); const random = crypto.randomBytes(4).toString('hex'); return user-${timestamp}-${random}; }

function hashTextOrImage(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

async function generateEmbeddingBatch(texts) { const response = await ai.models.embedContent({ model: 'gemini-embedding-001', contents: texts, config: { outputDimensionality: 768 } }); return response.embeddings.map(e => e.values); }

async function runGeminiOCR(imageBase64) { const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64; const response = await ai.models.generateContent({ model: 'gemini-2.5-flash-lite', contents: [{ role: 'user', parts: [ { text: 'Extract the question text.' }, { inlineData: { mimeType: 'image/png', data: base64Data } } ] }], config: { systemInstruction: { parts: [{ text: OCR_SYSTEM_PROMPT }] }, thinkingConfig: { thinkingBudget: 0 } } }); if (response?.candidates?.length) return response.candidates[0].content.parts[0].text?.trim() || ''; return ''; }

async function getCachedQuestion(hashKey) { return await redis.get(hashKey); }

async function cacheQuestion(hashKey, questionId) { await redis.set(hashKey, questionId, 'EX', 24 * 60 * 60); // 24h expiration }

/* ---------------- WORKER ---------------- */ const worker = new Worker('searchQueue', async job => { const { text, imageBase64 } = job.data; let finalQueryText = text || '';

// Compute hash for caching const hashKey = hashTextOrImage(imageBase64 || text); const cachedId = await getCachedQuestion(hashKey); if (cachedId) return { id: cachedId }; // return cached result immediately

// Run OCR if image if (imageBase64) { const extracted = await runGeminiOCR(imageBase64); if (extracted) finalQueryText += ' ' + extracted; }

if (!finalQueryText.trim()) return { id: '#0000' };

const [vector] = await generateEmbeddingBatch([finalQueryText]); const queryResponse = await index.query({ vector, topK: 1, includeMetadata: false });

if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) { const id = queryResponse.matches[0].id; await cacheQuestion(hashKey, id); return { id }; }

const newId = generateQuestionId(); await index.upsert([{ id: newId, values: vector }]);

if (firebaseInitialized) { await db.collection('questions').doc(newId).set({ question: finalQueryText, comment: 'Answer will be added soon.', videoUrl: '', embedded: true, createdAt: admin.firestore.FieldValue.serverTimestamp() }); }

await cacheQuestion(hashKey, newId); return { id: newId }; }, { connection, concurrency: 10 });

worker.on('failed', (job, err) => console.error('Job failed', job.id, err));

/* ---------------- API ---------------- */ app.post('/api/search', async (req, res) => { try { const { text, imageBase64 } = req.body; const job = await searchQueue.add('search', { text, imageBase64 }); res.json({ jobId: job.id }); } catch (err) { console.error(err); res.status(500).json({ error: 'job_failed' }); } });

app.get('/api/result/:jobId', async (req, res) => { try { const job = await searchQueue.getJob(req.params.jobId); if (!job) return res.json({ status: 'not_found' }); const state = await job.getState(); if (state === 'completed') return res.json({ status: 'completed', result: job.returnvalue }); if (state === 'failed') return res.json({ status: 'failed' }); res.json({ status: 'processing' }); } catch (err) { res.status(500).json({ error: 'status_error' }); } });

app.get('/health', (req, res) => res.send('Active')); app.listen(PORT, () => console.log(Server running on ${PORT}));
