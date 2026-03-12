const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const multer = require("multer");
const Tesseract = require("tesseract.js");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

const upload = multer({
    dest: "uploads/"
});


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

    } else {

        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');

    }

} catch (err) {

    console.error('Failed to initialize Firebase Admin:', err.message);

}

const db = firebaseInitialized ? admin.firestore() : null;


// Initialize Gemini
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});


// Initialize Pinecone
const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

const index = pc.index(process.env.PINECONE_INDEX_NAME);



/**
 * Generate embedding
 */
async function generateEmbedding(text) {

    if (!text || text.trim() === '') {
        throw new Error('Cannot embed empty text');
    }

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [text],
        config: {
            outputDimensionality: 768
        }
    });

    if (response.embeddings && response.embeddings.length > 0) {
        return response.embeddings[0].values;
    }

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
 * Run OCR using Tesseract
 */
async function runTesseractOCR(imagePath) {

    try {

        const result = await Tesseract.recognize(
            imagePath,
            "eng"
        );

        return result.data.text || "";

    } catch (error) {

        console.error("OCR extraction failed:", error.message);
        return "";

    }

}



/**
 * Add new question
 */
async function addNewQuestion(queryText, extractedText = '') {

    const fullText = [queryText, extractedText]
        .filter(Boolean)
        .join(' ')
        .trim();

    if (!fullText) throw new Error('No text to add');

    const vector = await generateEmbedding(fullText);

    const newId = generateQuestionId();


    await index.upsert([{
        id: newId,
        values: vector
    }]);


    if (db) {

        await db.collection('questions').doc(newId).set({

            question: fullText,
            comment: "Thank you for your question. Our team will provide an answer soon.",
            videoUrl: "",
            imageUrl: "",
            createdAt: admin.firestore.FieldValue.serverTimestamp()

        });

        console.log(`✅ Added new question to Firestore: ${newId}`);

    }


    return newId;

}



/**
 * SEARCH API
 */
app.post('/api/search', upload.single("image"), async (req, res) => {

    try {

        const { text } = req.body;

        let finalQueryText = text || "";
        let extractedText = "";


        if (req.file) {

            extractedText = await runTesseractOCR(req.file.path);

            fs.unlink(req.file.path, () => {});

            if (extractedText.trim()) {
                finalQueryText += " " + extractedText;
            }

            console.log("OCR extraction completed.");

        }


        if (!finalQueryText || finalQueryText.trim() === '') {

            return res.json([{ id: "#0000" }]);

        }


        const vector = await generateEmbedding(finalQueryText);


        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });


        if (

            queryResponse.matches &&
            queryResponse.matches.length > 0 &&
            queryResponse.matches[0].score > 0.6

        ) {

            const matchId = queryResponse.matches[0].id;

            console.log(`✅ Found match: ${matchId}`);

            return res.json([{ id: matchId }]);

        }


        console.log("No match found, adding new question...");

        const newId = await addNewQuestion(text || "", extractedText);

        return res.json([{ id: newId }]);

    }

    catch (error) {

        console.error("Critical Backend Error:", error);

        res.json([{ id: "#0000" }]);

    }

});



app.get('/health', (req, res) => res.send('Active'));



app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
