/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova plugins: connect outside services and let Nova use them in chat.
 *
 * Safety rules (enforced here, covered by scripts/test-nova-plugins.js):
 *   - A plugin is only offered when its keys are in .env (see .env.example and
 *     docs/nova-plugins.md). Unconfigured plugins are hidden from members.
 *   - Each member connects their OWN account. Tokens are encrypted at rest with
 *     AES-256-GCM in nova_secrets (target "plugin:<id>"), per user, never shared,
 *     never sent to the browser or the model, and removed on disconnect.
 *   - Read actions run right away. Write actions (send, post, create, change,
 *     delete) never run until the member presses Confirm on an approval card in
 *     chat; the card mints a single-use token bound to the exact action and
 *     parameters, and runWrite() refuses anything without a valid token.
 *   - ownerOnly plugins are invisible and unusable for everyone but the owner.
 */
const crypto = require('crypto');
const { PLUGINS } = require('./registry');

const SECRET_PREFIX = 'plugin:';
const APPROVAL_ACTION_TYPE = 'plugin.run';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_CALLS_PER_REPLY = 3;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;

const oauthStates = new Map();
const rateBuckets = new Map();
let fetchImpl = (...args) => fetch(...args);

function lazySecrets() { return require('../nova_secrets'); }
function lazyApprovals() { return require('../nova_approvals'); }
function lazyChat() { return require('../nova_chat'); }
function lazyWidgets() { return require('../nova_widgets'); }

function setFetchForTests(fn) { fetchImpl = fn; }

function baseUrl(env = process.env) {
  return String(env.NOVA_PLUGINS_BASE_URL || 'https://llyverse.org').replace(/\/+$/, '');
}

function redirectUri(pluginId, env = process.env) {
  return `${baseUrl(env)}/api/nova/plugins/oauth/callback/${pluginId}`;
}

function getPlugin(id) {
  return PLUGINS.find(p => p.id === id) || null;
}

function requiredEnv(plugin) {
  const a = plugin.auth || {};
  if (a.type === 'oauth2') return [a.clientIdEnv, a.clientSecretEnv];
  if (a.type === 'server_key') return [a.keyEnv];
  return [];
}

function isConfigured(plugin, env = process.env) {
  return requiredEnv(plugin).every(k => k && env[k] && String(env[k]).trim());
}

/** Same rule as isOwnerAdmin in server.js. */
function isOwner(user) {
  if (!user || user.role !== 'admin') return false;
  const username = String(user.username || '').toLowerCase();
  const email = String(user.email || '').toLowerCase();
  const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase();
  return user.id === 3 || username === 'mothyacorn' || Boolean(adminEmail && email === adminEmail);
}

function visibleTo(plugin, user, env = process.env) {
  if (!isConfigured(plugin, env)) return false;
  if (plugin.ownerOnly && !isOwner(user)) return false;
  return true;
}

function needsAccount(plugin) {
  return plugin.auth && plugin.auth.type === 'oauth2';
}

function getConnection(userId, pluginId) {
  try {
    return lazySecrets().getSecret({ userId: Number(userId), target: SECRET_PREFIX + pluginId }) || null;
  } catch (e) {
    return null;
  }
}

function saveConnection(userId, pluginId, payload) {
  return lazySecrets().saveSecret({ userId: Number(userId), target: SECRET_PREFIX + pluginId, payload });
}

function publicAction(a) {
  return { id: a.id, title: a.title, kind: a.kind, description: a.description, params: Object.keys(a.params || {}) };
}

/** Plugins a member can see (never includes tokens). */
function listForUser(user, env = process.env) {
  return PLUGINS.filter(p => visibleTo(p, user, env)).map(p => {
    const conn = needsAccount(p) ? getConnection(user.id, p.id) : null;
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      ownerOnly: Boolean(p.ownerOnly),
      needsAccount: needsAccount(p),
      needsShop: Boolean(p.auth.shopify),
      connected: needsAccount(p) ? Boolean(conn && conn.access_token) : true,
      accountLabel: conn && conn.account ? (conn.account.label || conn.account.shop || null) : null,
      connectedAt: conn ? conn.connected_at || null : null,
      actions: p.actions.map(publicAction)
    };
  });
}

/** Setup status for the admin page only. */
function setupStatus(env = process.env) {
  return PLUGINS.map(p => {
    const req = requiredEnv(p);
    return {
      id: p.id,
      name: p.name,
      ownerOnly: Boolean(p.ownerOnly),
      authType: p.auth.type,
      configured: isConfigured(p, env),
      requiredEnv: req,
      missingEnv: req.filter(k => !(env[k] && String(env[k]).trim())),
      redirectUri: p.auth.type === 'oauth2' ? redirectUri(p.id, env) : null,
      scopes: p.auth.scopes || [],
      devConsole: p.auth.devConsole || null,
      actions: p.actions.map(a => `${a.id} (${a.kind})`)
    };
  });
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function checkRate(userId) {
  const now = Date.now();
  const bucket = (rateBuckets.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) throw httpError(429, 'Too many plugin actions. Try again in a minute.', 'RATE_LIMITED');
  bucket.push(now);
  rateBuckets.set(userId, bucket);
}

// ---------------------------------------------------------------- OAuth flow
function cleanupStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.expires < now) oauthStates.delete(k);
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function beginConnect(user, pluginId, { shop } = {}, env = process.env) {
  const plugin = getPlugin(pluginId);
  if (!plugin || !visibleTo(plugin, user, env)) throw httpError(404, 'Plugin not available.');
  if (!needsAccount(plugin)) throw httpError(400, 'This plugin does not need an account.');
  const a = plugin.auth;
  let shopHost = null;
  if (a.shopify) {
    shopHost = String(shop || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!SHOP_RE.test(shopHost)) throw httpError(422, 'Enter your shop address, like yourshop.myshopify.com.');
  }
  cleanupStates();
  const state = crypto.randomBytes(24).toString('hex');
  const entry = { userId: Number(user.id), pluginId, expires: Date.now() + STATE_TTL_MS, shop: shopHost };
  const params = new URLSearchParams();
  params.set('client_id', env[a.clientIdEnv]);
  params.set('redirect_uri', redirectUri(pluginId, env));
  params.set('response_type', 'code');
  params.set('state', state);
  if (a.scopes && a.scopes.length) params.set(a.scopeParam || 'scope', a.scopes.join(a.scopeSeparator || ' '));
  for (const [k, v] of Object.entries(a.extraAuthorizeParams || {})) params.set(k, v);
  if (a.pkce) {
    entry.verifier = crypto.randomBytes(32).toString('base64url');
    params.set('code_challenge', crypto.createHash('sha256').update(entry.verifier).digest('base64url'));
    params.set('code_challenge_method', 'S256');
  }
  oauthStates.set(state, entry);
  const authUrl = a.authorizeUrl.replace('{shop}', shopHost || '');
  return `${authUrl}?${params.toString()}`;
}

function verifyShopifyHmac(query, secret) {
  const { hmac, ...rest } = query || {};
  if (!hmac) return false;
  const msg = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(String(hmac), 'utf8'));
  } catch (e) {
    return false;
  }
}

async function tokenRequest(plugin, bodyParams, env = process.env, shop = null) {
  const a = plugin.auth;
  const headers = { Accept: 'application/json', 'User-Agent': 'LLYVerse-Nova/1.0 (+https://llyverse.org)' };
  const id = env[a.clientIdEnv];
  const secret = env[a.clientSecretEnv];
  const payload = { ...bodyParams };
  if (a.tokenAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  } else {
    payload.client_id = id;
    payload.client_secret = secret;
  }
  let body;
  if (a.tokenBodyJson) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  }
  const url = a.tokenUrl.replace('{shop}', shop || '');
  const res = await fetchImpl(url, { method: 'POST', headers, body });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || data.error || data.ok === false) {
    throw httpError(502, `${plugin.name} did not accept the sign-in (${res.status}${data.error ? `: ${String(data.error).slice(0, 80)}` : ''}).`);
  }
  if (a.tokenPath && data[a.tokenPath]) {
    data = { ...data, ...data[a.tokenPath] };
  }
  return data;
}

function tokenPayloadFrom(plugin, data, previous = {}, extra = {}) {
  const keep = {};
  for (const k of (plugin.auth.keepFromToken || [])) if (data[k] !== undefined) keep[k] = data[k];
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous.refresh_token || null,
    expires_at: data.expires_in ? Date.now() + (Number(data.expires_in) - 60) * 1000 : (previous.expires_at || null),
    scope: data.scope || previous.scope || null,
    connected_at: previous.connected_at || new Date().toISOString(),
    account: { ...(previous.account || {}), ...extra, ...keep }
  };
}

async function completeConnect(user, pluginId, query = {}, env = process.env) {
  const plugin = getPlugin(pluginId);
  if (!plugin || !visibleTo(plugin, user, env) || !needsAccount(plugin)) throw httpError(404, 'Plugin not available.');
  const state = String(query.state || '');
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expires < Date.now() || entry.pluginId !== pluginId || entry.userId !== Number(user.id)) {
    throw httpError(400, 'That sign-in link expired or was not started here. Please try connecting again.');
  }
  if (query.error) throw httpError(400, `${plugin.name} sign-in was cancelled.`);
  const code = String(query.code || '');
  if (!code) throw httpError(400, 'Missing sign-in code.');
  let shop = null;
  if (plugin.auth.shopify) {
    shop = String(query.shop || '').toLowerCase();
    if (shop !== entry.shop || !SHOP_RE.test(shop)) throw httpError(400, 'Shop did not match.');
    if (!verifyShopifyHmac(query, env[plugin.auth.clientSecretEnv])) throw httpError(400, 'Shopify signature check failed.');
  }
  const body = plugin.auth.shopify
    ? { code }
    : { grant_type: 'authorization_code', code, redirect_uri: redirectUri(pluginId, env) };
  if (entry.verifier) body.code_verifier = entry.verifier;
  const data = await tokenRequest(plugin, body, env, shop);
  if (!data.access_token) throw httpError(502, `${plugin.name} did not return an access token.`);
  const extra = {};
  if (shop) { extra.shop = shop; extra.label = shop; }
  if (data.webhook && data.webhook.name) extra.label = `#${data.webhook.name}`;
  if (data.workspace_name) extra.label = data.workspace_name;
  if (data.team && data.team.name) extra.label = data.team.name;
  saveConnection(user.id, pluginId, tokenPayloadFrom(plugin, data, {}, extra));
  return { pluginId, connected: true };
}

async function getFreshConnection(user, plugin, env = process.env) {
  const conn = getConnection(user.id, plugin.id);
  if (!conn || !conn.access_token) throw httpError(409, `Connect ${plugin.name} first (Settings > Plugins).`, 'NOT_CONNECTED');
  if (conn.expires_at && conn.expires_at < Date.now() && conn.refresh_token) {
    const data = await tokenRequest(plugin, { grant_type: 'refresh_token', refresh_token: conn.refresh_token }, env, conn.account && conn.account.shop);
    const fresh = tokenPayloadFrom(plugin, data, conn);
    saveConnection(user.id, plugin.id, fresh);
    return fresh;
  }
  return conn;
}

async function disconnect(user, pluginId, env = process.env) {
  const plugin = getPlugin(pluginId);
  if (!plugin) throw httpError(404, 'Plugin not found.');
  const conn = getConnection(user.id, pluginId);
  // Best effort: ask the provider to revoke too. The local copy is deleted no matter what.
  if (conn && conn.access_token && isConfigured(plugin, env)) {
    const a = plugin.auth;
    try {
      if (a.githubRevoke) {
        await fetchImpl(`https://api.github.com/applications/${encodeURIComponent(env[a.clientIdEnv])}/grant`, {
          method: 'DELETE',
          headers: { Authorization: `Basic ${Buffer.from(`${env[a.clientIdEnv]}:${env[a.clientSecretEnv]}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'LLYVerse-Nova' },
          body: JSON.stringify({ access_token: conn.access_token })
        });
      } else if (a.dropboxRevoke) {
        await fetchImpl('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${conn.access_token}` } });
      } else if (a.revokeUrl && a.revokeUrl.includes('slack.com')) {
        await fetchImpl(a.revokeUrl, { method: 'POST', headers: { Authorization: `Bearer ${conn.access_token}` } });
      } else if (a.revokeUrl) {
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        const form = { token: conn.access_token };
        if (a.tokenAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${env[a.clientIdEnv]}:${env[a.clientSecretEnv]}`).toString('base64')}`;
        else { form.client_id = env[a.clientIdEnv]; form.client_secret = env[a.clientSecretEnv]; }
        await fetchImpl(a.revokeUrl, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
      }
    } catch (e) { /* provider revoke is best effort */ }
  }
  lazySecrets().deleteSecret({ userId: Number(user.id), target: SECRET_PREFIX + pluginId });
  return { pluginId, connected: false };
}

// ------------------------------------------------------------ Running actions
function validateParams(action, raw = {}) {
  const out = {};
  const spec = action.params || {};
  if (raw && typeof raw !== 'object') throw httpError(422, 'params must be an object.');
  for (const key of Object.keys(raw || {})) {
    if (!spec[key]) throw httpError(422, `Unknown parameter "${key}".`);
  }
  for (const [key, rule] of Object.entries(spec)) {
    let v = raw ? raw[key] : undefined;
    if (v === undefined || v === null || v === '') {
      if (rule.required) throw httpError(422, `Missing "${key}".`);
      continue;
    }
    if (rule.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) throw httpError(422, `"${key}" must be a positive number.`);
      v = Math.floor(Math.min(v, rule.max || v));
    } else if (rule.type === 'boolean') {
      v = v === true || v === 'true';
    } else {
      v = String(v);
      if (rule.max && v.length > rule.max) throw httpError(422, `"${key}" is too long (max ${rule.max}).`);
      if (rule.pattern && !rule.pattern.test(v)) throw httpError(422, `"${key}" is not in the right format.`);
    }
    out[key] = v;
  }
  return out;
}

function makeHttp(plugin, conn, key) {
  return async function http(url, opts = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('Plugins only call https URLs.');
    const headers = { Accept: 'application/json', 'User-Agent': 'LLYVerse-Nova/1.0 (+https://llyverse.org)', ...(plugin.apiHeaders || {}), ...(opts.headers || {}) };
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    else if (opts.shopify) headers['X-Shopify-Access-Token'] = conn.access_token;
    else if (!opts.noAuth && conn && conn.access_token) headers.Authorization = `Bearer ${conn.access_token}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetchImpl(url, { method: opts.method || 'GET', headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { text: text.slice(0, 2000) }; }
    if (res.status === 401) throw httpError(401, `${plugin.name} needs you to reconnect (Settings > Plugins).`, 'RECONNECT');
    if (!res.ok || (opts.slack && data && data.ok === false)) {
      const detail = data && (data.error_description || data.message || data.error || (data.errors && JSON.stringify(data.errors)));
      throw httpError(502, `${plugin.name} returned an error (${res.status}${detail ? `: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 160)}` : ''}).`);
    }
    return data;
  };
}

function resolve(user, pluginId, actionId, env = process.env) {
  const plugin = getPlugin(pluginId);
  if (!plugin || !visibleTo(plugin, user, env)) throw httpError(404, 'Plugin not available.');
  const action = plugin.actions.find(a => a.id === actionId);
  if (!action) throw httpError(404, `${plugin.name} has no action "${actionId}".`);
  return { plugin, action };
}

async function execute(user, plugin, action, params, env) {
  checkRate(user.id);
  let conn = null;
  let key = null;
  if (needsAccount(plugin)) conn = await getFreshConnection(user, plugin, env);
  if (plugin.auth.type === 'server_key') key = env[plugin.auth.keyEnv];
  const ctx = { http: makeHttp(plugin, conn, key), account: (conn && conn.account) || {}, key };
  const raw = await action.run(ctx, params);
  let text;
  try {
    text = action.format ? action.format(raw) : '```json\n' + JSON.stringify(raw, null, 2).slice(0, 3000) + '\n```';
  } catch (e) {
    text = '```json\n' + JSON.stringify(raw, null, 2).slice(0, 3000) + '\n```';
  }
  logAction(user, plugin, action, 'ok');
  return { pluginId: plugin.id, actionId: action.id, kind: action.kind, text };
}

function logAction(user, plugin, action, result) {
  try {
    require('../nova_actions').logNovaAction({
      userId: user.id,
      persona: 'nova',
      action: `plugin.${plugin.id}.${action.id}`,
      target: plugin.name,
      source: 'user',
      result,
      details: { kind: action.kind }
    });
  } catch (e) {}
}

/** Read actions only. Write actions throw CONFIRMATION_REQUIRED. */
async function runRead(user, pluginId, actionId, rawParams = {}, env = process.env) {
  const { plugin, action } = resolve(user, pluginId, actionId, env);
  if (action.kind !== 'read') throw httpError(403, 'This action changes something, so it needs your confirmation in chat first.', 'CONFIRMATION_REQUIRED');
  const params = validateParams(action, rawParams);
  return execute(user, plugin, action, params, env);
}

function approvalArgs({ pluginId, actionId, params, conversationId }) {
  return { pluginId, actionId, params, conversationId: conversationId || null };
}

/**
 * Write actions. Requires a single-use approval token minted when the member
 * pressed Confirm on the approval card, bound to these exact args.
 * The token is checked and consumed synchronously, before any network call.
 */
function runWrite(user, args, approvalToken, env = process.env) {
  const { plugin, action } = resolve(user, args.pluginId, args.actionId, env);
  if (action.kind !== 'write') return Promise.reject(httpError(400, 'Not a write action.'));
  const params = validateParams(action, args.params || {});
  const check = lazyApprovals().verifyAndConsumeApprovalToken({
    token: approvalToken,
    userId: user.id,
    actionType: APPROVAL_ACTION_TYPE,
    args: approvalArgs({ ...args, params: args.params || {} })
  });
  if (!check.ok) {
    logAction(user, plugin, action, 'blocked');
    return Promise.reject(httpError(check.status || 403, check.error || 'Confirmation required.', check.code || 'CONFIRMATION_REQUIRED'));
  }
  return execute(user, plugin, action, params, env);
}

/** Make the confirmation card a member must press before a write runs. */
function requestWriteConfirmation({ user, conversationId, agentId = 'nova', pluginId, actionId, params }, env = process.env) {
  const { plugin, action } = resolve(user, pluginId, actionId, env);
  if (action.kind !== 'write') throw httpError(400, 'Not a write action.');
  const clean = validateParams(action, params || {});
  if (needsAccount(plugin)) {
    const conn = getConnection(user.id, plugin.id);
    if (!conn || !conn.access_token) throw httpError(409, `Connect ${plugin.name} first (Settings > Plugins).`, 'NOT_CONNECTED');
  }
  const conn = needsAccount(plugin) ? getConnection(user.id, plugin.id) : null;
  const preview = action.preview ? action.preview(clean, conn && conn.account) : JSON.stringify(clean, null, 2);
  return lazyWidgets().createCardMessage({
    userId: user.id,
    conversationId,
    agentId,
    type: 'approval',
    body: `${plugin.name}: ${action.title}`,
    spec: {
      title: `${plugin.name}: ${action.title}`.slice(0, 240),
      details: String(preview).slice(0, 4000),
      action: { type: APPROVAL_ACTION_TYPE, args: approvalArgs({ pluginId, actionId, params: clean, conversationId }) },
      confirm: { label: 'Confirm', style: 'primary', doubleConfirm: true },
      cancel: { label: 'Cancel' }
    }
  });
}

function postResult(user, conversationId, agentId, body, payload) {
  if (!conversationId) return null;
  const chat = lazyChat();
  const msg = chat.insertMessage({ conversationId, role: 'assistant', agentId: agentId || 'nova', kind: 'result', body, payload, status: 'sent' });
  chat.emitToUser(user.id, 'message.created', { conversationId, message: msg }, msg.id);
  return msg;
}

/** Called by nova_widgets when the member confirms a plugin approval card. */
function executeApproved({ user, args, approvalToken }) {
  const p = runWrite(user, args, approvalToken);
  const plugin = getPlugin(args.pluginId);
  p.then(r => postResult(user, args.conversationId, 'nova', `✓ ${plugin ? plugin.name : 'Plugin'}: ${r.text}`, { plugin: { id: args.pluginId, action: args.actionId, kind: 'write' } }))
    .catch(err => postResult(user, args.conversationId, 'nova', `${plugin ? plugin.name : 'Plugin'} could not finish that: ${err.message}`, { plugin: { id: args.pluginId, action: args.actionId, error: true } }));
  return { queued: true };
}

// ---------------------------------------------------- Chat integration (model)
const CALL_RE = /```nova-plugin\s*\n([\s\S]*?)```/g;

function parseToolCalls(text) {
  const calls = [];
  const cleaned = String(text || '').replace(CALL_RE, (m, json) => {
    try {
      const obj = JSON.parse(json.trim());
      if (obj && typeof obj.plugin === 'string' && typeof obj.action === 'string') {
        calls.push({ plugin: obj.plugin, action: obj.action, params: (obj.params && typeof obj.params === 'object') ? obj.params : {} });
      }
    } catch (e) {}
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { calls: calls.slice(0, MAX_CALLS_PER_REPLY), cleaned };
}

/**
 * Run the plugin calls Nova asked for in a reply. Reads run now and post their
 * results; writes only create a confirmation card.
 */
async function handleReplyToolCalls({ user, conversationId, agentId = 'nova', reply }, env = process.env) {
  const { calls, cleaned } = parseToolCalls(reply);
  const outcomes = [];
  for (const c of calls) {
    try {
      const { plugin, action } = resolve(user, c.plugin, c.action, env);
      if (action.kind === 'write') {
        requestWriteConfirmation({ user, conversationId, agentId, pluginId: plugin.id, actionId: action.id, params: c.params }, env);
        outcomes.push({ ...c, status: 'awaiting_confirmation' });
      } else {
        const r = await runRead(user, plugin.id, action.id, c.params, env);
        postResult(user, conversationId, agentId, `**${plugin.name} · ${action.title}**\n\n${r.text}`, { plugin: { id: plugin.id, action: action.id, kind: 'read' } });
        outcomes.push({ ...c, status: 'done' });
      }
    } catch (err) {
      postResult(user, conversationId, agentId, `I couldn't use that plugin: ${err.message}`, { plugin: { id: c.plugin, action: c.action, error: true } });
      outcomes.push({ ...c, status: 'error', error: err.message });
    }
  }
  return { cleaned, outcomes };
}

/** Short block added to Nova's system prompt so she knows what she can use. */
function describeForPrompt(user, env = process.env) {
  if (!user) return '';
  const visible = PLUGINS.filter(p => visibleTo(p, user, env));
  if (!visible.length) return '';
  const ready = [];
  const notConnected = [];
  for (const p of visible) {
    const connected = !needsAccount(p) || Boolean((getConnection(user.id, p.id) || {}).access_token);
    if (!connected) { notConnected.push(p.name); continue; }
    const acts = p.actions.map(a => `${a.id}(${Object.keys(a.params || {}).join(', ')})${a.kind === 'write' ? ' [WRITE]' : ''}`).join('; ');
    ready.push(`- ${p.id} (${p.name}): ${acts}`);
  }
  const lines = ['[PLUGINS]'];
  if (ready.length) {
    lines.push('You can use these plugins for this member. To use one, add a block like this to your reply (at most 3 per reply):');
    lines.push('```nova-plugin\n{"plugin":"<id>","action":"<action>","params":{}}\n```');
    lines.push('Read actions run right away and their results appear in the chat. [WRITE] actions only run after the member presses Confirm on the card that appears, so never say a write is done before they confirm. Only use a plugin when it helps with what they asked.');
    lines.push(...ready);
  }
  if (notConnected.length) {
    lines.push(`Not connected yet (they can connect in Settings > Plugins): ${notConnected.join(', ')}.`);
  }
  return lines.join('\n');
}

module.exports = {
  PLUGINS,
  APPROVAL_ACTION_TYPE,
  SECRET_PREFIX,
  getPlugin,
  isConfigured,
  isOwner,
  visibleTo,
  requiredEnv,
  redirectUri,
  listForUser,
  setupStatus,
  beginConnect,
  completeConnect,
  disconnect,
  validateParams,
  runRead,
  runWrite,
  requestWriteConfirmation,
  executeApproved,
  parseToolCalls,
  handleReplyToolCalls,
  describeForPrompt,
  verifyShopifyHmac,
  _setFetchForTests: setFetchForTests,
  _oauthStates: oauthStates,
  _rateBuckets: rateBuckets
};
