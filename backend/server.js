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

//========== Temporary Endpoint ==============//

// -------------------------------------------------------------------
// Public Enrollment Endpoint (no auth required – defined before auth middleware)
// -------------------------------------------------------------------
const VALID_PROMO_CODE = "CEE 2026";  // Hardcoded for MVP

app.post('/enroll', strictLimiter, async (req, res) => {
  try {
    const { email, promoCode } = req.body;
    if (!email || !promoCode) {
      return res.status(400).json({ error: 'Email and promo code are required' });
    }

    // 1. Get user from Firebase Auth
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        // Redirect to auth page if user doesn't exist
        return res.redirect('https://tutoriom.github.io/auth/');
      }
      throw error; // rethrow unexpected auth errors
    }

    const userEmail = userRecord.email;

    // 2. Check existing enrollment
    const enrollmentRef = db.collection('studentEnrollments').doc(userEmail);
    const enrollmentDoc = await enrollmentRef.get();
    if (enrollmentDoc.exists) {
      return res.json({ message: 'User has already enrolled for this course. Thank You!' });
    }

    // 3. Validate promo code
    if (promoCode !== VALID_PROMO_CODE) {
      return res.status(400).json({ error: 'Invalid promo code' });
    }

    // 4. Create enrollment document
    const enrollmentData = {
      studentId: userEmail,

      enrolledClassId: {
        class_CEE: "CEE"
      },

      enrolledSubjectId: {
        class_CEE: {
          subject_Chemistry: "Chemistry"
        }
      },

      enrolledTutorId: {
  class_CEE: {
    subject_Chemistry: {
      "dilshad17600@gmail.com": "General"
    }
  }
},

expireAt: {
  class_CEE: {
    subject_Chemistry: {
      "dilshad17600@gmail.com": "2026-12-31"
    }
  }
},

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: "admin",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await enrollmentRef.set(enrollmentData);

    // 5. Success response
    return res.status(201).json({
      success: true,
      message: "Enrollment successful"
    });

  } catch (error) {
    logger.error({ err: error }, 'Enrollment endpoint error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// -------------------------------
// Input validation helper
// -------------------------------
const ID_REGEX = /^[a-zA-Z0-9_\-@.+]{1,256}$/;
function validateIdParam(value, name) {
  if (!value || typeof value !== 'string' || !ID_REGEX.test(value)) {
    throw new Error(`BAD_REQUEST: Invalid ${name} format`);
  }
}
// -------------------------------
// Unflatten dot-notation Firestore fields into nested objects
// e.g. { "a.b.c": 1 } → { a: { b: { c: 1 } } }
// -------------------------------
function unflattenFirestoreData(flatData) {
  // Known structural depths for dot-notation fields written by Endpoint 9.
  // Depth = number of dot-separated segments BEFORE the leaf value.
  // e.g. "enrolledClassId.class_CEE" → depth 1 (split into 2 parts, nest 1 level)
  // e.g. "expireAt.class_CEE.subject_Chemistry.tutor@email.com" → depth 3 (nest 3 levels,
  //      but the leaf key is everything after the 3rd dot, preserving the email intact)
  const FIELD_DEPTHS = {
    enrolledClassId:  1,  // enrolledClassId.<classId>
    enrolledSubjectId: 2, // enrolledSubjectId.<classId>.<subjectId>
    enrolledTutorId:  3,  // enrolledTutorId.<classId>.<subjectId>.<tutorEmail>
    expireAt:         3,  // expireAt.<classId>.<subjectId>.<tutorEmail>
  };

  const result = {};
  for (const [key, value] of Object.entries(flatData)) {
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) {
      // No dot → top-level field, copy as-is (handles studentId, createdAt, etc.)
      result[key] = value;
      continue;
    }

    const topField = key.substring(0, dotIndex);
    const depth = FIELD_DEPTHS[topField];

    if (depth === undefined) {
      // Unknown field with dots → copy as-is under its full key
      result[key] = value;
      continue;
    }

    // Split only up to `depth` dots, preserving the rest of the key as the final segment.
    // This keeps tutor emails (e.g. "a@b.com") intact as a single key.
    let parts = [];
    let remaining = key;
    for (let i = 0; i < depth; i++) {
      const idx = remaining.indexOf('.');
      if (idx === -1) break;
      parts.push(remaining.substring(0, idx));
      remaining = remaining.substring(idx + 1);
    }
    parts.push(remaining); // final segment (may contain dots, e.g. an email)

    let cursor = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cursor[parts[i]] === undefined || typeof cursor[parts[i]] !== 'object') {
        cursor[parts[i]] = {};
      }
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return result;
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
    
    const userEmail = req.user.email;
    const { classId, subjectId, chapterId, tutorId } = req.query;
    
    // Validate input
    [classId, subjectId, chapterId, tutorId].forEach(val => {
      if (!val) throw new Error('BAD_REQUEST: classId, subjectId, chapterId, and tutorId are required');
      validateIdParam(val, val === classId ? 'classId' : val === subjectId ? 'subjectId' : val === chapterId ? 'chapterId' : 'tutorId');
    });

    const enrollmentSnapshot = await db
      .collection('studentEnrollments')
      .where('studentId', '==', userEmail)
      .limit(1)
      .get();

    if (enrollmentSnapshot.empty) {
      throw new Error('FORBIDDEN: No enrollment record found');
    }

    const enrollmentData = unflattenFirestoreData(enrollmentSnapshot.docs[0].data());
    const enrolledClassMap = enrollmentData.enrolledClassId || {};
    const enrolledSubjectId = enrollmentData.enrolledSubjectId || {};
    const enrolledTutorId = enrollmentData.enrolledTutorId || {};
    const expireAt = enrollmentData.expireAt || {};
    if (!enrolledClassMap[classId]) throw new Error('FORBIDDEN: Student not enrolled in this class');
    const subjectsForClass = enrolledSubjectId[classId];
    if (!subjectsForClass || !subjectsForClass.hasOwnProperty(subjectId)) throw new Error('FORBIDDEN: Student not enrolled in this subject');
    const tutorsForSubject = enrolledTutorId[classId]?.[subjectId];
    if (!tutorsForSubject || !tutorsForSubject.hasOwnProperty(tutorId)) throw new Error('FORBIDDEN: Student not assigned to this tutor');
    const tutorExpiry = expireAt[classId]?.[subjectId]?.[tutorId];
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

    return { data, nextCursor, hasMore };
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
    
    const userEmail = req.user.email;

    const enrollmentsSnapshot = await db
      .collection('studentEnrollments')
      .where('studentId', '==', userEmail)
      .get();

    if (enrollmentsSnapshot.empty) {
      return { data: [], total: 0 };
    }

    const classes = [];
    enrollmentsSnapshot.forEach(doc => {
      const data = unflattenFirestoreData(doc.data());
      const enrolledClassIdMap = data.enrolledClassId || {};
      for (const [classId, className] of Object.entries(enrolledClassIdMap)) {
        classes.push({ classId, className });
      }
    });

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
    
    const userEmail = req.user.email;
    const { classId } = req.query;
    if (!classId) throw new Error('BAD_REQUEST: classId is required');
    validateIdParam(classId, 'classId');

    const enrollmentSnapshot = await db
      .collection('studentEnrollments')
      .where('studentId', '==', userEmail)
      .limit(1)
      .get();

    if (enrollmentSnapshot.empty) return [];

    const enrollmentData = unflattenFirestoreData(enrollmentSnapshot.docs[0].data());
    const enrolledClassIdMap = enrollmentData.enrolledClassId || {};
    
    // Validate classId exists in enrolledClassId
    if (!enrolledClassIdMap.hasOwnProperty(classId)) return [];

    const enrolledSubjectIdMap = enrollmentData.enrolledSubjectId || {};
    
    // Retrieve subjects only for the specific classId
    const subjectsForClass = enrolledSubjectIdMap[classId];
    
    // Validate subjectsForClass exists and is an object
    if (!subjectsForClass || typeof subjectsForClass !== 'object') return [];

    // Convert map to array of {subjectId, subjectName}
    const subjects = [];
    for (const [subjectId, subjectName] of Object.entries(subjectsForClass)) {
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

    let query = db.collection('chapters')
      .where('classId', '==', classId)
      .where('subjectId', '==', subjectId);
    const snapshot = await query.get();
    const chapters = [];
    snapshot.forEach(doc => chapters.push({ id: doc.id, ...doc.data() }));
    return chapters;
  }
});

//=============================================================================
// Endpoint 5: Filter tutors by classId + subjectId (from student's enrollment)
// with expiration validation
//=============================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/tutors',
  queueName: 'tutors',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');
    
    const userEmail = req.user.email;
    const { classId, subjectId } = req.query;
    if (!classId || !subjectId) {
      throw new Error('BAD_REQUEST: classId and subjectId are required');
    }
    validateIdParam(classId, 'classId');
    validateIdParam(subjectId, 'subjectId');

    // Single Firestore read
    const enrollmentSnapshot = await db
      .collection('studentEnrollments')
      .where('studentId', '==', userEmail)
      .limit(1)
      .get();

    if (enrollmentSnapshot.empty) return [];

    const enrollmentData = unflattenFirestoreData(enrollmentSnapshot.docs[0].data());
    const enrolledClassId = enrollmentData.enrolledClassId || {};
    const enrolledSubjectId = enrollmentData.enrolledSubjectId || {};
    const enrolledTutorId = enrollmentData.enrolledTutorId || {};
    const expireAt = enrollmentData.expireAt || {};

    // 1. Validate classId exists
    if (!enrolledClassId.hasOwnProperty(classId)) return [];

    // 2. Validate subjectId exists under that classId
    const subjectsForClass = enrolledSubjectId[classId];
    if (!subjectsForClass || !subjectsForClass.hasOwnProperty(subjectId)) return [];

    // 3. Retrieve tutors for the specific class and subject
    const tutorsForSubject = enrolledTutorId[classId]?.[subjectId];
    if (!tutorsForSubject || typeof tutorsForSubject !== 'object') return [];

    // 4. Retrieve expiry information for the same class/subject
    const expiryForSubject = expireAt[classId]?.[subjectId] || {};

    // Helper to convert expiry to milliseconds
    const getExpiryTime = (expiry) => {
      if (!expiry) return null;
      // Firestore Timestamp
      if (expiry.toMillis && typeof expiry.toMillis === 'function') {
        return expiry.toMillis();
      }
      // ISO string or Date
      return new Date(expiry).getTime();
    };

    const now = Date.now();
    const tutors = [];

    for (const [tutorId, tutorName] of Object.entries(tutorsForSubject)) {
      const expiryValue = expiryForSubject[tutorId];
      
      // Skip if expiry doesn't exist
      if (expiryValue === undefined) continue;

      const expiryTime = getExpiryTime(expiryValue);
      
      // Skip if expiry time is invalid or expired
      if (expiryTime === null || isNaN(expiryTime) || expiryTime <= now) continue;

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
    
    const userEmail = req.user.email;
    const { classId, subjectId, tutorId } = req.query;
    if (!classId || !subjectId || !tutorId) {
      throw new Error('BAD_REQUEST: classId, subjectId, and tutorId are required');
    }
    validateIdParam(classId, 'classId');
    validateIdParam(subjectId, 'subjectId');
    validateIdParam(tutorId, 'tutorId');

    const enrollmentSnapshot = await db
      .collection('studentEnrollments')
      .where('studentId', '==', userEmail)
      .limit(1)
      .get();

    if (enrollmentSnapshot.empty) {
      throw new Error('FORBIDDEN: No enrollment record found');
    }

    const enrollmentData = unflattenFirestoreData(enrollmentSnapshot.docs[0].data());
    const enrolledClassMap = enrollmentData.enrolledClassId || {};
    const enrolledSubjectId = enrollmentData.enrolledSubjectId || {};
    const enrolledTutorId = enrollmentData.enrolledTutorId || {};
    const expireAt = enrollmentData.expireAt || {};
    if (!enrolledClassMap[classId]) throw new Error('FORBIDDEN: Student not enrolled in this class');
    const subjectsForClass = enrolledSubjectId[classId];
    if (!subjectsForClass || !subjectsForClass.hasOwnProperty(subjectId)) throw new Error('FORBIDDEN: Student not enrolled in this subject');
    const tutorsForSubject = enrolledTutorId[classId]?.[subjectId];
    if (!tutorsForSubject || !tutorsForSubject.hasOwnProperty(tutorId)) throw new Error('FORBIDDEN: Student not assigned to this tutor');
    const tutorExpiry = expireAt[classId]?.[subjectId]?.[tutorId];
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

    return { data, nextCursor, hasMore };
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

    const userEmail = req.user.email;

// Query tutors collection by tutorId == userEmail and status == approved
const tutorSnapshot = await db
  .collection('tutors')
  .where('tutorId', '==', userEmail)
  .where('status', '==', 'approved')
  .limit(1)
  .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    const tutorData = tutorSnapshot.docs[0].data();

    // Sanitize and return only required fields
    return {
      tutorId: String(tutorData.tutorId || ''),
      tutorName: String(tutorData.tutorName || ''),
      registeredClassId: typeof tutorData.registeredClassId === 'object' && tutorData.registeredClassId !== null
        ? tutorData.registeredClassId : {},
      registeredSubjectId: typeof tutorData.registeredSubjectId === 'object' && tutorData.registeredSubjectId !== null
        ? tutorData.registeredSubjectId : {}
    };
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

    const userEmail = req.user.email;

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
    if (tutorId !== userEmail) {
      throw new Error('FORBIDDEN: tutorId does not match authenticated user');
    }

    // ── Verify tutor document with all required parameters ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', userEmail)
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
      createdBy:   userEmail,
      tutorId:     String(tutorId),
      tutorName:   tutorName ? String(tutorName).trim() : '',
      videoUrl:    String(videoUrl).trim(),
      thumbnailUrl: thumbnailUrl ? String(thumbnailUrl).trim() : '',
      classId:     String(classId),
      subjectId:   String(subjectId),
      chapterId:   String(chapterId),
    };

    await postsRef.set(postDocument);

    logger.info({ postId, tutorId, classId, subjectId, chapterId }, 'Post created successfully');

    return {
      success: true,
      message: 'Post created successfully',
      postId
    };
  }
});

// Strict rate limit for update/delete post endpoints
app.use('/tutor/post/update', strictLimiter);
app.use('/tutor/post/delete', strictLimiter);

//======================================================================
// Endpoint 8a: Update post (tutor only, owner-only)
// PATCH /tutor/post/update
//
// Body params:
//   postId       – ID of the post to update (required)
//   postTitle    – New title           (optional)
//   postSubtle   – New subtitle        (optional)
//   videoUrl     – New video URL       (optional)
//   thumbnailUrl – New thumbnail URL   (optional)
//
// Flow:
//   1. Validate postId and at least one updatable field is present.
//   2. Verify tutor is approved in Firestore.
//   3. Fetch the post and confirm it belongs to the authenticated tutor.
//   4. Apply partial update (only provided fields).
//   5. Return success.
//======================================================================
createQueuedEndpoint({
  method: 'patch',
  path: '/tutor/post/update',
  queueName: 'tutorPostUpdate',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const userEmail = req.user.email;

    // ── 1. Extract & validate params ──
    const { postId, postTitle, postSubtle, videoUrl, thumbnailUrl } = req.body;

    if (!postId) throw new Error('BAD_REQUEST: postId is required');
    validateIdParam(postId, 'postId');

    // At least one updatable field must be provided
    const hasUpdate = postTitle !== undefined
      || postSubtle !== undefined
      || videoUrl !== undefined
      || thumbnailUrl !== undefined;

    if (!hasUpdate) {
      throw new Error('BAD_REQUEST: At least one field to update must be provided (postTitle, postSubtle, videoUrl, thumbnailUrl)');
    }

    // Validate lengths if provided
    if (postTitle !== undefined) {
      if (typeof postTitle !== 'string' || postTitle.trim().length === 0) {
        throw new Error('BAD_REQUEST: postTitle cannot be empty');
      }
      if (postTitle.length > 200) {
        throw new Error('BAD_REQUEST: postTitle too long (max 200 chars)');
      }
    }
    if (postSubtle !== undefined && postSubtle.length > 1000) {
      throw new Error('BAD_REQUEST: postSubtle too long (max 1000 chars)');
    }

    // ── 2. Verify tutor is approved ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', userEmail)
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    // ── 3. Fetch post and verify ownership ──
    const postRef = db.collection('posts').doc(postId);
    const postSnap = await postRef.get();

    if (!postSnap.exists) {
      throw new Error('BAD_REQUEST: Post not found');
    }

    const postData = postSnap.data();

    if (postData.tutorId !== userEmail) {
      throw new Error('FORBIDDEN: You are not the owner of this post');
    }

    // ── 4. Build partial update payload ──
    const updatePayload = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userEmail,
    };

    if (postTitle   !== undefined) updatePayload.postTitle    = String(postTitle).trim();
    if (postSubtle  !== undefined) updatePayload.postSubtle   = String(postSubtle).trim();
    if (videoUrl    !== undefined) updatePayload.videoUrl     = String(videoUrl).trim();
    if (thumbnailUrl !== undefined) updatePayload.thumbnailUrl = String(thumbnailUrl).trim();

    await postRef.update(updatePayload);

    logger.info({ postId, userEmail }, 'Post updated successfully');

    return {
      success: true,
      message: 'Post updated successfully',
      postId,
    };
  }
});

//======================================================================
// Endpoint 8b: Delete post (tutor only, owner-only)
// DELETE /tutor/post/delete
//
// Body params:
//   postId – ID of the post to delete (required)
//
// Flow:
//   1. Validate postId.
//   2. Verify tutor is approved in Firestore.
//   3. Fetch the post and confirm it belongs to the authenticated tutor.
//   4. Hard-delete the document.
//   5. Return success.
//======================================================================
createQueuedEndpoint({
  method: 'delete',
  path: '/tutor/post/delete',
  queueName: 'tutorPostDelete',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const userEmail = req.user.email;

    // ── 1. Extract & validate params ──
    // DELETE bodies are less conventional; we support both body and query param
    const postId = req.body?.postId || req.query?.postId;

    if (!postId) throw new Error('BAD_REQUEST: postId is required');
    validateIdParam(postId, 'postId');

    // ── 2. Verify tutor is approved ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', userEmail)
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    // ── 3. Fetch post and verify ownership ──
    const postRef = db.collection('posts').doc(postId);
    const postSnap = await postRef.get();

    if (!postSnap.exists) {
      throw new Error('BAD_REQUEST: Post not found');
    }

    const postData = postSnap.data();

    if (postData.tutorId !== userEmail) {
      throw new Error('FORBIDDEN: You are not the owner of this post');
    }

    // ── 4. Hard-delete ──
    await postRef.delete();

    logger.info({ postId, userEmail }, 'Post deleted successfully');

    return {
      success: true,
      message: 'Post deleted successfully',
      postId,
    };
  }
});


// Strict rate limit for tutor posts endpoint
app.use('/tutor/posts', strictLimiter);

//======================================================================
// Endpoint 8c: Get tutor's own posts (paginated)
// GET /tutor/posts?classId=...&subjectId=...&chapterId=...&limit=10&cursor=...
//
// Query params:
//   classId   – filter by class    (required)
//   subjectId – filter by subject  (required)
//   chapterId – filter by chapter  (optional)
//   limit     – page size, max 50  (optional, default 10)
//   cursor    – pagination token   (optional)
//======================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/tutor/posts',
  queueName: 'tutorOwnPosts',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const userEmail = req.user.email;

    // ── 1. Validate required query params ──
    const { classId, subjectId, chapterId } = req.query;

    if (!classId)   throw new Error('BAD_REQUEST: classId is required');
    if (!subjectId) throw new Error('BAD_REQUEST: subjectId is required');

    validateIdParam(classId,   'classId');
    validateIdParam(subjectId, 'subjectId');
    if (chapterId) validateIdParam(chapterId, 'chapterId');

    // ── 2. Verify tutor is approved ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', userEmail)
      .where('status', '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    // ── 3. Pagination ──
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

    // ── 4. Build query ──
    let postsQuery = db.collection('posts')
      .where('tutorId',   '==', userEmail)
      .where('classId',   '==', classId)
      .where('subjectId', '==', subjectId);

    if (chapterId) {
      postsQuery = postsQuery.where('chapterId', '==', chapterId);
    }

    postsQuery = postsQuery
      .orderBy('createdAt', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId());

    if (cursor) {
      postsQuery = postsQuery.startAfter(cursor.createdAt, cursor.id);
    }

    postsQuery = postsQuery.limit(limit + 1);

    // ── 5. Execute & paginate ──
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

    return { data, nextCursor, hasMore };
  }
});
        
// ─────────────────────────────────────────────────────────────────────────────
// Endpoint 9: Enroll a student into a tutor's class/subject (tutor-initiated)
// POST /tutor/student/enroll
//
// Body params:
//   classId    – ID of the class     (e.g. "class_CEE")
//   subjectId  – ID of the subject   (e.g. "subject_Chemistry")
//   studentId  – student's email address
//   expireAt   – ISO-8601 string or Unix-ms timestamp for enrollment expiry
//
// Flow:
//   1. Validate all body params.
//   2. Confirm studentId exists in Firebase Auth.
//   3. Verify tutor (req.user.email) is approved and registered for the
//      requested classId + subjectId with a non-expired registration.
//   4. If no valid tutor record → 403.
//   5. Check studentEnrollments for an existing active enrollment for this
//      (classId, subjectId, tutorEmail) combination.
//      If found and active → return "Student is already enrolled."
//   6. Upsert the studentEnrollments document via dot-notation merge.
//   7. Return success.
// ─────────────────────────────────────────────────────────────────────────────

app.use('/tutor/student/enroll', strictLimiter);

//======================================================================
// Endpoint 9: Enroll student (tutor-initiated, with full validation)
//======================================================================
createQueuedEndpoint({
  method: 'post',
  path: '/tutor/student/enroll',
  queueName: 'tutorStudentEnroll',
  handler: async (req, db) => {
    // ── Guard: Firestore must be initialized ──────────────────────────
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    // ── 1. Extract & validate body params ────────────────────────────
    const { classId, subjectId, studentId, expireAt } = req.body;

    if (!classId)   throw new Error('BAD_REQUEST: classId is required');
    if (!subjectId) throw new Error('BAD_REQUEST: subjectId is required');
    if (!studentId) throw new Error('BAD_REQUEST: studentId is required');
    if (!expireAt)  throw new Error('BAD_REQUEST: expireAt is required');

    validateIdParam(classId,   'classId');
    validateIdParam(subjectId, 'subjectId');
    validateIdParam(studentId, 'studentId');

    // ── 2. Confirm student exists in Firebase Auth ────────────────────
    let studentEmail;
    try {
      const studentRecord = await admin.auth().getUserByEmail(studentId);
      studentEmail = studentRecord.email;
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        throw new Error('BAD_REQUEST: No student account found for this studentId');
      }
      logger.error({ err }, 'Endpoint 9: Firebase Auth lookup failed');
      throw new Error('INTERNAL_ERROR: Failed to verify student account');
    }

    // ── 3. Resolve tutor identity from the authenticated request ──────
    const tutorEmail = req.user?.email;
    if (!tutorEmail) throw new Error('BAD_REQUEST: Authenticated tutor email is missing');

    // ── 4. Fetch and verify the tutor document ────────────────────────
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', tutorEmail)
      .where('status',  '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor record found for this account');
    }

    const tutorData = tutorSnapshot.docs[0].data();

    // Verify classId is registered to this tutor
    const registeredClassId = tutorData.registeredClassId || {};
    if (!Object.prototype.hasOwnProperty.call(registeredClassId, classId)) {
      throw new Error('FORBIDDEN: Tutor is not registered for this class');
    }

    // Verify subjectId is registered under classId
    const registeredSubjectId = tutorData.registeredSubjectId || {};
    const classSubjects = registeredSubjectId[classId] || {};
    if (!Object.prototype.hasOwnProperty.call(classSubjects, subjectId)) {
      throw new Error('FORBIDDEN: Tutor is not registered for this subject under the given class');
    }

    // Verify tutor's own registration has not expired for this class/subject
    const tutorExpireAt = tutorData.expireAt || {};
    const tutorSubjectExpiry = tutorExpireAt[classId]?.[subjectId];
    if (!tutorSubjectExpiry) {
      throw new Error('FORBIDDEN: No expiry date found for tutor registration in this subject');
    }

    // Normalise Firestore Timestamp | Date | ISO string → Date
    const toDate = (value) => {
      if (!value) return null;
      if (typeof value.toDate === 'function') return value.toDate(); // Firestore Timestamp
      if (value instanceof Date) return value;
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    };

    const tutorExpiryDate = toDate(tutorSubjectExpiry);
    if (!tutorExpiryDate) {
      throw new Error('INTERNAL_ERROR: Tutor expiry timestamp is in an unrecognised format');
    }
    if (tutorExpiryDate <= new Date()) {
      throw new Error('FORBIDDEN: Tutor registration has expired for this class/subject');
    }

    // ── 5. Parse & validate the requested enrollment expiry ───────────
    const enrollmentExpiryDate = toDate(expireAt);
    if (!enrollmentExpiryDate) {
      throw new Error('BAD_REQUEST: expireAt is not a valid date/timestamp');
    }
    if (enrollmentExpiryDate <= new Date()) {
      throw new Error('BAD_REQUEST: expireAt must be a future date');
    }
    // Enrollment cannot outlive the tutor's own registration
    if (enrollmentExpiryDate > tutorExpiryDate) {
      throw new Error("BAD_REQUEST: expireAt cannot exceed the tutor's own registration expiry");
    }

    // ── 6. Resolve display names for the enrollment document ──────────
    const className   = String(registeredClassId[classId]  || '');
    const subjectName = String(classSubjects[subjectId]     || '');
    const tutorName   = String(tutorData.tutorName          || '');

    // ── 7. Check for an existing active enrollment ────────────────────
    const enrollmentRef = db.collection('studentEnrollments').doc(studentEmail);
    const enrollmentDoc = await enrollmentRef.get();

    if (enrollmentDoc.exists) {
      const existingData = enrollmentDoc.data();
      const existingTutorMap = existingData.enrolledTutorId?.[classId]?.[subjectId] || {};
      const existingExpiry   = existingData.expireAt?.[classId]?.[subjectId]?.[tutorEmail];

      if (Object.prototype.hasOwnProperty.call(existingTutorMap, tutorEmail)) {
        const existingExpiryDate = toDate(existingExpiry);
        if (existingExpiryDate && existingExpiryDate > new Date()) {
          // Active enrollment already exists — return friendly message
          return {
            success: false,
            message: 'Student is already enrolled for this course/subject.'
          };
        }
        // Expired enrollment found — fall through to re-enroll
      }
    }

    // ── 8. Upsert enrollment using dot-notation merge ─────────────────
    // set({ merge: true }) with dot-notation keys writes only the targeted
    // nested fields, leaving all sibling enrollments completely untouched.
    const expiryTimestamp = admin.firestore.Timestamp.fromDate(enrollmentExpiryDate);

    const enrollmentPayload = {
      studentId: studentEmail,

      // enrolledClassId   → classId: className
      [`enrolledClassId.${classId}`]: className,

      // enrolledSubjectId → classId.subjectId: subjectName
      [`enrolledSubjectId.${classId}.${subjectId}`]: subjectName,

      // enrolledTutorId   → classId.subjectId.tutorEmail: tutorName
      [`enrolledTutorId.${classId}.${subjectId}.${tutorEmail}`]: tutorName,

      // expireAt          → classId.subjectId.tutorEmail: Timestamp
      [`expireAt.${classId}.${subjectId}.${tutorEmail}`]: expiryTimestamp,

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Write createdAt / createdBy only on first-time document creation
    if (!enrollmentDoc.exists) {
      enrollmentPayload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      enrollmentPayload.createdBy = tutorEmail;
    }

    await enrollmentRef.set(enrollmentPayload, { merge: true });

    logger.info(
      { tutorEmail, studentEmail, classId, subjectId },
      'Endpoint 9: Student enrolled successfully'
    );

    return {
      success: true,
      message: 'Student enrolled successfully',
      data: {
        studentId: studentEmail,
        classId,
        subjectId,
        tutorId:   tutorEmail,
        expireAt:  enrollmentExpiryDate.toISOString(),
      }
    };
  }
});

// Strict rate limit for enrollment endpoints
app.use('/tutor/enrollments', strictLimiter);
app.use('/tutor/enrollment/delete', strictLimiter);

//======================================================================
// Endpoint 9a: Get enrolled students (tutor only)
// GET /tutor/enrollments?classId=...&subjectId=...
//
// Query params:
//   classId   – required
//   subjectId – required
//
// Flow:
//   1. Validate params.
//   2. Verify tutor is approved.
//   3. Query studentEnrollments where enrollmentKeys array-contains
//      "{classId}|{subjectId}|{tutorEmail}".
//   4. Map each document to a clean response shape.
//   5. Return list.
//======================================================================
createQueuedEndpoint({
  method: 'get',
  path: '/tutor/enrollments',
  queueName: 'tutorEnrollments',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const tutorEmail = req.user?.email;
    if (!tutorEmail) throw new Error('BAD_REQUEST: Authenticated tutor email is missing');

    // ── 1. Validate query params ──
    const { classId, subjectId } = req.query;

    if (!classId)   throw new Error('BAD_REQUEST: classId is required');
    if (!subjectId) throw new Error('BAD_REQUEST: subjectId is required');

    validateIdParam(classId,   'classId');
    validateIdParam(subjectId, 'subjectId');

    // ── 2. Verify tutor is approved ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', tutorEmail)
      .where('status',  '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    const tutorData = tutorSnapshot.docs[0].data();

    // Verify classId is registered to this tutor
    const registeredClassId = tutorData.registeredClassId || {};
    if (!Object.prototype.hasOwnProperty.call(registeredClassId, classId)) {
      throw new Error('FORBIDDEN: Tutor is not registered for this class');
    }

    // Verify subjectId is registered under classId
    const registeredSubjectId = tutorData.registeredSubjectId || {};
    const classSubjects = registeredSubjectId[classId] || {};
    if (!Object.prototype.hasOwnProperty.call(classSubjects, subjectId)) {
      throw new Error('FORBIDDEN: Tutor is not registered for this subject under the given class');
    }

    // ── 3. Query studentEnrollments ──
    const enrollmentKey = `${classId}|${subjectId}|${tutorEmail}`;

    const snapshot = await db
      .collection('studentEnrollments')
      .where('enrollmentKeys', 'array-contains', enrollmentKey)
      .get();

    if (snapshot.empty) {
      return { success: true, data: [] };
    }

    // ── 4. Map to clean response shape ──
    const toDate = (value) => {
      if (!value) return null;
      if (typeof value.toDate === 'function') return value.toDate();
      if (value instanceof Date) return value;
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    };

    const data = snapshot.docs.map(doc => {
      const d = doc.data();

      const expiryRaw  = d.expireAt?.[classId]?.[subjectId]?.[tutorEmail];
      const expiryDate = toDate(expiryRaw);

      const joinedRaw  = d.createdAt;
      const joinedDate = toDate(joinedRaw);

      const className   = d.enrolledClassId?.[classId]   || '';
      const subjectName = d.enrolledSubjectId?.[classId]?.[subjectId] || '';

      return {
        studentEmail: d.studentId,
        joinedAt:     joinedDate  ? joinedDate.toISOString()  : null,
        expireAt:     expiryDate  ? expiryDate.toISOString()  : null,
        className,
        subjectName,
      };
    });

    logger.info(
      { tutorEmail, classId, subjectId, count: data.length },
      'Endpoint 9a: Enrolled students fetched'
    );

    return { success: true, data };
  }
});

//======================================================================
// Endpoint 9b: Delete a specific enrollment combination (tutor only)
// DELETE /tutor/enrollment/delete
//
// Body params:
//   studentId – student email (required)
//   classId   – required
//   subjectId – required
//
// Flow:
//   1. Validate params.
//   2. Verify tutor is approved.
//   3. Fetch the studentEnrollments document.
//   4. Confirm the enrollment under this tutor actually exists.
//   5. Remove all nested fields for this classId+subjectId+tutorEmail
//      combination using FieldValue.delete().
//   6. Remove the enrollmentKey from the enrollmentKeys array.
//   7. Return success.
//======================================================================
createQueuedEndpoint({
  method: 'delete',
  path: '/tutor/enrollment/delete',
  queueName: 'tutorEnrollmentDelete',
  handler: async (req, db) => {
    if (!db) throw new Error('BAD_REQUEST: Firestore not initialized');

    const tutorEmail = req.user?.email;
    if (!tutorEmail) throw new Error('BAD_REQUEST: Authenticated tutor email is missing');

    // ── 1. Validate body params ──
    const studentId = req.body?.studentId || req.query?.studentId;
    const { classId, subjectId } = req.body || {};

    if (!studentId) throw new Error('BAD_REQUEST: studentId is required');
    if (!classId)   throw new Error('BAD_REQUEST: classId is required');
    if (!subjectId) throw new Error('BAD_REQUEST: subjectId is required');

    validateIdParam(studentId, 'studentId');
    validateIdParam(classId,   'classId');
    validateIdParam(subjectId, 'subjectId');

    // ── 2. Verify tutor is approved ──
    const tutorSnapshot = await db
      .collection('tutors')
      .where('tutorId', '==', tutorEmail)
      .where('status',  '==', 'approved')
      .limit(1)
      .get();

    if (tutorSnapshot.empty) {
      throw new Error('FORBIDDEN: No approved tutor found for this account');
    }

    // ── 3. Fetch the enrollment document ──
    const enrollmentRef = db.collection('studentEnrollments').doc(studentId);
    const enrollmentDoc = await enrollmentRef.get();

    if (!enrollmentDoc.exists) {
      throw new Error('BAD_REQUEST: No enrollment found for this student');
    }

    const enrollmentData = enrollmentDoc.data();

    // ── 4. Confirm this specific combination exists under this tutor ──
    const existingTutorMap = enrollmentData.enrolledTutorId?.[classId]?.[subjectId] || {};
    if (!Object.prototype.hasOwnProperty.call(existingTutorMap, tutorEmail)) {
      throw new Error('FORBIDDEN: No enrollment found for this tutor/class/subject combination');
    }

    // ── 5. Remove all nested fields for this combination ──
    // Using dot-notation FieldValue.delete() to surgically remove only
    // this tutor's entry, leaving all other enrollments untouched.
    const deletePayload = {
      [`enrolledTutorId.${classId}.${subjectId}.${tutorEmail}`]: admin.firestore.FieldValue.delete(),
      [`expireAt.${classId}.${subjectId}.${tutorEmail}`]:        admin.firestore.FieldValue.delete(),
      enrollmentKeys: admin.firestore.FieldValue.arrayRemove(`${classId}|${subjectId}|${tutorEmail}`),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // If this was the only tutor under this subject, also clean up
    // the subject-level and class-level entries to avoid empty maps.
    const remainingTutors = Object.keys(existingTutorMap).filter(k => k !== tutorEmail);

    if (remainingTutors.length === 0) {
      // No other tutors for this subject — remove subject entry too
      deletePayload[`enrolledSubjectId.${classId}.${subjectId}`] = admin.firestore.FieldValue.delete();

      // Check if this was the only subject under this class
      const subjectsUnderClass = enrollmentData.enrolledSubjectId?.[classId] || {};
      const remainingSubjects  = Object.keys(subjectsUnderClass).filter(k => k !== subjectId);

      if (remainingSubjects.length === 0) {
        // No other subjects for this class — remove class entry too
        deletePayload[`enrolledClassId.${classId}`] = admin.firestore.FieldValue.delete();
      }
    }

    await enrollmentRef.update(deletePayload);

    logger.info(
      { tutorEmail, studentId, classId, subjectId },
      'Endpoint 9b: Enrollment deleted successfully'
    );

    return {
      success: true,
      message: 'Enrollment removed successfully',
      data: { studentId, classId, subjectId, tutorId: tutorEmail }
    };
  }
});

// -------------------------------
// Start Server
// -------------------------------
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
