const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai"); // New unified client
const { Pinecone } = require('@pinecone-database/pinecone');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize new Google Gen AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Pinecone setup
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

/**
 * Generate embedding using the new API.
 * Tries multiple model names if needed, and requests 768‑dim output.
 */
async function generateEmbedding(text) {
    const possibleModels = [
        'gemini-embedding-001',   // current recommended embedding model
        'embedding-001'           // fallback (older name)
    ];

    for (const modelName of possibleModels) {
        try {
            const response = await ai.models.embedContent({
                model: modelName,
                contents: [text],
                config: {
                    outputDimensionality: 768   // match your Pinecone index
                }
            });
            // response.embeddings is an array of embedding objects
            if (response.embeddings && response.embeddings.length > 0) {
                console.log(`✅ Embedding succeeded with model: ${modelName}`);
                return response.embeddings[0].values; // the vector
            }
        } catch (err) {
            console.warn(`⚠️ Model ${modelName} failed:`, err.message);
        }
    }
    throw new Error("All embedding models failed.");
}

app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let finalQueryText = text || "";

        // 1. Vision extraction (if image provided)
        if (imageBase64) {
            try {
                const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                const visionResponse = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [{
                        role: 'user',
                        parts: [
                            { text: "Extract all text and any mathematical expressions from this image for a search query. Return only the extracted content." },
                            { inlineData: { mimeType: 'image/png', data: cleanBase64 } }
                        ]
                    }]
                });
                const extractedText = visionResponse.text;
                if (extractedText) {
                    finalQueryText += " " + extractedText;
                }
                console.log("Vision extraction successful.");
            } catch (vErr) {
                console.error("Vision failed, using text only:", vErr.message);
            }
        }

        // 2. Generate embedding
        const vector = await generateEmbedding(finalQueryText);

        // 3. Query Pinecone
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        // 4. Return the top match ID
        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.6) {
            res.json([{ id: queryResponse.matches[0].id }]);
        } else {
            res.json([{ id: "#0000" }]); // fallback
        }

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.json([{ id: "#0000" }]);
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
