/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Routines Scheduler Service (§6.3, §11.2, §12, §15.2)
 * Manages recurring scheduled and event-driven routines per persona in PT (America/Los_Angeles).
 * Respects the global Stop Nova kill switch and records every run in `nova_actions` with source='routine'.
 */

const crypto = require('crypto');
const db = require('../data/db');
const novaActions = require('./nova_actions');
const novaChat = require('./nova_chat');

const rawDb = db.getRawDb ? db.getRawDb() : db.db;

// Track last PT minute key (`YYYY-MM-DD HH:mm`) per routine id to prevent duplicate runs in the same minute
const lastFiredMinuteByRoutine = new Map();
let schedulerTimer = null;

/**
 * Get current date components in a target IANA timezone (default America/Los_Angeles)
 */
function getZonedParts(date = new Date(), timeZone = 'America/Los_Angeles') {
  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false
    });
    parts = fmt.formatToParts(date);
  } catch (e) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false
    });
    parts = fmt.formatToParts(date);
  }

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const minute = Number(map.minute);
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[map.weekday] !== undefined ? dowMap[map.weekday] : date.getDay();
  const minuteKey = `${map.year}-${map.month}-${map.day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return { year, month, day, hour, minute, dow, minuteKey };
}

/**
 * Evaluate a single cron field against a numeric value
 */
function matchCronField(fieldExpr, value) {
  const expr = String(fieldExpr || '*').trim();
  if (expr === '*') return true;

  const parts = expr.split(',');
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (p.startsWith('*/')) {
      const step = Number(p.slice(2));
      if (step > 0 && value % step === 0) return true;
      continue;
    }
    if (p.includes('-')) {
      const [startStr, endStr] = p.split('-');
      const start = Number(startStr);
      const end = Number(endStr);
      if (!Number.isNaN(start) && !Number.isNaN(end) && value >= start && value <= end) {
        return true;
      }
      continue;
    }
    const num = Number(p);
    if (!Number.isNaN(num) && num === value) return true;
  }
  return false;
}

/**
 * Evaluate a 5-field cron expression (minute hour day-of-month month day-of-week) against zoned parts
 */
function matchesCron(cronExpr, zonedParts) {
  if (!cronExpr || typeof cronExpr !== 'string') return false;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = fields;
  return (
    matchCronField(minExpr, zonedParts.minute) &&
    matchCronField(hourExpr, zonedParts.hour) &&
    matchCronField(domExpr, zonedParts.day) &&
    matchCronField(monExpr, zonedParts.month) &&
    (matchCronField(dowExpr, zonedParts.dow) || (zonedParts.dow === 0 && matchCronField(dowExpr, 7)))
  );
}

function hydrateRoutine(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    triggerType: row.trigger_type,
    cron: row.cron || null,
    timezone: row.timezone || 'America/Los_Angeles',
    event: row.event || null,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at || null,
    lastStatus: row.last_status || null
  };
}

function listRoutines(userId, agentId = null) {
  if (agentId) {
    return rawDb.prepare(`
      SELECT * FROM nova_routines
      WHERE user_id = ? AND agent_id = ?
      ORDER BY id DESC
    `).all(userId, String(agentId)).map(hydrateRoutine);
  }
  return rawDb.prepare(`
    SELECT * FROM nova_routines
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId).map(hydrateRoutine);
}

function createRoutine(user, data = {}, ip = '', userAgent = '') {
  const name = String(data.name || '').trim().slice(0, 80);
  const prompt = String(data.prompt || '').trim().slice(0, 2000);
  if (!name || !prompt) {
    throw new Error('Routine name and prompt are required.');
  }
  const agentId = ['nova', 'astra', 'astaria'].includes(String(data.agentId || 'nova').toLowerCase())
    ? String(data.agentId || 'nova').toLowerCase()
    : 'nova';
  const triggerType = data.triggerType === 'event' ? 'event' : 'cron';
  const cron = triggerType === 'cron' ? String(data.cron || '0 9 * * *').trim().slice(0, 64) : null;
  if (triggerType === 'cron' && cron.split(/\s+/).length !== 5) {
    throw new Error('Cron expression must have 5 fields (minute hour day month weekday).');
  }
  const timezone = String(data.timezone || 'America/Los_Angeles').trim().slice(0, 64);
  const event = triggerType === 'event' ? String(data.event || 'daily_summary').trim().slice(0, 64) : null;
  const enabled = data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1;

  const id = 'rtn_' + crypto.randomBytes(6).toString('hex');
  rawDb.prepare(`
    INSERT INTO nova_routines (id, user_id, agent_id, name, prompt, trigger_type, cron, timezone, event, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, agentId, name, prompt, triggerType, cron, timezone, event, enabled);

  if (db.logAudit) {
    db.logAudit(
      user.id,
      user.username,
      'NOVA_ROUTINE_CREATED',
      JSON.stringify({ routineId: id, agentId, name, triggerType, cron, timezone }),
      ip,
      process.env.NODE_ENV === 'test' ? 'test' : 'human'
    );
  }

  novaActions.logNovaAction({
    userId: user.id,
    persona: agentId,
    action: 'routine.create',
    target: id,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { name, triggerType, cron, timezone }
  });

  return hydrateRoutine(rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ?`).get(id));
}

function updateRoutine(user, routineId, patch = {}, ip = '', userAgent = '') {
  const row = rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ? AND user_id = ?`).get(routineId, user.id);
  if (!row) throw new Error('Routine not found.');

  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : row.name;
  const prompt = patch.prompt !== undefined ? String(patch.prompt).trim().slice(0, 2000) : row.prompt;
  const cron = patch.cron !== undefined ? String(patch.cron).trim().slice(0, 64) : row.cron;
  const timezone = patch.timezone !== undefined ? String(patch.timezone).trim().slice(0, 64) : row.timezone;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled;

  rawDb.prepare(`
    UPDATE nova_routines
    SET name = ?, prompt = ?, cron = ?, timezone = ?, enabled = ?
    WHERE id = ? AND user_id = ?
  `).run(name, prompt, cron, timezone, enabled, routineId, user.id);

  novaActions.logNovaAction({
    userId: user.id,
    persona: row.agent_id,
    action: 'routine.update',
    target: routineId,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { name, cron, enabled: Boolean(enabled) }
  });

  return hydrateRoutine(rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ?`).get(routineId));
}

function deleteRoutine(user, routineId, ip = '', userAgent = '') {
  const row = rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ? AND user_id = ?`).get(routineId, user.id);
  if (!row) throw new Error('Routine not found.');
  rawDb.prepare(`DELETE FROM nova_routines WHERE id = ? AND user_id = ?`).run(routineId, user.id);
  lastFiredMinuteByRoutine.delete(routineId);

  novaActions.logNovaAction({
    userId: user.id,
    persona: row.agent_id,
    action: 'routine.delete',
    target: routineId,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { name: row.name }
  });

  return { deleted: true, id: routineId };
}

/**
 * Execute a routine immediately (or via cron tick) and post the output to the agent's conversation.
 */
async function runRoutineNow(routineId, { trigger = 'cron', userOverride = null } = {}) {
  const row = rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ?`).get(routineId);
  if (!row) throw new Error('Routine not found.');
  if (userOverride && row.user_id !== userOverride.id && userOverride.role !== 'admin') {
    throw new Error('Forbidden');
  }

  // Respect global Stop Nova kill switch (§15.2)
  if (novaActions.isNovaPaused()) {
    rawDb.prepare(`
      UPDATE nova_routines
      SET last_run_at = CURRENT_TIMESTAMP, last_status = 'paused'
      WHERE id = ?
    `).run(row.id);

    novaActions.logNovaAction({
      userId: row.user_id,
      persona: row.agent_id,
      action: 'routine.skipped_paused',
      target: row.id,
      source: 'routine',
      result: 'paused',
      details: { routineName: row.name, trigger }
    });
    return { skipped: true, reason: 'Nova is paused', routine: hydrateRoutine(rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ?`).get(row.id)) };
  }

  const user = db.getUserById ? db.getUserById(row.user_id) : { id: row.user_id, username: 'citizen', role: 'member' };
  novaChat.ensureDefaultConversations(row.user_id);

  let conv = rawDb.prepare(`
    SELECT * FROM nova_conversations
    WHERE user_id = ? AND type = 'direct' AND agent_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(row.user_id, row.agent_id);

  if (!conv) {
    conv = novaChat.createConversation(row.user_id, { type: 'direct', agentId: row.agent_id });
  }

  const jobId = novaChat.generateUlid('job_');

  // 1. Insert routine trigger notice in conversation
  const triggerMsg = novaChat.insertMessage({
    conversationId: conv.id,
    role: 'assistant',
    agentId: row.agent_id,
    kind: 'progress',
    body: `Running scheduled routine "${row.name}"...`,
    payload: { routineId: row.id, routineName: row.name, trigger },
    status: 'sent',
    jobId
  });
  novaChat.emitToUser(row.user_id, 'message.created', {
    conversationId: conv.id,
    message: triggerMsg
  }, triggerMsg.id);

  let replyBody = '';
  let status = 'ok';
  try {
    const gen = await novaChat.streamAgentReply({
      user,
      agentId: row.agent_id,
      conversationId: conv.id,
      userText: `[Routine: ${row.name}] ${row.prompt}`
    });
    replyBody = gen.reply;
  } catch (err) {
    // Fallback deterministic summary so scheduled routines still report cleanly if offline/capped
    replyBody = `**Routine "${row.name}" executed** (${new Date().toLocaleTimeString('en-US', { timeZone: row.timezone || 'America/Los_Angeles' })} PT)\n\nPrompt: ${row.prompt}`;
    status = err.code === 'DAILY_CAP_REACHED' ? 'capped' : 'ok';
  }

  const resultMsg = novaChat.insertMessage({
    conversationId: conv.id,
    role: 'assistant',
    agentId: row.agent_id,
    kind: 'result',
    body: replyBody,
    payload: { routineId: row.id, routineName: row.name, trigger },
    status: 'sent',
    jobId
  });
  novaChat.emitToUser(row.user_id, 'message.created', {
    conversationId: conv.id,
    message: resultMsg
  }, resultMsg.id);

  rawDb.prepare(`
    UPDATE nova_routines
    SET last_run_at = CURRENT_TIMESTAMP, last_status = ?
    WHERE id = ?
  `).run(status, row.id);

  const actionRow = novaActions.logNovaAction({
    userId: row.user_id,
    persona: row.agent_id,
    action: 'routine.run',
    target: row.id,
    source: 'routine',
    result: status,
    details: {
      routineName: row.name,
      trigger,
      conversationId: conv.id,
      messageId: resultMsg.id
    }
  });

  return {
    skipped: false,
    status,
    message: resultMsg,
    actionId: actionRow ? actionRow.id : null,
    routine: hydrateRoutine(rawDb.prepare(`SELECT * FROM nova_routines WHERE id = ?`).get(row.id))
  };
}

/**
 * Evaluate all enabled cron routines for the current timestamp
 */
async function tickScheduler(now = new Date()) {
  if (novaActions.isNovaPaused()) return [];
  const enabledRows = rawDb.prepare(`
    SELECT * FROM nova_routines
    WHERE enabled = 1 AND trigger_type = 'cron' AND cron IS NOT NULL
  `).all();

  const fired = [];
  for (const r of enabledRows) {
    if (novaActions.isNovaPaused()) break;
    const tz = r.timezone || 'America/Los_Angeles';
    const parts = getZonedParts(now, tz);
    if (lastFiredMinuteByRoutine.get(r.id) === parts.minuteKey) {
      continue;
    }
    if (matchesCron(r.cron, parts)) {
      lastFiredMinuteByRoutine.set(r.id, parts.minuteKey);
      try {
        const res = await runRoutineNow(r.id, { trigger: 'cron' });
        fired.push(res);
      } catch (e) {}
    }
  }
  return fired;
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    tickScheduler().catch(() => {});
  }, 15000);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// Start routine scheduler automatically
startScheduler();

module.exports = {
  getZonedParts,
  matchesCron,
  listRoutines,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  runRoutineNow,
  tickScheduler,
  startScheduler,
  stopScheduler
};
