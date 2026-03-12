const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Pinecone
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

const index = pc.index(process.env.PINECONE_INDEX_NAME);

// --------------------------------------------
// SEARCH API
// --------------------------------------------
app.post('/api/search', async (req, res) => {
  try {
    const { text, imageBase64 } = req.body;

    if (!text && !imageBase64) {
      return res.status(400).json({
        success: false,
        message: "No text or image provided"
      });
    }

    let finalQueryText = text || "";

    // --------------------------------------------
    // IMAGE → TEXT (Gemini Vision)
    // --------------------------------------------
    if (imageBase64) {
      const visionModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash"
      });

      const cleanBase64 = imageBase64.includes(',')
        ? imageBase64.split(',')[1]
        : imageBase64;

      const visionResult = await visionModel.generateContent([
        "Extract all text, math equations, and describing features from this image for a search query.",
        {
          inlineData: {
            mimeType: "image/png",
            data: cleanBase64
          }
        }
      ]);

      const imageText = visionResult.response.text();
      finalQueryText = finalQueryText + " " + imageText;
    }

    // --------------------------------------------
    // TEXT → VECTOR (Embedding)
    // --------------------------------------------
    const embedModel = genAI.getGenerativeModel({
      model: "text-embedding-004"
    });

    const embedResult = await embedModel.embedContent({
      content: {
        parts: [{ text: finalQueryText }]
      }
    });

    const vector = embedResult.embedding.values;

    // --------------------------------------------
    // VECTOR SEARCH (Pinecone)
    // --------------------------------------------
    const queryResponse = await index.query({
      vector: vector,
      topK: 5,
      includeMetadata: false
    });

    if (!queryResponse.matches || queryResponse.matches.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No similar question found"
      });
    }

    // Return best match
    const bestMatch = queryResponse.matches[0];

    res.json({
      success: true,
      questionId: bestMatch.id
    });

  } catch (error) {
    console.error("Backend Error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------
// START SERVER
// --------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
