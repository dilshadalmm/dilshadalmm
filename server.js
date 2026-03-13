// ... (Keep your imports: Express, Firebase, Pinecone, GoogleGenAI, Tesseract, etc.)

// 1. SURGE PROTECTION: OCR Worker Pool
const scheduler = Tesseract.createScheduler();
(async () => {
    // Creates 4 parallel OCR lanes. 10k images will now wait in an orderly line.
    for (let i = 0; i < 4; i++) {
        const worker = await Tesseract.createWorker('eng');
        scheduler.addWorker(worker);
    }
    console.log("🚀 OCR Workers Online");
})();

/**
 * BATCH EMBEDDING (The Surge Killer)
 * Sends 250 questions to Google in ONE network trip.
 */
async function generateEmbeddingsBatch(textList) {
    if (!textList.length) return [];
    // Using gemini-embedding-001 or gemini-embedding-2-preview
    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: textList, // Passing the whole array here!
        config: { outputDimensionality: 768 }
    });
    return response.embeddings.map(e => e.values);
}

/**
 * BACKGROUND WATCHER: Sweeps 1,000 pending questions every 15 seconds
 */
async function embedPendingQuestions() {
    if (!db) return;
    const snapshot = await db.collection("questions")
        .where("embedded", "==", false).limit(1000).get();

    if (snapshot.empty) return;

    const docs = snapshot.docs;
    // Process in blocks of 250 (Google's Max Limit per call)
    for (let i = 0; i < docs.length; i += 250) {
        const chunk = docs.slice(i, i + 250);
        const texts = chunk.map(d => d.data().question);
        
        try {
            const vectors = await generateEmbeddingsBatch(texts);
            const firestoreBatch = db.batch();

            const upsertData = vectors.map((v, idx) => {
                firestoreBatch.update(chunk[idx].ref, { embedded: true });
                return { id: chunk[idx].id, values: v, metadata: { text: texts[idx] } };
            });

            await index.upsert(upsertData); // Push to Pinecone
            await firestoreBatch.commit(); // Mark as done in Firebase
            console.log(`✅ Surge Update: Processed ${chunk.length} items`);
        } catch (err) { console.error("Batch Error:", err.message); }
    }
}
setInterval(embedPendingQuestions, 15000);

/**
 * MAIN SEARCH API
 */
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        let queryText = text || "";

        // OCR handled by the Scheduler Queue
        if (imageBase64) {
            const base64Data = imageBase64.split(',')[1] || imageBase64;
            const tempPath = `./uploads/img_${Date.now()}.png`;
            fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
            
            const { data } = await scheduler.addJob('recognize', tempPath);
            queryText += " " + (data.text || "");
            fs.unlink(tempPath, () => {});
        }

        if (!queryText.trim()) return res.json([{ id: "#0000" }]);

        // REAL-TIME SEARCH (Fast Path)
        // We still embed the single query text to see if an answer already exists
        const vector = await generateEmbedding(queryText); 
        const results = await index.query({ vector, topK: 1 });

        if (results.matches?.[0]?.score > 0.7) {
            return res.json([{ id: results.matches[0].id }]);
        }

        // NEW QUESTION (Surge Path)
        // If not found, save to Firestore and return ID immediately.
        // The background watcher will embed it within 15 seconds.
        const newId = generateQuestionId();
        await db.collection('questions').doc(newId).set({
            question: queryText,
            embedded: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json([{ id: newId }]);
    } catch (e) {
        console.error(e);
        res.json([{ id: "#0000" }]);
    }
});
