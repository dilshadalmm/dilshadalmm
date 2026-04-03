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

function makeDocId(...parts) {
    return parts.map(p => p.replace(/[^a-zA-Z0-9]/g, '_')).join('_');
}

// ---- Metadata Counts Update (atomic increment) ----
async function updateMetadataCounts(className, subject, chapter, incrementBy) {
    if (!db) return;
    const courseId = makeDocId('class', className);
    const subjectId = makeDocId('class', className, subject);
    const chapterId = makeDocId('class', className, subject, chapter);

    await db.collection('courses').doc(courseId).set({
        name: className,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('subjects').doc(subjectId).set({
        class: className,
        subject: subject,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('chapters').doc(chapterId).set({
        class: className,
        subject: subject,
        chapter: chapter,
        totalQuestions: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

// ---- In-Memory Metadata Cache ----
let metadataCache = {
    classes: new Set(),
    subjectsByClass: new Map(),      // className -> Set(subject)
    chaptersByClassSubject: new Map() // `${className}|${subject}` -> Set(chapter)
};

// Load cache from Firestore metadata collections at startup
async function loadMetadataCache() {
    if (!db) return;
    console.log('Loading metadata cache from Firestore...');
    const newCache = {
        classes: new Set(),
        subjectsByClass: new Map(),
        chaptersByClassSubject: new Map()
    };

    const coursesSnapshot = await db.collection('courses').get();
    coursesSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.name) newCache.classes.add(data.name);
    });

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

if (db) {
    loadMetadataCache().catch(err => console.error('Failed to load metadata cache:', err));
}

// ---- Helper to update cache when a new mapping is added ----
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
    const allQuestions = [];
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

    const allHashes = allQuestions.map(q => q.hash);
    const existingHashesSet = await getExistingHashes(allHashes);
    const existingDocsMap = await getExistingDocsByHashes(Array.from(existingHashesSet));

    const newDocs = [];
    const updatesMap = new Map();
    const itemCounts = new Map();
    const metadataIncrements = new Map();       // for new questions
    const mappingAdditions = new Set();          // for ANY new mapping (new question or update)

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
            mappingAdditions.add(key);
            continue;
        }

        // Existing question – check if mapping already exists
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
                mappingAdditions.add(mappingKey);
            }
        }
    }

    // --- Assign questionNo to new questions (ordered per mapping group) ---
    // Group newDocs by mapping
    const newDocsByMapping = new Map(); // key -> array of newDocs
    for (const nd of newDocs) {
        const key = `${nd.mapping.class}|${nd.mapping.subject}|${nd.mapping.chapter}`;
        if (!newDocsByMapping.has(key)) newDocsByMapping.set(key, []);
        newDocsByMapping.get(key).push(nd);
    }

    for (const [key, ndList] of newDocsByMapping.entries()) {
        const mapping = ndList[0].mapping;
        // Query highest questionNo for this mapping
        let maxQuestionNo = 0;
        const maxQuery = await db.collection('questions')
            .where('mappings', 'array-contains', mapping)
            .orderBy('questionNo', 'desc')
            .limit(1)
            .get();
        if (!maxQuery.empty) {
            maxQuestionNo = maxQuery.docs[0].data().questionNo || 0;
        }

        let nextNo = maxQuestionNo + 1;
        const usedInBatch = new Set(); // numbers already assigned within this batch for this mapping
        const existsCache = new Map(); // questionNo -> exists (to avoid repeated queries)

        for (const nd of ndList) {
            const incomingNo = nd.question.questionNo;
            let assignedNo = null;

            if (incomingNo !== undefined && typeof incomingNo === 'number' && Number.isInteger(incomingNo) && incomingNo > 0) {
                // Determine if incomingNo is a duplicate
                let isDuplicate = false;
                if (incomingNo <= maxQuestionNo) {
                    // Might be duplicate with existing document
                    if (existsCache.has(incomingNo)) {
                        isDuplicate = existsCache.get(incomingNo);
                    } else {
                        const existQuery = await db.collection('questions')
                            .where('mappings', 'array-contains', mapping)
                            .where('questionNo', '==', incomingNo)
                            .limit(1)
                            .get();
                        const exists = !existQuery.empty;
                        existsCache.set(incomingNo, exists);
                        isDuplicate = exists;
                    }
                } else {
                    // incomingNo > maxQuestionNo, only possible duplicate is within this batch
                    isDuplicate = usedInBatch.has(incomingNo);
                }

                if (isDuplicate) {
                    assignedNo = nextNo;
                    nextNo++;
                } else {
                    assignedNo = incomingNo;
                    usedInBatch.add(assignedNo);
                    if (assignedNo > maxQuestionNo) {
                        maxQuestionNo = assignedNo;
                        nextNo = maxQuestionNo + 1;
                    }
                }
            } else {
                // No incoming questionNo → auto assign
                assignedNo = nextNo;
                nextNo++;
            }

            nd.question.questionNo = assignedNo;
        }
    }

    // Prepare create writes (including questionType)
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
            questionType: question.questionType || null,   // NEW FIELD
            mappings: [mapping],
            questionHash: hash,
            embedded: false,
            questionNo: question.questionNo,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        createWrites.push({ docRef: db.collection('questions').doc(questionId), data: questionDoc });
    }

    // Prepare update writes (no change to questionType)
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

    if (createWrites.length || updateWrites.length) {
        await commitMixedWrites(createWrites, updateWrites);
    }

    // Update metadata counts and cache for every new mapping added
    for (const key of mappingAdditions) {
        const [className, subject, chapter] = key.split('|');
        const incrementCount = metadataIncrements.get(key) || 1; // for updates, increment by 1
        await updateMetadataCounts(className, subject, chapter, incrementCount);
        updateCacheForNewMapping(className, subject, chapter);
    }

    // Send responses
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
            subject: subject,
            chapter: chapter,
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

// ==================== UNIQUE CHAPTER VIEW COUNTER ====================
// Counts each user-chapter combination only once per day
// No frontend changes required – works with existing /api/quiz calls

// Helper: get today's date as YYYY-MM-DD (UTC)
function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

// Helper: get client IP address
function getClientIp(req) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor) {
        return xForwardedFor.split(',')[0].trim();
    }
    return req.socket.remoteAddress || req.ip;
}

// Middleware: tracks unique chapter views per user per day
app.use('/api/quiz', async (req, res, next) => {
    if (!db) {
        console.warn('Firestore not initialized – counters not updated');
        return next();
    }

    // Get user identifier (IP address)
    const userIp = getClientIp(req);
    
    // Get chapter information from query parameters
    const className = req.query.className;
    const subject = req.query.subject;
    const chapter = req.query.chapter;
    
    // Only track if we have complete chapter info
    if (className && subject && chapter) {
        const today = getTodayString();
        
        // Create a unique key: date|ip|class|subject|chapter
        const sessionKey = `${today}|${userIp}|${className}|${subject}|${chapter}`;
        const sessionRef = db.collection('chapterViews').doc(sessionKey);
        
        try {
            // Check if this user already viewed this chapter today
            const sessionDoc = await sessionRef.get();
            
            if (!sessionDoc.exists) {
                // First time – record the view and increment counters
                await sessionRef.set({
                    userIp,
                    className,
                    subject,
                    chapter,
                    firstViewed: admin.firestore.FieldValue.serverTimestamp(),
                    date: today
                });
                
                // Increment daily counter
                const dailyCounterRef = db.collection('quizApiStats').doc(`daily_${today}`);
                await dailyCounterRef.set(
                    { count: admin.firestore.FieldValue.increment(1), date: today },
                    { merge: true }
                );
                
                // Increment global counter
                const globalCounterRef = db.collection('quizApiStats').doc('global');
                await globalCounterRef.set(
                    { totalUniqueChapterViews: admin.firestore.FieldValue.increment(1) },
                    { merge: true }
                );
                
                console.log(`✅ New unique chapter view: ${className} - ${subject} - ${chapter} (IP: ${userIp})`);
            } else {
                console.log(`⏭️ Duplicate chapter view ignored: ${className} - ${subject} - ${chapter} (IP: ${userIp})`);
            }
        } catch (err) {
            console.error('Failed to track chapter view:', err);
            // Don't block the quiz request
        }
    }
    
    next();
});

// Endpoint: get daily unique chapter views
app.get('/api/quiz/daily', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, error: 'Database not initialized' });
        }
        const { date } = req.query;
        const targetDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : getTodayString();
        const doc = await db.collection('quizApiStats').doc(`daily_${targetDate}`).get();
        const count = doc.exists ? doc.data().count : 0;
        res.json({ success: true, date: targetDate, uniqueChapterViews: count });
    } catch (err) {
        console.error('Error fetching daily count:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch daily count' });
    }
});

// Endpoint: get global total unique chapter views
app.get('/api/quiz/global', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, error: 'Database not initialized' });
        }
        const doc = await db.collection('quizApiStats').doc('global').get();
        const totalUniqueChapterViews = doc.exists ? doc.data().totalUniqueChapterViews : 0;
        res.json({ success: true, totalUniqueChapterViews });
    } catch (err) {
        console.error('Error fetching global count:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch global count' });
    }
});

// Optional: Get stats for a specific chapter
app.get('/api/quiz/chapter-stats', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, error: 'Database not initialized' });
        }
        const { class: className, subject, chapter, date } = req.query;
        
        if (!className || !subject || !chapter) {
            return res.status(400).json({ success: false, error: 'class, subject, and chapter are required' });
        }
        
        const targetDate = date || getTodayString();
        const querySnapshot = await db.collection('chapterViews')
            .where('className', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter)
            .where('date', '==', targetDate)
            .get();
        
        const uniqueViews = querySnapshot.size;
        
        res.json({ 
            success: true, 
            className, 
            subject, 
            chapter, 
            date: targetDate,
            uniqueViews 
        });
    } catch (err) {
        console.error('Error fetching chapter stats:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch chapter stats' });
    }
});
            

// ---- API Endpoint: Quiz (Ordered Pagination) ----
app.get('/api/quiz', async (req, res) => {
    try {
        const { className, subject, chapter, cursor, limit: limitParam } = req.query;

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

        // Build query with mapping and order by questionNo
        let query = db.collection('questions')
            .where('mappings', 'array-contains', { class: className, subject: subject, chapter: chapter })
            .orderBy('questionNo');

        if (cursor) {
            const cursorNum = parseInt(cursor, 10);
            if (isNaN(cursorNum)) {
                return res.status(400).json({
                    success: false,
                    error: 'cursor must be a number'
                });
            }
            query = query.startAfter(cursorNum);
        }

        query = query.limit(limit);

        const snapshot = await query.get();
        const questions = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            questions.push({
                questionText: data.questionText,
                options: data.options,
                solutionText: data.solutionText,
                correctIndex: data.correctIndex,
                solutionVideoUrl: data.solutionVideoUrl || null,
                questionImageUrl: data.questionImageUrl || null,
                solutionImageUrl: data.solutionImageUrl || null,
                questionType: data.questionType || null   // NEW FIELD
            });
        });

        let nextCursor = null;
        let hasMore = false;
        if (questions.length > 0) {
            const lastDoc = snapshot.docs[snapshot.docs.length - 1];
            nextCursor = lastDoc.data().questionNo;
            hasMore = snapshot.size === limit;
        }

        return res.json({
            success: true,
            questions,
            nextCursor,
            hasMore
        });

    } catch (error) {
        console.error('Error in /api/quiz:', error);
        return res.status(500).json({
            success: false,
            error: 'An internal server error occurred'
        });
    }
});

// ---- API Endpoint: Fetch single question by questionNo ----
app.get('/api/question', async (req, res) => {
    try {
        const { class: className, subject, chapter, questionNo } = req.query;
        if (!className || !subject || !chapter || !questionNo) {
            return res.status(400).json({
                success: false,
                error: 'class, subject, chapter, and questionNo are required'
            });
        }
        const num = parseInt(questionNo, 10);
        if (isNaN(num)) {
            return res.status(400).json({
                success: false,
                error: 'questionNo must be a number'
            });
        }
        if (!db) {
            console.error('Firestore not initialized');
            return res.status(500).json({
                success: false,
                error: 'Database service unavailable'
            });
        }

        const snapshot = await db.collection('questions')
            .where('mappings', 'array-contains', { class: className, subject: subject, chapter: chapter })
            .where('questionNo', '==', num)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.status(404).json({
                success: false,
                error: 'Question not found'
            });
        }

        const data = snapshot.docs[0].data();
        // Include questionType in response
        const question = { ...data, questionType: data.questionType || null };
        res.json({ success: true, question });
    } catch (error) {
        console.error('Error fetching single question:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// ==================== HELPER ====================
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

// ==================== ADMIN ENDPOINTS ====================

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

        const decrementMap = new Map();
        for (const m of mappings) {
            const key = `${m.class}|${m.subject}|${m.chapter}`;
            decrementMap.set(key, (decrementMap.get(key) || 0) + 1);
        }
        for (const [key, count] of decrementMap.entries()) {
            const [className, subject, chapter] = key.split('|');
            await updateMetadataCounts(className, subject, chapter, -count);
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

        // Fetch all documents to get mappings
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

        // Aggregate decrements
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

// PUT /api/question (update)
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
            questionType,          // NEW FIELD
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
        if (questionType !== undefined) updateData.questionType = questionType;   // NEW

        // Track newly added mappings for cache update
        const newlyAddedMappings = [];

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
                if (!mergedMap.has(key)) {
                    newlyAddedMappings.push(m);
                }
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

        // Update metadata counts and cache for newly added mappings
        for (const m of newlyAddedMappings) {
            await updateMetadataCounts(m.class, m.subject, m.chapter, 1);
            updateCacheForNewMapping(m.class, m.subject, m.chapter);
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

// GET /api/questions (admin) with optional cursor/limit pagination
app.get('/api/questions', async (req, res) => {
    try {
        const { class: className, subject, chapter, cursor, limit: limitParam } = req.query;

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

        // If class, subject, chapter are provided, use mapping query with cursor pagination
        if (className && subject && chapter) {
            let query = db.collection('questions')
                .where('mappings', 'array-contains', { class: className, subject: subject, chapter: chapter })
                .orderBy('questionNo');

            if (cursor) {
                const cursorNum = parseInt(cursor, 10);
                if (isNaN(cursorNum)) {
                    return res.status(400).json({
                        success: false,
                        error: 'cursor must be a number'
                    });
                }
                query = query.startAfter(cursorNum);
            }

            query = query.limit(limit);
            const snapshot = await query.get();

            const questions = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                questions.push({
                    questionId: data.questionId,
                    questionText: data.questionText,
                    options: data.options,
                    correctIndex: data.correctIndex,
                    solutionText: data.solutionText,
                    questionImageUrl: data.questionImageUrl || null,
                    solutionVideoUrl: data.solutionVideoUrl || null,
                    solutionImageUrl: data.solutionImageUrl || null,
                    questionType: data.questionType || null,   // NEW FIELD
                    mappings: data.mappings,
                    questionNo: data.questionNo,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt
                });
            });

            let nextCursor = null;
            let hasMore = false;
            if (questions.length > 0) {
                const lastDoc = snapshot.docs[snapshot.docs.length - 1];
                nextCursor = lastDoc.data().questionNo;
                hasMore = snapshot.size === limit;
            }

            return res.json({
                success: true,
                questions,
                nextCursor,
                hasMore
            });
        }

        // Fallback: old behavior without pagination (legacy query merging)
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
                solutionImageUrl: q.solutionImageUrl || null,
                questionType: q.questionType || null,   // NEW FIELD
                questionNo: q.questionNo || null
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

// ---- METADATA ENDPOINTS (using cache) ----
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

// ---- API Endpoint: Ad Banners ----
app.get('/api/ad-banners', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                error: 'Database not initialized'
            });
        }

        // Read brandName from query parameters
        const brandName = req.query.brandName;
        if (!brandName) {
            return res.status(400).json({
                success: false,
                error: 'Missing required query parameter: brandName'
            });
        }

        // Fetch all banner documents
        const snapshot = await db.collection('ad_banner').get();

        // Filter documents by brandName
        const banners = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(doc => doc.brandName === brandName)
            .sort((a, b) => a.order - b.order); // optional: sort by order field

        res.json({
            success: true,
            data: banners
        });

    } catch (error) {
        console.error('Error fetching ad banners:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch ad banners'
        });
    }
});


// ---- API Endpoint: Ultimate Solutions ----
app.get('/api/ultimate-solutions', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({
                success: false,
                error: 'Database not initialized'
            });
        }

        const snapshot = await db
            .collection('ultimateSolution')
            .orderBy('order')
            .get();

        const data = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error('Error fetching ultimate solutions:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch ultimate solutions'
        });
    }
});

// ==================== NOTES ENDPOINT ====================
// GET /api/notes?className=...&subject=...&chapter=...
// Returns all matching notes with their full sections subcollection
app.get('/api/notes', async (req, res) => {
  try {
    const { className, subject, chapter } = req.query;

    // Validate required parameters
    if (!className || !subject || !chapter) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameters: className, subject, chapter'
      });
    }

    if (!db) {
      console.error('Firestore not initialized');
      return res.status(500).json({
        success: false,
        error: 'Database service unavailable'
      });
    }

    // Query notes collection for matching metadata
    const notesSnapshot = await db.collection('notes')
      .where('className', '==', className)
      .where('subject', '==', subject)
      .where('chapter', '==', chapter)
      .get();

    if (notesSnapshot.empty) {
      return res.json({
        success: true,
        data: []  // No notes found
      });
    }

    // For each matching note, fetch its sections subcollection
    const notesData = [];
    for (const noteDoc of notesSnapshot.docs) {
      const note = noteDoc.data();
      const noteId = noteDoc.id;

      // Fetch sections, ordered by 'order' ascending
      const sectionsSnapshot = await noteDoc.ref.collection('sections')
        .orderBy('order')        // assuming each section has an 'order' field
        .get();

      const sections = [];
      sectionsSnapshot.forEach(sectionDoc => {
        const sectionData = sectionDoc.data();
        sections.push({
          sectionId: sectionDoc.id,
          heading: sectionData.heading || '',
          subtle: sectionData.subtle || null,
          content: sectionData.content || [],
          imageUrl: sectionData.imageUrl || [],
          order: sectionData.order || 0,
          createdAt: sectionData.createdAt || null
        });
      });

      // Build the note object (include all note fields, optionally omit internal fields)
      notesData.push({
        noteId: noteId,
        titleText: note.titleText || '',
        subtleText: note.subtleText || '',
        className: note.className,
        subject: note.subject,
        chapter: note.chapter,
        order: note.order || 0,
        authorId: note.authorId || '',
        createdAt: note.createdAt || null,
        updatedAt: note.updatedAt || null,
        tags: note.tags || [],
        sections: sections
      });
    }

    res.json({
      success: true,
      data: notesData
    });

  } catch (error) {
    console.error('Error in /api/notes:', error);
    res.status(500).json({
      success: false,
      error: 'An internal server error occurred'
    });
  }
});

app.get('/health', (req, res) => res.send('Active'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
