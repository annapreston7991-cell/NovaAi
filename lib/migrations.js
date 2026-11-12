/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova database tables. Every statement is "IF NOT EXISTS", so running this on a
 * database that already has Nova's tables changes nothing and loses no data.
 * The LLYVerse site still creates these same tables in its own data/db.js; this
 * copy lets Nova set up a fresh or test database on its own.
 *
 *   require('@llyverse/nova').runMigrations(rawBetterSqlite3Db);
 */

function runMigrations(db) {
  if (!db || typeof db.exec !== 'function') throw new Error('runMigrations needs a better-sqlite3 database');
  db.exec(`
    CREATE TABLE IF NOT EXISTS nova_agents (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      title TEXT,
      description TEXT,
      avatar_url TEXT,
      color TEXT,
      voice_profile TEXT,
      system_prompt TEXT,
      builtin INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nova_sections (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort INTEGER DEFAULT 0,
      collapsed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS nova_conversations (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'direct',
      agent_id TEXT REFERENCES nova_agents(id),
      title TEXT,
      section_id TEXT REFERENCES nova_sections(id),
      muted INTEGER DEFAULT 0,
      last_read_message_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nova_room_members (
      conversation_id TEXT REFERENCES nova_conversations(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES nova_agents(id),
      PRIMARY KEY (conversation_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS nova_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES nova_conversations(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nova_messages(id),
      role TEXT NOT NULL,
      agent_id TEXT,
      kind TEXT NOT NULL DEFAULT 'text',
      body TEXT,
      payload TEXT,
      status TEXT DEFAULT 'sent',
      job_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_nova_msgs_conv ON nova_messages(conversation_id, id);

    CREATE INDEX IF NOT EXISTS idx_nova_msgs_parent ON nova_messages(parent_id);

    CREATE TABLE IF NOT EXISTS nova_reactions (
      message_id TEXT NOT NULL REFERENCES nova_messages(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, actor_type, actor_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS nova_widgets (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES nova_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      spec TEXT NOT NULL,
      answer TEXT,
      answered_at DATETIME,
      expires_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS nova_attachments (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      message_id TEXT,
      filename TEXT,
      mime TEXT,
      size INTEGER,
      storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nova_routines (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      cron TEXT,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      event TEXT,
      enabled INTEGER DEFAULT 1,
      last_run_at DATETIME,
      last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS nova_secrets (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nova_user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT DEFAULT 'dark',
      accent TEXT DEFAULT 'cyan',
      density TEXT DEFAULT 'comfortable',
      sound INTEGER DEFAULT 1,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      language TEXT DEFAULT 'en',
      update_channel TEXT DEFAULT 'stable',
      nova_v2 INTEGER DEFAULT 1,
      nova_ui_v3 INTEGER DEFAULT 0,
      improve_nova INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nova_usage (
      day TEXT NOT NULL,
      persona TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      calls INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      PRIMARY KEY (day, persona, provider, model)
    );

    CREATE TABLE IF NOT EXISTS nova_usage_limits (
      scope TEXT PRIMARY KEY,
      daily_token_cap INTEGER NOT NULL,
      daily_cost_cap_usd REAL NOT NULL,
      ollama_max_concurrency INTEGER DEFAULT 1,
      alert_pct INTEGER DEFAULT 80,
      alerted_day TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS nova_push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      keys TEXT NOT NULL,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nova_push_prefs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      on_task_done INTEGER DEFAULT 1,
      on_approval INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, persona)
    );

    CREATE TABLE IF NOT EXISTS nova_user_daily_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL,
      day TEXT NOT NULL,
      messages INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(identity, day)
    );

    CREATE INDEX IF NOT EXISTS idx_nova_user_daily_usage ON nova_user_daily_usage(identity, day);
  `);
  const cols = db.prepare('PRAGMA table_info(nova_user_settings)').all().map(c => c.name);
  if (!cols.includes('nova_ui_v3')) db.exec('ALTER TABLE nova_user_settings ADD COLUMN nova_ui_v3 INTEGER DEFAULT 0');
  return true;
}

module.exports = { runMigrations };
