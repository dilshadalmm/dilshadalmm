const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // Added for password hashing
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

// ---- Configuration Constants ----
const BATCH_SIZE = 20;
const MAX_CONCURRENT_BATCHES = 5;
const MAX_WAIT_MS = 100;
const RESPONSE_TIMEOUT_MS = 30000;
const DAILY_LIMIT = 20;
const MONTHLY_LIMIT = 500;

// ---- Queue and Concurrency State ----
const requestQueue = [];
let activeBatches = 0;
let partialBatchTimeoutId = null;
let isEmbeddingRunning = false;

// ---- Prompts (unchanged) ----
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

// ---- Utility Functions ----
function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

function generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
}

function getTodayString() {
    return new Date().toISOString().slice(0, 10);
}

function getCurrentMonthString() {
    return new Date().toISOString().slice(0, 7);
}

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

// ---- Authentication & Limits Helper ----
async function validateUserAndDecrementLimits(userId, apiKey) {
    if (!db) throw new Error('Firestore not initialized');

    const userRef = db.collection('users').doc(userId);
    const today = getTodayString();
    const thisMonth = getCurrentMonthString();

    return await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
            throw new Error('User not found');
        }

        const userData = userDoc.data();
        if (userData.apiKey !== apiKey) {
            throw new Error('Invalid API key');
        }

        // Reset daily limit if new day
        let dailyLimit = userData.dailyLimit;
        let lastRequestDate = userData.lastRequestDate || null;
        if (lastRequestDate !== today) {
            dailyLimit = DAILY_LIMIT;
            lastRequestDate = today;
        }

        // Reset monthly limit if new month
        let monthlyLimit = userData.monthlyLimit;
        let lastRequestMonth = userData.lastRequestMonth || null;
        if (lastRequestMonth !== thisMonth) {
            monthlyLimit = MONTHLY_LIMIT;
            lastRequestMonth = thisMonth;
        }

        // Check limits
        if (dailyLimit <= 0) {
            throw new Error('Daily request limit exceeded');
        }
        if (monthlyLimit <= 0) {
            throw new Error('Monthly request limit exceeded');
        }

        // Decrement limits
        const newDailyLimit = dailyLimit - 1;
        const newMonthlyLimit = monthlyLimit - 1;

        transaction.update(userRef, {
            dailyLimit: newDailyLimit,
            monthlyLimit: newMonthlyLimit,
            lastRequestDate,
            lastRequestMonth
        });

        return { userId, apiKey }; // return user info
    });
}

// ---- AI Functions (unchanged) ----
async function normalizeAndValidate(text, imageBase64) {
    // ... (same as before)
}

async function generateEmbeddingsBatch(texts) {
    // ... (same as before)
}

// ---- Firestore Watcher for Embedding (unchanged) ----
async function embedPendingQuestions() {
    // ... (same as before)
}
setInterval(embedPendingQuestions, 60 * 1000);

// ---- Queue Processing Helpers (unchanged) ----
function setupRequestTimeout(item) {
    // ... (same as before)
}

function clearRequestTimeout(item) {
    // ... (same as before)
}

async function tryStartBatch() {
    // ... (same as before)
}

async function processBatch(batch) {
    // ... (same as before, but note: the items now have userId/apiKey?
    // Actually we only need the question data, so no change needed)
}

function scheduleProcessing() {
    // ... (same as before)
}

// ---- Authentication Endpoints ----
app.post('/register', async (req, res) => {
    try {
        const { userId, password } = req.body;
        if (!userId || !password) {
            return res.status(400).json({ error: 'userId and password are required' });
        }

        if (!db) {
            return res.status(500).json({ error: 'Database not available' });
        }

        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            return res.status(409).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = generateApiKey();

        await userRef.set({
            userId,
            passwordHash: hashedPassword,
            apiKey,
            dailyLimit: DAILY_LIMIT,
            monthlyLimit: MONTHLY_LIMIT,
            lastRequestDate: null,
            lastRequestMonth: null
        });

        res.json({ userId, apiKey });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { userId, password } = req.body;
        if (!userId || !password) {
            return res.status(400).json({ error: 'userId and password are required' });
        }

        if (!db) {
            return res.status(500).json({ error: 'Database not available' });
        }

        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const userData = userDoc.data();
        const passwordMatch = await bcrypt.compare(password, userData.passwordHash);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        res.json({ userId, apiKey: userData.apiKey });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/verify', async (req, res) => {
    try {
        const { userId, apiKey } = req.body;
        if (!userId || !apiKey) {
            return res.status(400).json({ error: 'userId and apiKey are required' });
        }

        if (!db) {
            return res.status(500).json({ error: 'Database not available' });
        }

        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.json({ valid: false });
        }

        const userData = userDoc.data();
        const valid = userData.apiKey === apiKey;
        res.json({ valid });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---- Modified Search Endpoint with Authentication ----
app.post('/api/search', async (req, res) => {
    try {
        const { userId, apiKey, text, imageBase64 } = req.body;
        if (!userId || !apiKey) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Validate user and decrement limits
        await validateUserAndDecrementLimits(userId, apiKey);

        // Proceed with existing queue logic
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
        console.error("Authentication or limit error:", error.message);
        if (!res.headersSent) {
            res.status(403).json({ error: error.message });
        }
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
