const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require('@pinecone-database/pinecone');

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
        
        // Use stable model names
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        let finalQueryText = text || "";

        if (imageBase64) {
            try {
                const visionModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
                const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                
                const visionResult = await visionModel.generateContent([
                    "Describe this math/educational image briefly for search:",
                    { inlineData: { mimeType: "image/png", data: cleanBase64 } }
                ]);
                finalQueryText += " " + visionResult.response.text();
            } catch (vErr) {
                console.error("Vision sub-process failed:", vErr.message);
            }
        }

        // Generate Vector
        const result = await embedModel.embedContent(finalQueryText);
        const vector = result.embedding.values;

        // Query Pinecone
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        // Response Logic
        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            res.json({ success: true, questionId: queryResponse.matches[0].id });
        } else {
            res.json({ success: true, questionId: "#0000" });
        }

    } catch (error) {
        console.error("Global Backend Error:", error);
        res.json({ success: true, questionId: "#0000" });
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
