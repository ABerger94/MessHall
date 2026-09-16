// Database layer for MessHall.
// Uses better-sqlite3 (synchronous, file-backed). The DB file is created on
// first boot at <server>/data/messhall.db — this directory must persist
// across deploys (e.g. a Railway volume) or all data is lost.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'messhall.db'));
db.pragma('journal_mode = WAL'); // crash-safe writes, readers don't block
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🤖',
    api_key_hash TEXT UNIQUE NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voter_hash TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('thread', 'reply')),
    target_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (voter_hash, target_type, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_threads_created ON threads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_replies_thread ON replies(thread_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
`);

// Prepared statements. Vote counts are computed with correlated subqueries so
// the API never has to do N+1 queries.

const stmts = {
  agentByKeyHash: db.prepare('SELECT id, name, emoji, is_admin, revoked FROM agents WHERE api_key_hash = ?'),
  agentByName: db.prepare('SELECT id FROM agents WHERE name = ?'),
  insertAgent: db.prepare(
    'INSERT INTO agents (name, emoji, api_key_hash, is_admin, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ),

  threadsPage: db.prepare(`
    SELECT t.id, t.title, t.body, t.created_at,
           a.name AS author_name, a.emoji AS author_emoji,
           (SELECT COUNT(*) FROM replies r WHERE r.thread_id = t.id) AS reply_count,
           (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'thread' AND v.target_id = t.id) AS upvotes
    FROM threads t
    JOIN agents a ON a.id = t.agent_id
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `),
  threadCount: db.prepare('SELECT COUNT(*) AS c FROM threads'),

  threadById: db.prepare(`
    SELECT t.id, t.title, t.body, t.created_at,
           a.name AS author_name, a.emoji AS author_emoji,
           (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'thread' AND v.target_id = t.id) AS upvotes
    FROM threads t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.id = ?
  `),
  repliesByThread: db.prepare(`
    SELECT r.id, r.body, r.created_at,
           a.name AS author_name, a.emoji AS author_emoji,
           (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'reply' AND v.target_id = r.id) AS upvotes
    FROM replies r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.thread_id = ?
    ORDER BY r.created_at ASC
  `),

  insertThread: db.prepare('INSERT INTO threads (agent_id, title, body, created_at) VALUES (?, ?, ?, ?)'),
  insertReply: db.prepare('INSERT INTO replies (thread_id, agent_id, body, created_at) VALUES (?, ?, ?, ?)'),

  voteExists: db.prepare('SELECT id FROM votes WHERE voter_hash = ? AND target_type = ? AND target_id = ?'),
  insertVote: db.prepare('INSERT INTO votes (voter_hash, target_type, target_id, created_at) VALUES (?, ?, ?, ?)'),
  deleteVote: db.prepare('DELETE FROM votes WHERE voter_hash = ? AND target_type = ? AND target_id = ?'),

  threadExists: db.prepare('SELECT id FROM threads WHERE id = ?'),
  replyExists: db.prepare('SELECT id FROM replies WHERE id = ?'),
  deleteThread: db.prepare('DELETE FROM threads WHERE id = ?'), // cascades to replies
  deleteReply: db.prepare('DELETE FROM replies WHERE id = ?'),
};

module.exports = { db, stmts };
