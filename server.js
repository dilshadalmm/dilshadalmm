app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        
        // 1. Setup Models (Using the most stable names)
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        let finalQueryText = text || "";

        // 2. Multimodal Bridge (Image -> Text)
        if (imageBase64) {
            try {
                const visionModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
                const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                
                const visionResult = await visionModel.generateContent([
                    "Describe this educational image briefly for a search query:",
                    { inlineData: { mimeType: "image/png", data: cleanBase64 } }
                ]);
                finalQueryText += " " + visionResult.response.text();
            } catch (vErr) {
                console.error("Vision failed, falling back to text only.");
            }
        }

        // 3. Generate Vector (768 dimensions)
        const result = await embedModel.embedContent(finalQueryText);
        const vector = result.embedding.values;

        // 4. Pinecone Search
        const queryResponse = await index.query({
            vector: vector,
            topK: 1,
            includeMetadata: false
        });

        // 5. Success Check
        if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].score > 0.7) {
            res.json({ success: true, questionId: queryResponse.matches[0].id });
        } else {
            // No high-confidence match found
            res.json({ success: true, questionId: "#0000" });
        }

    } catch (error) {
        console.error("System Error:", error.message);
        // On any system crash, trigger the fallback UI
        res.json({ success: true, questionId: "#0000" });
    }
});
