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

// ---- Hashing & Normalization Functions ----
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    let normalized = text.toLowerCase();
    normalized = normalized.replace(/[^\w\s+\-*/=]/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
}

function createQuestionHash(q) {
    const normalizedQuestion = normalizeText(q.questionText);
    const normalizedOptions = (q.options || []).map(opt => normalizeText(opt));
    const sortedOptions = [...normalizedOptions].sort();
    const combined = `${normalizedQuestion}|${sortedOptions.join('|')}`;
    return crypto.createHash('sha256').update(combined).digest('hex');
}

// ---- Configuration Constants ----
const BATCH_SIZE = 20;
const MAX_CONCURRENT_BATCHES = 5;
const MAX_WAIT_MS = 100;
const RESPONSE_TIMEOUT_MS = 60000;

// ---- Queue and Concurrency State ----
const requestQueue = [];
let activeBatches = 0;
let partialBatchTimeoutId = null;

// ---- Utility Functions ----

/**
 * Helper to split an array of Firestore writes into batches of 500.
 * Supports both set (create) and update operations.
 */
async function commitMixedWrites(createWrites, updateWrites) {
    const allOperations = [];
    for (const { docRef, data } of createWrites) {
        allOperations.push({ type: 'set', docRef, data });
    }
    for (const { docRef, data } of updateWrites) {
        allOperations.push({ type: 'update', docRef, data });
    }
    const chunkSize = 500;
    for (let i = 0; i < allOperations.length; i += chunkSize) {
        const chunk = allOperations.slice(i, i + chunkSize);
        const batch = db.batch();
        for (const op of chunk) {
            if (op.type === 'set') {
                batch.set(op.docRef, op.data);
            } else if (op.type === 'update') {
                batch.update(op.docRef, op.data);
            }
        }
        await batch.commit();
    }
}

/**
 * Check which hashes already exist in Firestore.
 * Returns a Set of existing hash strings.
 */
async function getExistingHashes(hashes) {
    if (!db || !hashes.length) return new Set();
    const existing = new Set();
    const chunkSize = 10;
    for (let i = 0; i < hashes.length; i += chunkSize) {
        const chunk = hashes.slice(i, i + chunkSize);
        const snapshot = await db.collection('questions')
            .where('questionHash', 'in', chunk)
            .select('questionHash')
            .get();
        snapshot.forEach(doc => {
            const hash = doc.data().questionHash;
            if (hash) existing.add(hash);
        });
    }
    return existing;
}

/**
 * Fetch full documents for given hashes (max 10 per query).
 * Returns a Map: hash → document data.
 */
async function getExistingDocsByHashes(hashes) {
    if (!db || !hashes.length) return new Map();
    const map = new Map();
    const chunkSize = 10;
    for (let i = 0; i < hashes.length; i += chunkSize) {
        const chunk = hashes.slice(i, i + chunkSize);
        const snapshot = await db.collection('questions')
            .where('questionHash', 'in', chunk)
            .get();
        snapshot.forEach(doc => {
            const data = doc.data();
            map.set(data.questionHash, data);
        });
    }
    return map;
}

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
 * New logic: creates new docs for unseen questions, and updates existing docs
 * by adding the new mapping (class/subject/chapter) if not already present.
 * Uses UUIDs for new question IDs.
 * Also updates metadata counts for new questions (only when a question is created).
 */
async function processBatch(batch) {
    // ---- Step 1: Collect all valid questions with their hashes and item info ----
    const allQuestions = []; // { item, question, hash }
    for (const item of batch) {
        const { questions } = item;
        if (!Array.isArray(questions) || questions.length === 0) continue;

        const validQuestions = questions.filter(q =>
            q.questionText &&
            Array.isArray(q.options) && q.options.length === 4 &&
            typeof q.correctIndex === 'number' &&
            q.solutionText
        );

        for (const q of validQuestions) {
            const hash = createQuestionHash(q);
            allQuestions.push({ item, question: q, hash });
        }
    }

    if (allQuestions.length === 0) {
        // No valid questions in any item; respond accordingly
        for (const item of batch) {
            if (!item.sent) {
                item.sent = true;
                clearRequestTimeout(item);
                item.res.json({
                    status: 'success',
                    message: 'No valid questions provided.',
                    questionsProcessed: 0
                });
            }
        }
        return;
    }

    // ---- Step 2: Get set of existing hashes ----
    const allHashes = allQuestions.map(q => q.hash);
    const existingHashesSet = await getExistingHashes(allHashes);

    // ---- Step 3: Fetch full documents for existing hashes ----
    const existingDocsMap = await getExistingDocsByHashes(Array.from(existingHashesSet));

    // ---- Step 4: Process each question to decide new doc or update ----
    const newDocs = [];              // { item, question, hash, mapping }
    const updatesMap = new Map();    // key: docRef.path → { docRef, currentMappings, newMappingsSet }
    const itemCounts = new Map();    // key: item object → { newCount, updatedCount }

    // Helper to get or init counts for an item
    function getItemCounts(item) {
        if (!itemCounts.has(item)) {
            itemCounts.set(item, { newCount: 0, updatedCount: 0 });
        }
        return itemCounts.get(item);
    }

    for (const { item, question, hash } of allQuestions) {
        const mapping = {
            class: item.class,
            subject: item.subject,
            chapter: item.chapter
        };
        const counts = getItemCounts(item);

        if (!existingDocsMap.has(hash)) {
            // ---- CASE A: Question does not exist - create new ----
            newDocs.push({ item, question, hash, mapping });
            counts.newCount++;
            continue;
        }

        // ---- CASE B: Question already exists - update mappings if needed ----
        const docData = existingDocsMap.get(hash);
        const docRef = db.collection('questions').doc(docData.questionId);
        let currentMappings = docData.mappings;
        if (!currentMappings) {
            // Convert legacy format
            currentMappings = [{
                class: docData.class,
                subject: docData.subject,
                chapter: docData.chapter
            }];
        }

        // Check if mapping already present
        const mappingExists = currentMappings.some(m =>
            m.class === mapping.class &&
            m.subject === mapping.subject &&
            m.chapter === mapping.chapter
        );

        if (!mappingExists) {
            const path = docRef.path;
            if (!updatesMap.has(path)) {
                updatesMap.set(path, {
                    docRef,
                    currentMappings,
                    newMappingsSet: new Set()
                });
            }
            const entry = updatesMap.get(path);
            const mappingKey = `${mapping.class}|${mapping.subject}|${mapping.chapter}`;
            // Avoid duplicate within batch
            if (!entry.newMappingsSet.has(mappingKey)) {
                entry.newMappingsSet.add(mappingKey);
                counts.updatedCount++;
            }
        }
        // If mapping already exists, no change → not counted
    }

    // ---- Step 5: Prepare create writes for new docs (using UUID) ----
    const createWrites = [];
    const newQuestionTriples = []; // { class, subject, chapter } for each new question
    for (const { item, question, hash, mapping } of newDocs) {
        const questionId = crypto.randomUUID();
        const questionDoc = {
            questionId,
            questionText: question.questionText,
            options: question.options,
            correctIndex: question.correctIndex,
            solutionText: question.solutionText,
            questionImageUrl: question.questionImageUrl || null,
            solutionVideoUrl: question.solutionVideoUrl || null,
            solutionImageUrl: question.solutionImageUrl || null,
            mappings: [mapping],
            questionHash: hash,
            embedded: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const docRef = db.collection('questions').doc(questionId);
        createWrites.push({ docRef, data: questionDoc });
        newQuestionTriples.push({ class: mapping.class, subject: mapping.subject, chapter: mapping.chapter });
    }

    // ---- Step 6: Prepare update writes for existing docs ----
    const updateWrites = [];
    for (const { docRef, currentMappings, newMappingsSet } of updatesMap.values()) {
        const newMappingsArray = [...currentMappings];
        for (const key of newMappingsSet) {
            const [classVal, subjectVal, chapterVal] = key.split('|');
            newMappingsArray.push({ class: classVal, subject: subjectVal, chapter: chapterVal });
        }
        // Deduplicate final array (should already be unique, but safe)
        const uniqueMappings = [];
        const seen = new Set();
        for (const m of newMappingsArray) {
            const k = `${m.class}|${m.subject}|${m.chapter}`;
            if (!seen.has(k)) {
                seen.add(k);
                uniqueMappings.push(m);
            }
        }
        updateWrites.push({
            docRef,
            data: {
                mappings: uniqueMappings,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }
        });
    }

    // ---- Step 7: Commit all writes in batches ----
    if (createWrites.length || updateWrites.length) {
        await commitMixedWrites(createWrites, updateWrites);
    }

    // ---- Step 8: Update metadata counts for newly created questions ----
    if (newQuestionTriples.length > 0) {
        await batchUpdateMetadataCounts(newQuestionTriples, 1);
    }

    // ---- Step 9: Send responses for each item ----
    for (const item of batch) {
        if (!item.sent) {
            const counts = itemCounts.get(item) || { newCount: 0, updatedCount: 0 };
            const totalProcessed = counts.newCount + counts.updatedCount;
            const message = totalProcessed === 0
                ? 'No new questions or mappings added.'
                : `Processed ${totalProcessed} questions (${counts.newCount} new, ${counts.updatedCount} updated).`;
            item.sent = true;
            clearRequestTimeout(item);
            item.res.json({
                status: 'success',
                message,
                questionsProcessed: totalProcessed
            });
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

// ==================== METADATA MANAGEMENT ====================

// Helper to get document IDs for metadata collections
function getCourseId(className) {
    return `class_${className}`.replace(/\s+/g, '_');
}

function getSubjectId(className, subject) {
    return `class_${className}_subject_${subject}`.replace(/\s+/g, '_');
}

function getChapterId(className, subject, chapter) {
    return `class_${className}_subject_${subject}_chapter_${chapter}`.replace(/\s+/g, '_');
}

/**
 * Increment count for a single (class, subject, chapter) triple.
 * Used for batch updates.
 */
async function updateSingleMetadataCount(className, subject, chapter, incrementBy) {
    if (!db) return;
    const courseId = getCourseId(className);
    const subjectId = getSubjectId(className, subject);
    const chapterId = getChapterId(className, subject, chapter);

    const batch = db.batch();

    // Course
    const courseRef = db.collection('courses').doc(courseId);
    batch.set(courseRef, {
        name: className,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Subject
    const subjectRef = db.collection('subjects').doc(subjectId);
    batch.set(subjectRef, {
        class: className,
        subject: subject,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Chapter
    const chapterRef = db.collection('chapters').doc(chapterId);
    batch.set(chapterRef, {
        class: className,
        subject: subject,
        chapter: chapter,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();
}

/**
 * Batch increment counts for multiple triples.
 * @param {Array} triples - Array of { class, subject, chapter } objects
 * @param {number} incrementBy - +1 for creation, -1 for deletion
 */
async function batchUpdateMetadataCounts(triples, incrementBy) {
    if (!db || triples.length === 0) return;
    // Group by triple to avoid duplicate increments for the same triple in the same batch
    const tripleCountMap = new Map();
    for (const t of triples) {
        const key = `${t.class}|${t.subject}|${t.chapter}`;
        tripleCountMap.set(key, (tripleCountMap.get(key) || 0) + 1);
    }

    const batchPromises = [];
    for (const [key, count] of tripleCountMap.entries()) {
        const [className, subject, chapter] = key.split('|');
        // For each triple, we need to increment by (count * incrementBy)
        const totalIncrement = count * incrementBy;
        if (totalIncrement === 0) continue;
        batchPromises.push(updateSingleMetadataCount(className, subject, chapter, totalIncrement));
    }

    await Promise.all(batchPromises);
}

/**
 * Decrement counts for all mappings of a question.
 * Used when a question is deleted.
 */
async function decrementCountsForQuestion(questionData) {
    let mappings = questionData.mappings;
    if (!mappings) {
        // Legacy format
        if (questionData.class && questionData.subject && questionData.chapter) {
            mappings = [{ class: questionData.class, subject: questionData.subject, chapter: questionData.chapter }];
        } else {
            return; // no valid mappings
        }
    }
    const triples = mappings.map(m => ({ class: m.class, subject: m.subject, chapter: m.chapter }));
    await batchUpdateMetadataCounts(triples, -1);
}

/**
 * Adjust counts when a question's mappings change.
 * @param {Object} oldData - The question document before update.
 * @param {Object} newData - The updated fields (containing new mappings or legacy fields).
 */
async function adjustCountsForMappingChange(oldData, newData) {
    // Get old mappings
    let oldMappings = oldData.mappings;
    if (!oldMappings && oldData.class && oldData.subject && oldData.chapter) {
        oldMappings = [{ class: oldData.class, subject: oldData.subject, chapter: oldData.chapter }];
    }
    // Get new mappings
    let newMappings = newData.mappings;
    if (!newMappings && newData.class && newData.subject && newData.chapter) {
        newMappings = [{ class: newData.class, subject: newData.subject, chapter: newData.chapter }];
    }
    if (!oldMappings || !newMappings) return;

    // Compute differences: triples to decrement (old - new) and to increment (new - old)
    const oldSet = new Set(oldMappings.map(m => `${m.class}|${m.subject}|${m.chapter}`));
    const newSet = new Set(newMappings.map(m => `${m.class}|${m.subject}|${m.chapter}`));

    const toDecrement = [];
    const toIncrement = [];

    for (const key of oldSet) {
        if (!newSet.has(key)) {
            const [c, s, ch] = key.split('|');
            toDecrement.push({ class: c, subject: s, chapter: ch });
        }
    }
    for (const key of newSet) {
        if (!oldSet.has(key)) {
            const [c, s, ch] = key.split('|');
            toIncrement.push({ class: c, subject: s, chapter: ch });
        }
    }

    if (toDecrement.length) await batchUpdateMetadataCounts(toDecrement, -1);
    if (toIncrement.length) await batchUpdateMetadataCounts(toIncrement, 1);
}

// ---- In‑Memory Cache for Metadata ----
let metadataCache = {
    classes: [],
    subjectsByClass: {},
    chaptersByClassSubject: {}
};

/**
 * Load metadata from Firestore into cache on server start.
 */
async function loadMetadataCache() {
    if (!db) return;
    console.log('🔄 Loading metadata cache from Firestore...');
    const coursesSnapshot = await db.collection('courses').get();
    const subjectsSnapshot = await db.collection('subjects').get();
    const chaptersSnapshot = await db.collection('chapters').get();

    const classesSet = new Set();
    const subjectsMap = new Map(); // class -> Set of subjects
    const chaptersMap = new Map(); // `${class}|${subject}` -> Set of chapters

    coursesSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.name) classesSet.add(data.name);
    });

    subjectsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.class && data.subject) {
            if (!subjectsMap.has(data.class)) subjectsMap.set(data.class, new Set());
            subjectsMap.get(data.class).add(data.subject);
        }
    });

    chaptersSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.class && data.subject && data.chapter) {
            const key = `${data.class}|${data.subject}`;
            if (!chaptersMap.has(key)) chaptersMap.set(key, new Set());
            chaptersMap.get(key).add(data.chapter);
        }
    });

    metadataCache = {
        classes: Array.from(classesSet).sort(),
        subjectsByClass: Object.fromEntries(
            Array.from(subjectsMap.entries()).map(([c, s]) => [c, Array.from(s).sort()])
        ),
        chaptersByClassSubject: Object.fromEntries(
            Array.from(chaptersMap.entries()).map(([key, ch]) => [key, Array.from(ch).sort()])
        )
    };
    console.log('✅ Metadata cache loaded');
}

/**
 * Update the in‑memory cache when a new metadata entry is added.
 * @param {string} className
 * @param {string} subject
 * @param {string} chapter
 */
function updateCacheForNewTriple(className, subject, chapter) {
    // Add class if new
    if (!metadataCache.classes.includes(className)) {
        metadataCache.classes.push(className);
        metadataCache.classes.sort();
    }
    // Add subject under class
    if (!metadataCache.subjectsByClass[className]) {
        metadataCache.subjectsByClass[className] = [];
    }
    if (!metadataCache.subjectsByClass[className].includes(subject)) {
        metadataCache.subjectsByClass[className].push(subject);
        metadataCache.subjectsByClass[className].sort();
    }
    // Add chapter under class+subject
    const key = `${className}|${subject}`;
    if (!metadataCache.chaptersByClassSubject[key]) {
        metadataCache.chaptersByClassSubject[key] = [];
    }
    if (!metadataCache.chaptersByClassSubject[key].includes(chapter)) {
        metadataCache.chaptersByClassSubject[key].push(chapter);
        metadataCache.chaptersByClassSubject[key].sort();
    }
}

/**
 * Remove a triple from the cache (when counts drop to zero and document is deleted).
 * Actually we don't delete metadata documents when counts become zero,
 * but we might want to remove them from cache if they have no questions.
 * For simplicity, we leave them in cache; they will be empty counts but still appear.
 * If we want to remove, we would need to check if totalQuestions == 0.
 * This is optional.
 */
// Not implemented for brevity; can be added if needed.

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
 * Supports both legacy and new mapping schemas.
 * Returns combined, shuffled, and limited questions.
 */
app.get('/api/quiz', async (req, res) => {
    try {
        const { className, subject, chapter, limit: limitParam } = req.query;

        if (!className || !subject || !chapter) {
            return res.status(400).json({
                success: false,
                error: 'Missing required query parameters: className, subject, chapter'
            });
        }

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

        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        const questionsRef = db.collection('questions');

        // Query for new mapping schema
        const mappedQuery = questionsRef.where('mappings', 'array-contains', {
            class: className,
            subject: subject,
            chapter: chapter
        });

        // Query for legacy schema
        const legacyQuery = questionsRef
            .where('class', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter);

        const [mappedSnapshot, legacySnapshot] = await Promise.all([
            mappedQuery.get(),
            legacyQuery.get()
        ]);

        // Combine and deduplicate by questionId
        const questionsMap = new Map();
        const addDocs = (snapshot) => {
            snapshot.forEach(doc => {
                const data = doc.data();
                if (!questionsMap.has(data.questionId)) {
                    questionsMap.set(data.questionId, data);
                }
            });
        };
        addDocs(mappedSnapshot);
        addDocs(legacySnapshot);

        let questions = Array.from(questionsMap.values());

        if (questions.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No questions found for the given criteria'
            });
        }

        // Shuffle
        for (let i = questions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [questions[i], questions[j]] = [questions[j], questions[i]];
        }

        const limitedQuestions = questions.slice(0, limit);

        const formattedQuestions = limitedQuestions.map(q => ({
            questionText: q.questionText,
            options: q.options,
            solutionText: q.solutionText,
            correctIndex: q.correctIndex,
            solutionVideoUrl: q.solutionVideoUrl || null,
            questionImageUrl: q.questionImageUrl || null,
            solutionImageUrl: q.solutionImageUrl || null
        }));

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

// ==================== ADMIN ENDPOINTS (UPDATED) ====================

/**
 * DELETE /api/question
 * Deletes a single question by its questionId and updates metadata counts.
 */
app.delete('/api/question', async (req, res) => {
    try {
        const { questionId } = req.body;

        if (!questionId || typeof questionId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'questionId is required and must be a string'
            });
        }

        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        const docRef = db.collection('questions').doc(questionId);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Question not found'
            });
        }

        const questionData = doc.data();
        // Decrement counts for all mappings of this question
        await decrementCountsForQuestion(questionData);

        await docRef.delete();
        console.log(`🗑️ Deleted question: ${questionId}`);
        res.json({
            success: true,
            message: 'Question deleted successfully'
        });
    } catch (error) {
        console.error('Error in DELETE /api/question:', error);
        res.status(500).json({
            success: false,
            error: 'An internal server error occurred'
        });
    }
});

/**
 * DELETE /api/questions/bulk
 * Bulk delete by IDs or by class/subject/chapter.
 * Supports both legacy and new mapping-based questions.
 * Updates metadata counts for each deleted question.
 */
app.delete('/api/questions/bulk', async (req, res) => {
    try {
        const { questionIds, class: className, subject, chapter } = req.body;

        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        let docRefsSet = new Set(); // use Set to avoid duplicates

        if (questionIds && Array.isArray(questionIds) && questionIds.length > 0) {
            for (const id of questionIds) {
                if (typeof id !== 'string') {
                    return res.status(400).json({
                        success: false,
                        error: 'Each questionId must be a string'
                    });
                }
                docRefsSet.add(db.collection('questions').doc(id));
            }
        } else if (className && subject && chapter) {
            // 1. Query legacy fields
            const legacySnapshot = await db.collection('questions')
                .where('class', '==', className)
                .where('subject', '==', subject)
                .where('chapter', '==', chapter)
                .get();

            legacySnapshot.forEach(doc => docRefsSet.add(doc.ref));

            // 2. Query new mapping format
            const mappingSnapshot = await db.collection('questions')
                .where('mappings', 'array-contains', {
                    class: className,
                    subject: subject,
                    chapter: chapter
                })
                .get();

            mappingSnapshot.forEach(doc => docRefsSet.add(doc.ref));
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid request. Provide either "questionIds" array or "class", "subject", "chapter"'
            });
        }

        const docRefs = Array.from(docRefsSet);
        if (docRefs.length === 0) {
            return res.json({ success: true, deletedCount: 0 });
        }

        // Fetch all questions data before deletion to update counts
        const questionsData = [];
        for (const ref of docRefs) {
            const doc = await ref.get();
            if (doc.exists) {
                questionsData.push(doc.data());
            }
        }

        // Decrement counts for each question
        for (const data of questionsData) {
            await decrementCountsForQuestion(data);
        }

        // Batched deletes (max 500 per batch)
        const chunkSize = 500;
        for (let i = 0; i < docRefs.length; i += chunkSize) {
            const chunk = docRefs.slice(i, i + chunkSize);
            const batch = db.batch();
            for (const ref of chunk) {
                batch.delete(ref);
            }
            await batch.commit();
        }

        console.log(`🗑️ Bulk deleted ${docRefs.length} questions`);
        res.json({
            success: true,
            deletedCount: docRefs.length
        });
    } catch (error) {
        console.error('Error in DELETE /api/questions/bulk:', error);
        res.status(500).json({
            success: false,
            error: 'An internal server error occurred'
        });
    }
});

/**
 * PUT /api/question
 * Updates an existing question.
 * - If mappings are provided, they are merged with existing mappings (preserving existing ones).
 * - Legacy documents are automatically converted to mapping format when mappings are updated.
 * - questionHash is recalculated if questionText or options change.
 * - Metadata counts are adjusted if mappings change.
 */
app.put('/api/question', async (req, res) => {
    try {
        const {
            questionId,
            questionText,
            options,
            correctIndex,
            solutionText,
            questionImageUrl,
            solutionVideoUrl,
            solutionImageUrl,
            mappings   // optional: array of {class, subject, chapter} to merge
        } = req.body;

        if (!questionId || typeof questionId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'questionId is required and must be a string'
            });
        }

        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        const docRef = db.collection('questions').doc(questionId);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Question not found'
            });
        }

        const currentData = doc.data();
        const updateData = {};

        // --- Update simple fields ---
        if (questionText !== undefined) updateData.questionText = questionText;
        if (options !== undefined) updateData.options = options;
        if (correctIndex !== undefined) updateData.correctIndex = correctIndex;
        if (solutionText !== undefined) updateData.solutionText = solutionText;
        if (questionImageUrl !== undefined) updateData.questionImageUrl = questionImageUrl;
        if (solutionVideoUrl !== undefined) updateData.solutionVideoUrl = solutionVideoUrl;
        if (solutionImageUrl !== undefined) updateData.solutionImageUrl = solutionImageUrl;

        // --- Handle mappings (merge) ---
        let newMappings = null;
        if (mappings !== undefined && Array.isArray(mappings)) {
            // Gather existing mappings from current document
            let existingMappings = [];
            if (currentData.mappings && Array.isArray(currentData.mappings)) {
                existingMappings = currentData.mappings;
            } else if (currentData.class && currentData.subject && currentData.chapter) {
                // Legacy document: convert to a single mapping
                existingMappings = [{
                    class: currentData.class,
                    subject: currentData.subject,
                    chapter: currentData.chapter
                }];
            }

            // Merge: combine existing and new, deduplicate by (class,subject,chapter)
            const mergedMap = new Map();
            for (const m of existingMappings) {
                const key = `${m.class}|${m.subject}|${m.chapter}`;
                mergedMap.set(key, m);
            }
            for (const m of mappings) {
                const key = `${m.class}|${m.subject}|${m.chapter}`;
                mergedMap.set(key, m);
            }
            newMappings = Array.from(mergedMap.values());
            updateData.mappings = newMappings;
        }

        // --- Recalculate hash if needed ---
        if (updateData.questionText !== undefined || updateData.options !== undefined) {
            const newQuestion = {
                questionText: updateData.questionText !== undefined ? updateData.questionText : currentData.questionText,
                options: updateData.options !== undefined ? updateData.options : currentData.options
            };
            updateData.questionHash = createQuestionHash(newQuestion);
        }

        // --- Add timestamp and perform update ---
        updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await docRef.update(updateData);

        // --- Adjust metadata counts if mappings changed ---
        if (newMappings !== null) {
            await adjustCountsForMappingChange(currentData, { mappings: newMappings });
        }

        console.log(`✏️ Updated question: ${questionId}`);
        res.json({
            success: true,
            message: 'Question updated successfully'
        });
    } catch (error) {
        console.error('Error in PUT /api/question:', error);
        res.status(500).json({
            success: false,
            error: 'An internal server error occurred'
        });
    }
});

/**
 * GET /api/questions
 * Admin endpoint to fetch questions with optional filters (class, subject, chapter).
 * Supports both legacy and new mapping-based questions.
 */
app.get('/api/questions', async (req, res) => {
    try {
        const { class: className, subject, chapter, limit: limitParam } = req.query;

        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        let limit = 50;
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

        // Map to store unique questions by questionId
        const questionsMap = new Map();

        // 1. Build legacy query (supports partial filters)
        let legacyQuery = db.collection('questions');
        if (className) legacyQuery = legacyQuery.where('class', '==', className);
        if (subject) legacyQuery = legacyQuery.where('subject', '==', subject);
        if (chapter) legacyQuery = legacyQuery.where('chapter', '==', chapter);

        // 2. Build mapping query only if all three filters are provided
        let mappingQuery = null;
        if (className && subject && chapter) {
            mappingQuery = db.collection('questions')
                .where('mappings', 'array-contains', {
                    class: className,
                    subject: subject,
                    chapter: chapter
                });
        }

        // Execute queries in parallel
        const promises = [legacyQuery.limit(limit).get()];
        if (mappingQuery) promises.push(mappingQuery.limit(limit).get());

        const snapshots = await Promise.all(promises);

        // Process all snapshots
        for (const snapshot of snapshots) {
            snapshot.forEach(doc => {
                const data = doc.data();
                if (!questionsMap.has(data.questionId)) {
                    questionsMap.set(data.questionId, data);
                }
            });
        }

        let questions = Array.from(questionsMap.values());

        // Apply final limit after deduplication (if needed)
        if (questions.length > limit) {
            questions = questions.slice(0, limit);
        }

        // Format output (include mappings if present)
        const formattedQuestions = questions.map(q => {
            const result = {
                questionId: q.questionId,
                questionText: q.questionText,
                options: q.options,
                correctIndex: q.correctIndex,
                solutionText: q.solutionText,
                questionImageUrl: q.questionImageUrl || null,
                solutionVideoUrl: q.solutionVideoUrl || null,
                solutionImageUrl: q.solutionImageUrl || null
            };
            if (q.mappings) result.mappings = q.mappings;
            // For backward compatibility, also include legacy fields if present
            if (q.class) result.class = q.class;
            if (q.subject) result.subject = q.subject;
            if (q.chapter) result.chapter = q.chapter;
            return result;
        });

        res.json({
            success: true,
            questions: formattedQuestions
        });
    } catch (error) {
        console.error('Error in GET /api/questions:', error);
        res.status(500).json({
            success: false,
            error: 'An internal server error occurred'
        });
    }
});

// ---- Dynamic Metadata Endpoints (served from cache) ----

app.get('/api/classes', async (req, res) => {
    try {
        if (!db) throw new Error('Firestore not initialized');
        res.json({ success: true, classes: metadataCache.classes });
    } catch (error) {
        console.error('Error fetching classes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch classes' });
    }
});

app.get('/api/subjects', async (req, res) => {
    try {
        const { class: className } = req.query;
        if (!className) {
            return res.status(400).json({ success: false, error: 'class parameter is required' });
        }
        if (!db) throw new Error('Firestore not initialized');
        const subjects = metadataCache.subjectsByClass[className] || [];
        res.json({ success: true, subjects });
    } catch (error) {
        console.error('Error fetching subjects:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch subjects' });
    }
});

app.get('/api/chapters', async (req, res) => {
    try {
        const { class: className, subject } = req.query;
        if (!className || !subject) {
            return res.status(400).json({ success: false, error: 'class and subject parameters are required' });
        }
        if (!db) throw new Error('Firestore not initialized');
        const key = `${className}|${subject}`;
        const chapters = metadataCache.chaptersByClassSubject[key] || [];
        res.json({ success: true, chapters });
    } catch (error) {
        console.error('Error fetching chapters:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch chapters' });
    }
});

app.get('/health', (req, res) => res.send('Active'));

// Initialize metadata cache on startup
if (db) {
    loadMetadataCache().catch(err => console.error('Failed to load metadata cache:', err));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
