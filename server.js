const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/genai"); // Note: Standard package name is @google/generative-ai
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
// Note: Using the standard GoogleGenerativeAI class
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * Generate embedding using text-embedding-004 (Updated to 768 dimensions)
 */
async function generateEmbedding(text) {
    if (!text || text.trim() === '') throw new Error('Cannot embed empty text');

    // Using text-embedding-004 which supports the 768 dimension output
    const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
    
    const result = await model.embedContent({
        content: { parts: [{ text }] },
        outputDimensionality: 768
    });

    const embedding = result.embedding;
    if (embedding && embedding.values) return embedding.values;
    throw new Error("No embeddings returned");
}

/**
 * Generate unique question ID
 */
function generateQuestionId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `user-${timestamp}-${random}`;
}

/**
 * Extract academic content using gemini-flash-lite-latest
 * @param {string} base64Image - raw base64 string
 */
async function describeImage(base64Image) {
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-flash-lite-latest",
            systemInstruction: `
You are an OCR academic parser.

STRICT RULES:
1. Extract ONLY the question exactly as written in the image.
2. DO NOT solve the question.
3. DO NOT explain anything.
4. DO NOT show steps, formulas, or answers.
5. DO NOT add extra text.
6. Use LaTeX ($...$) for mathematical expressions.

OUTPUT FORMAT ONLY:

Question: [Exact question text]

Diagram: [Only labels, values, symbols]

Options:
A. ...
B. ...
C. ...
D. ...

If no academic question is visible, return exactly:
No academic content detected.
`
        });

        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: 'image/png',
                    data: base64Image
                }
            }
        ]);

        return result.response.text() || "";
    } catch (error) {
        console.error("Image description failed:", error.message);
        return "";
    }
}

/**
 * Add new question to Pinecone + Firestore
 */
async function addNewQuestion(queryText, extractedText = '') {
    const fullText = [queryText, extractedText].filter(Boolean).join(' ').trim();
    if (!fullText) throw new Error('No text to add');

    const vector = await generateEmbedding(fullText);
    const newId = generateQuestionId();

    // Ensure your Pinecone Index is configured for 768 dimensions
    await index.upsert([{ id: newId, values: vector }]);

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
    }

    return newId;
}

/**
 * Watcher: auto-embed pending questions
 */
async function embedPendingQuestions() {
    if (!db) return;
    try {
        const snapshot = await db.collection("questions")
            .where("embedded", "==", false)
            .limit(50)
            .get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (!data.question) continue;

            try {
                const vector = await generateEmbedding(data.question);
                await index.upsert([{ id: doc.id, values: vector }]);
                await doc.ref.update({ embedded: true });
                console.log(`✅ Auto-embedded question: ${doc.id}`);
            } catch (err) {
                console.error(`Failed embedding question ${doc.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error("Error fetching pending questions:", err.message);
    }
}

setInterval(embedPendingQuestions, 60 * 1000);

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";
        let extractedText = "";

        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            extractedText = await describeImage(base64Data);
            if (extractedText.trim()) finalQueryText += " " + extractedText;
        }

        if (!finalQueryText.trim()) return res.json([{ id: "#0000" }]);

        const vector = await generateEmbedding(finalQueryText);
        const queryResponse = await index.query({ vector, topK: 1, includeMetadata: false });

        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            return res.json([{ id: queryResponse.matches[0].id }]);
        }

        const newId = await addNewQuestion(text || "", extractedText);
        return res.json([{ id: newId }]);

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.status(500).json([{ id: "#0000", error: "Internal Server Error" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT} with 768-dim embeddings`));
