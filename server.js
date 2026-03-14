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
const OCR_SYSTEM_PROMPT =   Just let me no what is the questions in the image and if any diagram is present then also let me know what is the diagram saying.   Don't explain and don't provide the solution.  ;

/**

Generate embedding
*/
async function generateEmbedding(text) {
if (!text || text.trim() === '') throw new Error('Cannot embed empty text');

const response = await ai.models.embedContent({
model: 'gemini-embedding-001',
contents: [text],
config: { outputDimensionality: 768 }
});

if (response.embeddings && response.embeddings.length > 0) return response.embeddings[0].values;
throw new Error("No embeddings returned");
}


/**

Generate unique question ID
*/
function generateQuestionId() {
const timestamp = Date.now();
const random = crypto.randomBytes(4).toString('hex');
return user-${timestamp}-${random};
}


/**

Run OCR using Gemini 2.5 Flash Lite
*/
async function runGeminiOCR(imageBase64) {
try {
// Remove data URL prefix if present
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
         generationConfig: {  
             temperature: 0.6,  
             topP: 0.95  
         },  
         thinkingConfig: { thinkingBudget: 0 }  
     }  
 });  

 // Extract full response text (do NOT discard diagram/options)  
 let fullText = "";  
 if (response && response.candidates && response.candidates.length > 0) {  
     const candidate = response.candidates[0];  
     if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {  
         fullText = candidate.content.parts[0].text || "";  
     }  
 }  

 return fullText.trim();

} catch (error) {
console.error("Gemini OCR extraction failed:", error.message);
return "";
}
}


/**

Add new question to Pinecone + Firestore
*/
async function addNewQuestion(queryText, extractedText = '') {
const fullText = extractedText || queryText;
if (!fullText) throw new Error('No text to add');

const vector = await generateEmbedding(fullText);
const newId = generateQuestionId();

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
console.log(✅ Added new question to Firestore: ${newId});
} else {
console.log(⚠️ Firestore not available. ID: ${newId});
}

return newId;
}


/**

Watcher: auto-embed pending questions in Firestore
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

         await index.upsert([{ id: doc.id, values: vector, metadata: { text: data.question } }]);  

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


// Run watcher every 1 minute
setInterval(embedPendingQuestions, 60 * 1000);

/**

Main API: text + imageBase64 input
*/
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

 const vector = await generateEmbedding(finalQueryText);  
 const queryResponse = await index.query({ vector, topK: 1, includeMetadata: false });  

 if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {  
     return res.json([{ id: queryResponse.matches[0].id }]);  
 }  

 const newId = await addNewQuestion(text || "", extractedText);  
 return res.json([{ id: newId }]);

} catch (error) {
console.error("Critical Backend Error:", error);
res.json([{ id: "#0000" }]);
}
});


app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(Server running on port ${PORT}));
