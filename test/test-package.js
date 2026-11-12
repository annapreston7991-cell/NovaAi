/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Package wiring check: the entry point loads, host services are injected (no
 * reach into a host's data/db.js), migrations are safe to run twice, and the
 * views, public files and persona the site serves are all in the package.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

process.env.NODE_ENV = 'test';
process.env.NOVA_SECRETS_KEY = process.env.NOVA_SECRETS_KEY || crypto.randomBytes(32).toString('hex');
process.env.NOVA_BACKUP_KEY = process.env.NOVA_BACKUP_KEY || crypto.randomBytes(32).toString('hex');
process.env.NOVA_WORKSPACE_DIR = '/tmp/nova-pkg-test-ws';
process.env.NOVA_BACKUP_DIR = '/tmp/nova-pkg-test-bk';
if (!process.env.VAPID_PUBLIC_KEY) {
  const keys = require('web-push').generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}

const root = path.join(__dirname, '..');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

console.log('=== NOVA PACKAGE CHECKS ===');

const nova = require('..');

check('no Nova module reaches into a host folder (data/db, services/, cloudflare-ai, mcp_servers)', () => {
  const dirs = ['lib', 'lib/nova_plugins', 'middleware'];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d)).filter(x => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(root, d, f), 'utf8');
      assert(!/require\(['"]\.\.\/(data|services)\//.test(src), `${d}/${f} requires a host path`);
      assert(!/require\(['"]\.\/(cloudflare-ai|mcp_servers)['"]\)/.test(src), `${d}/${f} requires a host service directly`);
    }
  }
});

check('using a host service before configure() gives a clear error', () => {
  assert.throws(() => require('../lib/host').db.getRawDb(), /not configured/);
});

const raw = new Database(':memory:');
check('runMigrations creates the Nova tables and is safe to run twice', () => {
  nova.runMigrations(raw);
  nova.runMigrations(raw);
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'nova_%'").all().map(r => r.name);
  for (const t of ['nova_agents', 'nova_messages', 'nova_conversations', 'nova_user_settings', 'nova_secrets']) assert(names.includes(t), t + ' missing');
  const cols = raw.prepare('PRAGMA table_info(nova_user_settings)').all().map(c => c.name);
  assert(cols.includes('nova_ui_v3'));
});

check('configure() injects the host db and every export loads', () => {
  fs.mkdirSync('/tmp/nova-pkg-test-host', { recursive: true });
  nova.configure({
    rootDir: '/tmp/nova-pkg-test-host',
    db: () => ({ db: raw, getRawDb: () => raw, getSetting: (k, d) => d, logAudit: () => {} }),
    cloudflareAi: { chat: async () => ({ text: '' }) },
    mcpServers: { listServers: () => [] }
  });
  assert.strictEqual(require('../lib/host').db.getRawDb(), raw);
  for (const k of ['createNovaRouter', 'createNovaPluginsRouter', 'novaMenu', 'novaPersona', 'novaPlugins', 'novaLockdown', 'requireNovaUser', 'requireApprovalToken', 'novaSecrets', 'novaApprovals']) {
    assert(nova[k], k + ' did not load');
  }
  assert.strictEqual(typeof nova.createNovaRouter, 'function');
  assert.strictEqual(typeof nova.novaMenu.resolveUiV3, 'function');
});

check('persona comes from prompts/nova-persona.md when no admin override is set', () => {
  const p = nova.novaPersona.getNovaPersona();
  const file = fs.readFileSync(path.join(root, 'prompts/nova-persona.md'), 'utf8');
  assert(/You are Nova/.test(p) && p.includes(file.split('\n').find(l => l.startsWith('You are Nova')).slice(0, 60)), 'persona wording');
});

check('views, public files and schemas the site serves are in the package', () => {
  for (const f of ['novaai_app.ejs', 'nova.ejs', 'nova_plugins.ejs', 'nova_download.ejs', 'nova_how_it_works.ejs', 'partials/nova_widget.ejs', 'partials/nova/sidebar_v3.ejs', 'partials/nova/v3_panels.ejs']) {
    assert(fs.existsSync(path.join(nova.viewsPath, f)), 'views/' + f);
  }
  for (const f of ['css/nova.css', 'css/nova-v3.css', 'js/nova/app.js', 'js/nova/nova-v3.js', 'nova-manifest.json', 'nova-app.mobileconfig', 'images/nova-icon.jpg']) {
    assert(fs.existsSync(path.join(nova.publicPath, f)), 'public/' + f);
  }
});

check('.env.example has keys only, no values (except the public base URL)', () => {
  const lines = fs.readFileSync(path.join(root, '.env.example'), 'utf8').split('\n').filter(l => /^[A-Z0-9_]+=/.test(l));
  for (const l of lines) {
    const [k, v] = [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)];
    if (k === 'NOVA_PLUGINS_BASE_URL') continue;
    assert.strictEqual(v, '', k + ' must be empty');
  }
});

console.log(`\n=== ${passed} NOVA PACKAGE CHECKS PASSED ===`);
