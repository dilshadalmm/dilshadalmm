const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Initialize Firebase Admin
let firebaseInitialized = false;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin initialized');
    } else console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
} catch (err) {
    console.error('Failed to initialize Firebase Admin:', err.message);
}
const db = firebaseInitialized ? admin.firestore() : null;

// ---- Configuration Constants ----
const BATCH_SIZE = 20;                    // Number of requests per batch
const MAX_CONCURRENT_BATCHES = 5;         // Maximum parallel batch workers
const MAX_WAIT_MS = 100;                  // Time to wait before processing a partial batch
const RESPONSE_TIMEOUT_MS = 60000;        // Increased to 60 seconds for large batches

// ---- Queue and Concurrency State ----
const requestQueue = [];                  // { res, questions, class, subject, chapter, timeout, sent }
let activeBatches = 0;                    // Number of currently processing batches
let partialBatchTimeoutId = null;         // Timeout ID for partial batch

// ---- Utility Functions ----

function generateQuestionId(classKey, subjectKey, sequenceNumber) {
    // Format: CLASS_10_ZOOLOGY_q1, IOE_MATHMATICS_q1, LOKSEWA_GK_q1, etc.
    return `${classKey}_${subjectKey}_q${sequenceNumber}`;
}

/**
 * Get the next 'count' sequence numbers for a given class/subject.
 * Uses a single transaction to atomically increment the counter.
 * @param {string} classKey e.g., "CLASS_10"
 * @param {string} subjectKey e.g., "ZOOLOGY"
 * @param {number} count Number of sequence numbers to reserve
 * @returns {Promise<number[]>} Array of numbers [start, start+1, ..., start+count-1]
 */
async function getNextQuestionNumbers(classKey, subjectKey, count) {
    if (!db) throw new Error('Firestore not initialized');
    if (count <= 0) return [];

    const counterId = `${classKey}_${subjectKey}`;
    const counterRef = db.collection('counters').doc(counterId);

    return await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(counterRef);
        let current = 1;
        if (doc.exists) {
            current = doc.data().currentNumber + 1;
        }
        const nextNumbers = [];
        for (let i = 0; i < count; i++) {
            nextNumbers.push(current + i);
        }
        transaction.set(counterRef, { currentNumber: current + count - 1 }, { merge: true });
        return nextNumbers;
    });
}

/**
 * Helper to split an array of Firestore writes into batches of 500.
 * @param {Array<{docRef: FirebaseFirestore.DocumentReference, data: object}>} writes
 */
async function commitBatchWrites(writes) {
    if (!writes.length) return;
    const chunkSize = 500;
    for (let i = 0; i < writes.length; i += chunkSize) {
        const chunk = writes.slice(i, i + chunkSize);
        const batch = db.batch();
        for (const { docRef, data } of chunk) {
            batch.set(docRef, data);
        }
        await batch.commit();
    }
}

// ---- Queue Processing Helpers ----

function setupRequestTimeout(item) {
    item.timeout = setTimeout(() => {
        if (!item.sent) {
            item.sent = true;
            item.res.json({
                status: 'error',
                message: 'Request took too long. Please try again.',
                questionsProcessed: 0
            });
            console.log('⏰ Request timeout');
        }
    }, RESPONSE_TIMEOUT_MS);
}

function clearRequestTimeout(item) {
    if (item.timeout) {
        clearTimeout(item.timeout);
        item.timeout = null;
    }
}

async function tryStartBatch() {
    if (activeBatches >= MAX_CONCURRENT_BATCHES || requestQueue.length === 0) return;

    const batchSize = Math.min(BATCH_SIZE, requestQueue.length);
    const batch = requestQueue.splice(0, batchSize);

    activeBatches++;
    try {
        await processBatch(batch);
    } catch (err) {
        console.error('Unexpected error in batch processing:', err);
        batch.forEach(item => {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    status: 'error',
                    message: 'An internal error occurred.',
                    questionsProcessed: 0
                });
            }
        });
    } finally {
        activeBatches--;
        scheduleProcessing();
    }
}

/**
 * Process a batch of ingestion requests.
 * For each item, directly save the provided questions to Firestore.
 * Uses a single counter transaction per request to reserve all needed IDs,
 * then commits the questions in chunks of 500.
 * @param {Array} batch Array of request objects
 */
async function processBatch(batch) {
    for (const item of batch) {
        const { questions, class: className, subject, chapter } = item;

        // Validate that questions is an array and not empty
        if (!Array.isArray(questions) || questions.length === 0) {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    status: 'success',
                    message: 'No questions provided.',
                    questionsProcessed: 0
                });
            }
            continue;
        }

        // Filter valid questions
        const validQuestions = questions.filter(q =>
            q.questionText &&
            Array.isArray(q.options) && q.options.length === 4 &&
            typeof q.correctIndex === 'number' &&
            q.solutionText
        );

        if (validQuestions.length === 0) {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    status: 'success',
                    message: 'No valid questions provided.',
                    questionsProcessed: 0
                });
            }
            continue;
        }

        // Generate sanitized keys for Firestore
        const classKey = className.trim().toUpperCase().replace(/\s+/g, '_');
        const subjectKey = subject.trim().toUpperCase().replace(/\s+/g, '_');

        try {
            // Reserve sequence numbers in one transaction
            const seqNumbers = await getNextQuestionNumbers(classKey, subjectKey, validQuestions.length);

            // Build all write operations
            const writes = [];
            const savedQuestionIds = [];

            for (let i = 0; i < validQuestions.length; i++) {
                const q = validQuestions[i];
                const seqNumber = seqNumbers[i];
                const questionId = generateQuestionId(classKey, subjectKey, seqNumber);

                const questionDoc = {
                    questionId,
                    questionText: q.questionText,
                    options: q.options,
                    correctIndex: q.correctIndex,
                    solutionText: q.solutionText,
                    questionImageUrl: q.questionImageUrl || null,
                    solutionVideoUrl: q.solutionVideoUrl || null,
                    solutionImageUrl: q.solutionImageUrl || null,
                    class: className,
                    subject: subject,
                    chapter: chapter,
                    embedded: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                };

                const docRef = db.collection('questions').doc(questionId);
                writes.push({ docRef, data: questionDoc });
                savedQuestionIds.push(questionId);
            }

            // Commit writes in batches of 500
            await commitBatchWrites(writes);
            console.log(`✅ Saved ${savedQuestionIds.length} questions for item`);

            // Respond to the client
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    status: 'success',
                    message: `Processed ${savedQuestionIds.length} questions.`,
                    questionsProcessed: savedQuestionIds.length
                });
            }
        } catch (err) {
            console.error(`Failed to process item: ${err.message}`);
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    status: 'error',
                    message: `Database operation failed: ${err.message}`,
                    questionsProcessed: 0
                });
            }
        }
    }
}

function scheduleProcessing() {
    while (activeBatches < MAX_CONCURRENT_BATCHES && requestQueue.length >= BATCH_SIZE) {
        tryStartBatch();
    }

    if (requestQueue.length > 0 && requestQueue.length < BATCH_SIZE) {
        if (!partialBatchTimeoutId) {
            partialBatchTimeoutId = setTimeout(() => {
                partialBatchTimeoutId = null;
                tryStartBatch();
            }, MAX_WAIT_MS);
        }
    } else {
        if (partialBatchTimeoutId) {
            clearTimeout(partialBatchTimeoutId);
            partialBatchTimeoutId = null;
        }
    }
}

// ---- API Endpoint ----

app.post('/api/ingest', async (req, res) => {
    try {
        const { questions, class: className, subject, chapter } = req.body;

        if (!questions || !Array.isArray(questions)) {
            return res.status(400).json({
                status: 'error',
                message: 'questions array is required'
            });
        }
        if (!className || !subject || !chapter) {
            return res.status(400).json({
                status: 'error',
                message: 'class, subject, and chapter are required'
            });
        }

        const item = {
            res,
            questions,
            class: className,
            subject,
            chapter,
            sent: false,
            timeout: null
        };
        setupRequestTimeout(item);

        requestQueue.push(item);
        scheduleProcessing();

    } catch (error) {
        console.error("Critical Backend Error:", error);
        if (!res.headersSent) {
            res.status(500).json({
                status: 'error',
                message: 'A critical error occurred.',
                questionsProcessed: 0
            });
        }
    }
});

/**
 * GET /api/quiz
 * Query parameters:
 *   - className (required) : e.g., "Class 10"
 *   - subject   (required) : e.g., "Zoology"
 *   - chapter   (required) : e.g., "Matter in Our Surroundings"
 *   - limit     (optional) : number of questions to return (default = 10)
 *
 * Returns a JSON object:
 *   {
 *     success: true,
 *     questions: [
 *       {
 *         questionText,
 *         options,
 *         solutionText,
 *         correctIndex,
 *         solutionVideoUrl,
 *         questionImageUrl,
 *         solutionImageUrl
 *       },
 *       ...
 *     ]
 *   }
 *
 * If no questions match, returns 404 with { success: false, error: "No questions found for the given criteria" }
 */
app.get('/api/quiz', async (req, res) => {
    try {
        // 1. Extract and validate query parameters
        const { className, subject, chapter, limit: limitParam } = req.query;

        if (!className || !subject || !chapter) {
            return res.status(400).json({
                success: false,
                error: 'Missing required query parameters: className, subject, chapter'
            });
        }

        // Parse limit – default to 10, ensure it's a positive integer
        let limit = 10;
        if (limitParam) {
            const parsed = parseInt(limitParam, 10);
            if (!isNaN(parsed) && parsed > 0) {
                limit = parsed;
            } else {
                return res.status(400).json({
                    success: false,
                    error: 'limit must be a positive integer'
                });
            }
        }

        // 2. Ensure Firestore is available
        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        // 3. Build and execute the Firestore query
        const questionsRef = db.collection('questions');
        const snapshot = await questionsRef
            .where('class', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter)
            .get();

        // 4. Check if any documents were found
        if (snapshot.empty) {
            return res.status(404).json({
                success: false,
                error: 'No questions found for the given criteria'
            });
        }

        // 5. Extract document data into an array
        let questions = snapshot.docs.map(doc => doc.data());

        // 6. Shuffle using Fisher‑Yates (in‑place)
        for (let i = questions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [questions[i], questions[j]] = [questions[j], questions[i]];
        }

        // 7. Apply limit (slice after shuffle)
        const limitedQuestions = questions.slice(0, limit);

        // 8. Map to the required response schema
        const formattedQuestions = limitedQuestions.map(q => ({
            questionText: q.questionText,
            options: q.options,
            solutionText: q.solutionText,
            correctIndex: q.correctIndex,
            solutionVideoUrl: q.solutionVideoUrl || null,
            questionImageUrl: q.questionImageUrl || null,
            solutionImageUrl: q.solutionImageUrl || null
        }));

        // 9. Send success response
        return res.json({
            success: true,
            questions: formattedQuestions
        });

    } catch (error) {
        console.error('Error in /api/quiz:', error);
        return res.status(500).json({
            success: false,
            error: 'An internal server error occurred'
        });
    }
});

// ---- Dynamic Metadata Endpoints ----

// Cache for metadata to reduce Firestore reads (optional, but efficient)
let metadataCache = {
    classes: null,
    subjectsByClass: {},
    chaptersByClassAndSubject: {},
    lastFetch: 0
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Helper to refresh metadata cache if stale.
 */
async function refreshMetadataCache() {
    if (!db) return;
    const now = Date.now();
    if (metadataCache.lastFetch && (now - metadataCache.lastFetch < CACHE_TTL_MS)) {
        return;
    }
    console.log('Refreshing metadata cache...');
    // Fetch all question documents (only needed fields)
    const snapshot = await db.collection('questions').select('class', 'subject', 'chapter').get();
    const classesSet = new Set();
    const subjectsMap = new Map(); // class -> Set of subjects
    const chaptersMap = new Map(); // `${class}|${subject}` -> Set of chapters

    snapshot.forEach(doc => {
        const data = doc.data();
        const className = data.class;
        const subject = data.subject;
        const chapter = data.chapter;

        if (className) classesSet.add(className);
        if (className && subject) {
            if (!subjectsMap.has(className)) subjectsMap.set(className, new Set());
            subjectsMap.get(className).add(subject);
        }
        if (className && subject && chapter) {
            const key = `${className}|${subject}`;
            if (!chaptersMap.has(key)) chaptersMap.set(key, new Set());
            chaptersMap.get(key).add(chapter);
        }
    });

    metadataCache = {
        classes: Array.from(classesSet).sort(),
        subjectsByClass: Object.fromEntries(
            Array.from(subjectsMap.entries()).map(([c, s]) => [c, Array.from(s).sort()])
        ),
        chaptersByClassAndSubject: Object.fromEntries(
            Array.from(chaptersMap.entries()).map(([key, ch]) => [key, Array.from(ch).sort()])
        ),
        lastFetch: Date.now()
    };
}

/**
 * GET /api/classes
 * Returns list of all distinct class values.
 */
app.get('/api/classes', async (req, res) => {
    try {
        if (!db) throw new Error('Firestore not initialized');
        await refreshMetadataCache();
        res.json({ success: true, classes: metadataCache.classes });
    } catch (error) {
        console.error('Error fetching classes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch classes' });
    }
});

/**
 * GET /api/subjects?class=<className>
 * Returns list of subjects for a given class.
 */
app.get('/api/subjects', async (req, res) => {
    try {
        const { class: className } = req.query;
        if (!className) {
            return res.status(400).json({ success: false, error: 'class parameter is required' });
        }
        if (!db) throw new Error('Firestore not initialized');
        await refreshMetadataCache();
        const subjects = metadataCache.subjectsByClass[className] || [];
        res.json({ success: true, subjects });
    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch subjects' });
    }
});

/**
 * GET /api/chapters?class=<className>&subject=<subject>
 * Returns list of chapters for a given class and subject.
 */
app.get('/api/chapters', async (req, res) => {
    try {
        const { class: className, subject } = req.query;
        if (!className || !subject) {
            return res.status(400).json({ success: false, error: 'class and subject parameters are required' });
        }
        if (!db) throw new Error('Firestore not initialized');
        await refreshMetadataCache();
        const key = `${className}|${subject}`;
        const chapters = metadataCache.chaptersByClassAndSubject[key] || [];
        res.json({ success: true, chapters });
    } catch (error) {
        console.error('Error fetching chapters:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch chapters' });
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
