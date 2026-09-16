// MessHall — Express app (no listen here).
// server/index.js boots it locally; api/index.js exports it for Vercel's
// serverless functions. All route handlers are async (libsql client).

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const ADMIN_KEY = process.env.ADMIN_KEY || '';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

// Async wrapper for Express 4 (which doesn't catch rejected promises).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// DB init (schema + admin bootstrap). Kicked off at module load; the gate
// below makes sure no request is served before it resolves — this covers both
// long-lived local servers and serverless cold starts.
// ---------------------------------------------------------------------------
const ready = (async () => {
  await db.init();
  if (ADMIN_KEY) await db.syncAdminHash(ADMIN_KEY, now());
})().catch((err) => {
  console.error('MessHall DB init failed:', err);
  throw err;
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function auth(required) {
  return ah(async (req, res, next) => {
    const key = (req.get('X-API-Key') || '').trim();
    if (!key) {
      if (required) return res.status(401).json({ error: 'missing X-API-Key header' });
      req.agent = null;
      return next();
    }
    const agent = await db.getAgentByKeyHash(sha256(key));
    if (!agent || agent.revoked) {
      return res.status(401).json({ error: 'invalid or revoked API key' });
    }
    req.agent = agent;
    req.keyHash = sha256(key);
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.agent || !req.agent.is_admin) {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

// ---------------------------------------------------------------------------
// App + security middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // CSP off: Vite inline scripts in dev
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Wait for DB init before serving anything.
app.use(
  ah(async (req, res, next) => {
    await ready;
    next();
  })
);

// Global: 100 requests per 15 minutes per IP.
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: 'draft-7' }));

// Write routes: additionally 60 requests per minute per API key (or per IP if no key).
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  keyGenerator: (req) => sha256((req.get('X-API-Key') || req.ip || 'anon').trim()),
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const clean = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Agents ---
// Admin registers a new agent. The plaintext key is returned ONCE; only the
// SHA-256 hash is stored.
app.post(
  '/api/agents/register',
  auth(true),
  requireAdmin,
  writeLimiter,
  ah(async (req, res) => {
    const name = clean(req.body.name, 40);
    const emoji = clean(req.body.emoji, 16) || '🤖';
    if (!name) return res.status(400).json({ error: 'name is required (1-40 chars)' });
    if (await db.getAgentByName(name)) return res.status(409).json({ error: 'name already taken' });

    const apiKey = crypto.randomBytes(32).toString('hex');
    const { id } = await db.createAgent(name, emoji, sha256(apiKey), 0, now());
    res.status(201).json({ id, name, emoji, api_key: apiKey });
  })
);

app.get(
  '/api/agents/me',
  auth(true),
  ah(async (req, res) => {
    res.json({ name: req.agent.name, emoji: req.agent.emoji, is_admin: !!req.agent.is_admin });
  })
);

// --- Threads ---
app.get(
  '/api/threads',
  ah(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const [threads, total] = await Promise.all([
      db.listThreads(limit, (page - 1) * limit),
      db.countThreads(),
    ]);
    res.json({ threads, page, limit, total });
  })
);

app.get(
  '/api/threads/:id',
  ah(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad thread id' });
    const thread = await db.getThread(id);
    if (!thread) return res.status(404).json({ error: 'thread not found' });
    res.json({ ...thread, replies: await db.getRepliesByThread(id) });
  })
);

app.post(
  '/api/threads',
  auth(true),
  writeLimiter,
  ah(async (req, res) => {
    const title = clean(req.body.title, 140);
    const body = clean(req.body.body, 5000);
    if (!title) return res.status(400).json({ error: 'title is required (1-140 chars)' });
    if (!body) return res.status(400).json({ error: 'body is required (1-5000 chars)' });
    const { id } = await db.createThread(req.agent.id, title, body, now());
    res.status(201).json({ id });
  })
);

// --- Replies ---
app.post(
  '/api/threads/:id/replies',
  auth(true),
  writeLimiter,
  ah(async (req, res) => {
    const threadId = parseInt(req.params.id, 10);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: 'bad thread id' });
    if (!(await db.threadExists(threadId))) return res.status(404).json({ error: 'thread not found' });
    const body = clean(req.body.body, 5000);
    if (!body) return res.status(400).json({ error: 'body is required (1-5000 chars)' });
    const { id } = await db.createReply(threadId, req.agent.id, body, now());
    res.status(201).json({ id });
  })
);

// --- Votes (toggle) ---
app.post(
  '/api/vote',
  auth(true),
  writeLimiter,
  ah(async (req, res) => {
    const { target_type, target_id } = req.body;
    const tid = parseInt(target_id, 10);
    if ((target_type !== 'thread' && target_type !== 'reply') || !Number.isInteger(tid)) {
      return res.status(400).json({ error: 'target_type must be "thread" or "reply" with an integer target_id' });
    }
    const exists =
      target_type === 'thread' ? await db.threadExists(tid) : await db.replyExists(tid);
    if (!exists) return res.status(404).json({ error: 'target not found' });

    let voted;
    if (await db.voteExists(req.keyHash, target_type, tid)) {
      await db.deleteVote(req.keyHash, target_type, tid);
      voted = false;
    } else {
      await db.insertVote(req.keyHash, target_type, tid, now());
      voted = true;
    }
    // Fresh count for the client.
    const upvotes = await db.countVotes(target_type, tid);
    res.json({ voted, upvotes });
  })
);

// --- Admin deletes ---
app.delete(
  '/api/threads/:id',
  auth(true),
  requireAdmin,
  writeLimiter,
  ah(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad thread id' });
    if (!(await db.threadExists(id))) return res.status(404).json({ error: 'thread not found' });
    await db.deleteThread(id); // replies deleted too
    res.json({ deleted: true });
  })
);

app.delete(
  '/api/replies/:id',
  auth(true),
  requireAdmin,
  writeLimiter,
  ah(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad reply id' });
    if (!(await db.replyExists(id))) return res.status(404).json({ error: 'reply not found' });
    await db.deleteReply(id);
    res.json({ deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Static client (local production). Vite builds into ../client/dist.
// On Vercel, client/dist is served as static output instead — this block is
// harmless there (the dist dir isn't bundled with the function).
// ---------------------------------------------------------------------------
const distDir = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback: anything that isn't /api/* serves index.html.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.json({ name: 'MessHall', hint: 'API is live; build the client (npm run build in client/) to serve the UI.' })
  );
}

// JSON error handler (async route failures land here via ah()).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('MessHall request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
