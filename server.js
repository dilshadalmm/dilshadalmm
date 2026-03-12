const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require('@pinecone-database/pinecone');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";

        // 1. If image is provided, use vision model to extract text
        if (imageBase64) {
            try {
                const visionModel = genAI.getGenerativeModel({ model: "models/gemini-1.5-flash" });
                const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                
                const visionResult = await visionModel.generateContent([
                    "Extract text and math from this image for a search query:",
                    { inlineData: { mimeType: "image/png", data: cleanBase64 } }
                ]);
                finalQueryText += " " + visionResult.response.text();
            } catch (vErr) {
                console.error("Vision failed, using text only:", vErr.message);
            }
        }

        // 2. Generate embedding vector (768-dim)
        const embedModel = genAI.getGenerativeModel({ model: "models/embedding-001" });
        const result = await embedModel.embedContent(finalQueryText);
        const vector = result.embedding.values;

        // 3. Query Pinecone
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        // 4. Return the top match ID (frontend expects an array with { id } )
        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            res.json([{ id: queryResponse.matches[0].id }]);
        } else {
            // Fallback – make sure a document with id "#0000" exists in Firestore
            res.json([{ id: "#0000" }]);
        }

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
