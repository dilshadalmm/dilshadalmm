const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const { Pinecone } = require('@pinecone-database/pinecone');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME);

// ---- Prompts ----
const NORMALIZATION_SYSTEM_PROMPT = `You are a helpful assistant. Rewrite the question clearly without changing meaning. (Note: if an educational diagram is present, describe it as well.) Also classify if the question is a VALID academic question. Return JSON in the format: { "normalized_question": "...", "validity": "VALID or INVALID" }`;

const SOLUTION_PROMPT = `Provide a **concise, exam-oriented, structured solution** to the following question. Use LaTeX formatting for all mathematical expressions, physics formulas, and chemistry equations. Keep the explanation step-by-step, clear, and **do not exceed 2000 characters**. Do not write unnecessary long explanations.

Question:
[Normalized question]`;

// ---- Utility Functions ----

/**
 * Generate a deterministic ID based on normalized question text.
 * Format: qstu_<first 12 chars of SHA256 hash>
 */
function generateQuestionId(normalizedQuestion) {
    const hash = crypto.createHash('sha256').update(normalizedQuestion).digest('hex');
    return `qstu_${hash.slice(0, 12)}`;
}

function getMimeTypeFromBase64(base64) {
    const match = base64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
    return match ? match[1] : 'image/png';
}

async function generateEmbeddingsBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error('Cannot embed empty text array');
    }

    const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: texts,
        config: { outputDimensionality: 768 }
    });

    if (response.embeddings && response.embeddings.length === texts.length) {
        return response.embeddings.map(e => e.values);
    }

    throw new Error("No embeddings returned or mismatch in count");
}

/**
 * Retry wrapper for Gemini API calls that handles 429 rate limits.
 * @param {Function} fn - Async function that calls Gemini API.
 * @param {number} maxRetries - Maximum number of retries (default 3).
 * @param {number} baseDelay - Base delay in ms (default 1000).
 * @returns {Promise<any>}
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            // Check if it's a 429 rate limit error
            const isRateLimit = error.status === 429 || error.code === 429 || 
                (error.message && error.message.includes('429')) ||
                (error.details && error.details.some(d => d['@type']?.includes('QuotaFailure')));

            if (!isRateLimit || attempt === maxRetries) {
                break; // don't retry other errors or if out of retries
            }

            // Try to extract retry delay from error
            let delayMs = baseDelay * Math.pow(2, attempt); // exponential backoff
            if (error.details) {
                const retryInfo = error.details.find(d => d['@type']?.includes('RetryInfo'));
                if (retryInfo && retryInfo.retryDelay) {
                    // retryDelay format like "25s" or "1.5s"
                    const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
                    if (match) {
                        delayMs = parseFloat(match[1]) * 1000;
                    }
                }
            }

            console.log(`Rate limit hit, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}

// ---- Normalization with retry ----
async function normalizeQuestion(text, imageBase64) {
    try {
        const parts = [];
        if (text && text.trim()) {
            parts.push({ text: `Question: ${text}` });
        }
        if (imageBase64) {
            const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
            const mimeType = getMimeTypeFromBase64(imageBase64);
            parts.push({ inlineData: { mimeType, data: base64Data } });
        }
        if (parts.length === 0) {
            throw new Error('No input provided');
        }

        const response = await withRetry(() => ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: { parts: [{ text: NORMALIZATION_SYSTEM_PROMPT }] },
                generationConfig: { temperature: 0.2, topP: 0.95 },
                thinkingConfig: { thinkingBudget: 0 }
            }
        }));

        let textResponse = "";
        if (response?.candidates?.length > 0) {
            textResponse = response.candidates[0]?.content?.parts?.[0]?.text || "";
        }

        // Extract JSON from response
        const jsonMatch = textResponse.match(/\{.*\}/s);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.normalized_question && parsed.validity) {
                return parsed;
            }
        }
        throw new Error('Invalid JSON response from normalization');
    } catch (err) {
        console.error("Normalization failed:", err.message);
        return null;
    }
}

// ---- AI Solving with retry ----
async function solveQuestion(normalizedQuestion) {
    try {
        const prompt = SOLUTION_PROMPT.replace('[Normalized question]', normalizedQuestion);
        const response = await withRetry(() => ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                generationConfig: { temperature: 0.4, topP: 0.95, maxOutputTokens: 2000 },
                thinkingConfig: { thinkingBudget: 0 }
            }
        }));

        let solution = "";
        if (response?.candidates?.length > 0) {
            solution = response.candidates[0]?.content?.parts?.[0]?.text || "";
        }
        return solution.trim();
    } catch (err) {
        console.error("AI solve failed:", err.message);
        return null;
    }
}

// ---- Knowledge Base Storage (Pinecone only) ----
async function addToKnowledgeBase(normalizedQuestion, solution, videoUrl = '', imageUrl = '') {
    if (!normalizedQuestion || !solution) throw new Error('Missing question or solution');

    const vector = (await generateEmbeddingsBatch([normalizedQuestion]))[0];
    const id = generateQuestionId(normalizedQuestion);

    // Store all metadata in Pinecone
    await index.upsert([{
        id,
        values: vector,
        metadata: {
            question: normalizedQuestion,
            solution: solution,
            videoUrl: videoUrl || '',
            imageUrl: imageUrl || '',
            has_solution: true
        }
    }]);

    console.log(`✅ Added solved question to Pinecone: ${id}`);
    return id;
}

// ---- API Endpoint ----
app.post('/api/search', async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;

        // Step 1: Normalize and validate
        const normResult = await normalizeQuestion(text, imageBase64);
        if (!normResult) {
            return res.status(500).json({ error: "Normalization failed" });
        }
        if (normResult.validity !== "VALID") {
            return res.status(400).json({ error: "Invalid academic question" });
        }
        const normalizedQuestion = normResult.normalized_question;

        // Step 2: Generate embedding
        const vector = (await generateEmbeddingsBatch([normalizedQuestion]))[0];

        // Step 3: Query Pinecone for solved questions only, include metadata
        const queryResponse = await index.query({
            vector,
            topK: 3,
            includeMetadata: true,
            filter: { has_solution: true }
        });

        // Step 4: Find best match with score >= 0.85
        let bestMatch = null;
        if (queryResponse.matches && queryResponse.matches.length > 0) {
            const sorted = queryResponse.matches.sort((a, b) => b.score - a.score);
            bestMatch = sorted.find(m => m.score >= 0.85);
        }

        if (bestMatch && bestMatch.metadata && bestMatch.metadata.solution) {
            // Return full metadata from Pinecone
            return res.json({
                question: bestMatch.metadata.question || normalizedQuestion,
                solution: bestMatch.metadata.solution,
                videoUrl: bestMatch.metadata.videoUrl || '',
                imageUrl: bestMatch.metadata.imageUrl || ''
            });
        }

        // Step 5: No good match – solve with AI
        const solution = await solveQuestion(normalizedQuestion);
        if (!solution) {
            return res.status(500).json({ error: "AI solving failed" });
        }

        // Step 6: Store in knowledge base (Pinecone)
        await addToKnowledgeBase(normalizedQuestion, solution);

        // Step 7: Return metadata
        return res.json({
            question: normalizedQuestion,
            solution: solution,
            videoUrl: '',
            imageUrl: ''
        });

    } catch (error) {
        console.error("Critical Backend Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Health check
app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
