/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova plugins: registry + confirmation gating tests.
 * Runs on an in-memory SQLite database and a fake network, so it never touches
 * the real database, real accounts or the internet.
 */
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

process.env.NODE_ENV = 'test';
// Set the Nova keys so nova_secrets never writes to .env during tests
process.env.NOVA_SECRETS_KEY = crypto.randomBytes(32).toString('hex');
process.env.NOVA_BACKUP_KEY = crypto.randomBytes(32).toString('hex');
process.env.NOVA_WORKSPACE_DIR = '/tmp/nova-test-workspace';
process.env.NOVA_BACKUP_DIR = '/tmp/nova-test-backups';

const root = path.join(__dirname, '..');
function stub(rel, exportsObj) {
  const file = require.resolve(path.join(root, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

// Fake data/db with a real in-memory SQLite (nova_secrets + nova_approvals only need getRawDb)
const raw = new Database(':memory:');
require('../lib/host').configure({ rootDir: '/tmp/nova-test-host', db: { db: raw, getRawDb: () => raw, getSetting: (k, d) => d, logAudit: () => {} } });
const cards = [];
const messages = [];
stub('lib/nova_widgets.js', { createCardMessage: (c) => { cards.push(c); return { id: 'w' + cards.length, ...c }; } });
stub('lib/nova_chat.js', {
  insertMessage: (m) => { const msg = { id: 'm' + (messages.length + 1), ...m }; messages.push(msg); return msg; },
  emitToUser: () => {}
});
stub('lib/nova_actions.js', { logNovaAction: () => {} });

const plugins = require('../lib/nova_plugins');
const approvals = require('../lib/nova_approvals');
const secrets = require('../lib/nova_secrets');

const member = { id: 42, username: 'member', role: 'user' };
const owner = { id: 3, username: 'owner', role: 'admin' };
const ALL_ENV = {};
for (const p of plugins.PLUGINS) for (const k of plugins.requiredEnv(p)) ALL_ENV[k] = 'test-value';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('✓ ' + name);
}

(async () => {
  console.log('=== NOVA PLUGINS TESTS ===');

  await check('registry has Gmail, GitHub and at least 15 more, with unique ids', () => {
    const ids = plugins.PLUGINS.map(p => p.id);
    assert(ids.includes('gmail') && ids.includes('github'));
    assert(ids.length >= 17, 'need 17+ plugins, got ' + ids.length);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate plugin id');
  });

  await check('every manifest is complete; every write has a preview', () => {
    for (const p of plugins.PLUGINS) {
      assert(p.name && p.description && p.category, p.id + ' missing name/description/category');
      assert(['oauth2', 'server_key', 'none'].includes(p.auth.type), p.id + ' bad auth type');
      if (p.auth.type === 'oauth2') {
        assert(p.auth.authorizeUrl && p.auth.tokenUrl, p.id + ' oauth urls');
        assert(/^NOVA_PLUGIN_[A-Z_]+_CLIENT_ID$/.test(p.auth.clientIdEnv) && /^NOVA_PLUGIN_[A-Z_]+_CLIENT_SECRET$/.test(p.auth.clientSecretEnv), p.id + ' env names');
        assert(p.auth.devConsole, p.id + ' needs a developer console hint');
        assert(p.auth.authorizeUrl.startsWith('https://') && p.auth.tokenUrl.startsWith('https://'));
      }
      assert(p.actions.length > 0, p.id + ' has no actions');
      assert(p.actions.some(a => a.kind === 'read'), p.id + ' needs at least one read action');
      for (const a of p.actions) {
        assert(['read', 'write'].includes(a.kind), `${p.id}.${a.id} kind`);
        assert(typeof a.run === 'function' && a.title, `${p.id}.${a.id} run/title`);
        if (a.kind === 'write') assert(typeof a.preview === 'function', `${p.id}.${a.id} write needs a preview`);
      }
      if (p.ownerOnly) assert(p.actions.every(a => a.kind === 'read'), p.id + ' owner plugins are read-only');
    }
  });

  await check('.env.example lists every plugin key with no values', () => {
    const fs = require('fs');
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    for (const k of Object.keys(ALL_ENV)) {
      const line = example.split('\n').find(l => l.startsWith(k + '='));
      assert(line, k + ' missing from .env.example');
      assert.strictEqual(line, k + '=', k + ' must be empty in .env.example');
    }
  });

  await check('unconfigured plugins are hidden from members; owner-only hidden from members', () => {
    const none = plugins.listForUser(member, {});
    assert.deepStrictEqual(none.map(p => p.id), ['wikipedia'], 'only key-less plugins show with no env');
    const all = plugins.listForUser(member, ALL_ENV).map(p => p.id);
    assert(all.includes('gmail') && all.includes('github'));
    assert(!all.includes('stripe') && !all.includes('cloudflare'), 'owner-only plugins leaked to a member');
    const ownerList = plugins.listForUser(owner, ALL_ENV).map(p => p.id);
    assert(ownerList.includes('stripe') && ownerList.includes('cloudflare'));
    const half = { NOVA_PLUGIN_GITHUB_CLIENT_ID: 'x' };
    assert(!plugins.listForUser(member, half).some(p => p.id === 'github'), 'needs ALL keys');
  });

  await check('member listing and setup status never include secret values', () => {
    const env = { ...ALL_ENV, NOVA_PLUGIN_GITHUB_CLIENT_SECRET: 'super-secret-value' };
    assert(!JSON.stringify(plugins.listForUser(owner, env)).includes('super-secret-value'));
    const status = plugins.setupStatus(env);
    assert(!JSON.stringify(status).includes('super-secret-value'));
    const gh = status.find(s => s.id === 'github');
    assert.strictEqual(gh.configured, true);
    assert.strictEqual(gh.redirectUri, 'https://llyverse.org/api/nova/plugins/oauth/callback/github');
    assert.deepStrictEqual(plugins.setupStatus({}).find(s => s.id === 'github').missingEnv, ['NOVA_PLUGIN_GITHUB_CLIENT_ID', 'NOVA_PLUGIN_GITHUB_CLIENT_SECRET']);
  });

  await check('validateParams rejects unknown, missing and badly formatted params', () => {
    const action = plugins.getPlugin('github').actions.find(a => a.id === 'create_issue');
    assert.throws(() => plugins.validateParams(action, { repo: 'a/b', title: 't', evil: 1 }), /not allowed|Unknown|unknown/);
    assert.throws(() => plugins.validateParams(action, { title: 't' }), /Missing "repo"/);
    assert.throws(() => plugins.validateParams(action, { repo: '../etc', title: 't' }), /format/);
    assert.throws(() => plugins.validateParams(action, { repo: 'a/..', title: 't' }), /format/);
    assert.deepStrictEqual(plugins.validateParams(action, { repo: 'me/.github', title: 't' }), { repo: 'me/.github', title: 't' });
    assert.deepStrictEqual(plugins.validateParams(action, { repo: 'a/b', title: 't' }), { repo: 'a/b', title: 't' });
  });

  await check('OAuth connect: state is per user, single use, and PKCE for X', async () => {
    const url = new URL(plugins.beginConnect(member, 'github', {}, ALL_ENV));
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://llyverse.org/api/nova/plugins/oauth/callback/github');
    const state = url.searchParams.get('state');
    assert(state && state.length >= 32);
    await assert.rejects(plugins.completeConnect(owner, 'github', { state, code: 'c' }, ALL_ENV), /state|expired|match/i, 'another user cannot use my state');
    const x = new URL(plugins.beginConnect(member, 'x', {}, ALL_ENV));
    assert.strictEqual(x.searchParams.get('code_challenge_method'), 'S256');
    assert.throws(() => plugins.beginConnect(member, 'shopify', { shop: 'evil.com' }, ALL_ENV), /shop/);
    assert.throws(() => plugins.beginConnect(member, 'stripe', {}, ALL_ENV), /not available/);
  });

  await check('Shopify callback HMAC is verified', () => {
    const q = { code: 'abc', shop: 'demo.myshopify.com', state: 's', timestamp: '1' };
    const msg = Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('&');
    const hmac = crypto.createHmac('sha256', 'shh').update(msg).digest('hex');
    assert.strictEqual(plugins.verifyShopifyHmac({ ...q, hmac }, 'shh'), true);
    assert.strictEqual(plugins.verifyShopifyHmac({ ...q, hmac, code: 'tampered' }, 'shh'), false);
    assert.strictEqual(plugins.verifyShopifyHmac(q, 'shh'), false);
  });

  // ---- confirmation gating ----
  Object.assign(process.env, ALL_ENV);
  secrets.saveSecret({ userId: member.id, target: 'plugin:github', payload: { access_token: 'gho_test', token_type: 'bearer', account: { label: 'member' } } });
  const calls = [];
  plugins._setFetchForTests(async (url, opts) => {
    calls.push({ url, method: opts.method, auth: opts.headers.Authorization });
    const body = opts.method === 'POST' ? { number: 7, html_url: 'https://github.com/a/b/issues/7', title: 'Hello' } : [{ full_name: 'a/b', private: false, html_url: 'https://github.com/a/b', updated_at: '2026-11-01' }];
    return { status: opts.method === 'POST' ? 201 : 200, ok: true, text: async () => JSON.stringify(body) };
  });
  const args = { pluginId: 'github', actionId: 'create_issue', params: { repo: 'a/b', title: 'Hello' }, conversationId: 'conv1' };

  await check('reads run straight away with the member\'s own token', async () => {
    const r = await plugins.runRead(member, 'github', 'list_repos', {});
    assert(r.text.includes('a/b'));
    assert.strictEqual(calls.pop().auth, 'Bearer gho_test');
  });

  await check('runRead refuses write actions (CONFIRMATION_REQUIRED)', async () => {
    await assert.rejects(plugins.runRead(member, 'github', 'create_issue', { repo: 'a/b', title: 'x' }), (e) => e.code === 'CONFIRMATION_REQUIRED' && e.status === 403);
    assert.strictEqual(calls.length, 0, 'no network call');
  });

  await check('write with no token / a wrong token / a token for other args is blocked before any network call', async () => {
    await assert.rejects(plugins.runWrite(member, args, null));
    await assert.rejects(plugins.runWrite(member, args, 'not-a-real-token'));
    const other = approvals.issueApprovalToken({ userId: member.id, actionType: 'plugin.run', args: { ...args, params: { repo: 'a/b', title: 'Different' } } });
    await assert.rejects(plugins.runWrite(member, args, other.token), 'token bound to different args');
    const otherUser = approvals.issueApprovalToken({ userId: owner.id, actionType: 'plugin.run', args });
    await assert.rejects(plugins.runWrite(member, args, otherUser.token), 'token for another user');
    const wrongType = approvals.issueApprovalToken({ userId: member.id, actionType: 'nova.resume', args });
    await assert.rejects(plugins.runWrite(member, args, wrongType.token), 'token for another action type');
    assert.strictEqual(calls.length, 0, 'no network call was made');
  });

  await check('a valid confirmation runs the write once; the token cannot be reused', async () => {
    const ok = approvals.issueApprovalToken({ userId: member.id, actionType: 'plugin.run', args });
    const r = await plugins.runWrite(member, args, ok.token);
    assert(r.text.includes('#7') || r.text.includes('issues/7'), r.text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'POST');
    await assert.rejects(plugins.runWrite(member, args, ok.token), 'reuse must fail');
    assert.strictEqual(calls.length, 1);
    calls.length = 0;
  });

  await check('requestWriteConfirmation makes an approval card and runs nothing', () => {
    plugins.requestWriteConfirmation({ user: member, conversationId: 'conv1', ...args });
    const card = cards.pop();
    assert.strictEqual(card.type, 'approval');
    assert.strictEqual(card.spec.action.type, 'plugin.run');
    assert.deepStrictEqual(card.spec.action.args, args);
    assert(card.spec.details.includes('Hello'), 'preview shows what will happen');
    assert.strictEqual(calls.length, 0);
    assert.throws(() => plugins.requestWriteConfirmation({ user: { id: 99, role: 'user' }, conversationId: 'c', ...args }), /Connect GitHub first/);
  });

  await check('Nova\'s reply: reads run, writes become cards (never run directly)', async () => {
    const reply = 'Sure!\n```nova-plugin\n{"plugin":"github","action":"create_issue","params":{"repo":"a/b","title":"Hello"}}\n```\n```nova-plugin\n{"plugin":"github","action":"list_repos","params":{}}\n```';
    const parsed = plugins.parseToolCalls(reply);
    assert.strictEqual(parsed.calls.length, 2);
    assert.strictEqual(parsed.cleaned, 'Sure!');
    const out = await plugins.handleReplyToolCalls({ user: member, conversationId: 'conv1', reply });
    assert.deepStrictEqual(out.outcomes.map(o => o.status), ['awaiting_confirmation', 'done']);
    assert.strictEqual(cards.length, 1, 'one confirmation card');
    assert(calls.every(c => c.method !== 'POST'), 'the write did not run');
    const many = Array.from({ length: 6 }, () => '```nova-plugin\n{"plugin":"wikipedia","action":"search","params":{"query":"x"}}\n```').join('\n');
    assert.strictEqual(plugins.parseToolCalls(many).calls.length, 3, 'max 3 calls per reply');
  });

  await check('rate limit: 20 actions a minute per member', async () => {
    plugins._rateBuckets.clear();
    for (let i = 0; i < 20; i++) await plugins.runRead(member, 'github', 'list_repos', {});
    await assert.rejects(plugins.runRead(member, 'github', 'list_repos', {}), (e) => e.status === 429);
    plugins._rateBuckets.clear();
  });

  await check('disconnect deletes the member\'s token', async () => {
    await plugins.disconnect(member, 'github');
    assert.strictEqual(secrets.getSecret({ userId: member.id, target: 'plugin:github' }), null);
    assert(!plugins.listForUser(member).find(p => p.id === 'github').connected);
  });

  await check('system prompt block lists only what this member can use, with no secrets', () => {
    const text = plugins.describeForPrompt(member);
    assert(text.includes('nova-plugin') && text.includes('Wikipedia'));
    assert(!text.includes('Stripe'), 'owner-only plugin in a member prompt');
    assert(!text.includes('test-value'));
  });

  console.log(`\n=== ${passed} NOVA PLUGIN CHECKS PASSED ===`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
