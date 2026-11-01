/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Guest Gate & Widget Guest Mode Middleware (§3.7, §12)
 * - Redirects logged-out visitors from /novaai, /novaai/computer, /app, and /mobile to /login?next=<path>
 * - Enforces strict guest limits on the public floating Nova widget (10 msgs / 10 min, 30 / day per IP,
 *   Nova persona only, text-only, no tools/MCP/computer, ~500 token cap).
 */

const guestWindowMap = new Map(); // ip -> { tenMinTimestamps: number[], dayTimestamps: number[], dayKey: string }

function getTodayKeyPT() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function getClientIp(req) {
  return (
    req.clientIp ||
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : null) ||
    req.ip ||
    '127.0.0.1'
  );
}

/**
 * Server-side guard for /novaai, /novaai/computer, /app, /mobile (and aliases /nova, /chat, /ai)
 */
function requireNovaUser(req, res, next) {
  if (req.user && req.user.id) {
    return next();
  }
  const nextPath = req.originalUrl || req.path || '/novaai';
  const safeNext = (typeof nextPath === 'string' && nextPath.startsWith('/') && !nextPath.startsWith('//'))
    ? nextPath
    : '/novaai';
  return res.redirect(302, `/register?next=${encodeURIComponent(safeNext)}`);
}

/**
 * Enforces §12 guest limits on /api/chat when caller is not authenticated
 */
function enforceWidgetGuestLimits(req, res, next) {
  if (req.user && req.user.id) {
    req.isGuestWidget = false;
    return next();
  }

  req.isGuestWidget = true;
  const body = req.body || {};

  // 1. Persona restriction: Nova only, no rooms
  const requestedAgent = (body.agentId || body.botId || body.persona || 'nova').toLowerCase();
  if (requestedAgent !== 'nova' || body.roomId || body.conversationType === 'room') {
    return res.status(403).json({
      success: false,
      error: 'Guests can only chat with Nova in the public widget. Sign in for multi-persona and room access.'
    });
  }

  // 2. Text-only restriction: no uploads, attachments, voice memos, tools, or secure forms
  if (
    (Array.isArray(body.attachments) && body.attachments.length > 0) ||
    (Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0) ||
    body.voiceMemo ||
    body.audio ||
    body.enableTools ||
    body.mcp
  ) {
    return res.status(403).json({
      success: false,
      error: 'Attachments, voice memos, and tools require a signed-in account.'
    });
  }

  // 3. Rate limits: 10 messages per 10 minutes and 30 per day per IP
  const ip = getClientIp(req);
  const now = Date.now();
  const todayKey = getTodayKeyPT();
  let record = guestWindowMap.get(ip);

  if (!record || record.dayKey !== todayKey) {
    record = {
      tenMinTimestamps: record ? record.tenMinTimestamps.filter(t => now - t < 10 * 60 * 1000) : [],
      dayTimestamps: [],
      dayKey: todayKey
    };
  } else {
    record.tenMinTimestamps = record.tenMinTimestamps.filter(t => now - t < 10 * 60 * 1000);
    record.dayTimestamps = record.dayTimestamps.filter(t => now - t < 24 * 60 * 60 * 1000);
  }

  if (record.tenMinTimestamps.length >= 10) {
    guestWindowMap.set(ip, record);
    return res.status(429).json({
      success: false,
      error: 'Guest limit reached (10 messages per 10 minutes). Please sign in for the full Nova app.',
      signInUrl: '/login?next=/novaai'
    });
  }

  if (record.dayTimestamps.length >= 30) {
    guestWindowMap.set(ip, record);
    return res.status(429).json({
      success: false,
      error: 'Daily guest message limit reached (30 messages per day). Sign in to continue chatting with Nova.',
      signInUrl: '/login?next=/novaai'
    });
  }

  record.tenMinTimestamps.push(now);
  record.dayTimestamps.push(now);
  guestWindowMap.set(ip, record);

  // 4. Cap guest replies at ~500 tokens and disable tools
  req.body.options = {
    ...(body.options || {}),
    num_predict: Math.min((body.options && body.options.num_predict) || 500, 500),
    max_tokens: 500
  };
  req.body.toolsDisabled = true;

  return next();
}

function resetGuestLimitsForTest() {
  guestWindowMap.clear();
}

module.exports = {
  requireNovaUser,
  enforceWidgetGuestLimits,
  resetGuestLimitsForTest
};
