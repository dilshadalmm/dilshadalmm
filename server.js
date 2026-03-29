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

// ---- Helper: Generate safe Firestore document ID ----
function makeDocId(...parts) {
    return parts.map(p => p.replace(/[^a-zA-Z0-9]/g, '_')).join('_');
}

// ---- NEW METADATA COUNTS UPDATE (with atomic increment) ----
async function updateMetadataCounts(className, subject, chapter, incrementBy) {
    if (!db) return;
    const courseId = makeDocId('class', className);
    const subjectId = makeDocId('class', className, subject);
    const chapterId = makeDocId('class', className, subject, chapter);

    // Update courses collection
    await db.collection('courses').doc(courseId).set({
        name: className,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Update subjects collection
    await db.collection('subjects').doc(subjectId).set({
        class: className,
        subject: subject,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Update chapters collection
    await db.collection('chapters').doc(chapterId).set({
        class: className,
        subject: subject,
        chapter: chapter,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

// ---- NEW IN-MEMORY METADATA CACHE ----
let metadataCache = {
    classes: new Set(),
    subjectsByClass: new Map(),      // className -> Set(subject)
    chaptersByClassSubject: new Map() // `${className}|${subject}` -> Set(chapter)
};

async function loadMetadataCache() {
    if (!db) return;
    console.log('Loading metadata cache from Firestore...');
    const newCache = {
        classes: new Set(),
        subjectsByClass: new Map(),
        chaptersByClassSubject: new Map()
    };

    // Load courses
    const coursesSnapshot = await db.collection('courses').get();
    coursesSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.name) newCache.classes.add(data.name);
    });

    // Load subjects
    const subjectsSnapshot = await db.collection('subjects').get();
    subjectsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.class && data.subject) {
            if (!newCache.subjectsByClass.has(data.class)) {
                newCache.subjectsByClass.set(data.class, new Set());
            }
            newCache.subjectsByClass.get(data.class).add(data.subject);
        }
    });

    // Load chapters
    const chaptersSnapshot = await db.collection('chapters').get();
    chaptersSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.class && data.subject && data.chapter) {
            const key = `${data.class}|${data.subject}`;
            if (!newCache.chaptersByClassSubject.has(key)) {
                newCache.chaptersByClassSubject.set(key, new Set());
            }
            newCache.chaptersByClassSubject.get(key).add(data.chapter);
        }
    });

    metadataCache = newCache;
    console.log('Metadata cache loaded successfully.');
}

// Call once at startup
if (db) {
    loadMetadataCache().catch(err => console.error('Failed to load metadata cache:', err));
}

// ---- Helper to update cache when new metadata appears ----
function updateCacheForNewMapping(className, subject, chapter) {
    metadataCache.classes.add(className);
    if (!metadataCache.subjectsByClass.has(className)) {
        metadataCache.subjectsByClass.set(className, new Set());
    }
    metadataCache.subjectsByClass.get(className).add(subject);
    const key = `${className}|${subject}`;
    if (!metadataCache.chaptersByClassSubject.has(key)) {
        metadataCache.chaptersByClassSubject.set(key, new Set());
    }
    metadataCache.chaptersByClassSubject.get(key).add(chapter);
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

async function processBatch(batch) {
    // ---- Step 1: Collect all valid questions with hashes and item info ----
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

    // ---- Step 2: Get existing hashes ----
    const allHashes = allQuestions.map(q => q.hash);
    const existingHashesSet = await getExistingHashes(allHashes);

    // ---- Step 3: Fetch full docs for existing hashes ----
    const existingDocsMap = await getExistingDocsByHashes(Array.from(existingHashesSet));

    // ---- Step 4: Process each question ----
    const newDocs = [];              // { item, question, hash, mapping }
    const updatesMap = new Map();    // key: docRef.path → { docRef, currentMappings, newMappingsSet }
    const itemCounts = new Map();    // key: item → { newCount, updatedCount }
    // Aggregated metadata increments per (class,subject,chapter) for new questions
    const metadataIncrements = new Map(); // key: `${class}|${subject}|${chapter}` → count

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
            // New question
            newDocs.push({ item, question, hash, mapping });
            counts.newCount++;
            const key = `${mapping.class}|${mapping.subject}|${mapping.chapter}`;
            metadataIncrements.set(key, (metadataIncrements.get(key) || 0) + 1);
            continue;
        }

        // Existing question - update mappings if needed
        const docData = existingDocsMap.get(hash);
        const docRef = db.collection('questions').doc(docData.questionId);
        let currentMappings = docData.mappings;
        if (!currentMappings) {
            currentMappings = [{
                class: docData.class,
                subject: docData.subject,
                chapter: docData.chapter
            }];
        }

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
            if (!entry.newMappingsSet.has(mappingKey)) {
                entry.newMappingsSet.add(mappingKey);
                counts.updatedCount++;
            }
        }
    }

    // ---- Step 5: Prepare create writes for new docs ----
    const createWrites = [];
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
    }

    // ---- Step 6: Prepare update writes for existing docs ----
    const updateWrites = [];
    for (const { docRef, currentMappings, newMappingsSet } of updatesMap.values()) {
        const newMappingsArray = [...currentMappings];
        for (const key of newMappingsSet) {
            const [classVal, subjectVal, chapterVal] = key.split('|');
            newMappingsArray.push({ class: classVal, subject: subjectVal, chapter: chapterVal });
        }
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

    // ---- Step 7: Commit all writes ----
    if (createWrites.length || updateWrites.length) {
        await commitMixedWrites(createWrites, updateWrites);
    }

    // ---- Step 8: Update metadata counts for new questions (only once per unique mapping) ----
    for (const [key, incrementCount] of metadataIncrements.entries()) {
        const [className, subject, chapter] = key.split('|');
        await updateMetadataCounts(className, subject, chapter, incrementCount);
        // Also update in-memory cache
        updateCacheForNewMapping(className, subject, chapter);
    }

    // ---- Step 9: Send responses ----
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

// ---- API Endpoint: Ingestion ----
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
            subject: chapter,  // Note: original code used 'chapter' as value for 'subject'? No, re-check. Actually original uses: class: className, subject, chapter. So keep as is.
            chapter,
            sent: false,
            timeout: null
        };
        // Fix: original had subject and chapter swapped? Let's keep consistent with the item structure used in processBatch.
        // In processBatch we access item.class, item.subject, item.chapter. So we must set correctly.
        item.class = className;
        item.subject = subject;
        item.chapter = chapter;
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

// ---- API Endpoint: Quiz ----
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

        const mappedQuery = questionsRef.where('mappings', 'array-contains', {
            class: className,
            subject: subject,
            chapter: chapter
        });

        const legacyQuery = questionsRef
            .where('class', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter);

        const [mappedSnapshot, legacySnapshot] = await Promise.all([
            mappedQuery.get(),
            legacyQuery.get()
        ]);

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

// ==================== HELPER: Extract mappings from a question document ====================
function extractMappingsFromDoc(docData) {
    if (docData.mappings && Array.isArray(docData.mappings)) {
        return docData.mappings;
    } else if (docData.class && docData.subject && docData.chapter) {
        return [{
            class: docData.class,
            subject: docData.subject,
            chapter: docData.chapter
        }];
    }
    return [];
}

// ==================== ADMIN ENDPOINTS (with metadata count updates) ====================

// DELETE /api/question
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

        const docData = doc.data();
        const mappings = extractMappingsFromDoc(docData);

        await docRef.delete();

        // Decrement metadata counts for each unique mapping
        const decrementMap = new Map(); // key → count
        for (const m of mappings) {
            const key = `${m.class}|${m.subject}|${m.chapter}`;
            decrementMap.set(key, (decrementMap.get(key) || 0) + 1);
        }
        for (const [key, count] of decrementMap.entries()) {
            const [className, subject, chapter] = key.split('|');
            await updateMetadataCounts(className, subject, chapter, -count);
            // Note: We do not remove from in-memory cache even if count becomes zero,
            // because the class/subject/chapter might still exist from other questions.
            // The cache will be eventually correct if we reload on server restart.
        }

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

// DELETE /api/questions/bulk
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

        const docRefsSet = new Set();

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
            const legacySnapshot = await db.collection('questions')
                .where('class', '==', className)
                .where('subject', '==', subject)
                .where('chapter', '==', chapter)
                .get();
            legacySnapshot.forEach(doc => docRefsSet.add(doc.ref));

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

        // Fetch all documents to get mappings before deletion
        const docsData = [];
        for (const ref of docRefs) {
            const snap = await ref.get();
            if (snap.exists) docsData.push({ ref, data: snap.data() });
        }

        // Batch delete
        const chunkSize = 500;
        for (let i = 0; i < docRefs.length; i += chunkSize) {
            const chunk = docRefs.slice(i, i + chunkSize);
            const batch = db.batch();
            for (const ref of chunk) {
                batch.delete(ref);
            }
            await batch.commit();
        }

        // Aggregate decrements per mapping
        const decrementMap = new Map();
        for (const { data } of docsData) {
            const mappings = extractMappingsFromDoc(data);
            for (const m of mappings) {
                const key = `${m.class}|${m.subject}|${m.chapter}`;
                decrementMap.set(key, (decrementMap.get(key) || 0) + 1);
            }
        }
        for (const [key, count] of decrementMap.entries()) {
            const [className, subject, chapter] = key.split('|');
            await updateMetadataCounts(className, subject, chapter, -count);
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

// PUT /api/question
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
            mappings
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

        if (questionText !== undefined) updateData.questionText = questionText;
        if (options !== undefined) updateData.options = options;
        if (correctIndex !== undefined) updateData.correctIndex = correctIndex;
        if (solutionText !== undefined) updateData.solutionText = solutionText;
        if (questionImageUrl !== undefined) updateData.questionImageUrl = questionImageUrl;
        if (solutionVideoUrl !== undefined) updateData.solutionVideoUrl = solutionVideoUrl;
        if (solutionImageUrl !== undefined) updateData.solutionImageUrl = solutionImageUrl;

        if (mappings !== undefined && Array.isArray(mappings)) {
            let existingMappings = [];
            if (currentData.mappings && Array.isArray(currentData.mappings)) {
                existingMappings = currentData.mappings;
            } else if (currentData.class && currentData.subject && currentData.chapter) {
                existingMappings = [{
                    class: currentData.class,
                    subject: currentData.subject,
                    chapter: currentData.chapter
                }];
            }
            const mergedMap = new Map();
            for (const m of existingMappings) {
                const key = `${m.class}|${m.subject}|${m.chapter}`;
                mergedMap.set(key, m);
            }
            for (const m of mappings) {
                const key = `${m.class}|${m.subject}|${m.chapter}`;
                mergedMap.set(key, m);
            }
            updateData.mappings = Array.from(mergedMap.values());
        }

        if (updateData.questionText !== undefined || updateData.options !== undefined) {
            const newQuestion = {
                questionText: updateData.questionText !== undefined ? updateData.questionText : currentData.questionText,
                options: updateData.options !== undefined ? updateData.options : currentData.options
            };
            updateData.questionHash = createQuestionHash(newQuestion);
        }

        updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await docRef.update(updateData);

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

// GET /api/questions (admin)
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

        const questionsMap = new Map();

        let legacyQuery = db.collection('questions');
        if (className) legacyQuery = legacyQuery.where('class', '==', className);
        if (subject) legacyQuery = legacyQuery.where('subject', '==', subject);
        if (chapter) legacyQuery = legacyQuery.where('chapter', '==', chapter);

        let mappingQuery = null;
        if (className && subject && chapter) {
            mappingQuery = db.collection('questions')
                .where('mappings', 'array-contains', {
                    class: className,
                    subject: subject,
                    chapter: chapter
                });
        }

        const promises = [legacyQuery.limit(limit).get()];
        if (mappingQuery) promises.push(mappingQuery.limit(limit).get());

        const snapshots = await Promise.all(promises);

        for (const snapshot of snapshots) {
            snapshot.forEach(doc => {
                const data = doc.data();
                if (!questionsMap.has(data.questionId)) {
                    questionsMap.set(data.questionId, data);
                }
            });
        }

        let questions = Array.from(questionsMap.values());
        if (questions.length > limit) {
            questions = questions.slice(0, limit);
        }

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

// ---- METADATA ENDPOINTS (using in-memory cache) ----
app.get('/api/classes', async (req, res) => {
    try {
        const classes = Array.from(metadataCache.classes).sort();
        res.json({ success: true, classes });
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
        const subjectsSet = metadataCache.subjectsByClass.get(className) || new Set();
        const subjects = Array.from(subjectsSet).sort();
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
        const key = `${className}|${subject}`;
        const chaptersSet = metadataCache.chaptersByClassSubject.get(key) || new Set();
        const chapters = Array.from(chaptersSet).sort();
        res.json({ success: true, chapters });
    } catch (error) {
        console.error('Error fetching chapters:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch chapters' });
    }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
