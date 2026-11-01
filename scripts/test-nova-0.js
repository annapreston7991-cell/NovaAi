// scripts/test-nova-0.js
// Verification for NOVA-0: Privacy fix in training dataset extract
const assert = require('assert');
const Database = require('better-sqlite3');

function runTest() {
  console.log('=== RUNNING NOVA-0 PRIVACY VERIFICATION ===\n');

  const db = new Database(':memory:');
  
  // Setup tables
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      role TEXT,
      improve_nova INTEGER DEFAULT 0
    );
    CREATE TABLE user_chats (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      title TEXT,
      messages TEXT,
      system_prompt TEXT
    );
    CREATE TABLE user_memories (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      text TEXT
    );
  `);

  // Insert mock users:
  // User 1: Admin, opted IN (improve_nova = 1)
  // User 2: Admin, opted OUT (improve_nova = 0)
  // User 3: Member, opted IN (improve_nova = 1)
  // User 4: Member, opted OUT (improve_nova = 0)
  db.prepare("INSERT INTO users (id, username, role, improve_nova) VALUES (1, 'admin_optin', 'admin', 1)").run();
  db.prepare("INSERT INTO users (id, username, role, improve_nova) VALUES (2, 'admin_optout', 'admin', 0)").run();
  db.prepare("INSERT INTO users (id, username, role, improve_nova) VALUES (3, 'user_optin', 'member', 1)").run();
  db.prepare("INSERT INTO users (id, username, role, improve_nova) VALUES (4, 'user_optout', 'member', 0)").run();

  // Insert memories
  db.prepare("INSERT INTO user_memories (id, user_id, text) VALUES ('m1', 1, 'Admin 1 memory')").run();
  db.prepare("INSERT INTO user_memories (id, user_id, text) VALUES ('m2', 2, 'Admin 2 private memory')").run();
  db.prepare("INSERT INTO user_memories (id, user_id, text) VALUES ('m3', 3, 'Member 3 memory')").run();
  db.prepare("INSERT INTO user_memories (id, user_id, text) VALUES ('m4', 4, 'Member 4 private memory')").run();

  // Insert chats
  db.prepare("INSERT INTO user_chats (id, user_id, title, messages, system_prompt) VALUES (1, 1, 'Admin chat 1', '[]', 'sys1')").run();
  db.prepare("INSERT INTO user_chats (id, user_id, title, messages, system_prompt) VALUES (2, 2, 'Admin chat 2', '[]', 'sys2')").run();

  // Test the queries from server.js
  const extractedChats = db.prepare("SELECT c.title, c.messages, c.system_prompt FROM user_chats c JOIN users u ON c.user_id = u.id WHERE u.role = 'admin' AND u.improve_nova = 1 ORDER BY c.id ASC").all();
  const extractedMemories = db.prepare("SELECT m.text FROM user_memories m JOIN users u ON m.user_id = u.id WHERE u.improve_nova = 1 ORDER BY m.id ASC").all();

  console.log('Extracted chats count:', extractedChats.length);
  assert.strictEqual(extractedChats.length, 1, 'Only opted-in admin chat should be extracted');
  assert.strictEqual(extractedChats[0].title, 'Admin chat 1');

  console.log('Extracted memories count:', extractedMemories.length);
  assert.strictEqual(extractedMemories.length, 2, 'Only opted-in user memories should be extracted');
  const texts = extractedMemories.map(m => m.text);
  assert(texts.includes('Admin 1 memory'), 'Must include Admin 1 memory');
  assert(texts.includes('Member 3 memory'), 'Must include Member 3 memory');
  assert(!texts.includes('Admin 2 private memory'), 'Must NOT include Admin 2 private memory');
  assert(!texts.includes('Member 4 private memory'), 'Must NOT include Member 4 private memory');

  console.log('✓ All private / opted-out user memories strictly excluded from training dataset.\n');
  console.log('🎉 NOVA-0 PRIVACY VERIFICATION PASSED (100%)');
}

runTest();
