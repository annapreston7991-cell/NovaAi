/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Human Approval Service (§15.1, §5.3)
 * - Issues single-use, 5-minute approval tokens bound to the canonical SHA-256 hash of a stored action
 * - Stores only token_hash in SQLite table `nova_approvals`
 * - Enforces human-only approval (never automated, test, or routine self-approval)
 */

const crypto = require('crypto');
const db = require('./host').db;

const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

function ensureApprovalsTable() {
  const rawDb = db.getRawDb();
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS nova_approvals (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      widget_id TEXT,
      action_type TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      ip TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nova_approvals_token_hash ON nova_approvals(token_hash);
    CREATE INDEX IF NOT EXISTS idx_nova_approvals_user ON nova_approvals(user_id);
  `);
}

ensureApprovalsTable();

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sortedKeys = Object.keys(value).sort();
  const result = {};
  for (const k of sortedKeys) {
    if (value[k] !== undefined) {
      result[k] = canonicalize(value[k]);
    }
  }
  return result;
}

function computeActionHash({ type, args = {}, target = null, userId = null, conversationId = null }) {
  const canonical = canonicalize({
    type: String(type || ''),
    args: args || {},
    target: target || null,
    userId: userId ? Number(userId) : null,
    conversationId: conversationId || null
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

/**
 * Issues a single-use 5-minute approval token bound to the canonical action hash.
 * Must only be called from an authenticated human confirmation endpoint.
 */
function issueApprovalToken({
  userId,
  widgetId = null,
  actionType,
  args = {},
  target = null,
  conversationId = null,
  ip = null,
  userAgent = null,
  ttlMs = APPROVAL_TTL_MS
}) {
  if (!userId) {
    throw new Error('Human userId is required to mint an approval token');
  }
  if (!actionType) {
    throw new Error('actionType is required to mint an approval token');
  }

  ensureApprovalsTable();
  const rawDb = db.getRawDb();

  const id = `appr_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const rawToken = `nvt_${crypto.randomBytes(24).toString('hex')}`;
  const tokenHash = hashToken(rawToken);
  const actionHash = computeActionHash({
    type: actionType,
    args,
    target,
    userId,
    conversationId
  });
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  rawDb.prepare(`
    INSERT INTO nova_approvals (id, user_id, widget_id, action_type, action_hash, token_hash, expires_at, used_at, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, Number(userId), widgetId, String(actionType), actionHash, tokenHash, expiresAt, ip || null, userAgent || null);

  return {
    approvalId: id,
    token: rawToken,
    actionHash,
    expiresAt
  };
}

/**
 * Validates and atomically consumes a single-use approval token.
 * Returns { ok: boolean, status?: number, error?: string, code?: string, approval?: object }
 */
function verifyAndConsumeApprovalToken({
  token,
  userId,
  actionType,
  args = {},
  target = null,
  conversationId = null
}) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return {
      ok: false,
      status: 403,
      code: 'APPROVAL_REQUIRED',
      error: 'Human approval token is required before Nova can execute this action.'
    };
  }

  ensureApprovalsTable();
  const rawDb = db.getRawDb();
  const tokenHash = hashToken(token.trim());
  const row = rawDb.prepare('SELECT * FROM nova_approvals WHERE token_hash = ?').get(tokenHash);

  if (!row) {
    return {
      ok: false,
      status: 403,
      code: 'APPROVAL_INVALID',
      error: 'Invalid or unknown approval token.'
    };
  }

  if (row.used_at) {
    return {
      ok: false,
      status: 409,
      code: 'APPROVAL_REUSED',
      error: 'Approval token has already been used.'
    };
  }

  const nowMs = Date.now();
  const expiresMs = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresMs) || expiresMs <= nowMs) {
    return {
      ok: false,
      status: 410,
      code: 'APPROVAL_EXPIRED',
      error: 'Approval token has expired (5-minute validity window).'
    };
  }

  if (userId && Number(row.user_id) !== Number(userId)) {
    return {
      ok: false,
      status: 403,
      code: 'APPROVAL_USER_MISMATCH',
      error: 'Approval token belongs to a different user.'
    };
  }

  const expectedHash = computeActionHash({
    type: actionType,
    args,
    target,
    userId: row.user_id,
    conversationId
  });

  if (row.action_hash !== expectedHash) {
    return {
      ok: false,
      status: 403,
      code: 'APPROVAL_HASH_MISMATCH',
      error: 'Approval token does not match the requested action parameters.'
    };
  }

  const updateRes = rawDb.prepare(`
    UPDATE nova_approvals
    SET used_at = CURRENT_TIMESTAMP
    WHERE id = ? AND used_at IS NULL
  `).run(row.id);

  if (updateRes.changes === 0) {
    return {
      ok: false,
      status: 409,
      code: 'APPROVAL_REUSED',
      error: 'Approval token has already been used.'
    };
  }

  return {
    ok: true,
    approvalId: row.id,
    approval: { ...row, used_at: new Date().toISOString() }
  };
}

/**
 * Revokes all open (unused) approval tokens, e.g. when Stop Nova is pressed (§15.2)
 */
function revokeOpenApprovals(userId = null) {
  ensureApprovalsTable();
  const rawDb = db.getRawDb();
  if (userId) {
    return rawDb.prepare(`
      UPDATE nova_approvals
      SET expires_at = '1970-01-01T00:00:00.000Z'
      WHERE user_id = ? AND used_at IS NULL
    `).run(Number(userId));
  }
  return rawDb.prepare(`
    UPDATE nova_approvals
    SET expires_at = '1970-01-01T00:00:00.000Z'
    WHERE used_at IS NULL
  `).run();
}

module.exports = {
  APPROVAL_TTL_MS,
  computeActionHash,
  issueApprovalToken,
  verifyAndConsumeApprovalToken,
  revokeOpenApprovals,
  ensureApprovalsTable
};
