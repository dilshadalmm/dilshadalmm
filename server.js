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

// ==================== Firebase Admin Initialization ====================
let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin initialized');
  } else console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set');
} catch (err) {
  console.error('Failed to initialize Firebase Admin:', err.message);
}
const db = firebaseInitialized ? admin.firestore() : null;

// ==================== Hashing & Normalization ====================
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

// ==================== Constants ====================
const BATCH_SIZE = 20;
const MAX_CONCURRENT_BATCHES = 5;
const MAX_WAIT_MS = 100;
const RESPONSE_TIMEOUT_MS = 60000;
const DEFAULT_ROLE = 'student';

// ==================== Authentication & Permission Helpers ====================
/**
 * Verify Firebase ID token from Authorization header.
 * Attaches user data to req.user.
 */
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or invalid token' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    // Get or create user document
    let userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      // Create new user with default student role
      await db.collection('users').doc(uid).set({
        email: decoded.email,
        role: DEFAULT_ROLE,
        sessionVersion: 0,
        permissions: {},
        subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        expireAt: null, // or far future
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      });
      userDoc = await db.collection('users').doc(uid).get();
    } else {
      // Update last login
      await db.collection('users').doc(uid).update({
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    req.user = { uid, ...userDoc.data() };
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

/**
 * Middleware to check if user has admin role.
 */
function checkAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

/**
 * Check if admin has permission for a given class and subject.
 * Permissions structure:
 * {
 *   "CLASS_10": { "fullAccess": true },
 *   "CLASS_9": { "subjects": ["Physics"] }
 * }
 */
function hasPermission(userPermissions, className, subjectName) {
  if (!userPermissions) return false;
  const classPerm = userPermissions[className];
  if (!classPerm) return false;
  if (classPerm.fullAccess === true) return true;
  if (classPerm.subjects && classPerm.subjects.includes(subjectName)) return true;
  return false;
}

/**
 * Middleware to check if admin can access the given class/subject.
 * Expects req.body.class and req.body.subject or req.query.class/subject.
 */
function checkQuestionPermission(req, res, next) {
  const className = req.body.class || req.query.class;
  const subject = req.body.subject || req.query.subject;
  if (!className || !subject) {
    return res.status(400).json({ success: false, error: 'Missing class or subject' });
  }
  if (!hasPermission(req.user.permissions, className, subject)) {
    return res.status(403).json({ success: false, error: 'No permission for this class/subject' });
  }
  next();
}

/**
 * Helper to generate Firestore query constraints based on admin permissions.
 * Returns an array of { class, subjects[] } objects.
 */
function getPermissionConstraints(permissions) {
  const constraints = [];
  for (const [className, perm] of Object.entries(permissions)) {
    if (perm.fullAccess === true) {
      constraints.push({ class: className, allSubjects: true });
    } else if (perm.subjects && perm.subjects.length) {
      constraints.push({ class: className, subjects: perm.subjects });
    }
  }
  return constraints;
}

// ==================== Queue & Batch Processing ====================
const requestQueue = [];
let activeBatches = 0;
let partialBatchTimeoutId = null;

function generateQuestionId(classKey, subjectKey, sequenceNumber) {
  return `${classKey}_${subjectKey}_q${sequenceNumber}`;
}

async function getNextQuestionNumbers(classKey, subjectKey, count) {
  if (!db) throw new Error('Firestore not initialized');
  if (count <= 0) return [];

  const counterId = `${classKey}_${subjectKey}`;
  const counterRef = db.collection('counters').doc(counterId);

  return await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(counterRef);
    let current = 1;
    if (doc.exists) current = doc.data().currentNumber + 1;
    const nextNumbers = [];
    for (let i = 0; i < count; i++) nextNumbers.push(current + i);
    transaction.set(counterRef, { currentNumber: current + count - 1 }, { merge: true });
    return nextNumbers;
  });
}

async function commitBatchWrites(writes) {
  if (!writes.length) return;
  const chunkSize = 500;
  for (let i = 0; i < writes.length; i += chunkSize) {
    const chunk = writes.slice(i, i + chunkSize);
    const batch = db.batch();
    for (const { docRef, data } of chunk) batch.set(docRef, data);
    await batch.commit();
  }
}

async function commitBatchDeletes(docRefs) {
  if (!docRefs.length) return;
  const chunkSize = 500;
  for (let i = 0; i < docRefs.length; i += chunkSize) {
    const chunk = docRefs.slice(i, i + chunkSize);
    const batch = db.batch();
    for (const docRef of chunk) batch.delete(docRef);
    await batch.commit();
  }
}

function setupRequestTimeout(item) {
  item.timeout = setTimeout(() => {
    if (!item.sent) {
      item.sent = true;
      item.res.json({
        status: 'error',
        message: 'Request took too long. Please try again.',
        questionsProcessed: 0,
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

async function getExistingHashes(hashes) {
  if (!db || !hashes.length) return new Set();
  const existing = new Set();
  const chunkSize = 10;
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const chunk = hashes.slice(i, i + chunkSize);
    const snapshot = await db
      .collection('questions')
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

async function processBatch(batch) {
  // Step 1: Gather all valid questions and compute hashes
  const allItemsData = [];
  for (const item of batch) {
    const { questions, class: className, subject, chapter } = item;
    if (!Array.isArray(questions) || questions.length === 0) {
      allItemsData.push({ item, validQuestions: [], hashes: [] });
      continue;
    }
    const validQuestions = questions.filter(
      q =>
        q.questionText &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        typeof q.correctIndex === 'number' &&
        q.solutionText
    );
    if (validQuestions.length === 0) {
      allItemsData.push({ item, validQuestions: [], hashes: [] });
      continue;
    }
    const hashes = validQuestions.map(q => createQuestionHash(q));
    allItemsData.push({ item, validQuestions, hashes });
  }

  // Step 2: Check duplicates
  const allHashes = allItemsData.flatMap(data => data.hashes);
  let existingHashesSet = new Set();
  if (allHashes.length) existingHashesSet = await getExistingHashes(allHashes);

  // Step 3: Process each item
  for (const { item, validQuestions, hashes } of allItemsData) {
    if (validQuestions.length === 0) {
      if (!item.sent) {
        item.sent = true;
        clearRequestTimeout(item);
        item.res.json({
          status: 'success',
          message: 'No valid questions provided.',
          questionsProcessed: 0,
        });
      }
      continue;
    }

    const newQuestions = [];
    const newHashes = [];
    for (let i = 0; i < validQuestions.length; i++) {
      const hash = hashes[i];
      if (!existingHashesSet.has(hash)) {
        newQuestions.push(validQuestions[i]);
        newHashes.push(hash);
        existingHashesSet.add(hash);
      }
    }

    if (newQuestions.length === 0) {
      if (!item.sent) {
        item.sent = true;
        clearRequestTimeout(item);
        item.res.json({
          status: 'success',
          message: 'All provided questions are duplicates.',
          questionsProcessed: 0,
        });
      }
      continue;
    }

    const classKey = item.class.trim().toUpperCase().replace(/\s+/g, '_');
    const subjectKey = item.subject.trim().toUpperCase().replace(/\s+/g, '_');

    try {
      const seqNumbers = await getNextQuestionNumbers(classKey, subjectKey, newQuestions.length);
      const writes = [];
      const savedQuestionIds = [];

      for (let i = 0; i < newQuestions.length; i++) {
        const q = newQuestions[i];
        const seqNumber = seqNumbers[i];
        const questionId = generateQuestionId(classKey, subjectKey, seqNumber);
        const hash = newHashes[i];

        const questionDoc = {
          questionId,
          questionText: q.questionText,
          options: q.options,
          correctIndex: q.correctIndex,
          solutionText: q.solutionText,
          questionImageUrl: q.questionImageUrl || null,
          solutionVideoUrl: q.solutionVideoUrl || null,
          solutionImageUrl: q.solutionImageUrl || null,
          class: item.class,
          subject: item.subject,
          chapter: item.chapter,
          embedded: false,
          questionHash: hash,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = db.collection('questions').doc(questionId);
        writes.push({ docRef, data: questionDoc });
        savedQuestionIds.push(questionId);
      }

      await commitBatchWrites(writes);
      console.log(`✅ Saved ${savedQuestionIds.length} new questions for item`);

      if (!item.sent) {
        item.sent = true;
        clearRequestTimeout(item);
        item.res.json({
          status: 'success',
          message: `Processed ${savedQuestionIds.length} questions. (${
            validQuestions.length - savedQuestionIds.length
          } duplicates skipped)`,
          questionsProcessed: savedQuestionIds.length,
        });
      }
    } catch (err) {
      console.error(`Failed to process item: ${err.message}`);
      if (!item.sent) {
        item.sent = true;
        clearRequestTimeout(item);
        item.res.json({
          status: 'error',
          message: `Database operation failed: ${err.message}`,
          questionsProcessed: 0,
        });
      }
    }
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
          questionsProcessed: 0,
        });
      }
    });
  } finally {
    activeBatches--;
    scheduleProcessing();
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

// ==================== Authentication Endpoints ====================

/**
 * POST /auth/verify-token
 * Receives Firebase ID token, verifies it, updates sessionVersion, returns user data.
 */
app.post('/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token required' });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // Create new user
      await userRef.set({
        email: decoded.email,
        role: DEFAULT_ROLE,
        sessionVersion: 1,
        permissions: {},
        subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        expireAt: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // Increment sessionVersion and update lastLogin
      const currentVersion = userDoc.data().sessionVersion || 0;
      await userRef.update({
        sessionVersion: currentVersion + 1,
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const freshUser = await userRef.get();
    const userData = freshUser.data();
    return res.json({
      success: true,
      user: {
        uid,
        email: userData.email,
        role: userData.role,
        sessionVersion: userData.sessionVersion,
        permissions: userData.permissions,
        subscribedAt: userData.subscribedAt,
        expireAt: userData.expireAt,
      },
    });
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
});

/**
 * POST /auth/validate-session
 * Validates UID + sessionVersion from frontend storage.
 */
app.post('/auth/validate-session', async (req, res) => {
  const { uid, sessionVersion } = req.body;
  if (!uid || sessionVersion === undefined) {
    return res.status(400).json({ success: false, error: 'UID and sessionVersion required' });
  }

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }
    const userData = userDoc.data();
    if (userData.sessionVersion !== sessionVersion) {
      return res.status(401).json({ success: false, error: 'Session expired' });
    }
    return res.json({
      success: true,
      user: {
        uid,
        email: userData.email,
        role: userData.role,
        sessionVersion: userData.sessionVersion,
        permissions: userData.permissions,
        subscribedAt: userData.subscribedAt,
        expireAt: userData.expireAt,
      },
    });
  } catch (error) {
    console.error('Session validation error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==================== Question Management (Admin Only, Permission Scoped) ====================

/**
 * POST /api/ingest
 * Create new questions. Requires admin and permission for the class/subject.
 */
app.post('/api/ingest', verifyToken, checkAdmin, checkQuestionPermission, async (req, res) => {
  try {
    const { questions, class: className, subject, chapter } = req.body;

    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ status: 'error', message: 'questions array is required' });
    }
    if (!className || !subject || !chapter) {
      return res.status(400).json({ status: 'error', message: 'class, subject, and chapter are required' });
    }

    const item = {
      res,
      questions,
      class: className,
      subject,
      chapter,
      sent: false,
      timeout: null,
    };
    setupRequestTimeout(item);
    requestQueue.push(item);
    scheduleProcessing();
  } catch (error) {
    console.error('Critical Backend Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        status: 'error',
        message: 'A critical error occurred.',
        questionsProcessed: 0,
      });
    }
  }
});

/**
 * GET /api/questions
 * Admin endpoint to fetch questions within permission scope.
 */
app.get('/api/questions', verifyToken, checkAdmin, async (req, res) => {
  try {
    const { limit: limitParam } = req.query;
    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) limit = parsed;
      else return res.status(400).json({ success: false, error: 'limit must be a positive integer' });
    }

    const constraints = getPermissionConstraints(req.user.permissions);
    if (constraints.length === 0) {
      return res.json({ success: true, questions: [] }); // no permissions
    }

    // Execute multiple queries and merge results
    const allQuestions = [];
    for (const constraint of constraints) {
      let query = db.collection('questions');
      if (constraint.allSubjects) {
        query = query.where('class', '==', constraint.class);
      } else {
        // Need to query for each subject? Firestore doesn't support OR for subjects.
        // We'll run one query per subject (up to a reasonable number)
        for (const subject of constraint.subjects) {
          let subQuery = db.collection('questions').where('class', '==', constraint.class).where('subject', '==', subject);
          const snapshot = await subQuery.limit(limit).get();
          snapshot.forEach(doc => allQuestions.push(doc.data()));
        }
        continue;
      }
      const snapshot = await query.limit(limit).get();
      snapshot.forEach(doc => allQuestions.push(doc.data()));
    }

    // Remove duplicates (by questionId) and apply limit
    const unique = new Map();
    for (const q of allQuestions) unique.set(q.questionId, q);
    const questions = Array.from(unique.values()).slice(0, limit);

    res.json({
      success: true,
      questions: questions.map(q => ({
        questionId: q.questionId,
        questionText: q.questionText,
        options: q.options,
        correctIndex: q.correctIndex,
        solutionText: q.solutionText,
        questionImageUrl: q.questionImageUrl || null,
        solutionVideoUrl: q.solutionVideoUrl || null,
        solutionImageUrl: q.solutionImageUrl || null,
      })),
    });
  } catch (error) {
    console.error('Error in GET /api/questions:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * PUT /api/question
 * Update a question. Checks permission against existing question's class/subject.
 */
app.put('/api/question', verifyToken, checkAdmin, async (req, res) => {
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
    } = req.body;

    if (!questionId || typeof questionId !== 'string') {
      return res.status(400).json({ success: false, error: 'questionId required' });
    }

    const docRef = db.collection('questions').doc(questionId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Question not found' });

    const existing = doc.data();
    // Check permission for the existing class/subject
    if (!hasPermission(req.user.permissions, existing.class, existing.subject)) {
      return res.status(403).json({ success: false, error: 'No permission to edit this question' });
    }

    const updateData = {};
    if (questionText !== undefined) updateData.questionText = questionText;
    if (options !== undefined) updateData.options = options;
    if (correctIndex !== undefined) updateData.correctIndex = correctIndex;
    if (solutionText !== undefined) updateData.solutionText = solutionText;
    if (questionImageUrl !== undefined) updateData.questionImageUrl = questionImageUrl;
    if (solutionVideoUrl !== undefined) updateData.solutionVideoUrl = solutionVideoUrl;
    if (solutionImageUrl !== undefined) updateData.solutionImageUrl = solutionImageUrl;

    // Recalculate hash if text or options changed
    if (updateData.questionText !== undefined || updateData.options !== undefined) {
      const newQuestion = {
        questionText: updateData.questionText !== undefined ? updateData.questionText : existing.questionText,
        options: updateData.options !== undefined ? updateData.options : existing.options,
      };
      updateData.questionHash = createQuestionHash(newQuestion);
    }

    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await docRef.update(updateData);
    console.log(`✏️ Updated question: ${questionId}`);
    res.json({ success: true, message: 'Question updated successfully' });
  } catch (error) {
    console.error('Error in PUT /api/question:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /api/question
 * Delete a single question. Checks permission against its class/subject.
 */
app.delete('/api/question', verifyToken, checkAdmin, async (req, res) => {
  try {
    const { questionId } = req.body;
    if (!questionId || typeof questionId !== 'string') {
      return res.status(400).json({ success: false, error: 'questionId required' });
    }

    const docRef = db.collection('questions').doc(questionId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Question not found' });

    const existing = doc.data();
    if (!hasPermission(req.user.permissions, existing.class, existing.subject)) {
      return res.status(403).json({ success: false, error: 'No permission to delete this question' });
    }

    await docRef.delete();
    console.log(`🗑️ Deleted question: ${questionId}`);
    res.json({ success: true, message: 'Question deleted successfully' });
  } catch (error) {
    console.error('Error in DELETE /api/question:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /api/questions/bulk
 * Bulk delete questions. Checks permission for each.
 */
app.delete('/api/questions/bulk', verifyToken, checkAdmin, async (req, res) => {
  try {
    const { questionIds, class: className, subject, chapter } = req.body;

    let docRefs = [];
    if (questionIds && Array.isArray(questionIds) && questionIds.length > 0) {
      for (const id of questionIds) {
        if (typeof id !== 'string') return res.status(400).json({ success: false, error: 'Each questionId must be a string' });
        docRefs.push(db.collection('questions').doc(id));
      }
    } else if (className && subject && chapter) {
      const snapshot = await db.collection('questions')
        .where('class', '==', className)
        .where('subject', '==', subject)
        .where('chapter', '==', chapter)
        .get();
      if (!snapshot.empty) docRefs = snapshot.docs.map(doc => doc.ref);
    } else {
      return res.status(400).json({ success: false, error: 'Provide questionIds or class/subject/chapter' });
    }

    if (docRefs.length === 0) return res.json({ success: true, deletedCount: 0 });

    // Fetch all documents to check permissions
    const docs = await Promise.all(docRefs.map(ref => ref.get()));
    const invalid = docs.some(doc => {
      if (!doc.exists) return false;
      const data = doc.data();
      return !hasPermission(req.user.permissions, data.class, data.subject);
    });
    if (invalid) {
      return res.status(403).json({ success: false, error: 'Some questions are not allowed for deletion' });
    }

    await commitBatchDeletes(docRefs);
    console.log(`🗑️ Bulk deleted ${docRefs.length} questions`);
    res.json({ success: true, deletedCount: docRefs.length });
  } catch (error) {
    console.error('Error in DELETE /api/questions/bulk:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==================== Public Quiz Endpoint ====================
app.get('/api/quiz', async (req, res) => {
  try {
    const { className, subject, chapter, limit: limitParam } = req.query;

    if (!className || !subject || !chapter) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    let limit = 10;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) limit = parsed;
      else return res.status(400).json({ success: false, error: 'limit must be a positive integer' });
    }

    if (!db) return res.status(500).json({ success: false, error: 'Database unavailable' });

    const snapshot = await db.collection('questions')
      .where('class', '==', className)
      .where('subject', '==', subject)
      .where('chapter', '==', chapter)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ success: false, error: 'No questions found' });
    }

    let questions = snapshot.docs.map(doc => doc.data());
    // Shuffle
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
    const limited = questions.slice(0, limit);
    const formatted = limited.map(q => ({
      questionText: q.questionText,
      options: q.options,
      solutionText: q.solutionText,
      correctIndex: q.correctIndex,
      solutionVideoUrl: q.solutionVideoUrl || null,
      questionImageUrl: q.questionImageUrl || null,
      solutionImageUrl: q.solutionImageUrl || null,
    }));
    res.json({ success: true, questions: formatted });
  } catch (error) {
    console.error('Error in /api/quiz:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==================== Metadata Endpoints (Public) ====================
let metadataCache = {
  classes: null,
  subjectsByClass: {},
  chaptersByClassAndSubject: {},
  lastFetch: 0,
};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function refreshMetadataCache() {
  if (!db) return;
  const now = Date.now();
  if (metadataCache.lastFetch && now - metadataCache.lastFetch < CACHE_TTL_MS) return;
  console.log('Refreshing metadata cache...');
  const snapshot = await db.collection('questions').select('class', 'subject', 'chapter').get();
  const classesSet = new Set();
  const subjectsMap = new Map();
  const chaptersMap = new Map();

  snapshot.forEach(doc => {
    const data = doc.data();
    const className = data.class;
    const subject = data.subject;
    const chapter = data.chapter;
    if (className) classesSet.add(className);
    if (className && subject) {
      if (!subjectsMap.has(className)) subjectsMap.set(className, new Set());
      subjectsMap.get(className).add(subject);
    }
    if (className && subject && chapter) {
      const key = `${className}|${subject}`;
      if (!chaptersMap.has(key)) chaptersMap.set(key, new Set());
      chaptersMap.get(key).add(chapter);
    }
  });

  metadataCache = {
    classes: Array.from(classesSet).sort(),
    subjectsByClass: Object.fromEntries(
      Array.from(subjectsMap.entries()).map(([c, s]) => [c, Array.from(s).sort()])
    ),
    chaptersByClassAndSubject: Object.fromEntries(
      Array.from(chaptersMap.entries()).map(([key, ch]) => [key, Array.from(ch).sort()])
    ),
    lastFetch: Date.now(),
  };
}

app.get('/api/classes', async (req, res) => {
  try {
    if (!db) throw new Error('Firestore not initialized');
    await refreshMetadataCache();
    res.json({ success: true, classes: metadataCache.classes });
  } catch (error) {
    console.error('Error fetching classes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch classes' });
  }
});

app.get('/api/subjects', async (req, res) => {
  try {
    const { class: className } = req.query;
    if (!className) return res.status(400).json({ success: false, error: 'class parameter required' });
    if (!db) throw new Error('Firestore not initialized');
    await refreshMetadataCache();
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
    if (!className || !subject) return res.status(400).json({ success: false, error: 'class and subject required' });
    if (!db) throw new Error('Firestore not initialized');
    await refreshMetadataCache();
    const key = `${className}|${subject}`;
    const chapters = metadataCache.chaptersByClassAndSubject[key] || [];
    res.json({ success: true, chapters });
  } catch (error) {
    console.error('Error fetching chapters:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch chapters' });
  }
});

// ==================== Health Check ====================
app.get('/health', (req, res) => res.send('Active'));

// ==================== Start Server ====================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
