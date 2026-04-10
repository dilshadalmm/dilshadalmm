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
const db = (() => {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            firebaseInitialized = true;
            console.log('✅ Firebase Admin initialized');
            return admin.firestore();
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
            return null;
        }
    } catch (err) {
        console.error('Failed to initialize Firebase Admin:', err.message);
        return null;
    }
})();

// Health check
app.get('/health', (req, res) => res.send('Active'));

// 1. Filter posts by classId, subjectId, chapterId, tutorId (all required, oldest first)
app.get('/filter-posts', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

        const { classId, subjectId, chapterId, tutorId } = req.query;

        // All parameters are now required
        if (!classId || !subjectId || !chapterId || !tutorId) {
            return res.status(400).json({ error: 'classId, subjectId, chapterId, and tutorId are required' });
        }

        let query = db.collection('posts');
        query = query.where('classId', '==', classId)
                     .where('subjectId', '==', subjectId)
                     .where('chapterId', '==', chapterId)
                     .where('tutorId', '==', tutorId);
        query = query.orderBy('createdAt', 'asc');

        const snapshot = await query.get();
        const posts = [];
        snapshot.forEach(doc => posts.push({ id: doc.id, ...doc.data() }));
        res.json(posts);
    } catch (err) {
    console.error('Filter posts error:', err.message); // This will print the index URL
    res.status(500).json({ error: err.message });
    }
});

// 2. Fetch all classes
app.get('/classes', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Firestore not initialized' });
        const snapshot = await db.collection('classes').get();
        const classes = [];
        snapshot.forEach(doc => classes.push({ id: doc.id, ...doc.data() }));
        res.json(classes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Filter subjects by classId (required)
app.get('/subjects', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Firestore not initialized' });
        const { classId } = req.query;
        if (!classId) return res.status(400).json({ error: 'classId is required' });

        const snapshot = await db.collection('subjects').where('classId', '==', classId).get();
        const subjects = [];
        snapshot.forEach(doc => subjects.push({ id: doc.id, ...doc.data() }));
        res.json(subjects);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Filter chapters by classId and subjectId (both required)
app.get('/chapters', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Firestore not initialized' });
        const { classId, subjectId } = req.query;
        if (!classId || !subjectId) return res.status(400).json({ error: 'classId and subjectId are required' });

        let query = db.collection('chapters');
        query = query.where('classId', '==', classId).where('subjectId', '==', subjectId);
        const snapshot = await query.get();
        const chapters = [];
        snapshot.forEach(doc => chapters.push({ id: doc.id, ...doc.data() }));
        res.json(chapters);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Filter tutors by classId, subjectId, chapterId (all required)
app.get('/tutors', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Firestore not initialized' });
        const { classId, subjectId, chapterId } = req.query;
        if (!classId || !subjectId || !chapterId) {
            return res.status(400).json({ error: 'classId, subjectId, and chapterId are required' });
        }

        let query = db.collection('tutors');
        query = query.where('classId', '==', classId)
                     .where('subjectId', '==', subjectId)
                     .where('chapterId', '==', chapterId);
        const snapshot = await query.get();
        const tutors = [];
        snapshot.forEach(doc => tutors.push({ id: doc.id, ...doc.data() }));
        res.json(tutors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//====================================================================================================

// 6. Cursor-based pagination for posts

app.get('/api/posts', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'Firestore not initialized' });

        // --- 1. Parse and validate limit ---
        let limit = parseInt(req.query.limit) || 10;
        if (limit < 1) limit = 10;
        const MAX_LIMIT = 50;
        limit = Math.min(limit, MAX_LIMIT);

        // --- 2. Parse cursor safely ---
        let cursor = null;
        if (req.query.cursor) {
            try {
                const rawCursor = JSON.parse(req.query.cursor);
                // Validate required fields
                if (!rawCursor.createdAt || !rawCursor.id) {
                    return res.status(400).json({ error: 'Invalid cursor: missing createdAt or id' });
                }
                // Convert createdAt to Firestore Timestamp
                let timestamp;
                if (rawCursor.createdAt._seconds !== undefined) {
                    // Already serialized Firestore Timestamp format
                    timestamp = new admin.firestore.Timestamp(
                        rawCursor.createdAt._seconds,
                        rawCursor.createdAt._nanoseconds || 0
                    );
                } else {
                    // Attempt to parse as ISO string or timestamp number
                    const date = new Date(rawCursor.createdAt);
                    if (isNaN(date.getTime())) {
                        return res.status(400).json({ error: 'Invalid cursor: createdAt is not a valid date' });
                    }
                    timestamp = admin.firestore.Timestamp.fromDate(date);
                }
                cursor = {
                    createdAt: timestamp,
                    id: rawCursor.id
                };
            } catch (e) {
                return res.status(400).json({ error: 'Invalid cursor JSON' });
            }
        }

        // --- 3. Build query ---
        let query = db.collection('posts')
            .orderBy('createdAt', 'desc')
            .orderBy(admin.firestore.FieldPath.documentId());

        if (cursor) {
            query = query.startAfter(cursor.createdAt, cursor.id);
        }

        // Fetch one extra to determine hasMore
        query = query.limit(limit + 1);

        // --- 4. Execute query ---
        const snapshot = await query.get();

        // --- 5. Determine hasMore ---
        const docs = snapshot.docs;
        const hasMore = docs.length > limit;
        const resultDocs = hasMore ? docs.slice(0, limit) : docs;

        // --- 6. Format data ---
        const data = resultDocs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        // --- 7. Build nextCursor ---
        let nextCursor = null;
        if (hasMore) {
            const lastDoc = resultDocs[resultDocs.length - 1];
            const lastData = lastDoc.data();
            // Ensure createdAt is a Firestore Timestamp
            const createdAt = lastData.createdAt;
            if (!createdAt || !(createdAt instanceof admin.firestore.Timestamp)) {
                throw new Error('Post document missing valid createdAt Timestamp');
            }
            nextCursor = {
                createdAt: {
                    _seconds: createdAt.seconds,
                    _nanoseconds: createdAt.nanoseconds
                },
                id: lastDoc.id
            };
        }

        // --- 8. Send response ---
        res.json({
            data,
            nextCursor,
            hasMore
        });

    } catch (err) {
        console.error('Pagination error:', err.message);
        res.status(500).json({ error: err.message });
    }
});



// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
