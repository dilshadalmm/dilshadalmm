// Cloudflare Worker for Ultimate Solution API
// Bindings: US_KV (KV namespace)

import * as jose from 'jose';

const FIREBASE_PROJECT_ID = 'fir-f3d53';
const FIREBASE_PUBLIC_KEYS_URL = `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function successResponse(data, extra = {}) {
  return new Response(JSON.stringify({ success: true, ...extra, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function verifyFirebaseToken(token) {
  try {
    const cacheKey = 'firebase_public_keys';
    let publicKeys;
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      publicKeys = await cached.json();
    } else {
      const resp = await fetch(FIREBASE_PUBLIC_KEYS_URL);
      publicKeys = await resp.json();
      const cacheResponse = new Response(JSON.stringify(publicKeys), {
        headers: { 'Cache-Control': 'public, max-age=21600' },
      });
      await caches.default.put(cacheKey, cacheResponse);
    }

    const { payload } = await jose.jwtVerify(token, async (header) => {
      const key = publicKeys[header.kid];
      if (!key) throw new Error('Invalid key ID');
      return jose.importX509(key, 'RS256');
    });

    if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error('Invalid audience');
    return payload;
  } catch (err) {
    console.error('Token verification failed:', err);
    return null;
  }
}

async function checkUserAccess(kv, uid, requestedClass) {
  const userKey = `user:${uid}`;
  const userData = await kv.get(userKey, 'json');
  if (!userData) return false;
  // Use permittedClass (singular) as defined in KV rebuild endpoint
  const permittedClass = userData.permittedClass || [];
  return permittedClass.includes(requestedClass);
}

async function handleSubjects(request, env) {
  const url = new URL(request.url);
  const className = url.searchParams.get('class');
  if (!className) return errorResponse('Missing required query parameter: class', 400);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return errorResponse('Missing or invalid authorization token', 401);
  const token = authHeader.slice(7);
  const decoded = await verifyFirebaseToken(token);
  if (!decoded) return errorResponse('Invalid or expired token', 401);

  const hasAccess = await checkUserAccess(env.US_KV, decoded.sub, className);
  if (!hasAccess) return errorResponse(`Access denied: you are not permitted to access "${className}"`, 403);

  const subjectsKey = `subjects:${className}`;
  let subjects = await env.US_KV.get(subjectsKey, 'json');
  if (!subjects) subjects = [];

  return successResponse({ subjects });
}

async function handleChapters(request, env) {
  const url = new URL(request.url);
  const className = url.searchParams.get('class');
  const subject = url.searchParams.get('subject');
  if (!className || !subject) return errorResponse('Missing required query parameters: class and subject', 400);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return errorResponse('Missing or invalid authorization token', 401);
  const token = authHeader.slice(7);
  const decoded = await verifyFirebaseToken(token);
  if (!decoded) return errorResponse('Invalid or expired token', 401);

  const hasAccess = await checkUserAccess(env.US_KV, decoded.sub, className);
  if (!hasAccess) return errorResponse(`Access denied: you are not permitted to access "${className}"`, 403);

  const chaptersKey = `chapters:${className}:${subject}`;
  let chapters = await env.US_KV.get(chaptersKey, 'json');
  if (!chapters) chapters = [];

  return successResponse({ chapters });
}

async function handleUltimateSolutions(request, env) {
  const url = new URL(request.url);
  const className = url.searchParams.get('className');
  const subject = url.searchParams.get('subject');
  const chapter = url.searchParams.get('chapter');

  if (!className) return errorResponse('Missing required query parameter: className', 400);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return errorResponse('Missing or invalid authorization token', 401);
  const token = authHeader.slice(7);
  const decoded = await verifyFirebaseToken(token);
  if (!decoded) return errorResponse('Invalid or expired token', 401);

  const hasAccess = await checkUserAccess(env.US_KV, decoded.sub, className);
  if (!hasAccess) return errorResponse(`Access denied: you are not permitted to access "${className}"`, 403);

  const kvKey = `ultimate:class:${className}`;
  let allSolutions = await env.US_KV.get(kvKey, 'json');
  if (!allSolutions) allSolutions = [];

  let filtered = [];
  if (subject && chapter) {
    filtered = allSolutions.filter(item => item.subject === subject && item.chapter === chapter);
  } else if (!subject && !chapter) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    filtered = allSolutions.filter(item => {
      if (!item.createdAt) return false;
      const itemDate = new Date(item.createdAt);
      return itemDate >= sevenDaysAgo;
    });
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else {
    return errorResponse('Invalid parameters. Provide either only "className" or all three: className, subject, chapter.', 400);
  }

  return successResponse(filtered, { count: filtered.length });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/subjects' && request.method === 'GET') return handleSubjects(request, env);
    if (path === '/api/chapters' && request.method === 'GET') return handleChapters(request, env);
    if (path === '/api/ultimate-solutions' && request.method === 'GET') return handleUltimateSolutions(request, env);

    return errorResponse('Endpoint not found', 404);
  },
};
