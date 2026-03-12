// server.js
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require('@pinecone-database/pinecone');
// Load environment variables from a .env file for local development
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";

        // 1. If image is provided, use a current vision model to extract text
        if (imageBase64) {
            try {
                // Use Gemini 2.5 Flash - a current, fast, and capable model
                const visionModel = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash" });
                const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                
                const visionResult = await visionModel.generateContent([
                    "Extract all text and any mathematical expressions from this image for a search query. Return only the extracted content.",
                    { inlineData: { mimeType: "image/png", data: cleanBase64 } }
                ]);
                const extractedText = visionResult.response.text();
                if (extractedText) {
                    finalQueryText += " " + extractedText;
                }
                console.log("Vision extraction successful. Combined query:", finalQueryText);
            } catch (vErr) {
                console.error("Vision failed, using text only:", vErr.message);
            }
        }

        // 2. Generate embedding vector using the latest Gemini Embedding 2 model
        //    This model supports flexible dimensions. We request 768 to match your Pinecone index.
        const embedModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-2" });
        const result = await embedModel.embedContent({
            content: { parts: [{ text: finalQueryText }] },
            // Request 768-dimension output. This is optional but recommended for performance/cost balance.
            // If omitted, the default is 3072.
            outputDimensionality: 768 
        });
        // The embedding is in result.embedding.values
        const vector = result.embedding.values;

        // 3. Query Pinecone
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false // You only need the ID
        });

        // 4. Return the top match ID (frontend expects an array with { id } )
        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            res.json([{ id: queryResponse.matches[0].id }]);
        } else {
            // Fallback – ensure a document with id "#0000" exists in your Firestore 'questions' collection
            console.log("No match with sufficient score, returning fallback ID.");
            res.json([{ id: "#0000" }]);
        }

    } catch (error) {
        console.error("Critical Backend Error:", error);
        // Fallback for server error
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
