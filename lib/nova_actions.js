/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Kill Switch & Activity Log Service (§15.2)
 * - Append-only SQLite `nova_actions` table with strict `source` ('user'|'routine'|'test'|'automated')
 * - Redacts secrets before storing `details`
 * - Coordinates global "Stop Nova" kill switch across running jobs, terminal processes, screen streams,
 *   open approval tokens, and routines
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const db = require('./host').db;
const novaSecrets = require('./nova_secrets');
const novaApprovals = require('./nova_approvals');

const VALID_SOURCES = new Set(['user', 'routine', 'test', 'automated']);
const novaBus = new EventEmitter();
novaBus.setMaxListeners(100);

// Registries of cancellable resources when Stop Nova is triggered
const stopHandlers = new Set();

function ensureActionsTable() {
  const rawDb = db.getRawDb();
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS nova_actions (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER,
      persona TEXT DEFAULT 'nova',
      action TEXT NOT NULL,
      target TEXT,
      source TEXT NOT NULL CHECK (source IN ('user','routine','test','automated')),
      approval_id TEXT REFERENCES nova_approvals(id),
      ip TEXT,
      user_agent TEXT,
      result TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nova_actions_created ON nova_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nova_actions_user ON nova_actions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nova_actions_persona ON nova_actions(persona, source);
  `);
}

ensureActionsTable();

function normalizeSource(source) {
  if (process.env.NODE_ENV === 'test' && (!source || source === 'automated')) {
    return 'test';
  }
  const s = String(source || 'user').toLowerCase();
  return VALID_SOURCES.has(s) ? s : 'automated';
}

/**
 * Append-only activity log writer for Nova actions.
 */
function logNovaAction({
  userId = null,
  persona = 'nova',
  action,
  target = null,
  source = null,
  approvalId = null,
  ip = null,
  userAgent = null,
  result = 'ok',
  details = {}
}) {
  if (!action) return null;
  ensureActionsTable();
  const rawDb = db.getRawDb();

  const id = `act_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  const cleanSource = normalizeSource(source);
  const redactedDetails = novaSecrets.redact(details || {});
  const detailsJson = typeof redactedDetails === 'string'
    ? redactedDetails
    : JSON.stringify(redactedDetails);

  rawDb.prepare(`
    INSERT INTO nova_actions (id, created_at, user_id, persona, action, target, source, approval_id, ip, user_agent, result, details)
    VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId ? Number(userId) : null,
    String(persona || 'nova').toLowerCase(),
    String(action),
    target ? String(target) : null,
    cleanSource,
    approvalId || null,
    ip || null,
    userAgent || null,
    String(result || 'ok'),
    detailsJson
  );

  const row = rawDb.prepare('SELECT * FROM nova_actions WHERE id = ?').get(id);
  novaBus.emit('action.logged', row);
  return row;
}

/**
 * Query activity log with filters; strips IP and User-Agent for non-admins.
 */
function queryNovaActions({
  requesterUserId = null,
  isAdmin = false,
  persona = null,
  source = null,
  action = null,
  result = null,
  from = null,
  to = null,
  limit = 50
} = {}) {
  ensureActionsTable();
  const rawDb = db.getRawDb();

  let sql = 'SELECT * FROM nova_actions WHERE 1=1';
  const params = [];

  if (!isAdmin) {
    sql += ' AND user_id = ?';
    params.push(Number(requesterUserId || 0));
  }
  if (persona) {
    sql += ' AND LOWER(persona) = ?';
    params.push(String(persona).toLowerCase());
  }
  if (source) {
    sql += ' AND LOWER(source) = ?';
    params.push(String(source).toLowerCase());
  }
  if (action) {
    sql += ' AND action LIKE ?';
    params.push(`%${action}%`);
  }
  if (result) {
    sql += ' AND LOWER(result) = ?';
    params.push(String(result).toLowerCase());
  }
  if (from) {
    sql += ' AND created_at >= ?';
    params.push(String(from));
  }
  if (to) {
    sql += ' AND created_at <= ?';
    params.push(String(to));
  }

  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));

  const rows = rawDb.prepare(sql).all(...params);
  return rows.map(r => {
    let parsedDetails = {};
    try {
      parsedDetails = r.details ? JSON.parse(r.details) : {};
    } catch (e) {
      parsedDetails = { raw: r.details };
    }
    const base = {
      id: r.id,
      createdAt: r.created_at,
      userId: r.user_id,
      persona: r.persona,
      action: r.action,
      target: r.target,
      source: r.source,
      approvalId: r.approval_id,
      result: r.result,
      details: parsedDetails
    };
    if (isAdmin) {
      base.ip = r.ip;
      base.userAgent = r.user_agent;
    }
    return base;
  });
}

function isNovaPaused() {
  try {
    return db.getSetting('nova_paused', '0') === '1';
  } catch (e) {
    return false;
  }
}

function registerStopHandler(fn) {
  if (typeof fn === 'function') {
    stopHandlers.add(fn);
  }
  return () => stopHandlers.delete(fn);
}

/**
 * Immediately stops all running Nova jobs, terminal processes, screen streams, open approvals, and routines.
 */
async function stopNova({ userId = null, ip = null, userAgent = null, source = 'user', reason = 'Manual kill switch triggered' } = {}) {
  db.setSetting('nova_paused', '1');
  db.setSetting('nova_paused_at', new Date().toISOString());

  // 1. Revoke all open approval tokens
  const revoked = novaApprovals.revokeOpenApprovals();

  // 2. Pause all enabled nova_routines if table exists
  let pausedRoutines = 0;
  try {
    const rawDb = db.getRawDb();
    const hasRoutines = rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nova_routines'").get();
    if (hasRoutines) {
      const res = rawDb.prepare('UPDATE nova_routines SET enabled = 0 WHERE enabled = 1').run();
      pausedRoutines = res.changes || 0;
    }
  } catch (e) {}

  // 3. Invoke all registered stop handlers (jobs, terminal child processes, screen streams)
  const handlerResults = [];
  for (const handler of stopHandlers) {
    try {
      const r = await handler({ userId, reason });
      handlerResults.push(r);
    } catch (e) {
      handlerResults.push({ error: e.message });
    }
  }

  // 4. Emit SSE stop broadcast
  novaBus.emit('nova.stopped', {
    paused: true,
    stoppedBy: userId,
    timestamp: new Date().toISOString()
  });

  // 5. Record in nova_actions
  const actionRecord = logNovaAction({
    userId,
    persona: 'nova',
    action: 'nova.stop',
    target: 'all',
    source: source || 'user',
    ip,
    userAgent,
    result: 'stopped',
    details: {
      reason,
      revokedApprovals: revoked ? revoked.changes : 0,
      pausedRoutines,
      handlersRun: handlerResults.length
    }
  });

  return {
    success: true,
    paused: true,
    revokedApprovals: revoked ? revoked.changes : 0,
    pausedRoutines,
    actionId: actionRecord ? actionRecord.id : null
  };
}

/**
 * Resumes Nova after being paused (requires admin + approval token).
 */
function resumeNova({ userId = null, approvalId = null, ip = null, userAgent = null, source = 'user' } = {}) {
  db.setSetting('nova_paused', '0');

  novaBus.emit('nova.resumed', {
    paused: false,
    resumedBy: userId,
    timestamp: new Date().toISOString()
  });

  const actionRecord = logNovaAction({
    userId,
    persona: 'nova',
    action: 'nova.resume',
    target: 'all',
    source: source || 'user',
    approvalId,
    ip,
    userAgent,
    result: 'resumed',
    details: { approvalId }
  });

  return {
    success: true,
    paused: false,
    actionId: actionRecord ? actionRecord.id : null
  };
}

module.exports = {
  novaBus,
  logNovaAction,
  queryNovaActions,
  isNovaPaused,
  registerStopHandler,
  stopNova,
  resumeNova,
  ensureActionsTable
};
