/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * EMERGENCY Nova Lockdown Middleware (Oct 17, 2026)
 *
 * Locks every route that can run shell commands, touch the host filesystem,
 * drive Nova's computer, or broadcast push notifications:
 *   - /api/nova/computer/*     (files, terminal, servers, live screen, events)
 *   - /api/nova/terminal*      (any terminal route under /api/nova)
 *   - /api/nova/mcp/chat       (MCP chat can reach bash via computer tools)
 *   - /api/nova/push/send      (broadcast to all push subscribers)
 *   - /api/term/exec           (ONLY the raw-shell fallback; LLY Term built-in
 *                               commands like help/status/whoami still work)
 *
 * Rules:
 *   1. Kill switch: unless process.env.NOVA_COMPUTER_ENABLED === 'true', these
 *      routes return 404 for EVERYONE, including the founder.
 *   2. When enabled, ONLY the founder may use them: a logged-in session
 *      (req.user, set by the lly_session middleware) whose user id is 3
 *      (@mothyacorn). The admin role alone is NOT enough, and there is no
 *      fallback to the founder when nobody is logged in.
 *   3. If the founder has 2FA enabled, the session must be 2FA-verified.
 *   4. Everyone else gets a plain 404 so the routes are not advertised.
 *
 * Must be registered AFTER the session middleware (so req.user exists) and
 * BEFORE any Nova / terminal route.
 */

const FOUNDER_USER_ID = 3;

// LLY Term built-in commands handled inside /api/term/exec without a shell.
const TERM_BUILTINS = new Set([
  'help', '?', 'status', 'sys', 'uptime', 'models', 'nova', 'ask', 'whoami',
  'flame', 'chain', 'burn', 'xmr', 'treasury', 'ert', 'equation', 'glyphs',
  'theme', 'login', 'blog', 'forum', 'community', 'quikdocs', 'shop', 'docs',
  'mail', 'inbox', 'webmail', 'cd', 'pwd', 'exit'
]);

function normalizePath(req) {
  let p = String(req.path || req.url || '').split('?')[0];
  try { p = decodeURIComponent(p); } catch (_) { /* keep raw */ }
  p = p.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

function isLockedNovaPath(p) {
  return (
    p === '/api/nova/computer' || p.startsWith('/api/nova/computer/') ||
    p === '/api/nova/terminal' || p.startsWith('/api/nova/terminal') ||
    p === '/api/nova/mcp/chat' ||
    p === '/api/nova/push/send'
  );
}

function isTermShellPassthrough(req, p) {
  if (p !== '/api/term/exec') return false;
  const command = req.body && typeof req.body.command === 'string' ? req.body.command.trim() : '';
  if (!command) return false; // empty command is a no-op in the route
  const first = command.split(/\s+/)[0].toLowerCase();
  return !TERM_BUILTINS.has(first);
}

function isFounderSession(req) {
  const user = req.user;
  if (!user || !req.sessionId) return false;
  if (Number(user.id) !== FOUNDER_USER_ID) return false;
  if (user.two_factor_enabled && !user.session_two_factor_verified) return false;
  return true;
}

function notFound(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ success: false, error: 'Not Found' });
}

function novaLockdown(req, res, next) {
  const p = normalizePath(req);
  if (isTermShellPassthrough(req, p)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({
      success: false,
      error: 'unknown command',
      output: 'unknown command: Type \'help\' for allowlisted commands.'
    });
  }
  const locked = isLockedNovaPath(p);
  if (!locked) return next();

  const enabled = String(process.env.NOVA_COMPUTER_ENABLED || '').trim().toLowerCase() === 'true';
  if (enabled && isFounderSession(req)) return next();

  const who = req.user ? `user #${req.user.id}` : 'anonymous';
  const why = enabled ? 'not founder' : 'NOVA_COMPUTER_ENABLED is off';
  console.warn(`[Nova Lockdown] Blocked ${req.method} ${p} from ${who} (IP ${req.clientIp || req.ip}) - ${why}`);
  return notFound(req, res);
}

module.exports = novaLockdown;
module.exports.novaLockdown = novaLockdown;
module.exports._internals = { normalizePath, isLockedNovaPath, isTermShellPassthrough, isFounderSession, TERM_BUILTINS };
