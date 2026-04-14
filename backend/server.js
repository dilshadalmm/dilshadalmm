// npm install express-rate-limit pino pino-pretty

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// -------------------------------
// In-Memory Cache
// -------------------------------
const cache = new Map();

function getCache(key) {
  return cache.has(key) ? cache.get(key) : null;
}

function setCache(key, value) {
  cache.set(key, value);
}

function invalidatePattern(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

function generatePostsKey(classId, subjectId, tutorId, chapterId, cursor) {
  const cursorHash = crypto.createHash('md5').update(cursor || 'firstPage').digest('hex');
  const chapter = chapterId || 'all';
  return `posts:${classId}:${subjectId}:${tutorId}:${chapter}:${cursorHash}`;
}

// -------------------------------
// Logger setup
// -------------------------------
const logger = pino({
  level: isProduction ? 'info' : 'debug',
  transport: !isProduction ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

// -------------------------------
// Trust proxy for rate limiter (Fix 3)
// -------------------------------
app.set('trust proxy', 1);

// -------------------------------
// CORS configuration
// -------------------------------
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  allowedHeaders: ['Authorization', 'Content-Type'],
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// -------------------------------
// Rate limiters
// -------------------------------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please slow down.' });
  },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please slow down.' });
  },
});

app.use(globalLimiter);

// -------------------------------
// Input validation helper
// -------------------------------
const ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
function validateIdParam(value, name) {
  if (!value || typeof value !== 'string' || !ID_REGEX.test(value)) {
    throw new Error(`BAD_REQUEST: Invalid ${name} format`);
  }
}

// -------------------------------
// Authentication middleware
// -------------------------------
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const tokenId = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null; // Fix 2: removed req.query fallback
  if (!tokenId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(tokenId);
    req.user = decodedToken;
    next();
  } catch (err) {
    logger.warn({ err }, 'Invalid or expired token');
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// -------------------------------
// Admin secret check for /queue-stats
// -------------------------------
function requireAdminSecret(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    logger.error('ADMIN_SECRET environment variable not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const provided = req.headers['x-admin-secret'];
  if (provided !== adminSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// -------------------------------
// Queue Class (unchanged logic, logger integration)
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
    logger.debug(message);
  }
}

// -------------------------------
// Factory Pattern: Zero Boilerplate
// -------------------------------
const QUEUE_REGISTRY = [];

function createQueuedEndpoint({
  method,
  path,
  queueName,
  concurrency = 50,
  maxSize = 5000,
  timeoutMs = 30000,
  handler
}) {
  const queue = new Queue(concurrency, maxSize, timeoutMs);
  QUEUE_REGISTRY.push({ name: queueName, queue });
  
  // All endpoints except health and stats will have auth middleware applied separately.
  // We define the route handler here; middleware will be attached at registration time.
  app[method](path, async (req, res) => {
    try {
      const result = await queue.add(() => handler(req, db));
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });
}

// -------------------------------
// Firebase Admin Initialization
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
      logger.info('✅ Firebase Admin initialized');
      return admin.firestore();
    } else {
      logger.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
      return null;
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Firebase Admin');
    return null;
  }
})();

// -------------------------------
// Real-Time Cache Invalidation Listeners
// -------------------------------
function startCacheListeners(db) {
  if (!db) return;

  // chapters: any change → delete all global:chapters keys
  db.collection('chapters').onSnapshot(() => {
    invalidatePattern('global:chapters');
    logger.info('Cache invalidated: global:chapters (all)');
  }, err => logger.error({ err }, 'chapters listener error'));

  // tutors: any change → delete global:tutors and user:{tutorId}:tutorProfile
  db.collection('tutors').onSnapshot(snapshot => {
    cache.delete('global:tutors');
    logger.info('Cache invalidated: global:tutors');
    snapshot.docChanges().forEach(change => {
      const tutorId = change.doc.data().tutorId;
      if (tutorId) {
        cache.delete(`user:${tutorId}:tutorProfile`);
        logger.info({ tutorId }, 'Cache invalidated: user tutor profile');
      }
    });
  }, err => logger.error({ err }, 'tutors listener error'));

  // studentEnrollments: change → delete that user's enrollment cache
  db.collection('studentEnrollments').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      const studentId = change.doc.data().studentId;
      if (studentId) {
        cache.delete(`user:${studentId}:enrollment`);
        logger.info({ studentId }, 'Cache invalidated: user enrollment');
      }
    });
  }, err => logger.error({ err }, 'enrollments listener error'));

  // posts: any change → invalidate matching posts:classId:subjectId:tutorId keys
  db.collection('posts').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      const d = change.doc.data();
      if (d.classId && d.subjectId && d.tutorId) {
        const prefix = `posts:${d.classId}:${d.subjectId}:${d.tutorId}`;
        invalidatePattern(prefix);
        logger.info({ prefix }, 'Cache invalidated: posts prefix');
      }
    });
  }, err => logger.error({ err }, 'posts listener error'));
}

startCacheListeners(db);

// -------------------------------
// Error Handler (updated with FORBIDDEN case)
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
  // Fix 1: handle FORBIDDEN errors
  if (err.message.startsWith('FORBIDDEN:')) {
    const cleanMsg = err.message.replace('FORBIDDEN:', '').trim();
    return res.status(403).json({ error: cleanMsg });
  }
  logger.error({ err }, 'Unhandled error in queued job');
  res.status(500).json({ error: 'Internal server error' });
};

// -------------------------------
// Health Check (no auth)
// -------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    firebase: firebaseInitialized,
    uptime: process.uptime()
  });
});

// -------------------------------
// Dynamic Queue Stats Endpoint (admin protected)
// -------------------------------
app.get('/queue-stats', requireAdminSecret, (req, res) => {
  const stats = {};
  for (const { name, queue } of QUEUE_REGISTRY) {
    stats[name] = queue.getStats();
  }
  res.json(stats);
});

// -------------------------------
// Apply authentication middleware to all queued endpoints
// We'll define a wrapper to attach middleware after routes are created.
// Since createQueuedEndpoint registers the route immediately, we can apply a global
// middleware that runs before route handlers, excluding /health and /queue-stats.
// -------------------------------
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/queue-stats') {
    return next();
  }
  verifyFirebaseToken(req, res, next);
});

// Apply stricter rate limiting to specific endpoints
app.use('/filter-posts', strictLimiter);
app.use('/api/posts', strictLimiter);

// -------------------------------
// All Endpoints Defined Declaratively (ZERO BOILERPLATE)
// -------------------------------

//===================================================================
// Endpoint 1: Filter posts (with access control and chapter filter) - Paginated (Fix 4)
//===================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/filter-posts',
  queueName: 'filterPosts',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    
    const userUId = req.user.uid;
    const { classId, subjectId, chapterId, tutorId } = req.query;
    
    // Validate input
    [classId, subjectId, chapterId, tutorId].forEach(val => {
      if (!val) throw new Error('BAD_REQUEST: classId, subjectId, chapterId, and tutorId are required');
      validateIdParam(val, val === classId ? 'classId' : val === subjectId ? 'subjectId' : val === chapterId ? 'chapterId' : 'tutorId');
    });

    // Bug fix 1: Use cached enrollment data
    const enrollmentCacheKey = `user:${userUId}:enrollment`;
    let enrollmentData = getCache(enrollmentCacheKey);
    if (enrollmentData === null) {
      const enrollmentSnapshot = await db
        .collection('studentEnrollments')
        .where('studentId', '==', userUId)
        .limit(1)
        .get();
      if (enrollmentSnapshot.empty) {
        throw new Error('FORBIDDEN: No enrollment record found');
      }
      enrollmentData = enrollmentSnapshot.docs[0].data();
      setCache(enrollmentCacheKey, enrollmentData);
    }

    const enrolledClassMap = enrollmentData.enrolledClassId || {};
    const enrolledSubjectMap = enrollmentData.enrolledSubjectId || {};
    const enrolledTutorMap = enrollmentData.enrolledTutorId || {};

    if (!enrolledClassMap[classId]) throw new Error('FORBIDDEN: Student not enrolled in this class');
    if (!enrolledSubjectMap[subjectId]) throw new Error('FORBIDDEN: Student not enrolled in this subject');
    if (!enrolledTutorMap[tutorId]) throw new Error('FORBIDDEN: Student not assigned to this tutor');

    const expireAtMap = enrollmentData.expireAt || {};
    const tutorExpiry = expireAtMap[tutorId];
    if (!tutorExpiry) throw new Error('FORBIDDEN: No expiry date set for this tutor');

    let expiryDate;
    if (tutorExpiry instanceof admin.firestore.Timestamp) {
      expiryDate = tutorExpiry.toDate();
    } else if (tutorExpiry && typeof tutorExpiry.toDate === 'function') {
      expiryDate = tutorExpiry.toDate();
    } else {
      expiryDate = new Date(tutorExpiry);
    }

    if (isNaN(expiryDate.getTime())) throw new Error('INTERNAL_ERROR: Invalid expiry timestamp format');
    if (new Date() >= expiryDate) throw new Error('FORBIDDEN: Access expired for this tutor');

    // --- Cache check (after security validation) ---
    const postsCacheKey = generatePostsKey(classId, subjectId, tutorId, chapterId, req.query.cursor);
    const cachedPosts = getCache(postsCacheKey);
    if (cachedPosts !== null) return cachedPosts;

    // --- Pagination (Fix 4) ---
    let limit = parseInt(req.query.limit) || 20;
    const MAX_LIMIT = 50;
    limit = Math.min(Math.max(1, limit), MAX_LIMIT);

    let cursor = null;
    if (req.query.cursor) {
      try {
        const decoded = Buffer.from(req.query.cursor, 'base64').toString('utf8');
        const rawCursor = JSON.parse(decoded);
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
        throw new Error(`BAD_REQUEST: Invalid cursor encoding - ${e.message}`);
      }
    }

    let postsQuery = db.collection('posts')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId)
      .where('chapterId', '==', chapterId)
      .where('tutorId', '==', tutorId)
      .orderBy('createdAt', 'asc')
      .orderBy(admin.firestore.FieldPath.documentId());

    if (cursor) {
      postsQuery = postsQuery.startAfter(cursor.createdAt, cursor.id);
    }
    postsQuery = postsQuery.limit(limit + 1);

    const snapshot = await postsQuery.get();
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
      const cursorObj = {
        createdAt: {
          _seconds: createdAt.seconds,
          _nanoseconds: createdAt.nanoseconds
        },
        id: lastDoc.id
      };
      nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');
    }

    const result = { data, nextCursor, hasMore };
    setCache(postsCacheKey, result);
    return result;
  }
});

//======================================================
// Endpoint 2: Get classes for authenticated student (paginated)
//======================================================
createQueuedEndpoint({
  method: 'get',
  path: '/classes',
  queueName: 'classes',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    
    const userUId = req.user.uid;

    // Use enrollment cache
    const enrollmentCacheKey = `user:${userUId}:enrollment`;
    let enrollmentData = getCache(enrollmentCacheKey);
    if (enrollmentData === null) {
      const enrollmentsSnapshot = await db
        .collection('studentEnrollments')
        .where('studentId', '==', userUId)
        .get();

      if (enrollmentsSnapshot.empty) {
        return { data: [], total: 0 };
      }
      // Bug fix 3: Merge all enrollment documents for the student
      const mergedDoc = {};
enrollmentsSnapshot.docs.forEach(doc => {
  Object.assign(mergedDoc, doc.data());
});
enrollmentData = mergedDoc;
setCache(enrollmentCacheKey, enrollmentData);
    }

    const classes = [];
    const enrolledClassIdMap = enrollmentData.enrolledClassId || {};
    for (const [classId, className] of Object.entries(enrolledClassIdMap)) {
      classes.push({ classId, className });
    }

    // Pagination
    let limit = parseInt(req.query.limit) || 50;
    const MAX_LIMIT = 100;
    limit = Math.min(Math.max(1, limit), MAX_LIMIT);
    const data = classes.slice(0, limit);

    return data;
  }
});

//====================================================================
// Endpoint 3: Filter subjects by classId (from student's enrollment)
//====================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/subjects',
  queueName: 'subjects',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    
    const userUId = req.user.uid;
    const { classId } = req.query;
    if (!classId) throw new Error('BAD_REQUEST: classId is required');
    validateIdParam(classId, 'classId');

    // Use enrollment cache
    const enrollmentCacheKey = `user:${userUId}:enrollment`;
    let enrollmentData = getCache(enrollmentCacheKey);
    if (enrollmentData === null) {
      const enrollmentSnapshot = await db
        .collection('studentEnrollments')
        .where('studentId', '==', userUId)
        .limit(1)
        .get();

      if (enrollmentSnapshot.empty) return [];
      enrollmentData = enrollmentSnapshot.docs[0].data();
      setCache(enrollmentCacheKey, enrollmentData);
    }

    const enrolledClassIdMap = enrollmentData.enrolledClassId || {};
    if (!enrolledClassIdMap[classId]) return [];

    const enrolledSubjectIdMap = enrollmentData.enrolledSubjectId || {};
    const subjects = [];
    for (const [subjectId, subjectName] of Object.entries(enrolledSubjectIdMap)) {
      subjects.push({ subjectId, subjectName });
    }
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
    validateIdParam(classId, 'classId');
    validateIdParam(subjectId, 'subjectId');

    const compoundKey = `global:chapters:${classId}:${subjectId}`;
    const cached = getCache(compoundKey);
    if (cached !== null) {
      return cached;
    }

    let query = db.collection('chapters')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId);
    const snapshot = await query.get();
    const chapters = [];
    snapshot.forEach(doc => chapters.push({ id: doc.id, ...doc.data() }));

    setCache(compoundKey, chapters);
    return chapters;
  }
});

//=============================================================================
// Endpoint 5: Filter tutors by classId + subjectId (from student's enrollment)
//=============================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/tutors',
  queueName: 'tutors',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    
    const userUId = req.user.uid;
    const { classId, subjectId } = req.query;
    if (!classId || !subjectId) {
      throw new Error('BAD_REQUEST: classId and subjectId are required');
    }
    validateIdParam(classId, 'classId');
    validateIdParam(subjectId, 'subjectId');

    // Use enrollment cache
    const enrollmentCacheKey = `user:${userUId}:enrollment`;
    let enrollmentData = getCache(enrollmentCacheKey);
    if (enrollmentData === null) {
      const enrollmentSnapshot = await db
        .collection('studentEnrollments')
        .where('studentId', '==', userUId)
        .limit(1)
        .get();

      if (enrollmentSnapshot.empty) return [];
      enrollmentData = enrollmentSnapshot.docs[0].data();
      setCache(enrollmentCacheKey, enrollmentData);
    }

    const enrolledClassIdMap = enrollmentData.enrolledClassId || {};
    const enrolledSubjectIdMap = enrollmentData.enrolledSubjectId || {};

    if (!enrolledClassIdMap[classId] || !enrolledSubjectIdMap[subjectId]) return [];

    const enrolledTutorIdMap = enrollmentData.enrolledTutorId || {};
    const tutors = [];
    for (const [tutorId, tutorName] of Object.entries(enrolledTutorIdMap)) {
      tutors.push({ tutorId, tutorName });
    }
    return tutors;
  }
});

//======================================================================
// Endpoint 6: Cursor-based pagination for posts (with access control)
//======================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/api/posts',
  queueName: 'posts',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    
    const userUId = req.user.uid;
    const { classId, subjectId, tutorId } = req.query;
    if (!classId || !subjectId || !tutorId) {
      throw new Error('BAD_REQUEST: classId, subjectId, and tutorId are required');
    }
    validateIdParam(classId, 'classId');
    validateIdParam(subjectId, 'subjectId');
    validateIdParam(tutorId, 'tutorId');

    // Bug fix 2: Use cached enrollment data
    const enrollmentCacheKey = `user:${userUId}:enrollment`;
    let enrollmentData = getCache(enrollmentCacheKey);
    if (enrollmentData === null) {
      const enrollmentSnapshot = await db
        .collection('studentEnrollments')
        .where('studentId', '==', userUId)
        .limit(1)
        .get();
      if (enrollmentSnapshot.empty) {
        throw new Error('FORBIDDEN: No enrollment record found');
      }
      enrollmentData = enrollmentSnapshot.docs[0].data();
      setCache(enrollmentCacheKey, enrollmentData);
    }

    const enrolledClassMap = enrollmentData.enrolledClassId || {};
    const enrolledSubjectMap = enrollmentData.enrolledSubjectId || {};
    const enrolledTutorMap = enrollmentData.enrolledTutorId || {};

    if (!enrolledClassMap[classId]) throw new Error('FORBIDDEN: Student not enrolled in this class');
    if (!enrolledSubjectMap[subjectId]) throw new Error('FORBIDDEN: Student not enrolled in this subject');
    if (!enrolledTutorMap[tutorId]) throw new Error('FORBIDDEN: Student not assigned to this tutor');

    const expireAtMap = enrollmentData.expireAt || {};
    const tutorExpiry = expireAtMap[tutorId];
    if (!tutorExpiry) throw new Error('FORBIDDEN: No expiry date set for this tutor');

    let expiryDate;
    if (tutorExpiry instanceof admin.firestore.Timestamp) {
      expiryDate = tutorExpiry.toDate();
    } else if (tutorExpiry && typeof tutorExpiry.toDate === 'function') {
      expiryDate = tutorExpiry.toDate();
    } else {
      expiryDate = new Date(tutorExpiry);
    }

    if (isNaN(expiryDate.getTime())) throw new Error('INTERNAL_ERROR: Invalid expiry timestamp format');
    if (new Date() >= expiryDate) throw new Error('FORBIDDEN: Access expired for this tutor');

    // Cache check (after security validation)
    const postsCacheKey = generatePostsKey(classId, subjectId, tutorId, null, req.query.cursor);
    const cachedPosts = getCache(postsCacheKey);
    if (cachedPosts !== null) return cachedPosts;

    let limit = parseInt(req.query.limit) || 10;
    const MAX_LIMIT = 50;
    limit = Math.min(Math.max(1, limit), MAX_LIMIT);

    let cursor = null;
    if (req.query.cursor) {
      try {
        const decoded = Buffer.from(req.query.cursor, 'base64').toString('utf8');
        const rawCursor = JSON.parse(decoded);
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
        throw new Error(`BAD_REQUEST: Invalid cursor encoding - ${e.message}`);
      }
    }

    let postsQuery = db.collection('posts')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId)
      .where('tutorId', '==', tutorId)
      .orderBy('createdAt', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId());

    if (cursor) {
      postsQuery = postsQuery.startAfter(cursor.createdAt, cursor.id);
    }
    postsQuery = postsQuery.limit(limit + 1);

    const snapshot = await postsQuery.get();
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
      const cursorObj = {
        createdAt: {
          _seconds: createdAt.seconds,
          _nanoseconds: createdAt.nanoseconds
        },
        id: lastDoc.id
      };
      nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');
    }

    const result = { data, nextCursor, hasMore };
    setCache(postsCacheKey, result);
    return result;
  }
});

// Strict rate limit for tutor profile endpoint
app.use('/tutor/profile', strictLimiter);

//======================================================================
// Endpoint 7 : Get tutor profile by verified token
//======================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/tutor/profile',
  queueName: 'tutorProfile',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const userUId = req.user.uid;

    // Cache check
    const profileCacheKey = `user:${userUId}:tutorProfile`;
    const cachedProfile = getCache(profileCacheKey);
    if (cachedProfile !== null) return cachedProfile;

    // Query tutors collection by tutorId == userUId and status == approved
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', userUId)
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    const tutorData = tutorSnapshot.docs[0].data();

    // Sanitize and return only required fields
    const profile = {
      tutorId: String(tutorData.tutorId || ''),
      tutorName: String(tutorData.tutorName || ''),
      registeredClassId: typeof tutorData.registeredClassId === 'object' && tutorData.registeredClassId !== null
        ? tutorData.registeredClassId : {},
      registeredSubjectId: typeof tutorData.registeredSubjectId === 'object' && tutorData.registeredSubjectId !== null
        ? tutorData.registeredSubjectId : {}
    };

    setCache(profileCacheKey, profile);
    return profile;
  }
});

// Strict rate limit for create post endpoint
app.use('/tutor/post/create', strictLimiter);

//======================================================================
// Endpoint 8 : Create post (tutor only, with full access validation)
//======================================================================
createQueuedEndpoint({
  method: 'post',
  path: '/tutor/post/create',
  queueName: 'tutorPostCreate',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const userUId = req.user.uid;

    // ── Extract & validate required fields ──
    const {
      classId,
      subjectId,
      chapterId,
      tutorId,
      tutorName,
      postTitle,
      postSubtle,
      videoUrl,
      thumbnailUrl
    } = req.body;

    // Required field checks
    if (!classId)    throw new Error('BAD_REQUEST: classId is required');
    if (!subjectId)  throw new Error('BAD_REQUEST: subjectId is required');
    if (!chapterId)  throw new Error('BAD_REQUEST: chapterId is required');
    if (!tutorId)    throw new Error('BAD_REQUEST: tutorId is required');
    if (!postTitle)  throw new Error('BAD_REQUEST: postTitle is required');
    if (!videoUrl)   throw new Error('BAD_REQUEST: videoUrl is required');

    // Validate ID formats
    validateIdParam(classId,   'classId');
    validateIdParam(subjectId, 'subjectId');
    validateIdParam(chapterId, 'chapterId');
    validateIdParam(tutorId,   'tutorId');

    // Validate string lengths
    if (postTitle.length > 200)  throw new Error('BAD_REQUEST: postTitle too long (max 200 chars)');
    if (postSubtle && postSubtle.length > 1000) throw new Error('BAD_REQUEST: postSubtle too long (max 1000 chars)');

    // ── Security: tutorId must match authenticated user ──
    if (tutorId !== userUId) {
      throw new Error('FORBIDDEN: tutorId does not match authenticated user');
    }

    // ── Verify tutor document with all required parameters ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', userUId)
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    const tutorData = tutorSnapshot.docs[0].data();

    // Verify classId is registered
    const registeredClassId = tutorData.registeredClassId || {};
    if (!registeredClassId[classId]) {
      throw new Error('FORBIDDEN: Tutor not registered for this class');
    }

    // Verify subjectId is registered under classId
    const registeredSubjectId = tutorData.registeredSubjectId || {};
    const classSubjects = registeredSubjectId[classId] || {};
    if (!classSubjects[subjectId]) {
      throw new Error('FORBIDDEN: Tutor not registered for this subject under the given class');
    }

    // ── Create post document ──
    const postsRef = db.collection('posts').doc(); // Firestore auto-generated ID
    const postId = postsRef.id;

    const postDocument = {
      postId,
      postTitle:   String(postTitle).trim(),
      postSubtle:  postSubtle ? String(postSubtle).trim() : '',
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      createdBy:   userUId,
      tutorId:     String(tutorId),
      tutorName:   tutorName ? String(tutorName).trim() : '',
      videoUrl:    String(videoUrl).trim(),
      thumbnailUrl: thumbnailUrl ? String(thumbnailUrl).trim() : '',
      classId:     String(classId),
      subjectId:   String(subjectId),
      chapterId:   String(chapterId),
    };

    await postsRef.set(postDocument);

    // Invalidate posts cache for this tutor's content
    invalidatePattern(`posts:${classId}:${subjectId}:${tutorId}`);
    logger.info({ postId, tutorId, classId, subjectId, chapterId }, 'Post created successfully');

    return {
      success: true,
      message: 'Post created successfully',
      postId
    };
  }
});

// -------------------------------
// Start Server
// -------------------------------
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
