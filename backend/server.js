const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// -------------------------------
// 1. Improved Reusable Queue Class
// -------------------------------
/**
 * In‑memory queue with concurrency control, max total requests, timeout protection, and request IDs.
 * - FIFO order
 * - Automatically starts next jobs when workers free
 * - Rejects new jobs when (waiting + active) >= maxSize
 * - Each job has a unique requestId for debugging
 */
class Queue {
  /**
   * @param {number} concurrency - Number of jobs processed simultaneously (e.g., 50)
   * @param {number} maxSize - Maximum total requests allowed (waiting + active) (e.g., 5000)
   * @param {number} timeoutMs - Job timeout in milliseconds (default 30000)
   */
  constructor(concurrency, maxSize, timeoutMs = 30000) {
    this.concurrency = concurrency;
    this.maxSize = maxSize;
    this.timeoutMs = timeoutMs;
    this.queue = [];           // { id, fn, resolve, reject }
    this.activeCount = 0;
  }

  /**
   * Returns current queue statistics.
   * @returns {Object} { waiting, active, concurrency, maxSize }
   */
  getStats() {
    return {
      waiting: this.queue.length,
      active: this.activeCount,
      concurrency: this.concurrency,
      maxSize: this.maxSize
    };
  }

  /**
   * Adds a job to the queue.
   * Returns a Promise that resolves with the job's return value or rejects on error/timeout.
   * @param {Function} fn - Async function representing the job
   * @returns {Promise<any>}
   */
  add(fn) {
    return new Promise((resolve, reject) => {
      // Correct capacity check: waiting + active >= maxSize
      if (this.queue.length + this.activeCount >= this.maxSize) {
        reject(new Error('QUEUE_FULL: Server is busy, please try again later.'));
        return;
      }

      const requestId = crypto.randomUUID();
      this.queue.push({ id: requestId, fn, resolve, reject });
      this._log(`Job ${requestId} added. Waiting: ${this.queue.length}, Active: ${this.activeCount}`);
      this._processAvailable();
    });
  }

  /**
   * Starts as many jobs as allowed by concurrency (while loop).
   * Called after a job is added or when a worker finishes.
   */
  _processAvailable() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.activeCount++;
      this._executeJob(job);
    }
  }

  /**
   * Executes a single job with timeout protection.
   * @param {Object} job - { id, fn, resolve, reject }
   */
  _executeJob(job) {
    this._log(`Job ${job.id} started. Active: ${this.activeCount}`);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`JOB_TIMEOUT: Job ${job.id} exceeded ${this.timeoutMs}ms`)), this.timeoutMs)
    );

    Promise.race([job.fn(), timeoutPromise])
      .then(result => {
        job.resolve(result);
        this._log(`Job ${job.id} completed successfully.`);
      })
      .catch(err => {
        job.reject(err);
        this._log(`Job ${job.id} failed: ${err.message}`);
      })
      .finally(() => {
        this.activeCount--;
        this._log(`Job ${job.id} finished. Active: ${this.activeCount}`);
        this._processAvailable(); // start next waiting jobs
      });
  }

  /**
   * Conditional logging (only when not in production).
   * @param {string} message
   */
  _log(message) {
    if (!isProduction) {
      console.log(`[Queue] ${message}`);
    }
  }
}

// -------------------------------
// 2. Create Six Queue Instances
// -------------------------------
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
// 4. Queue Monitoring Endpoint
// -------------------------------
app.get('/queue-stats', (req, res) => {
  res.json({
    filterPosts: filterPostsQueue.getStats(),
    classes: classesQueue.getStats(),
    subjects: subjectsQueue.getStats(),
    chapters: chaptersQueue.getStats(),
    tutors: tutorsQueue.getStats(),
    posts: postsQueue.getStats()
  });
});

// -------------------------------
// 5. Endpoint Wrappers with Queue Processing
// -------------------------------
// Helper to send standardized error responses
const handleError = (err, res) => {
  if (err.message === 'QUEUE_FULL: Server is busy, please try again later.') {
    return res.status(503).json({ error: err.message });
  }
  if (err.message.startsWith('JOB_TIMEOUT:')) {
    return res.status(504).json({ error: 'Request timeout, please try again.' });
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
