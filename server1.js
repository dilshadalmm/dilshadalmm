const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.LECTURE_PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// ---------- Firebase Admin Initialization ----------
let firebaseInitialized = false;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('✅ Firebase Admin initialized (Lectures)');
    } else console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
} catch (err) {
    console.error('Failed to initialize Firebase Admin:', err.message);
}
const db = firebaseInitialized ? admin.firestore() : null;

// ---------- Helper: Normalization & Hashing ----------
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    let normalized = text.toLowerCase();
    normalized = normalized.replace(/[^\w\s]/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
}

function createLectureHash(lecture) {
    const normalizedClass = normalizeText(lecture.class);
    const normalizedSubject = normalizeText(lecture.subject);
    const normalizedChapter = normalizeText(lecture.chapter);
    const normalizedTitle = normalizeText(lecture.lectureTitle);
    const combined = `${normalizedClass}|${normalizedSubject}|${normalizedChapter}|${normalizedTitle}`;
    return crypto.createHash('sha256').update(combined).digest('hex');
}

function makeDocId(...parts) {
    return parts.map(p => p.replace(/[^a-zA-Z0-9]/g, '_')).join('_');
}

// ---------- Metadata Collections & Counts ----------
async function updateLectureMetadataCounts(className, subject, chapter, incrementBy) {
    if (!db) return;
    const classId = makeDocId('class', className);
    const subjectId = makeDocId('class', className, subject);
    const chapterId = makeDocId('class', className, subject, chapter);

    await db.collection('lecture_classes').doc(classId).set({
        name: className,
        totalLectures: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('lecture_subjects').doc(subjectId).set({
        class: className,
        subject: subject,
        totalLectures: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('lecture_chapters').doc(chapterId).set({
        class: className,
        subject: subject,
        chapter: chapter,
        totalLectures: admin.firestore.FieldValue.increment(incrementBy),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

// ---------- In-Memory Metadata Cache ----------
let metadataCache = {
    classes: new Set(),
    subjectsByClass: new Map(),      // className -> Set(subject)
    chaptersByClassSubject: new Map() // `${className}|${subject}` -> Set(chapter)
};

async function loadMetadataCache() {
    if (!db) return;
    console.log('Loading lecture metadata cache...');
    const newCache = {
        classes: new Set(),
        subjectsByClass: new Map(),
        chaptersByClassSubject: new Map()
    };

    const classesSnap = await db.collection('lecture_classes').get();
    classesSnap.forEach(doc => {
        const data = doc.data();
        if (data.name) newCache.classes.add(data.name);
    });

    const subjectsSnap = await db.collection('lecture_subjects').get();
    subjectsSnap.forEach(doc => {
        const data = doc.data();
        if (data.class && data.subject) {
            if (!newCache.subjectsByClass.has(data.class))
                newCache.subjectsByClass.set(data.class, new Set());
            newCache.subjectsByClass.get(data.class).add(data.subject);
        }
    });

    const chaptersSnap = await db.collection('lecture_chapters').get();
    chaptersSnap.forEach(doc => {
        const data = doc.data();
        if (data.class && data.subject && data.chapter) {
            const key = `${data.class}|${data.subject}`;
            if (!newCache.chaptersByClassSubject.has(key))
                newCache.chaptersByClassSubject.set(key, new Set());
            newCache.chaptersByClassSubject.get(key).add(data.chapter);
        }
    });

    metadataCache = newCache;
    console.log('Lecture metadata cache loaded.');
}

if (db) {
    loadMetadataCache().catch(err => console.error('Failed to load lecture metadata cache:', err));
}

function updateCacheForNewMapping(className, subject, chapter) {
    metadataCache.classes.add(className);
    if (!metadataCache.subjectsByClass.has(className))
        metadataCache.subjectsByClass.set(className, new Set());
    metadataCache.subjectsByClass.get(className).add(subject);
    const key = `${className}|${subject}`;
    if (!metadataCache.chaptersByClassSubject.has(key))
        metadataCache.chaptersByClassSubject.set(key, new Set());
    metadataCache.chaptersByClassSubject.get(key).add(chapter);
}

// ---------- Ingestion Queue Configuration ----------
const BATCH_SIZE = 20;
const MAX_CONCURRENT_BATCHES = 5;
const MAX_WAIT_MS = 100;
const RESPONSE_TIMEOUT_MS = 60000;

const requestQueue = [];
let activeBatches = 0;
let partialBatchTimeoutId = null;

// ---------- Firestore Helpers ----------
async function commitWrites(createWrites, updateWrites) {
    const allOps = [];
    for (const { ref, data } of createWrites) allOps.push({ type: 'set', ref, data });
    for (const { ref, data } of updateWrites) allOps.push({ type: 'update', ref, data });

    const chunkSize = 500;
    for (let i = 0; i < allOps.length; i += chunkSize) {
        const batch = db.batch();
        for (const op of allOps.slice(i, i + chunkSize)) {
            if (op.type === 'set') batch.set(op.ref, op.data);
            else batch.update(op.ref, op.data);
        }
        await batch.commit();
    }
}

async function getExistingLecturesByHashes(hashes) {
    if (!db || !hashes.length) return new Map();
    const map = new Map();
    const chunkSize = 10;
    for (let i = 0; i < hashes.length; i += chunkSize) {
        const chunk = hashes.slice(i, i + chunkSize);
        const snap = await db.collection('lectures')
            .where('hash', 'in', chunk)
            .get();
        snap.forEach(doc => map.set(doc.data().hash, { id: doc.id, ...doc.data() }));
    }
    return map;
}

// ---------- Batch Processing ----------
async function processBatch(batch) {
    const allLectures = [];
    for (const item of batch) {
        const { lectures, defaultClass, defaultSubject, defaultChapter } = item;
        if (!Array.isArray(lectures) || lectures.length === 0) continue;

        for (const lec of lectures) {
            // Apply defaults if missing
            const finalClass = lec.class || defaultClass;
            const finalSubject = lec.subject || defaultSubject;
            const finalChapter = lec.chapter || defaultChapter;
            if (!finalClass || !finalSubject || !finalChapter || !lec.lectureTitle || !lec.lectureVideoUrl) {
                console.warn('Skipping lecture missing required fields:', lec);
                continue;
            }
            const enriched = {
                ...lec,
                class: finalClass,
                subject: finalSubject,
                chapter: finalChapter,
            };
            const hash = createLectureHash(enriched);
            allLectures.push({ item, lecture: enriched, hash });
        }
    }

    if (allLectures.length === 0) {
        for (const item of batch) {
            if (!item.sent) {
                item.sent = true;
                clearTimeout(item.timeout);
                item.res.json({ status: 'success', message: 'No valid lectures provided.', lecturesProcessed: 0 });
            }
        }
        return;
    }

    const allHashes = allLectures.map(l => l.hash);
    const existingMap = await getExistingLecturesByHashes(allHashes);

    const createWrites = [];
    const updateWrites = [];
    const itemCounts = new Map(); // item -> { newCount, updatedCount }
    const metadataIncrements = new Map(); // key `${class}|${subject}|${chapter}` -> count
    const newMappingsSet = new Set(); // for cache update

    function getItemCounts(item) {
        if (!itemCounts.has(item)) itemCounts.set(item, { newCount: 0, updatedCount: 0 });
        return itemCounts.get(item);
    }

    // Group new lectures by mapping to assign lectureNo
    const newByMapping = new Map(); // key -> array of { lecture, item, hash }

    for (const { item, lecture, hash } of allLectures) {
        const mapping = { class: lecture.class, subject: lecture.subject, chapter: lecture.chapter };
        const key = `${mapping.class}|${mapping.subject}|${mapping.chapter}`;
        const counts = getItemCounts(item);

        if (!existingMap.has(hash)) {
            // New lecture
            if (!newByMapping.has(key)) newByMapping.set(key, []);
            newByMapping.get(key).push({ lecture, item, hash, mapping });
            counts.newCount++;
            metadataIncrements.set(key, (metadataIncrements.get(key) || 0) + 1);
            newMappingsSet.add(key);
        } else {
            // Existing lecture – update fields
            const existing = existingMap.get(hash);
            const docRef = db.collection('lectures').doc(existing.id);
            const updateData = {};
            for (const field of ['lectureTitle', 'lectureThumbnailUrl', 'lectureVideoUrl', 'lectureDescription',
                                 'tutorName', 'tutorProfileUrl', 'lectureTag', 'lectureNo']) {
                if (lecture[field] !== undefined) updateData[field] = lecture[field];
            }
            updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            updateWrites.push({ ref: docRef, data: updateData });
            counts.updatedCount++;
            // No metadata increment because mapping unchanged
        }
    }

    // Assign lectureNo for new lectures
    for (const [key, lecList] of newByMapping.entries()) {
        const [className, subject, chapter] = key.split('|');
        // Get current max lectureNo for this mapping
        let maxNo = 0;
        const maxQuery = await db.collection('lectures')
            .where('class', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter)
            .orderBy('lectureNo', 'desc')
            .limit(1)
            .get();
        if (!maxQuery.empty) maxNo = maxQuery.docs[0].data().lectureNo || 0;

        let nextNo = maxNo + 1;
        const usedInBatch = new Set();

        for (const { lecture, item, hash, mapping } of lecList) {
            let assignedNo = null;
            const incomingNo = lecture.lectureNo;
            if (incomingNo && Number.isInteger(incomingNo) && incomingNo > 0) {
                let isDuplicate = false;
                if (incomingNo <= maxNo) {
                    // check existing
                    const exist = await db.collection('lectures')
                        .where('class', '==', mapping.class)
                        .where('subject', '==', mapping.subject)
                        .where('chapter', '==', mapping.chapter)
                        .where('lectureNo', '==', incomingNo)
                        .limit(1)
                        .get();
                    isDuplicate = !exist.empty;
                } else {
                    isDuplicate = usedInBatch.has(incomingNo);
                }
                if (isDuplicate) {
                    assignedNo = nextNo++;
                } else {
                    assignedNo = incomingNo;
                    usedInBatch.add(assignedNo);
                    if (assignedNo > maxNo) {
                        maxNo = assignedNo;
                        nextNo = maxNo + 1;
                    }
                }
            } else {
                assignedNo = nextNo++;
            }
            lecture.lectureNo = assignedNo;

            const docRef = db.collection('lectures').doc(crypto.randomUUID());
            const docData = {
                lectureId: docRef.id,
                ...lecture,
                hash,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            createWrites.push({ ref: docRef, data: docData });
        }
    }

    // Commit all writes
    if (createWrites.length || updateWrites.length) {
        await commitWrites(createWrites, updateWrites);
    }

    // Update metadata counts & cache for new mappings
    for (const key of newMappingsSet) {
        const [className, subject, chapter] = key.split('|');
        const inc = metadataIncrements.get(key) || 1;
        await updateLectureMetadataCounts(className, subject, chapter, inc);
        updateCacheForNewMapping(className, subject, chapter);
    }

    // Send responses
    for (const item of batch) {
        if (!item.sent) {
            const counts = itemCounts.get(item) || { newCount: 0, updatedCount: 0 };
            item.sent = true;
            clearTimeout(item.timeout);
            item.res.json({
                status: 'success',
                message: `Processed ${counts.newCount + counts.updatedCount} lectures (${counts.newCount} new, ${counts.updatedCount} updated).`,
                lecturesProcessed: counts.newCount + counts.updatedCount
            });
        }
    }
}

function scheduleProcessing() {
    while (activeBatches < MAX_CONCURRENT_BATCHES && requestQueue.length >= BATCH_SIZE) {
        activeBatches++;
        const batch = requestQueue.splice(0, BATCH_SIZE);
        processBatch(batch).catch(err => {
            console.error('Batch processing error:', err);
            batch.forEach(item => {
                if (!item.sent) {
                    item.sent = true;
                    clearTimeout(item.timeout);
                    item.res.status(500).json({ status: 'error', message: 'Internal server error' });
                }
            });
        }).finally(() => {
            activeBatches--;
            scheduleProcessing();
        });
    }

    if (requestQueue.length > 0 && requestQueue.length < BATCH_SIZE && !partialBatchTimeoutId) {
        partialBatchTimeoutId = setTimeout(() => {
            partialBatchTimeoutId = null;
            scheduleProcessing();
        }, MAX_WAIT_MS);
    } else if (partialBatchTimeoutId && requestQueue.length === 0) {
        clearTimeout(partialBatchTimeoutId);
        partialBatchTimeoutId = null;
    }
}

function setupRequestTimeout(item) {
    item.timeout = setTimeout(() => {
        if (!item.sent) {
            item.sent = true;
            item.res.json({ status: 'error', message: 'Request timeout', lecturesProcessed: 0 });
        }
    }, RESPONSE_TIMEOUT_MS);
}

// ---------- API Endpoints ----------

// 1. Ingestion
app.post('/api/lectures/ingest', async (req, res) => {
    try {
        const { lectures, class: defaultClass, subject: defaultSubject, chapter: defaultChapter } = req.body;
        if (!lectures || !Array.isArray(lectures)) {
            return res.status(400).json({ status: 'error', message: 'lectures array is required' });
        }
        if (!defaultClass || !defaultSubject || !defaultChapter) {
            return res.status(400).json({ status: 'error', message: 'class, subject, chapter defaults are required' });
        }

        const item = { res, lectures, defaultClass, defaultSubject, defaultChapter, sent: false, timeout: null };
        setupRequestTimeout(item);
        requestQueue.push(item);
        scheduleProcessing();
    } catch (err) {
        console.error('Ingestion error:', err);
        if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Internal error' });
    }
});

// 2. Playlist for frontend (sorted by lectureNo)
app.get('/api/lectures/playlist', async (req, res) => {
    try {
        const { class: className, subject, chapter, cursor, limit = 20 } = req.query;
        if (!className || !subject || !chapter) {
            return res.status(400).json({ success: false, error: 'class, subject, chapter required' });
        }
        if (!db) return res.status(500).json({ success: false, error: 'Database unavailable' });

        let query = db.collection('lectures')
            .where('class', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter)
            .orderBy('lectureNo');

        if (cursor) {
            const cursorNum = parseInt(cursor, 10);
            if (isNaN(cursorNum)) return res.status(400).json({ success: false, error: 'cursor must be number' });
            query = query.startAfter(cursorNum);
        }

        const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
        query = query.limit(limitNum);
        const snapshot = await query.get();

        const lectures = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            lectures.push({
                lectureId: d.lectureId,
                lectureNo: d.lectureNo,
                lectureTitle: d.lectureTitle,
                lectureThumbnailUrl: d.lectureThumbnailUrl || null,
                lectureVideoUrl: d.lectureVideoUrl,
                lectureDescription: d.lectureDescription || '',
                tutorName: d.tutorName || '',
                tutorProfileUrl: d.tutorProfileUrl || null,
                lectureTag: d.lectureTag || '',
            });
        });

        let nextCursor = null;
        let hasMore = false;
        if (lectures.length > 0) {
            const last = snapshot.docs[snapshot.docs.length - 1];
            nextCursor = last.data().lectureNo;
            hasMore = snapshot.size === limitNum;
        }

        res.json({ success: true, lectures, nextCursor, hasMore });
    } catch (err) {
        console.error('Playlist error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// 3. Single lecture fetch
app.get('/api/lectures/lecture', async (req, res) => {
    try {
        const { class: className, subject, chapter, lectureNo } = req.query;
        if (!className || !subject || !chapter || !lectureNo) {
            return res.status(400).json({ success: false, error: 'class, subject, chapter, lectureNo required' });
        }
        const num = parseInt(lectureNo, 10);
        if (isNaN(num)) return res.status(400).json({ success: false, error: 'lectureNo must be number' });

        const snap = await db.collection('lectures')
            .where('class', '==', className)
            .where('subject', '==', subject)
            .where('chapter', '==', chapter)
            .where('lectureNo', '==', num)
            .limit(1)
            .get();
        if (snap.empty) return res.status(404).json({ success: false, error: 'Lecture not found' });
        res.json({ success: true, lecture: snap.docs[0].data() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});

// 4. Update lecture (cannot change class/subject/chapter)
app.put('/api/lectures/lecture', async (req, res) => {
    try {
        const { lectureId, ...updates } = req.body;
        if (!lectureId) return res.status(400).json({ success: false, error: 'lectureId required' });

        const docRef = db.collection('lectures').doc(lectureId);
        const doc = await docRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, error: 'Lecture not found' });

        const current = doc.data();
        // Prevent changing class/subject/chapter
        if (updates.class || updates.subject || updates.chapter) {
            return res.status(400).json({ success: false, error: 'Cannot change class, subject, or chapter. Delete and re-ingest.' });
        }

        const updateData = {};
        const allowed = ['lectureTitle', 'lectureThumbnailUrl', 'lectureVideoUrl', 'lectureDescription',
                         'tutorName', 'tutorProfileUrl', 'lectureTag', 'lectureNo'];
        for (const field of allowed) {
            if (updates[field] !== undefined) updateData[field] = updates[field];
        }
        if (updates.lectureTitle !== undefined) {
            // Recompute hash
            const newLecture = { ...current, lectureTitle: updates.lectureTitle };
            updateData.hash = createLectureHash(newLecture);
        }
        updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await docRef.update(updateData);
        res.json({ success: true, message: 'Lecture updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Update failed' });
    }
});

// 5. Delete single lecture
app.delete('/api/lectures/lecture', async (req, res) => {
    try {
        const { lectureId } = req.body;
        if (!lectureId) return res.status(400).json({ success: false, error: 'lectureId required' });

        const docRef = db.collection('lectures').doc(lectureId);
        const doc = await docRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });

        const data = doc.data();
        await docRef.delete();
        await updateLectureMetadataCounts(data.class, data.subject, data.chapter, -1);
        // Note: cache not purged, will be refreshed on restart
        res.json({ success: true, message: 'Lecture deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Delete failed' });
    }
});

// 6. Bulk delete by class/subject/chapter or list of IDs
app.delete('/api/lectures/bulk', async (req, res) => {
    try {
        const { lectureIds, class: className, subject, chapter } = req.body;
        if (!db) return res.status(500).json({ success: false, error: 'DB unavailable' });

        let refs = [];
        if (lectureIds && Array.isArray(lectureIds)) {
            for (const id of lectureIds) refs.push(db.collection('lectures').doc(id));
        } else if (className && subject && chapter) {
            const snap = await db.collection('lectures')
                .where('class', '==', className)
                .where('subject', '==', subject)
                .where('chapter', '==', chapter)
                .get();
            refs = snap.docs.map(d => d.ref);
        } else {
            return res.status(400).json({ success: false, error: 'Provide lectureIds or class+subject+chapter' });
        }

        if (refs.length === 0) return res.json({ success: true, deletedCount: 0 });

        // Fetch metadata before deletion
        const docsData = [];
        for (const ref of refs) {
            const snap = await ref.get();
            if (snap.exists) docsData.push(snap.data());
        }

        // Batch delete
        for (let i = 0; i < refs.length; i += 500) {
            const batch = db.batch();
            for (const ref of refs.slice(i, i + 500)) batch.delete(ref);
            await batch.commit();
        }

        // Update metadata counts
        const decrementMap = new Map();
        for (const data of docsData) {
            const key = `${data.class}|${data.subject}|${data.chapter}`;
            decrementMap.set(key, (decrementMap.get(key) || 0) + 1);
        }
        for (const [key, count] of decrementMap.entries()) {
            const [c, s, ch] = key.split('|');
            await updateLectureMetadataCounts(c, s, ch, -count);
        }

        res.json({ success: true, deletedCount: refs.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Bulk delete failed' });
    }
});

// 7. Admin: list lectures with optional filters & pagination
app.get('/api/lectures/admin/list', async (req, res) => {
    try {
        const { class: className, subject, chapter, cursor, limit = 50 } = req.query;
        let query = db.collection('lectures');
        if (className) query = query.where('class', '==', className);
        if (subject) query = query.where('subject', '==', subject);
        if (chapter) query = query.where('chapter', '==', chapter);
        query = query.orderBy('lectureNo');

        if (cursor) {
            const cursorNum = parseInt(cursor, 10);
            if (!isNaN(cursorNum)) query = query.startAfter(cursorNum);
        }

        const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
        const snap = await query.limit(limitNum).get();
        const lectures = [];
        snap.forEach(doc => lectures.push(doc.data()));

        let nextCursor = null;
        if (lectures.length > 0 && snap.size === limitNum) {
            nextCursor = lectures[lectures.length - 1].lectureNo;
        }
        res.json({ success: true, lectures, nextCursor });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'List error' });
    }
});

// 8. Metadata endpoints for dropdowns
app.get('/api/lectures/classes', async (req, res) => {
    try {
        res.json({ success: true, classes: Array.from(metadataCache.classes).sort() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/lectures/subjects', async (req, res) => {
    const { class: className } = req.query;
    if (!className) return res.status(400).json({ success: false, error: 'class required' });
    const subjects = metadataCache.subjectsByClass.get(className) || new Set();
    res.json({ success: true, subjects: Array.from(subjects).sort() });
});

app.get('/api/lectures/chapters', async (req, res) => {
    const { class: className, subject } = req.query;
    if (!className || !subject) return res.status(400).json({ success: false, error: 'class and subject required' });
    const key = `${className}|${subject}`;
    const chapters = metadataCache.chaptersByClassSubject.get(key) || new Set();
    res.json({ success: true, chapters: Array.from(chapters).sort() });
});

// Health check
app.get('/health', (req, res) => res.send('Lecture server active'));

// Start server
app.listen(PORT, () => console.log(`Lecture server running on port ${PORT}`));
