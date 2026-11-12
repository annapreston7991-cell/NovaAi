#!/usr/bin/env node
/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nightly Encrypted Nova Backup Script (§15.7)
 * - Reads Nova tables from production SQLite DB (excluding nova_secrets)
 * - Compresses with gzip and encrypts with AES-256-GCM using NOVA_BACKUP_KEY
 * - Writes to NOVA_BACKUP_DIR (outside repo and outside public/)
 * - Prunes backup files older than 14 days
 * - Records backup metadata and SHA-256 in nova_backups table
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Load .env
const envPath = path.join(require('../lib/host').getRootDir(), '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      const idx = t.indexOf('=');
      if (idx !== -1) {
        const k = t.slice(0, idx).trim();
        const v = t.slice(idx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
    }
  });
}

const BACKUP_TABLES = [
  'nova_agents',
  'nova_sections',
  'nova_conversations',
  'nova_room_members',
  'nova_messages',
  'nova_reactions',
  'nova_attachments',
  'user_memories',
  'nova_routines',
  'nova_actions'
];

function deriveKey(rawKey) {
  if (!rawKey) throw new Error('NOVA_BACKUP_KEY is required in .env');
  if (/^[0-9a-fA-F]{64}$/.test(rawKey.trim())) {
    return Buffer.from(rawKey.trim(), 'hex');
  }
  return crypto.createHash('sha256').update(String(rawKey)).digest();
}

function runBackup({ dbPath = null, backupDir = null, retentionDays = 14 } = {}) {
  const prodDbPath = dbPath || process.env.DB_PATH || path.join(require('../lib/host').getRootDir(), 'data/llyverse.db');
  const targetDir = backupDir || process.env.NOVA_BACKUP_DIR || '/home/lily/nova-backups';
  const key = deriveKey(process.env.NOVA_BACKUP_KEY);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  const d = new Database(prodDbPath);
  d.pragma('busy_timeout = 5000');

  try {
    d.exec(`
      CREATE TABLE IF NOT EXISTS nova_backups (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        row_counts TEXT,
        last_drill_at DATETIME,
        last_drill_status TEXT,
        last_drill_details TEXT
      );
    `);

    const dump = {
      version: 1,
      createdAt: new Date().toISOString(),
      tables: {},
      schemas: {},
      rowCounts: {}
    };

    for (const table of BACKUP_TABLES) {
      const schemaRow = d.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
      if (!schemaRow || !schemaRow.sql) {
        dump.tables[table] = [];
        dump.rowCounts[table] = 0;
        continue;
      }
      dump.schemas[table] = schemaRow.sql;
      const rows = d.prepare(`SELECT * FROM "${table}"`).all();
      dump.tables[table] = rows;
      dump.rowCounts[table] = rows.length;
    }

    const jsonBytes = Buffer.from(JSON.stringify(dump), 'utf8');
    const compressed = zlib.gzipSync(jsonBytes, { level: 6 });

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format: MAGIC(8 bytes "NOVABKP1") + IV(12) + TAG(16) + CIPHERTEXT
    const magic = Buffer.from('NOVABKP1', 'ascii');
    const finalBuf = Buffer.concat([magic, iv, tag, encrypted]);
    const sha256 = crypto.createHash('sha256').update(finalBuf).digest('hex');

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `nova-${ts}.nova-backup`;
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, finalBuf, { mode: 0o600 });

    // Prune files older than retentionDays (14 days)
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const pruned = [];
    for (const entry of fs.readdirSync(targetDir)) {
      if (!entry.endsWith('.nova-backup')) continue;
      const full = path.join(targetDir, entry);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
          pruned.push(entry);
        }
      } catch (e) {}
    }

    const backupId = `bkp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    d.prepare(`
      INSERT INTO nova_backups (id, path, size, sha256, status, row_counts)
      VALUES (?, ?, ?, ?, 'OK', ?)
    `).run(backupId, filePath, finalBuf.length, sha256, JSON.stringify(dump.rowCounts));

    return {
      success: true,
      id: backupId,
      path: filePath,
      size: finalBuf.length,
      sha256,
      rowCounts: dump.rowCounts,
      pruned
    };
  } finally {
    d.close();
  }
}

function main() {
  try {
    const res = runBackup();
    console.log(JSON.stringify(res));
  } catch (err) {
    console.error('[NOVA BACKUP ERROR]', err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runBackup, deriveKey, BACKUP_TABLES, main };
