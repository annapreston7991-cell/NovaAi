#!/usr/bin/env node
/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Backup Restore Drill Script (§15.7)
 * - Decrypts a .nova-backup file with NOVA_BACKUP_KEY and decompresses it
 * - Restores into an isolated scratch SQLite DB (never into production or test.db)
 * - Verifies row counts match for all tables and queries a conversation
 * - Updates nova_backups with last_drill_at and last_drill_status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { deriveKey, BACKUP_TABLES } = require('./nova_backup');

function runRestoreDrill({ backupFilePath = null, scratchDbPath = null, keepScratch = false, wrongKey = null } = {}) {
  const prodDbPath = process.env.DB_PATH || path.join(require('../lib/host').getRootDir(), 'data/llyverse.db');
  const backupDir = process.env.NOVA_BACKUP_DIR || '/home/lily/nova-backups';

  let targetBackup = backupFilePath;
  if (!targetBackup) {
    const files = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter(f => f.endsWith('.nova-backup')).sort()
      : [];
    if (files.length === 0) {
      throw new Error(`No .nova-backup files found in ${backupDir}`);
    }
    targetBackup = path.join(backupDir, files[files.length - 1]);
  }

  const resolvedScratch = scratchDbPath || path.join(os.tmpdir(), `nova_restore_drill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
  if (path.resolve(resolvedScratch) === path.resolve(prodDbPath) || resolvedScratch.endsWith('test.db')) {
    throw new Error('Refusing to restore into production or test database.');
  }

  const rawBuf = fs.readFileSync(targetBackup);
  const magic = rawBuf.subarray(0, 8).toString('ascii');
  if (magic !== 'NOVABKP1') {
    throw new Error('Invalid backup file header');
  }
  const iv = rawBuf.subarray(8, 20);
  const tag = rawBuf.subarray(20, 36);
  const ciphertext = rawBuf.subarray(36);

  const key = deriveKey(wrongKey || process.env.NOVA_BACKUP_KEY);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const jsonStr = zlib.gunzipSync(compressed).toString('utf8');
  const dump = JSON.parse(jsonStr);

  const scratch = new Database(resolvedScratch);
  scratch.pragma('foreign_keys = OFF');
  const verifiedCounts = {};

  try {
    for (const table of BACKUP_TABLES) {
      const createSql = dump.schemas && dump.schemas[table];
      if (!createSql) {
        verifiedCounts[table] = 0;
        continue;
      }
      scratch.exec(createSql);
      const rows = (dump.tables && dump.tables[table]) || [];
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(', ');
        const colNames = cols.map(c => `"${c}"`).join(', ');
        const ins = scratch.prepare(`INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`);
        const tx = scratch.transaction((items) => {
          for (const item of items) {
            ins.run(...cols.map(c => item[c]));
          }
        });
        tx(rows);
      }
      const actualCount = scratch.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get().c;
      const expectedCount = (dump.rowCounts && dump.rowCounts[table]) || 0;
      if (actualCount !== expectedCount) {
        throw new Error(`Row count mismatch on ${table}: expected ${expectedCount}, got ${actualCount}`);
      }
      verifiedCounts[table] = actualCount;
    }

    // Verify built-in agents and a conversation can be queried from scratch DB
    const agents = scratch.prepare(`SELECT id, name FROM nova_agents ORDER BY id ASC`).all();
    const sampleConv = scratch.prepare(`SELECT id, title, agent_id FROM nova_conversations LIMIT 1`).get() || null;

    // Record drill success in production nova_backups table
    const prodDb = new Database(prodDbPath);
    prodDb.pragma('busy_timeout = 5000');
    try {
      prodDb.prepare(`
        UPDATE nova_backups
        SET last_drill_at = CURRENT_TIMESTAMP,
            last_drill_status = 'PASS',
            last_drill_details = ?
        WHERE path = ?
      `).run(JSON.stringify({ verifiedCounts, agentsCount: agents.length }), targetBackup);
    } finally {
      prodDb.close();
    }

    return {
      success: true,
      backupPath: targetBackup,
      scratchDbPath: resolvedScratch,
      verifiedCounts,
      agentsCount: agents.length,
      sampleConversation: sampleConv
    };
  } finally {
    scratch.close();
    if (!keepScratch && fs.existsSync(resolvedScratch)) {
      try { fs.unlinkSync(resolvedScratch); } catch (e) {}
    }
  }
}

function main() {
  try {
    const keepScratch = process.argv.includes('--keep');
    const fileArg = process.argv.find(a => a.endsWith('.nova-backup')) || null;
    const res = runRestoreDrill({ backupFilePath: fileArg, keepScratch });
    console.log(JSON.stringify(res));
  } catch (err) {
    console.error('[NOVA RESTORE DRILL ERROR]', err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runRestoreDrill, main };
