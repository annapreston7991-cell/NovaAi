/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Secrets & Redaction Service (§12, §5.2)
 * - AES-256-GCM encrypted storage in SQLite table `nova_secrets` using NOVA_SECRETS_KEY from .env
 * - Recursive `redact(obj, keys)` helper to ensure credentials/tokens never enter logs, audit details, or messages
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../data/db');

const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'apppassword',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'authtoken',
  'accesstoken',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
  'refreshtoken',
  'refresh_token',
  'otp',
  'totp',
  'code',
  'privatekey',
  'private_key'
];

// Ensure required Nova environment variables exist in .env without ever committing secrets to git
function ensureNovaEnvVars() {
  const envPath = path.join(__dirname, '../.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim();
          if (!process.env[k]) {
            process.env[k] = v;
          }
        }
      }
    });
  }

  let appended = '';
  if (!process.env.NOVA_SECRETS_KEY) {
    const generatedKey = crypto.randomBytes(32).toString('hex');
    process.env.NOVA_SECRETS_KEY = generatedKey;
    appended += `\n# Nova Encrypted Secrets Key (AES-256-GCM)\nNOVA_SECRETS_KEY=${generatedKey}\n`;
  }
  if (!process.env.NOVA_WORKSPACE_DIR) {
    const defaultWs = '/home/lily/nova-computer/workspace';
    process.env.NOVA_WORKSPACE_DIR = defaultWs;
    appended += `\n# Nova Computer Workspace Path\nNOVA_WORKSPACE_DIR=${defaultWs}\n`;
  }
  if (!process.env.NOVA_BACKUP_KEY) {
    const backupKey = crypto.randomBytes(32).toString('hex');
    process.env.NOVA_BACKUP_KEY = backupKey;
    appended += `\n# Nova Encrypted Backups Key (AES-256-GCM)\nNOVA_BACKUP_KEY=${backupKey}\n`;
  }
  if (!process.env.NOVA_BACKUP_DIR) {
    const defaultBackupDir = '/home/lily/backups/nova';
    process.env.NOVA_BACKUP_DIR = defaultBackupDir;
    appended += `\n# Nova Encrypted Backups Directory (outside repo)\nNOVA_BACKUP_DIR=${defaultBackupDir}\n`;
  }

  if (appended) {
    try {
      fs.appendFileSync(envPath, appended, { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      // Ignore if read-only in test environment
    }
  }
}

ensureNovaEnvVars();

function getEncryptionKeyBuffer() {
  const raw = process.env.NOVA_SECRETS_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(String(raw || 'nova-default-fallback-test-key')).digest();
}

function ensureSecretsTable() {
  const rawDb = db.getRawDb();
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS nova_secrets (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nova_secrets_user_target ON nova_secrets(user_id, target);
  `);
}

ensureSecretsTable();

/**
 * Redacts sensitive fields from any object, array, or JSON string.
 * @param {any} input
 * @param {string[]} [keys]
 */
function redact(input, keys = ['password', 'token', 'apiKey', 'secret', 'clientSecret', 'refreshToken', 'otp']) {
  const lowerSet = new Set([
    ...DEFAULT_SENSITIVE_KEYS,
    ...(Array.isArray(keys) ? keys.map(k => String(k).toLowerCase()) : [])
  ]);

  function walk(val, seen) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
      // If it looks like JSON, try redacting inside it
      if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
        try {
          const parsed = JSON.parse(val);
          return JSON.stringify(walk(parsed, seen));
        } catch (e) {
          return val;
        }
      }
      return val;
    }
    if (typeof val !== 'object') return val;
    if (Buffer.isBuffer(val)) return '[REDACTED_BUFFER]';
    if (seen.has(val)) return '[Circular]';
    seen.add(val);

    if (Array.isArray(val)) {
      return val.map(item => walk(item, seen));
    }

    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const kLower = k.toLowerCase();
      const isSensitive =
        lowerSet.has(kLower) ||
        kLower.includes('password') ||
        kLower.includes('secret') ||
        kLower.includes('apikey') ||
        kLower.includes('api_key') ||
        kLower.includes('token') ||
        kLower === 'otp' ||
        kLower === 'totp';
      if (isSensitive && v !== undefined && v !== null && v !== '') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = walk(v, seen);
      }
    }
    return out;
  }

  return walk(input, new WeakSet());
}

/**
 * Encrypts and stores a secret payload in `nova_secrets` using AES-256-GCM
 */
function saveSecret({ userId = 3, target, payload }) {
  if (!target) throw new Error('Secret target is required');
  ensureSecretsTable();
  const rawDb = db.getRawDb();
  const key = getEncryptionKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const existing = rawDb.prepare('SELECT id FROM nova_secrets WHERE user_id = ? AND target = ?').get(userId, target);
  const id = existing ? existing.id : `sec_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  rawDb.prepare(`
    INSERT INTO nova_secrets (id, user_id, target, ciphertext, iv, tag, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, target) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, userId, target, ciphertext, iv, tag);

  return { id, userId, target, updatedAt: new Date().toISOString() };
}

/**
 * Decrypts and returns a secret payload from `nova_secrets`
 */
function getSecret({ userId = 3, target }) {
  ensureSecretsTable();
  const rawDb = db.getRawDb();
  const row = rawDb.prepare('SELECT * FROM nova_secrets WHERE user_id = ? AND target = ?').get(userId, target);
  if (!row) return null;

  try {
    const key = getEncryptionKeyBuffer();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, row.iv);
    decipher.setAuthTag(row.tag);
    const decrypted = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    try {
      return JSON.parse(decrypted);
    } catch (e) {
      return decrypted;
    }
  } catch (err) {
    return null;
  }
}

/**
 * Lists all decrypted secrets matching a target prefix for a user (or falls back to founder user_id=3 for global MCP)
 */
function getSecretsByPrefix({ userId = 3, prefix = 'mcp_credentials:' }) {
  ensureSecretsTable();
  const rawDb = db.getRawDb();
  const rows = rawDb.prepare('SELECT * FROM nova_secrets WHERE user_id = ? AND target LIKE ?').all(userId, `${prefix}%`);
  const result = {};
  const key = getEncryptionKeyBuffer();

  for (const row of rows) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, row.iv);
      decipher.setAuthTag(row.tag);
      const decrypted = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
      const subKey = row.target.slice(prefix.length);
      result[subKey] = JSON.parse(decrypted);
    } catch (e) {}
  }
  return result;
}

function deleteSecret({ userId = 3, target }) {
  ensureSecretsTable();
  const rawDb = db.getRawDb();
  return rawDb.prepare('DELETE FROM nova_secrets WHERE user_id = ? AND target = ?').run(userId, target);
}

module.exports = {
  redact,
  saveSecret,
  getSecret,
  getSecretsByPrefix,
  deleteSecret,
  ensureSecretsTable
};
