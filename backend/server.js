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
// 1. Queue Class (unchanged, improved)
// -------------------------------
class Queue {
  constructor(concurrency, maxSize, timeoutMs = 30000) {
    this.concurrency = concurrency;
    this.maxSize = maxSize;
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.activeCount = 0;
  }

  getStats() {
    return {
      waiting: this.queue.length,
      active: this.activeCount,
      concurrency: this.concurrency,
      maxSize: this.maxSize
    };
  }

  add(fn) {
    return new Promise((resolve, reject) => {
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

  _processAvailable() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.activeCount++;
      this._executeJob(job);
    }
  }

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
        this._processAvailable();
      });
  }

  _log(message) {
    if (!isProduction) console.log(`[Queue] ${message}`);
  }
}

// -------------------------------
// 2. Factory Pattern: Zero Boilerplate
// -------------------------------
// Global registry for queue stats
const QUEUE_REGISTRY = [];

/**
 * Creates a queued endpoint with automatic queue management, error handling, and stats.
 * @param {Object} config
 * @param {string} config.method - HTTP method (get, post, put, delete)
 * @param {string} config.path - Express route path
 * @param {string} config.queueName - Unique name for this queue (used in stats)
 * @param {number} config.concurrency - Concurrent jobs allowed (default 50)
 * @param {number} config.maxSize - Max total requests (waiting + active) (default 5000)
 * @param {number} config.timeoutMs - Job timeout in ms (default 30000)
 * @param {Function} config.handler - Async function (req, db) => data (return value sent as JSON)
 */
function createQueuedEndpoint({
  method,
  path,
  queueName,
  concurrency = 50,
  maxSize = 5000,
  timeoutMs = 30000,
  handler
}) {
  // 1. Create dedicated queue instance
  const queue = new Queue(concurrency, maxSize, timeoutMs);
  
  // 2. Register for stats endpoint
  QUEUE_REGISTRY.push({ name: queueName, queue });
  
  // 3. Define Express route handler
  app[method](path, async (req, res) => {
    try {
      // Pass req and db to the business logic
      const result = await queue.add(() => handler(req, db));
      res.json(result);
    } catch (err) {
      // Reuse existing error handling logic
      handleError(err, res);
    }
  });
}

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

// -------------------------------
// 4. Error Handler (unchanged)
// -------------------------------
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

// -------------------------------
// 5. Health Check (no queue)
// -------------------------------
app.get('/health', (req, res) => res.send('Active'));

// -------------------------------
// 6. Dynamic Queue Stats Endpoint
// -------------------------------
app.get('/queue-stats', (req, res) => {
  const stats = {};
  for (const { name, queue } of QUEUE_REGISTRY) {
    stats[name] = queue.getStats();
  }
  res.json(stats);
});

// -------------------------------
// 7. All Endpoints Defined Declaratively (ZERO BOILERPLATE)
// -------------------------------

// Endpoint 1: Filter posts
createQueuedEndpoint({
  method: 'get',
  path: '/filter-posts',
  queueName: 'filterPosts',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    const { classId, subjectId, chapterId, tutorId } = req.query;
    if (!classId || !subjectId || !chapterId || !tutorId) {
      throw new Error('BAD_REQUEST: classId, subjectId, chapterId, and tutorId are required');
    }
    let query = db.collection('posts')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId)
      .where('chapterId', '==', chapterId)
      .where('tutorId', '==', tutorId)
      .orderBy('createdAt', 'asc');
    const snapshot = await query.get();
    const posts = [];
    snapshot.forEach(doc => posts.push({ id: doc.id, ...doc.data() }));
    return posts;
  }
});

// Endpoint 2: Get all classes
createQueuedEndpoint({
  method: 'get',
  path: '/classes',
  queueName: 'classes',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    const snapshot = await db.collection('classes').get();
    const classes = [];
    snapshot.forEach(doc => classes.push({ id: doc.id, ...doc.data() }));
    return classes;
  }
});

// Endpoint 3: Filter subjects by classId
createQueuedEndpoint({
  method: 'get',
  path: '/subjects',
  queueName: 'subjects',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    const { classId } = req.query;
    if (!classId) throw new Error('BAD_REQUEST: classId is required');
    const snapshot = await db.collection('subjects').where('classId', '==', classId).get();
    const subjects = [];
    snapshot.forEach(doc => subjects.push({ id: doc.id, ...doc.data() }));
    return subjects;
  }
});

// Endpoint 4: Filter chapters by classId + subjectId
createQueuedEndpoint({
  method: 'get',
  path: '/chapters',
  queueName: 'chapters',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    const { classId, subjectId } = req.query;
    if (!classId || !subjectId) {
      throw new Error('BAD_REQUEST: classId and subjectId are required');
    }
    let query = db.collection('chapters')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId);
    const snapshot = await query.get();
    const chapters = [];
    snapshot.forEach(doc => chapters.push({ id: doc.id, ...doc.data() }));
    return chapters;
  }
});

// Endpoint 5: Filter tutors by classId + subjectId + chapterId
createQueuedEndpoint({
  method: 'get',
  path: '/tutors',
  queueName: 'tutors',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    const { classId, subjectId, chapterId } = req.query;
    if (!classId || !subjectId || !chapterId) {
      throw new Error('BAD_REQUEST: classId, subjectId, and chapterId are required');
    }
    let query = db.collection('tutors')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId)
      .where('chapterId', '==', chapterId);
    const snapshot = await query.get();
    const tutors = [];
    snapshot.forEach(doc => tutors.push({ id: doc.id, ...doc.data() }));
    return tutors;
  }
});

// Endpoint 6: Cursor-based pagination for posts
createQueuedEndpoint({
  method: 'get',
  path: '/api/posts',
  queueName: 'posts',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    // Parse limit
    let limit = parseInt(req.query.limit) || 10;
    if (limit < 1) limit = 10;
    const MAX_LIMIT = 50;
    limit = Math.min(limit, MAX_LIMIT);

    // Parse cursor
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
        cursor = { createdAt: timestamp, id: rawCursor.id };
      } catch (e) {
        throw new Error(`BAD_REQUEST: Invalid cursor JSON - ${e.message}`);
      }
    }

    // Build query
    let query = db.collection('posts')
      .orderBy('createdAt', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
    query = query.limit(limit + 1);

    const snapshot = await query.get();
    const docs = snapshot.docs;
    const hasMore = docs.length > limit;
    const resultDocs = hasMore ? docs.slice(0, limit) : docs;

    const data = resultDocs.map(doc => ({ id: doc.id, ...doc.data() }));

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
  }
});

// -------------------------------
// 8. Start Server
// -------------------------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
