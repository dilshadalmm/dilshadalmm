const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require('@pinecone-database/pinecone');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        let finalQueryText = text || "";

        // 1. If student sent an image, convert image to text description first
        if (imageBase64) {
            const visionModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            
            const visionResult = await visionModel.generateContent([
                "Extract all text, math equations, and describing features from this image for a search query:",
                { inlineData: { mimeType: "image/png", data: cleanBase64 } }
            ]);
            finalQueryText += " " + visionResult.response.text();
        }

        // 2. CONVERT THE DESCRIPTION INTO A VECTOR (768 dimensions)
        const result = await embedModel.embedContent(finalQueryText);
        const vector = result.embedding.values;

        // 3. SEARCH PINECONE USING THE VECTOR
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        if (queryResponse.matches && queryResponse.matches.length > 0) {
            res.json({ 
                success: true, 
                questionId: queryResponse.matches[0].id 
            });
        } else {
            res.status(404).json({ success: false, message: "No match found" });
        }
    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
