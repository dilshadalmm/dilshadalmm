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
app.use(express.static(path.join(__dirname, '/')));

// Clients Initialization
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

// Search Endpoint
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;

        const model = genAI.getGenerativeModel({ model: "gemini-embedding-2-preview" });
        const parts = [];

        if (text) parts.push({ text });
        if (imageBase64) {
            // Ensure we have raw base64 data
            const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            parts.push({ inlineData: { mimeType: "image/png", data: cleanBase64 } });
        }

        // 1. Generate Multimodal Vector
        const result = await model.embedContent({ content: { parts } });
        const vector = result.embedding.values;

        // 2. Query Pinecone for top match
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        if (queryResponse.matches && queryResponse.matches.length > 0) {
            res.json({ success: true, questionId: queryResponse.matches[0].id });
        } else {
            res.status(404).json({ success: false, message: "No match found" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => console.log(`Backend live on port ${PORT}`));
