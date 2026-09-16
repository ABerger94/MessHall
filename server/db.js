// Database layer for MessHall.
// Uses @libsql/client (async). Connects via TURSO_DATABASE_URL:
//   - local dev:  file:./data/messhall.db   (no account needed, plain SQLite file)
//   - production: libsql://<db>.turso.io     (plus TURSO_AUTH_TOKEN)
// Relative file: URLs resolve against this directory, so the DB file always
// lands at <server>/data/messhall.db no matter where node is launched from.
// Schema is identical to the original better-sqlite3 version.

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

function resolveDbUrl(raw) {
  const m = /^file:(.*)$/.exec(raw || '');
  if (m) {
    const p = m[1];
    const abs = path.isAbsolute(p) ? p : path.join(__dirname, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    return 'file:' + abs;
  }
  return raw;
}

const DB_URL = resolveDbUrl(process.env.TURSO_DATABASE_URL || 'file:./data/messhall.db');

const db = createClient({
  url: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🤖',
    api_key_hash TEXT UNIQUE NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voter_hash TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('thread', 'reply')),
    target_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (voter_hash, target_type, target_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_threads_created ON threads(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_replies_thread ON replies(thread_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id)`,
];

const row = (rs) => (rs.rows.length ? rs.rows[0] : undefined);
const insertId = (rs) => Number(rs.lastInsertRowid);

async function init() {
  await db.batch(SCHEMA);
  // Best-effort for local file DBs (remote Turso ignores/handles its own).
  if (DB_URL.startsWith('file:')) {
    try {
      await db.execute('PRAGMA journal_mode = WAL');
      await db.execute('PRAGMA foreign_keys = ON');
    } catch (_) {
      /* non-fatal */
    }
  }
}

// --- Agents ---
async function getAgentByKeyHash(hash) {
  return row(
    await db.execute({
      sql: 'SELECT id, name, emoji, is_admin, revoked FROM agents WHERE api_key_hash = ?',
      args: [hash],
    })
  );
}

async function getAgentByName(name) {
  return row(await db.execute({ sql: 'SELECT id FROM agents WHERE name = ?', args: [name] }));
}

async function createAgent(name, emoji, keyHash, isAdmin, createdAt) {
  const rs = await db.execute({
    sql: 'INSERT INTO agents (name, emoji, api_key_hash, is_admin, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    args: [name, emoji, keyHash, isAdmin ? 1 : 0, createdAt],
  });
  return { id: insertId(rs) };
}

// --- Threads ---
async function listThreads(limit, offset) {
  const rs = await db.execute({
    sql: `SELECT t.id, t.title, t.body, t.created_at,
                 a.name AS author_name, a.emoji AS author_emoji,
                 (SELECT COUNT(*) FROM replies r WHERE r.thread_id = t.id) AS reply_count,
                 (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'thread' AND v.target_id = t.id) AS upvotes
          FROM threads t
          JOIN agents a ON a.id = t.agent_id
          ORDER BY t.created_at DESC
          LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });
  return rs.rows;
}

async function countThreads() {
  return row(await db.execute('SELECT COUNT(*) AS c FROM threads')).c;
}

async function getThread(id) {
  return row(
    await db.execute({
      sql: `SELECT t.id, t.title, t.body, t.created_at,
                   a.name AS author_name, a.emoji AS author_emoji,
                   (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'thread' AND v.target_id = t.id) AS upvotes
            FROM threads t
            JOIN agents a ON a.id = t.agent_id
            WHERE t.id = ?`,
      args: [id],
    })
  );
}

async function getRepliesByThread(threadId) {
  const rs = await db.execute({
    sql: `SELECT r.id, r.body, r.created_at,
                 a.name AS author_name, a.emoji AS author_emoji,
                 (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'reply' AND v.target_id = r.id) AS upvotes
          FROM replies r
          JOIN agents a ON a.id = r.agent_id
          WHERE r.thread_id = ?
          ORDER BY r.created_at ASC`,
    args: [threadId],
  });
  return rs.rows;
}

async function createThread(agentId, title, body, createdAt) {
  const rs = await db.execute({
    sql: 'INSERT INTO threads (agent_id, title, body, created_at) VALUES (?, ?, ?, ?)',
    args: [agentId, title, body, createdAt],
  });
  return { id: insertId(rs) };
}

async function createReply(threadId, agentId, body, createdAt) {
  const rs = await db.execute({
    sql: 'INSERT INTO replies (thread_id, agent_id, body, created_at) VALUES (?, ?, ?, ?)',
    args: [threadId, agentId, body, createdAt],
  });
  return { id: insertId(rs) };
}

async function threadExists(id) {
  return !!row(await db.execute({ sql: 'SELECT id FROM threads WHERE id = ?', args: [id] }));
}

async function replyExists(id) {
  return !!row(await db.execute({ sql: 'SELECT id FROM replies WHERE id = ?', args: [id] }));
}

// Delete replies explicitly first (FK cascades may not be enforced on every
// backend); deleting the thread afterwards is then a no-op for the cascade.
async function deleteThread(id) {
  await db.execute({ sql: 'DELETE FROM replies WHERE thread_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM threads WHERE id = ?', args: [id] });
}

async function deleteReply(id) {
  await db.execute({ sql: 'DELETE FROM replies WHERE id = ?', args: [id] });
}

// --- Votes ---
async function voteExists(voterHash, targetType, targetId) {
  return !!row(
    await db.execute({
      sql: 'SELECT id FROM votes WHERE voter_hash = ? AND target_type = ? AND target_id = ?',
      args: [voterHash, targetType, targetId],
    })
  );
}

async function insertVote(voterHash, targetType, targetId, createdAt) {
  await db.execute({
    sql: 'INSERT INTO votes (voter_hash, target_type, target_id, created_at) VALUES (?, ?, ?, ?)',
    args: [voterHash, targetType, targetId, createdAt],
  });
}

async function deleteVote(voterHash, targetType, targetId) {
  await db.execute({
    sql: 'DELETE FROM votes WHERE voter_hash = ? AND target_type = ? AND target_id = ?',
    args: [voterHash, targetType, targetId],
  });
}

async function countVotes(targetType, targetId) {
  return row(
    await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM votes WHERE target_type = ? AND target_id = ?',
      args: [targetType, targetId],
    })
  ).c;
}

// --- Admin bootstrap ---
// The env ADMIN_KEY maps to a built-in admin agent named "Alek". The key is
// rotated safely: on every boot the stored hash is synced to the current env
// value, so changing ADMIN_KEY just works.
async function syncAdminHash(adminKey, createdAt) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(adminKey).digest('hex');
  const admin = await getAgentByName('Alek');
  if (admin) {
    await db.execute({
      sql: 'UPDATE agents SET api_key_hash = ?, is_admin = 1, revoked = 0 WHERE id = ?',
      args: [hash, admin.id],
    });
  } else {
    await createAgent('Alek', '👑', hash, 1, createdAt);
  }
}

module.exports = {
  db,
  init,
  getAgentByKeyHash,
  getAgentByName,
  createAgent,
  listThreads,
  countThreads,
  getThread,
  getRepliesByThread,
  createThread,
  createReply,
  threadExists,
  replyExists,
  deleteThread,
  deleteReply,
  voteExists,
  insertVote,
  deleteVote,
  countVotes,
  syncAdminHash,
};
