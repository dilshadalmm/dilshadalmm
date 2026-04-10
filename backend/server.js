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

// -------------------------------
// 1. Reusable In‑Memory Queue Class
// -------------------------------
/**
 * A queue that processes async jobs with a fixed concurrency limit and max queue size.
 * - FIFO order
 * - Automatically starts next job when a worker becomes free
 * - Rejects new jobs when queue is full
 */
class Queue {
  /**
   * @param {number} concurrency - Number of jobs processed simultaneously
   * @param {number} maxSize - Maximum number of waiting jobs allowed
   */
  constructor(concurrency, maxSize) {
    this.concurrency = concurrency;   // e.g., 50
    this.maxSize = maxSize;           // e.g., 5000
    this.queue = [];                  // { fn, resolve, reject }
    this.activeCount = 0;             // Currently running jobs
  }

  /**
   * Adds a job to the queue.
   * Returns a Promise that resolves with the job's return value or rejects on error.
   * @param {Function} fn - Async function representing the job
   * @returns {Promise<any>}
   */
  add(fn) {
    return new Promise((resolve, reject) => {
      // Reject immediately if queue is already at capacity
      if (this.queue.length >= this.maxSize) {
        reject(new Error('QUEUE_FULL: Server is busy, please try again later.'));
        return;
      }

      // Store job with its resolve/reject callbacks
      this.queue.push({ fn, resolve, reject });
      this._processNext();
    });
  }

  /**
   * Internal method that starts a new job if concurrency allows.
   * Called after a job is added or when a worker finishes.
   */
  _processNext() {
    // Do not exceed concurrency limit
    if (this.activeCount >= this.concurrency) return;
    if (this.queue.length === 0) return;

    // Dequeue next job (FIFO)
    const { fn, resolve, reject } = this.queue.shift();
    this.activeCount++;

    // Execute job, capture result/error, then resolve/reject the outer Promise
    Promise.resolve(fn())
      .then(result => resolve(result))
      .catch(err => reject(err))
      .finally(() => {
        // Worker freed – decrement counter and try to start another job
        this.activeCount--;
        this._processNext();
      });
  }
}

// -------------------------------
// 2. Create Six Queue Instances
// -------------------------------
// Each endpoint gets its own queue: concurrency=50, maxQueueSize=5000
const filterPostsQueue = new Queue(50, 5000);
const classesQueue      = new Queue(50, 5000);
const subjectsQueue     = new Queue(50, 5000);
const chaptersQueue     = new Queue(50, 5000);
const tutorsQueue       = new Queue(50, 5000);
const postsQueue        = new Queue(50, 5000);

// -------------------------------
// 3. Firebase Admin Initialization
// -------------------------------
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

// Health check (no queue needed)
app.get('/health', (req, res) => res.send('Active'));

// -------------------------------
// 4. Endpoint Wrappers with Queue Processing
// -------------------------------
// Helper to send standardized error responses
const handleError = (err, res) => {
  if (err.message === 'QUEUE_FULL: Server is busy, please try again later.') {
    return res.status(503).json({ error: err.message });
  }
  if (err.message.startsWith('BAD_REQUEST:')) {
    const cleanMsg = err.message.replace('BAD_REQUEST:', '').trim();
    return res.status(400).json({ error: cleanMsg });
  }
  console.error('Unhandled error in queued job:', err);
  res.status(500).json({ error: 'Internal server error' });
};

// ---------- Endpoint 1: Filter Posts ----------
app.get('/filter-posts', async (req, res) => {
  try {
    const result = await filterPostsQueue.add(async () => {
      if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

      const { classId, subjectId, chapterId, tutorId } = req.query;
      if (!classId || !subjectId || !chapterId || !tutorId) {
        throw new Error('BAD_REQUEST: classId, subjectId, chapterId, and tutorId are required');
      }

      let query = db.collection('posts');
      query = query.where('classId', '==', classId)
                   .where('subjectId', '==', subjectId)
                   .where('chapterId', '==', chapterId)
                   .where('tutorId', '==', tutorId)
                   .orderBy('createdAt', 'asc');

      const snapshot = await query.get();
      const posts = [];
      snapshot.forEach(doc => posts.push({ id: doc.id, ...doc.data() }));
      return posts;
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------- Endpoint 2: Get All Classes ----------
app.get('/classes', async (req, res) => {
  try {
    const result = await classesQueue.add(async () => {
      if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
      const snapshot = await db.collection('classes').get();
      const classes = [];
      snapshot.forEach(doc => classes.push({ id: doc.id, ...doc.data() }));
      return classes;
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------- Endpoint 3: Filter Subjects by classId ----------
app.get('/subjects', async (req, res) => {
  try {
    const result = await subjectsQueue.add(async () => {
      if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
      const { classId } = req.query;
      if (!classId) throw new Error('BAD_REQUEST: classId is required');

      const snapshot = await db.collection('subjects').where('classId', '==', classId).get();
      const subjects = [];
      snapshot.forEach(doc => subjects.push({ id: doc.id, ...doc.data() }));
      return subjects;
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------- Endpoint 4: Filter Chapters by classId + subjectId ----------
app.get('/chapters', async (req, res) => {
  try {
    const result = await chaptersQueue.add(async () => {
      if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
      const { classId, subjectId } = req.query;
      if (!classId || !subjectId) {
        throw new Error('BAD_REQUEST: classId and subjectId are required');
      }

      let query = db.collection('chapters');
      query = query.where('classId', '==', classId).where('subjectId', '==', subjectId);
      const snapshot = await query.get();
      const chapters = [];
      snapshot.forEach(doc => chapters.push({ id: doc.id, ...doc.data() }));
      return chapters;
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------- Endpoint 5: Filter Tutors by classId + subjectId + chapterId ----------
app.get('/tutors', async (req, res) => {
  try {
    const result = await tutorsQueue.add(async () => {
      if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
      const { classId, subjectId, chapterId } = req.query;
      if (!classId || !subjectId || !chapterId) {
        throw new Error('BAD_REQUEST: classId, subjectId, and chapterId are required');
      }

      let query = db.collection('tutors');
      query = query.where('classId', '==', classId)
                   .where('subjectId', '==', subjectId)
                   .where('chapterId', '==', chapterId);
      const snapshot = await query.get();
      const tutors = [];
      snapshot.forEach(doc => tutors.push({ id: doc.id, ...doc.data() }));
      return tutors;
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ---------- Endpoint 6: Cursor-based Pagination for Posts ----------
app.get('/api/posts', async (req, res) => {
  try {
    const result = await postsQueue.add(async () => {
      if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

      // 1. Parse and validate limit
      let limit = parseInt(req.query.limit) || 10;
      if (limit < 1) limit = 10;
      const MAX_LIMIT = 50;
      limit = Math.min(limit, MAX_LIMIT);

      // 2. Parse cursor safely
      let cursor = null;
      if (req.query.cursor) {
        try {
          const rawCursor = JSON.parse(req.query.cursor);
          if (!rawCursor.createdAt || !rawCursor.id) {
            throw new Error('BAD_REQUEST: Invalid cursor: missing createdAt or id');
          }
          let timestamp;
          if (rawCursor.createdAt._seconds !== undefined) {
            timestamp = new admin.firestore.Timestamp(
              rawCursor.createdAt._seconds,
              rawCursor.createdAt._nanoseconds || 0
            );
          } else {
            const date = new Date(rawCursor.createdAt);
            if (isNaN(date.getTime())) {
              throw new Error('BAD_REQUEST: Invalid cursor: createdAt is not a valid date');
            }
            timestamp = admin.firestore.Timestamp.fromDate(date);
          }
          cursor = {
            createdAt: timestamp,
            id: rawCursor.id
          };
        } catch (e) {
          throw new Error(`BAD_REQUEST: Invalid cursor JSON - ${e.message}`);
        }
      }

      // 3. Build query
      let query = db.collection('posts')
        .orderBy('createdAt', 'desc')
        .orderBy(admin.firestore.FieldPath.documentId());

      if (cursor) {
        query = query.startAfter(cursor.createdAt, cursor.id);
      }
      query = query.limit(limit + 1);

      // 4. Execute query
      const snapshot = await query.get();
      const docs = snapshot.docs;
      const hasMore = docs.length > limit;
      const resultDocs = hasMore ? docs.slice(0, limit) : docs;

      // 5. Format data
      const data = resultDocs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      // 6. Build nextCursor
      let nextCursor = null;
      if (hasMore) {
        const lastDoc = resultDocs[resultDocs.length - 1];
        const lastData = lastDoc.data();
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

      return { data, nextCursor, hasMore };
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
