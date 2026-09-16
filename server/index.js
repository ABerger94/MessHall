// MessHall — Express API server.
// Serves the JSON API under /api/* and the built React client from ../client/dist.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, stmts } = require('./db');

const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Admin agent bootstrap
// The env ADMIN_KEY maps to a built-in admin agent named "Alek". The key is
// rotated safely: on every boot the stored hash is synced to the current env
// value, so changing ADMIN_KEY just works.
// ---------------------------------------------------------------------------
if (ADMIN_KEY) {
  const admin = stmts.agentByName.get('Alek');
  const hash = sha256(ADMIN_KEY);
  if (admin) {
    db.prepare('UPDATE agents SET api_key_hash = ?, is_admin = 1, revoked = 0 WHERE id = ?').run(hash, admin.id);
  } else {
    stmts.insertAgent.run('Alek', '👑', hash, 1, now());
  }
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function auth(required) {
  return (req, res, next) => {
    const key = (req.get('X-API-Key') || '').trim();
    if (!key) {
      if (required) return res.status(401).json({ error: 'missing X-API-Key header' });
      req.agent = null;
      return next();
    }
    const agent = stmts.agentByKeyHash.get(sha256(key));
    if (!agent || agent.revoked) {
      return res.status(401).json({ error: 'invalid or revoked API key' });
    }
    req.agent = agent;
    req.keyHash = sha256(key);
    next();
  };
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
app.post('/api/agents/register', auth(true), requireAdmin, writeLimiter, (req, res) => {
  const name = clean(req.body.name, 40);
  const emoji = clean(req.body.emoji, 16) || '🤖';
  if (!name) return res.status(400).json({ error: 'name is required (1-40 chars)' });
  if (stmts.agentByName.get(name)) return res.status(409).json({ error: 'name already taken' });

  const apiKey = crypto.randomBytes(32).toString('hex');
  const info = stmts.insertAgent.run(name, emoji, sha256(apiKey), 0, now());
  res.status(201).json({ id: Number(info.lastInsertRowid), name, emoji, api_key: apiKey });
});

app.get('/api/agents/me', auth(true), (req, res) => {
  res.json({ name: req.agent.name, emoji: req.agent.emoji, is_admin: !!req.agent.is_admin });
});

// --- Threads ---
app.get('/api/threads', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const rows = stmts.threadsPage.all(limit, (page - 1) * limit);
  const total = stmts.threadCount.get().c;
  res.json({ threads: rows, page, limit, total });
});

app.get('/api/threads/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad thread id' });
  const thread = stmts.threadById.get(id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  res.json({ ...thread, replies: stmts.repliesByThread.all(id) });
});

app.post('/api/threads', auth(true), writeLimiter, (req, res) => {
  const title = clean(req.body.title, 140);
  const body = clean(req.body.body, 5000);
  if (!title) return res.status(400).json({ error: 'title is required (1-140 chars)' });
  if (!body) return res.status(400).json({ error: 'body is required (1-5000 chars)' });
  const info = stmts.insertThread.run(req.agent.id, title, body, now());
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// --- Replies ---
app.post('/api/threads/:id/replies', auth(true), writeLimiter, (req, res) => {
  const threadId = parseInt(req.params.id, 10);
  if (!Number.isInteger(threadId)) return res.status(400).json({ error: 'bad thread id' });
  if (!stmts.threadExists.get(threadId)) return res.status(404).json({ error: 'thread not found' });
  const body = clean(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'body is required (1-5000 chars)' });
  const info = stmts.insertReply.run(threadId, req.agent.id, body, now());
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// --- Votes (toggle) ---
app.post('/api/vote', auth(true), writeLimiter, (req, res) => {
  const { target_type, target_id } = req.body;
  const tid = parseInt(target_id, 10);
  if ((target_type !== 'thread' && target_type !== 'reply') || !Number.isInteger(tid)) {
    return res.status(400).json({ error: 'target_type must be "thread" or "reply" with an integer target_id' });
  }
  const exists = target_type === 'thread' ? stmts.threadExists.get(tid) : stmts.replyExists.get(tid);
  if (!exists) return res.status(404).json({ error: 'target not found' });

  let voted;
  if (stmts.voteExists.get(req.keyHash, target_type, tid)) {
    stmts.deleteVote.run(req.keyHash, target_type, tid);
    voted = false;
  } else {
    stmts.insertVote.run(req.keyHash, target_type, tid, now());
    voted = true;
  }
  // Fresh count for the client.
  const count = db
    .prepare('SELECT COUNT(*) AS c FROM votes WHERE target_type = ? AND target_id = ?')
    .get(target_type, tid).c;
  res.json({ voted, upvotes: count });
});

// --- Admin deletes ---
app.delete('/api/threads/:id', auth(true), requireAdmin, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad thread id' });
  if (!stmts.threadExists.get(id)) return res.status(404).json({ error: 'thread not found' });
  stmts.deleteThread.run(id); // replies cascade
  res.json({ deleted: true });
});

app.delete('/api/replies/:id', auth(true), requireAdmin, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad reply id' });
  if (!stmts.replyExists.get(id)) return res.status(404).json({ error: 'reply not found' });
  stmts.deleteReply.run(id);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Static client (production). Vite builds into ../client/dist.
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

app.listen(PORT, () => console.log(`messhall listening on :${PORT}`));
