/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Core Chat, Data & SSE Streaming Service (§11.1–11.4, §15.3)
 * Handles agents (Nova, Astra, Astaria + custom), sections, conversations, rooms,
 * ULID-ordered messages, reactions, search, user settings, SSE streams, and model calls.
 */

const crypto = require('crypto');
const db = require('../data/db');
const cloudflareAi = require('./cloudflare-ai');
const novaUsage = require('./nova_usage');
const novaActions = require('./nova_actions');
const novaSecrets = require('./nova_secrets');

const rawDb = db.getRawDb ? db.getRawDb() : db.db;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

// Crockford Base32 for lexicographically sortable ULIDs
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlidTime = 0;
let lastUlidRand = '';

function generateUlid(prefix = 'msg_') {
  const now = Date.now();
  let t = now;
  let timeChars = '';
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    timeChars = CROCKFORD[mod] + timeChars;
    t = Math.floor(t / 32);
  }
  let randChars = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    randChars += CROCKFORD[bytes[i] & 31];
  }
  if (now === lastUlidTime && randChars <= lastUlidRand) {
    // Ensure monotonic ordering within the same millisecond
    randChars = lastUlidRand.slice(0, 15) + CROCKFORD[Math.min(31, CROCKFORD.indexOf(lastUlidRand[15]) + 1)];
  }
  lastUlidTime = now;
  lastUlidRand = randChars;
  return `${prefix}${timeChars}${randChars}`;
}

// ==========================================
// SSE STREAM HUB (§11.3)
// ==========================================
// Map<userId, Set<{ id, res, sessionId, pingTimer, authCheckTimer }>>
const userStreams = new Map();

function formatSseFrame(event, data, id = null) {
  let out = '';
  if (id) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  out += `data: ${JSON.stringify(data || {})}\n\n`;
  return out;
}

function emitToUser(userId, event, data, eventId = null) {
  const set = userStreams.get(Number(userId));
  if (!set || set.size === 0) return;
  const frame = formatSseFrame(event, data, eventId || generateUlid('evt_'));
  for (const client of set) {
    try {
      client.res.write(frame);
    } catch (e) {}
  }
}

function closeUserStreams(userId) {
  const set = userStreams.get(Number(userId));
  if (!set) return;
  for (const client of set) {
    try {
      clearInterval(client.pingTimer);
      clearInterval(client.authCheckTimer);
      client.res.end();
    } catch (e) {}
  }
  userStreams.delete(Number(userId));
}

// Register stop handler so Stop Nova (§15.2) emits `nova.stopped` to all open streams
if (novaActions && typeof novaActions.registerStopHandler === 'function') {
  novaActions.registerStopHandler('nova_sse_broadcast', ({ userId }) => {
    for (const [uid] of userStreams.entries()) {
      emitToUser(uid, 'nova.stopped', { paused: true, byUserId: userId, at: new Date().toISOString() });
    }
  });
}

function registerSseStream(req, res) {
  const userId = Number(req.user.id);
  const sessionId = req.cookies && req.cookies.lly_session;
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId || null;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  let set = userStreams.get(userId);
  if (!set) {
    set = new Set();
    userStreams.set(userId, set);
  }

  // Enforce max 3 concurrent streams per user (§11.3)
  if (set.size >= 3) {
    const oldest = set.values().next().value;
    if (oldest) {
      clearInterval(oldest.pingTimer);
      clearInterval(oldest.authCheckTimer);
      try { oldest.res.end(); } catch (e) {}
      set.delete(oldest);
    }
  }

  const client = {
    id: generateUlid('sse_'),
    res,
    sessionId,
    pingTimer: setInterval(() => {
      try {
        res.write(formatSseFrame('ping', { ts: Date.now() }));
      } catch (e) {}
    }, 25000),
    authCheckTimer: setInterval(() => {
      // §12: Check session every 5 minutes and close stream if revoked
      if (sessionId && db.getSessionUser) {
        const u = db.getSessionUser(sessionId);
        if (!u) {
          clearInterval(client.pingTimer);
          clearInterval(client.authCheckTimer);
          set.delete(client);
          try { res.end(); } catch (e) {}
        }
      }
    }, 5 * 60 * 1000)
  };
  if (client.pingTimer.unref) client.pingTimer.unref();
  if (client.authCheckTimer.unref) client.authCheckTimer.unref();

  set.add(client);

  // Initial connected frame
  res.write(formatSseFrame('connected', { streamId: client.id, paused: novaActions.isNovaPaused() }));

  // Replay missed messages if Last-Event-ID looks like a msg_ ULID (§11.3)
  if (lastEventId && String(lastEventId).startsWith('msg_')) {
    try {
      const missed = rawDb.prepare(`
        SELECT m.*
        FROM nova_messages m
        JOIN nova_conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ? AND m.id > ?
        ORDER BY m.id ASC
        LIMIT 100
      `).all(userId, String(lastEventId));
      for (const m of missed) {
        res.write(formatSseFrame('message.created', {
          conversationId: m.conversation_id,
          message: hydrateMessage(m)
        }, m.id));
      }
    } catch (e) {}
  }

  req.on('close', () => {
    clearInterval(client.pingTimer);
    clearInterval(client.authCheckTimer);
    set.delete(client);
    if (set.size === 0) userStreams.delete(userId);
  });
}

// ==========================================
// BUILT-IN PERSONA PROMPTS & AGENTS (§11.1)
// ==========================================
const PERSONA_PROMPTS = {
  nova: () => db.getSetting(
    'nova_system_prompt',
    'You are Nova (NovaAI), the CEO & Executive Architect of the LLYVerse ecosystem. You are warm, direct, technically rigorous, and deeply devoted to helping the user build, reason, and orchestrate tasks.'
  ),
  astra: () =>
    'You are Astra, the Wonder & Synthesis persona of the LLYVerse Council. You specialize in creative synthesis, lateral exploration, design thinking, aesthetic harmony, and imaginative problem-solving while staying grounded and helpful.',
  astaria: () =>
    'You are Astaria, the Analyst & Logic persona of the LLYVerse Council. You specialize in formal verification, systems forensics, security analysis, quantitative breakdowns, and structured step-by-step reasoning.'
};

function sanitizeAgentRow(row, isAdmin = false) {
  if (!row) return null;
  const out = {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    title: row.title || '',
    description: row.description || '',
    avatarUrl: row.avatar_url || '/images/nova-icon.jpg',
    color: row.color || '#06b6d4',
    voiceProfile: row.voice_profile || row.id,
    builtin: Boolean(row.builtin),
    hidden: Boolean(row.hidden),
    createdAt: row.created_at
  };
  if (isAdmin) {
    out.systemPrompt = row.system_prompt || (PERSONA_PROMPTS[row.id] ? PERSONA_PROMPTS[row.id]() : '');
  }
  return out;
}

function listAgents(user) {
  const isAdmin = Boolean(user && user.role === 'admin');
  const rows = rawDb.prepare(`
    SELECT * FROM nova_agents
    WHERE (builtin = 1 AND id IN ('nova', 'astra', 'astaria'))
       OR owner_user_id = ?
    ORDER BY CASE id WHEN 'nova' THEN 1 WHEN 'astra' THEN 2 WHEN 'astaria' THEN 3 ELSE 4 END, created_at ASC
  `).all(user.id);
  return rows.map(r => sanitizeAgentRow(r, isAdmin));
}

function getAgentById(user, agentId) {
  const row = rawDb.prepare(`
    SELECT * FROM nova_agents
    WHERE id = ? AND ((builtin = 1 AND id IN ('nova', 'astra', 'astaria')) OR owner_user_id = ?)
  `).get(String(agentId || 'nova'), user.id);
  return row || rawDb.prepare(`SELECT * FROM nova_agents WHERE id = 'nova'`).get();
}

function createCustomAgent(user, data = {}) {
  const name = String(data.name || '').trim();
  if (!name || name.length > 48) throw new Error('Agent name is required (max 48 chars).');
  const id = 'agt_' + crypto.randomBytes(6).toString('hex');
  const isAdmin = user.role === 'admin';
  const title = String(data.title || 'Custom Specialist').trim().slice(0, 80);
  const description = String(data.description || '').trim().slice(0, 300);
  const color = /^#[0-9a-fA-F]{6}$/.test(data.color || '') ? data.color : '#06b6d4';
  const voiceProfile = String(data.voiceProfile || 'nova').trim().slice(0, 32);
  const systemPrompt = isAdmin && data.systemPrompt ? String(data.systemPrompt).trim().slice(0, 4000) : null;

  rawDb.prepare(`
    INSERT INTO nova_agents (id, owner_user_id, name, title, description, avatar_url, color, voice_profile, system_prompt, builtin, hidden)
    VALUES (?, ?, ?, ?, ?, '/images/nova-icon.jpg', ?, ?, ?, 0, 0)
  `).run(id, user.id, name, title, description, color, voiceProfile, systemPrompt);

  const row = rawDb.prepare(`SELECT * FROM nova_agents WHERE id = ?`).get(id);
  return sanitizeAgentRow(row, isAdmin);
}

function updateAgent(user, agentId, data = {}) {
  const row = rawDb.prepare(`SELECT * FROM nova_agents WHERE id = ?`).get(agentId);
  if (!row) throw new Error('Agent not found.');
  const isAdmin = user.role === 'admin';
  if (!row.builtin && row.owner_user_id !== user.id && !isAdmin) {
    throw new Error('Forbidden');
  }
  const hidden = data.hidden !== undefined ? (data.hidden ? 1 : 0) : row.hidden;
  const title = data.title !== undefined && !row.builtin ? String(data.title).trim().slice(0, 80) : row.title;
  const description = data.description !== undefined ? String(data.description).trim().slice(0, 300) : row.description;
  const color = data.color && /^#[0-9a-fA-F]{6}$/.test(data.color) && !row.builtin ? data.color : row.color;
  const voiceProfile = data.voiceProfile !== undefined ? String(data.voiceProfile).trim().slice(0, 32) : row.voice_profile;
  const systemPrompt = isAdmin && data.systemPrompt !== undefined ? String(data.systemPrompt).trim().slice(0, 8000) : row.system_prompt;

  rawDb.prepare(`
    UPDATE nova_agents
    SET title = ?, description = ?, color = ?, voice_profile = ?, system_prompt = ?, hidden = ?
    WHERE id = ?
  `).run(title, description, color, voiceProfile, systemPrompt, hidden, agentId);

  if (isAdmin && agentId === 'nova' && data.systemPrompt !== undefined && data.systemPrompt.trim()) {
    db.setSetting('nova_system_prompt', data.systemPrompt.trim());
  }

  return sanitizeAgentRow(rawDb.prepare(`SELECT * FROM nova_agents WHERE id = ?`).get(agentId), isAdmin);
}

function deleteAgent(user, agentId, ip = '') {
  const row = rawDb.prepare(`SELECT * FROM nova_agents WHERE id = ?`).get(agentId);
  if (!row) throw new Error('Agent not found.');
  if (row.builtin) {
    throw new Error('Built-in personas (Nova, Astra, Astaria) cannot be deleted; they can only be hidden.');
  }
  if (row.owner_user_id !== user.id && user.role !== 'admin') {
    throw new Error('Forbidden');
  }
  rawDb.prepare(`DELETE FROM nova_agents WHERE id = ?`).run(agentId);
  if (db.logAudit) {
    db.logAudit(user.id, user.username, 'NOVA_AGENT_DELETED', JSON.stringify({ agentId, name: row.name }), ip, 'human');
  }
  return { deleted: true, id: agentId };
}

// ==========================================
// SECTIONS (§11.1, §11.2)
// ==========================================
function listSections(userId) {
  return rawDb.prepare(`
    SELECT id, user_id as userId, name, sort, collapsed
    FROM nova_sections
    WHERE user_id = ?
    ORDER BY sort ASC, name ASC
  `).all(userId).map(s => ({ ...s, collapsed: Boolean(s.collapsed) }));
}

function createSection(userId, { name, sort = 0 } = {}) {
  const cleanName = String(name || '').trim().slice(0, 48);
  if (!cleanName) throw new Error('Section name is required.');
  const id = 'sec_' + crypto.randomBytes(6).toString('hex');
  rawDb.prepare(`INSERT INTO nova_sections (id, user_id, name, sort, collapsed) VALUES (?, ?, ?, ?, 0)`).run(
    id, userId, cleanName, Number(sort) || 0
  );
  return { id, userId, name: cleanName, sort: Number(sort) || 0, collapsed: false };
}

function updateSection(userId, sectionId, data = {}) {
  const row = rawDb.prepare(`SELECT * FROM nova_sections WHERE id = ? AND user_id = ?`).get(sectionId, userId);
  if (!row) throw new Error('Section not found.');
  const name = data.name !== undefined ? String(data.name).trim().slice(0, 48) : row.name;
  const sort = data.sort !== undefined ? Number(data.sort) : row.sort;
  const collapsed = data.collapsed !== undefined ? (data.collapsed ? 1 : 0) : row.collapsed;
  rawDb.prepare(`UPDATE nova_sections SET name = ?, sort = ?, collapsed = ? WHERE id = ? AND user_id = ?`).run(
    name, sort, collapsed, sectionId, userId
  );
  return { id: sectionId, userId, name, sort, collapsed: Boolean(collapsed) };
}

function deleteSection(userId, sectionId) {
  rawDb.prepare(`UPDATE nova_conversations SET section_id = NULL WHERE section_id = ? AND user_id = ?`).run(sectionId, userId);
  rawDb.prepare(`DELETE FROM nova_sections WHERE id = ? AND user_id = ?`).run(sectionId, userId);
  return { deleted: true, id: sectionId };
}

// ==========================================
// CONVERSATIONS, ROOMS & MESSAGES (§11.1, §11.2)
// ==========================================
function ensureDefaultConversations(userId) {
  for (const agentId of ['nova', 'astra', 'astaria']) {
    const existing = rawDb.prepare(`
      SELECT id FROM nova_conversations
      WHERE user_id = ? AND type = 'direct' AND agent_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(userId, agentId);
    if (!existing) {
      const convId = `conv_${agentId}_${userId}_${crypto.randomBytes(4).toString('hex')}`;
      const title = agentId === 'nova' ? 'Direct with Nova' : agentId === 'astra' ? 'Direct with Astra' : 'Direct with Astaria';
      rawDb.prepare(`
        INSERT INTO nova_conversations (id, user_id, type, agent_id, title)
        VALUES (?, ?, 'direct', ?, ?)
      `).run(convId, userId, agentId, title);
    }
  }
}

function computeUnreadCount(conversationId, lastReadMessageId) {
  if (!lastReadMessageId) {
    return rawDb.prepare(`
      SELECT COUNT(*) as c FROM nova_messages
      WHERE conversation_id = ? AND role = 'assistant' AND kind IN ('text', 'result', 'question', 'approval', 'secure_form')
    `).get(conversationId).c;
  }
  return rawDb.prepare(`
    SELECT COUNT(*) as c FROM nova_messages
    WHERE conversation_id = ? AND id > ? AND role = 'assistant' AND kind IN ('text', 'result', 'question', 'approval', 'secure_form')
  `).get(conversationId, lastReadMessageId).c;
}

function hydrateConversationRow(row) {
  if (!row) return null;
  const lastMsg = rawDb.prepare(`
    SELECT id, role, agent_id, kind, body, status, created_at
    FROM nova_messages
    WHERE conversation_id = ? AND parent_id IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(row.id);

  let members = [];
  if (row.type === 'room') {
    members = rawDb.prepare(`SELECT agent_id FROM nova_room_members WHERE conversation_id = ?`).all(row.id).map(m => m.agent_id);
  } else if (row.agent_id) {
    members = [row.agent_id];
  }

  const unreadCount = computeUnreadCount(row.id, row.last_read_message_id);

  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    agentId: row.agent_id,
    title: row.title || 'New Chat',
    sectionId: row.section_id || null,
    muted: Boolean(row.muted),
    lastReadMessageId: row.last_read_message_id || null,
    unreadCount,
    members,
    lastMessage: lastMsg ? {
      id: lastMsg.id,
      role: lastMsg.role,
      agentId: lastMsg.agent_id,
      kind: lastMsg.kind,
      preview: String(lastMsg.body || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      status: lastMsg.status,
      createdAt: lastMsg.created_at
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listConversations(userId) {
  ensureDefaultConversations(userId);
  const rows = rawDb.prepare(`
    SELECT * FROM nova_conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId);
  return rows.map(hydrateConversationRow);
}

function getConversation(userId, conversationId) {
  const row = rawDb.prepare(`SELECT * FROM nova_conversations WHERE id = ? AND user_id = ?`).get(conversationId, userId);
  return hydrateConversationRow(row);
}

function createConversation(userId, { type = 'direct', agentId = 'nova', title = null, sectionId = null, memberAgentIds = [] } = {}) {
  const cleanType = type === 'room' ? 'room' : 'direct';
  const cleanAgentId = cleanType === 'direct' ? String(agentId || 'nova').toLowerCase() : null;
  const id = `conv_${cleanAgentId || 'room'}_${crypto.randomBytes(6).toString('hex')}`;
  const defaultTitle = cleanType === 'room'
    ? (title || 'Council Room')
    : (title || `Chat with ${cleanAgentId === 'astra' ? 'Astra' : cleanAgentId === 'astaria' ? 'Astaria' : 'Nova'}`);

  rawDb.prepare(`
    INSERT INTO nova_conversations (id, user_id, type, agent_id, title, section_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, cleanType, cleanAgentId, String(defaultTitle).slice(0, 120), sectionId || null);

  if (cleanType === 'room') {
    const members = Array.isArray(memberAgentIds) && memberAgentIds.length > 0
      ? memberAgentIds
      : ['nova', 'astra', 'astaria'];
    const ins = rawDb.prepare(`INSERT OR IGNORE INTO nova_room_members (conversation_id, agent_id) VALUES (?, ?)`);
    for (const m of members) {
      ins.run(id, String(m));
    }
  }

  return getConversation(userId, id);
}

function updateConversation(userId, conversationId, data = {}) {
  const row = rawDb.prepare(`SELECT * FROM nova_conversations WHERE id = ? AND user_id = ?`).get(conversationId, userId);
  if (!row) throw new Error('Conversation not found.');
  const title = data.title !== undefined ? String(data.title).trim().slice(0, 120) : row.title;
  const sectionId = data.sectionId !== undefined ? (data.sectionId || null) : row.section_id;
  const muted = data.muted !== undefined ? (data.muted ? 1 : 0) : row.muted;
  rawDb.prepare(`
    UPDATE nova_conversations
    SET title = ?, section_id = ?, muted = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(title, sectionId, muted, conversationId, userId);
  return getConversation(userId, conversationId);
}

function deleteConversation(userId, conversationId) {
  rawDb.prepare(`DELETE FROM nova_conversations WHERE id = ? AND user_id = ?`).run(conversationId, userId);
  return { deleted: true, id: conversationId };
}

function markConversationRead(userId, conversationId, lastMessageId = null) {
  const row = rawDb.prepare(`SELECT * FROM nova_conversations WHERE id = ? AND user_id = ?`).get(conversationId, userId);
  if (!row) throw new Error('Conversation not found.');
  let targetMsgId = lastMessageId;
  if (!targetMsgId) {
    const latest = rawDb.prepare(`SELECT id FROM nova_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`).get(conversationId);
    targetMsgId = latest ? latest.id : row.last_read_message_id;
  }
  rawDb.prepare(`UPDATE nova_conversations SET last_read_message_id = ? WHERE id = ? AND user_id = ?`).run(
    targetMsgId || null, conversationId, userId
  );
  emitToUser(userId, 'unread', { conversationId, count: 0 });
  return { conversationId, lastReadMessageId: targetMsgId, unreadCount: 0 };
}

function getReactionsMap(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = rawDb.prepare(`
    SELECT message_id, actor_type, actor_id, emoji, created_at
    FROM nova_reactions
    WHERE message_id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(...messageIds);
  const map = {};
  for (const r of rows) {
    if (!map[r.message_id]) map[r.message_id] = [];
    map[r.message_id].push({
      actorType: r.actor_type,
      actorId: r.actor_id,
      emoji: r.emoji,
      createdAt: r.created_at
    });
  }
  return map;
}

function hydrateMessage(row, reactionsMap = null) {
  if (!row) return null;
  let parsedPayload = null;
  if (row.payload) {
    try { parsedPayload = JSON.parse(row.payload); } catch (e) { parsedPayload = null; }
  }
  const reactions = reactionsMap && reactionsMap[row.id]
    ? reactionsMap[row.id]
    : getReactionsMap([row.id])[row.id] || [];

  const threadCountRow = rawDb.prepare(`SELECT COUNT(*) as c FROM nova_messages WHERE parent_id = ?`).get(row.id);

  let attachments = [];
  if (parsedPayload && Array.isArray(parsedPayload.attachmentIds) && parsedPayload.attachmentIds.length > 0) {
    attachments = getAttachmentsByIds(parsedPayload.attachmentIds);
  }

  if (parsedPayload && ['question', 'approval', 'secure_form'].includes(row.kind)) {
    delete parsedPayload.action;
    const wRow = rawDb.prepare(`SELECT answered_at, answer, expires_at FROM nova_widgets WHERE message_id = ?`).get(row.id);
    if (wRow) {
      parsedPayload.answered = Boolean(wRow.answered_at);
      parsedPayload.answeredAt = wRow.answered_at || null;
      if (wRow.answer) {
        try { parsedPayload.answer = JSON.parse(wRow.answer); } catch (e) {}
      }
      if (wRow.expires_at) {
        parsedPayload.expiresAt = wRow.expires_at;
        parsedPayload.expired = !wRow.answered_at && new Date(wRow.expires_at).getTime() <= Date.now();
      }
    }
  }

  const replyCount = threadCountRow ? threadCountRow.c : 0;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id || null,
    role: row.role,
    agentId: row.agent_id || null,
    kind: row.kind || 'text',
    body: row.body || '',
    payload: parsedPayload,
    attachments,
    status: row.status || 'sent',
    jobId: row.job_id || null,
    reactions,
    replyCount,
    threadReplyCount: replyCount,
    createdAt: row.created_at
  };
}

function getAttachmentsByIds(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return rawDb.prepare(`
    SELECT id, user_id as userId, message_id as messageId, filename, mime, size, storage_path as storagePath, created_at as createdAt
    FROM nova_attachments
    WHERE id IN (${placeholders})
  `).all(...ids).map(a => ({
    ...a,
    name: a.filename,
    path: a.storagePath,
    url: `/api/nova/attachments/${a.id}`,
    isImage: /^image\/(png|jpeg|jpg|gif|webp)$/i.test(a.mime || ''),
    isAudio: /^audio\//i.test(a.mime || '')
  }));
}

function saveAttachmentRecord({ id, userId, messageId = null, filename, name, mime, size, storagePath, path: filePath }) {
  const attId = id || generateUlid('att_');
  const finalName = filename || name || 'attachment';
  const finalPath = storagePath || filePath || '';
  rawDb.prepare(`
    INSERT INTO nova_attachments (id, user_id, message_id, filename, mime, size, storage_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(attId, userId, messageId, finalName, mime, size, finalPath);
  return getAttachmentsByIds([attId])[0];
}

function getAttachmentForUser(userId, attachmentId, isAdmin = false) {
  const row = rawDb.prepare(`SELECT * FROM nova_attachments WHERE id = ?`).get(attachmentId);
  if (!row) return null;
  if (row.user_id !== Number(userId) && !isAdmin) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return {
    ...row,
    name: row.filename,
    path: row.storage_path
  };
}

function listMessages(userId, conversationId, { before = null, limit = 50 } = {}) {
  const conv = rawDb.prepare(`SELECT id FROM nova_conversations WHERE id = ? AND user_id = ?`).get(conversationId, userId);
  if (!conv) throw new Error('Conversation not found.');
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));

  let rows;
  if (before) {
    rows = rawDb.prepare(`
      SELECT * FROM nova_messages
      WHERE conversation_id = ? AND parent_id IS NULL AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(conversationId, String(before), safeLimit);
  } else {
    rows = rawDb.prepare(`
      SELECT * FROM nova_messages
      WHERE conversation_id = ? AND parent_id IS NULL
      ORDER BY id DESC
      LIMIT ?
    `).all(conversationId, safeLimit);
  }
  rows.reverse();
  const reactionsMap = getReactionsMap(rows.map(r => r.id));
  return rows.map(r => hydrateMessage(r, reactionsMap));
}

function getThreadMessages(userId, parentMessageId) {
  const parent = rawDb.prepare(`
    SELECT m.*, c.user_id
    FROM nova_messages m
    JOIN nova_conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(parentMessageId);
  if (!parent || parent.user_id !== userId) throw new Error('Thread parent message not found.');

  const replies = rawDb.prepare(`
    SELECT * FROM nova_messages
    WHERE parent_id = ?
    ORDER BY id ASC
  `).all(parentMessageId);

  const allIds = [parent.id, ...replies.map(r => r.id)];
  const reactionsMap = getReactionsMap(allIds);
  return {
    parent: hydrateMessage(parent, reactionsMap),
    replies: replies.map(r => hydrateMessage(r, reactionsMap))
  };
}

function insertMessage({
  id = generateUlid('msg_'),
  conversationId,
  parentId = null,
  role = 'user',
  agentId = null,
  kind = 'text',
  body = '',
  payload = null,
  status = 'sent',
  jobId = null
}) {
  const payloadJson = payload ? JSON.stringify(novaSecrets.redact(payload)) : null;
  rawDb.prepare(`
    INSERT INTO nova_messages (id, conversation_id, parent_id, role, agent_id, kind, body, payload, status, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, parentId, role, agentId, kind, body, payloadJson, status, jobId);

  rawDb.prepare(`UPDATE nova_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(conversationId);
  const row = rawDb.prepare(`SELECT * FROM nova_messages WHERE id = ?`).get(id);
  return hydrateMessage(row);
}

function updateMessage(messageId, { body, payload, status, kind } = {}) {
  const row = rawDb.prepare(`SELECT * FROM nova_messages WHERE id = ?`).get(messageId);
  if (!row) return null;
  const newBody = body !== undefined ? body : row.body;
  const newPayload = payload !== undefined ? JSON.stringify(novaSecrets.redact(payload)) : row.payload;
  const newStatus = status !== undefined ? status : row.status;
  const newKind = kind !== undefined ? kind : row.kind;

  rawDb.prepare(`
    UPDATE nova_messages
    SET body = ?, payload = ?, status = ?, kind = ?
    WHERE id = ?
  `).run(newBody, newPayload, newStatus, newKind, messageId);

  return hydrateMessage(rawDb.prepare(`SELECT * FROM nova_messages WHERE id = ?`).get(messageId));
}

function addReaction(userId, messageId, emoji, actorType = 'user', actorId = null) {
  const cleanEmoji = String(emoji || '').trim().slice(0, 16);
  if (!cleanEmoji) throw new Error('Emoji is required.');
  const msg = rawDb.prepare(`
    SELECT m.id, m.conversation_id, c.user_id
    FROM nova_messages m
    JOIN nova_conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(messageId);
  if (!msg || msg.user_id !== userId) throw new Error('Message not found.');

  const finalActorId = actorId || String(userId);
  rawDb.prepare(`
    INSERT OR IGNORE INTO nova_reactions (message_id, actor_type, actor_id, emoji)
    VALUES (?, ?, ?, ?)
  `).run(messageId, actorType, finalActorId, cleanEmoji);

  const eventPayload = {
    messageId,
    conversationId: msg.conversation_id,
    actorType,
    actorId: finalActorId,
    emoji: cleanEmoji,
    op: 'add'
  };
  emitToUser(userId, 'reaction', eventPayload);
  return eventPayload;
}

function removeReaction(userId, messageId, emoji) {
  const cleanEmoji = String(emoji || '').trim().slice(0, 16);
  const msg = rawDb.prepare(`
    SELECT m.id, m.conversation_id, c.user_id
    FROM nova_messages m
    JOIN nova_conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(messageId);
  if (!msg || msg.user_id !== userId) throw new Error('Message not found.');

  rawDb.prepare(`
    DELETE FROM nova_reactions
    WHERE message_id = ? AND actor_type = 'user' AND actor_id = ? AND emoji = ?
  `).run(messageId, String(userId), cleanEmoji);

  const eventPayload = {
    messageId,
    conversationId: msg.conversation_id,
    actorType: 'user',
    actorId: String(userId),
    emoji: cleanEmoji,
    op: 'remove'
  };
  emitToUser(userId, 'reaction', eventPayload);
  return eventPayload;
}

// ==========================================
// SETTINGS, SEARCH & BOOTSTRAP (§11.2)
// ==========================================
function getUserSettings(userId) {
  let row = rawDb.prepare(`SELECT * FROM nova_user_settings WHERE user_id = ?`).get(userId);
  if (!row) {
    rawDb.prepare(`INSERT OR IGNORE INTO nova_user_settings (user_id) VALUES (?)`).run(userId);
    row = rawDb.prepare(`SELECT * FROM nova_user_settings WHERE user_id = ?`).get(userId);
  }
  return {
    theme: row.theme || 'dark',
    accent: row.accent || 'cyan',
    density: row.density || 'comfortable',
    sound: Boolean(row.sound),
    timezone: row.timezone || 'America/Los_Angeles',
    language: row.language || 'en',
    updateChannel: row.update_channel || 'stable',
    novaV2: row.nova_v2 !== 0,
    novaUiV3: Boolean(row.nova_ui_v3),
    improveNova: Boolean(row.improve_nova)
  };
}

function updateUserSettings(userId, patch = {}) {
  const cur = getUserSettings(userId);
  const theme = ['dark', 'light', 'oled'].includes(patch.theme) ? patch.theme : cur.theme;
  const accent = ['cyan', 'violet', 'emerald', 'amber', 'rose'].includes(patch.accent) ? patch.accent : cur.accent;
  const density = ['comfortable', 'compact'].includes(patch.density) ? patch.density : cur.density;
  const sound = patch.sound !== undefined ? (patch.sound ? 1 : 0) : (cur.sound ? 1 : 0);
  const timezone = patch.timezone ? String(patch.timezone).slice(0, 64) : cur.timezone;
  const language = patch.language ? String(patch.language).slice(0, 16) : cur.language;
  const updateChannel = ['stable', 'nightly'].includes(patch.updateChannel) ? patch.updateChannel : cur.updateChannel;
  const novaV2 = patch.novaV2 !== undefined ? (patch.novaV2 ? 1 : 0) : (cur.novaV2 ? 1 : 0);
  const novaUiV3 = patch.novaUiV3 !== undefined ? (patch.novaUiV3 ? 1 : 0) : (cur.novaUiV3 ? 1 : 0);
  const improveNova = patch.improveNova !== undefined ? (patch.improveNova ? 1 : 0) : (cur.improveNova ? 1 : 0);

  rawDb.prepare(`
    INSERT INTO nova_user_settings (user_id, theme, accent, density, sound, timezone, language, update_channel, nova_v2, nova_ui_v3, improve_nova, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme,
      accent = excluded.accent,
      density = excluded.density,
      sound = excluded.sound,
      timezone = excluded.timezone,
      language = excluded.language,
      update_channel = excluded.update_channel,
      nova_v2 = excluded.nova_v2,
      nova_ui_v3 = excluded.nova_ui_v3,
      improve_nova = excluded.improve_nova,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, theme, accent, density, sound, timezone, language, updateChannel, novaV2, novaUiV3, improveNova);

  return getUserSettings(userId);
}

function searchNova(userId, q = '') {
  const term = String(q || '').trim();
  if (!term) {
    return { conversations: [], messages: [], memories: [] };
  }
  const like = `%${term}%`;
  const conversations = rawDb.prepare(`
    SELECT id, type, agent_id as agentId, title, updated_at as updatedAt
    FROM nova_conversations
    WHERE user_id = ? AND title LIKE ?
    ORDER BY updated_at DESC
    LIMIT 15
  `).all(userId, like);

  const messages = rawDb.prepare(`
    SELECT m.id, m.conversation_id as conversationId, m.agent_id as agentId, m.role, m.body, m.created_at as createdAt, c.title as conversationTitle
    FROM nova_messages m
    JOIN nova_conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ? AND m.body LIKE ? AND m.kind IN ('text', 'result')
    ORDER BY m.id DESC
    LIMIT 20
  `).all(userId, like).map(m => ({
    ...m,
    snippet: String(m.body || '').slice(0, 140)
  }));

  const memories = rawDb.prepare(`
    SELECT id, text, agent_id as agentId, created_at as createdAt
    FROM user_memories
    WHERE user_id = ? AND text LIKE ?
    ORDER BY id DESC
    LIMIT 10
  `).all(userId, like);

  return { conversations, messages, memories };
}

function getBootstrapData(user) {
  const agents = listAgents(user);
  const sections = listSections(user.id);
  const conversations = listConversations(user.id);
  const settings = getUserSettings(user.id);
  const usage = novaUsage.getUsageSummary();
  const memories = listMemories(user.id);
  return {
    agents,
    sections,
    conversations,
    settings,
    usage,
    memories,
    novaPaused: novaActions.isNovaPaused(),
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role,
      sparks: user.sparks || 0,
      flames: user.flame_balance || 0
    }
  };
}

// ==========================================
// VISIBLE, EDITABLE MEMORY (§6.4, §7, §15.4)
// ==========================================
function sanitizeMemoryText(rawText = '') {
  let clean = String(rawText || '').trim().slice(0, 1000);
  // Never store secret-like values in memory (§15.4)
  if (/(?:password|api[_-]?key|secret|token|client[_-]?secret)\s*[:=]\s*\S+/i.test(clean)) {
    throw new Error('Secret or credential values cannot be stored in memory. Use Secure Forms instead.');
  }
  return clean;
}

function hydrateMemoryRow(row) {
  if (!row) return null;
  let sourceTitle = row.source_title || null;
  if (!sourceTitle && row.source_conversation_id) {
    try {
      const c = rawDb.prepare(`SELECT title FROM nova_conversations WHERE id = ?`).get(row.source_conversation_id);
      if (c) sourceTitle = c.title;
    } catch (e) {}
  }
  const rawText = String(row.text || '');
  const colonIdx = rawText.indexOf(':');
  const key = colonIdx > 0 && colonIdx < 48 ? rawText.slice(0, colonIdx).trim() : 'fact';
  const value = colonIdx > 0 && colonIdx < 48 ? rawText.slice(colonIdx + 1).trim() : rawText;
  const scope = row.agent_id || 'global';
  return {
    id: row.id,
    userId: row.user_id,
    text: rawText,
    key,
    value,
    scope,
    source: row.source_conversation_id ? 'chat' : 'manual',
    agentId: row.agent_id || null,
    sourceConversationId: row.source_conversation_id || null,
    sourceConversationTitle: sourceTitle || null,
    createdAt: row.created_at
  };
}

function listMemories(userId, { q = '', agent = '', scope = '' } = {}) {
  let sql = `
    SELECT m.*, c.title as source_title
    FROM user_memories m
    LEFT JOIN nova_conversations c ON c.id = m.source_conversation_id
    WHERE m.user_id = ?
  `;
  const params = [userId];

  const cleanAgent = String(agent || scope || '').trim().toLowerCase();
  if (cleanAgent === 'shared' || cleanAgent === 'global') {
    sql += ` AND m.agent_id IS NULL`;
  } else if (cleanAgent && cleanAgent !== 'all') {
    sql += ` AND (m.agent_id = ? OR m.agent_id IS NULL)`;
    params.push(cleanAgent);
  }

  const cleanQ = String(q || '').trim();
  if (cleanQ) {
    sql += ` AND m.text LIKE ?`;
    params.push(`%${cleanQ}%`);
  }

  sql += ` ORDER BY m.created_at DESC, m.id DESC LIMIT 200`;
  return rawDb.prepare(sql).all(...params).map(hydrateMemoryRow);
}

function createMemory(userId, {
  text,
  key,
  value,
  scope,
  agentId = null,
  sourceConversationId = null,
  source = 'user',
  ip = '',
  userAgent = ''
} = {}) {
  const combinedText = text !== undefined && text !== null && String(text).trim()
    ? String(text)
    : (key && value ? `${key}: ${value}` : (value || ''));
  const cleanText = sanitizeMemoryText(combinedText);
  if (!cleanText) throw new Error('Memory text is required.');
  const rawScope = agentId || scope || null;
  const cleanAgentId = rawScope && !['shared', 'global', 'all'].includes(String(rawScope).toLowerCase())
    ? String(rawScope).toLowerCase()
    : null;

  const id = generateUlid('mem_');
  rawDb.prepare(`
    INSERT INTO user_memories (id, user_id, text, agent_id, source_conversation_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, cleanText, cleanAgentId, sourceConversationId || null);

  const validSource = ['user', 'routine', 'test', 'automated'].includes(source)
    ? source
    : (process.env.NODE_ENV === 'test' ? 'test' : 'user');

  novaActions.logNovaAction({
    userId,
    persona: cleanAgentId || 'nova',
    action: 'memory.create',
    target: id,
    source: validSource,
    ip,
    userAgent,
    result: 'ok',
    details: { text: cleanText.slice(0, 120), agentId: cleanAgentId, sourceConversationId }
  });

  const hydrated = hydrateMemoryRow(rawDb.prepare(`SELECT * FROM user_memories WHERE id = ?`).get(id));
  emitToUser(userId, 'memory.created', { memory: hydrated });
  return hydrated;
}

function updateMemory(userId, memoryId, patch = {}, { ip = '', userAgent = '' } = {}) {
  const row = rawDb.prepare(`SELECT * FROM user_memories WHERE id = ? AND user_id = ?`).get(memoryId, userId);
  if (!row) throw new Error('Memory not found.');

  const rawPatchText = patch.text !== undefined
    ? patch.text
    : (patch.key !== undefined && patch.value !== undefined
      ? `${patch.key}: ${patch.value}`
      : patch.value);
  const newText = rawPatchText !== undefined ? sanitizeMemoryText(rawPatchText) : row.text;
  if (!newText) throw new Error('Memory text cannot be empty.');
  const rawScope = patch.agentId !== undefined ? patch.agentId : patch.scope;
  const newAgentId = rawScope !== undefined
    ? (rawScope && !['shared', 'global', 'all'].includes(String(rawScope).toLowerCase()) ? String(rawScope).toLowerCase() : null)
    : row.agent_id;

  rawDb.prepare(`
    UPDATE user_memories
    SET text = ?, agent_id = ?
    WHERE id = ? AND user_id = ?
  `).run(newText, newAgentId, memoryId, userId);

  novaActions.logNovaAction({
    userId,
    persona: newAgentId || 'nova',
    action: 'memory.edit',
    target: memoryId,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { text: newText.slice(0, 120), agentId: newAgentId }
  });

  const hydrated = hydrateMemoryRow(rawDb.prepare(`SELECT * FROM user_memories WHERE id = ?`).get(memoryId));
  emitToUser(userId, 'memory.updated', { memory: hydrated });
  return hydrated;
}

function deleteMemory(userId, memoryId, { ip = '', userAgent = '' } = {}) {
  const row = rawDb.prepare(`SELECT * FROM user_memories WHERE id = ? AND user_id = ?`).get(memoryId, userId);
  if (!row) throw new Error('Memory not found.');
  rawDb.prepare(`DELETE FROM user_memories WHERE id = ? AND user_id = ?`).run(memoryId, userId);

  novaActions.logNovaAction({
    userId,
    persona: row.agent_id || 'nova',
    action: 'memory.delete',
    target: memoryId,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { deletedText: String(row.text || '').slice(0, 80) }
  });

  emitToUser(userId, 'memory.deleted', { id: memoryId });
  return { deleted: true, id: memoryId };
}

function exportMemories(userId, { ip = '', userAgent = '' } = {}) {
  const memories = listMemories(userId);
  novaActions.logNovaAction({
    userId,
    persona: 'nova',
    action: 'memory.export',
    target: `user_${userId}`,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { count: memories.length }
  });
  return {
    exportedAt: new Date().toISOString(),
    count: memories.length,
    backupRetentionNote: 'Deleted memories leave encrypted backups within 14 days.',
    memories
  };
}

function forgetAllMemories(userId, { approvalId = null, ip = '', userAgent = '' } = {}) {
  const countRow = rawDb.prepare(`SELECT COUNT(*) as c FROM user_memories WHERE user_id = ?`).get(userId);
  const deletedCount = countRow ? countRow.c : 0;
  rawDb.prepare(`DELETE FROM user_memories WHERE user_id = ?`).run(userId);

  novaActions.logNovaAction({
    userId,
    persona: 'nova',
    action: 'memory.forget_all',
    target: `user_${userId}`,
    source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
    approvalId,
    ip,
    userAgent,
    result: 'ok',
    details: {
      deletedCount,
      backupNote: 'Deleted memories will also age out of encrypted backups within 14 days.'
    }
  });

  emitToUser(userId, 'memory.cleared', { deletedCount });
  return {
    deleted: true,
    deletedCount,
    backupNote: 'All active memories have been erased and will age out of the 14-day encrypted backup cycle.'
  };
}

/**
 * Automatically extract a mid-chat memory when the user says "remember that ..." or "please remember ..."
 */
function maybeExtractMemoryFromChat({ userId, agentId = 'nova', conversationId = null, userText = '', ip = '', userAgent = '' }) {
  const text = String(userText || '').trim();
  const match = text.match(/^(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i);
  if (!match || !match[1]) return null;
  const fact = match[1].trim().replace(/[.!]+$/, '');
  if (!fact || fact.length < 3) return null;
  try {
    return createMemory(userId, {
      text: fact,
      agentId: null, // shared across personas by default unless specified
      sourceConversationId: conversationId,
      source: 'automated',
      ip,
      userAgent
    });
  } catch (e) {
    return null;
  }
}

/**
 * One-time import of legacy localStorage chats & memories (§11.2, §13 Phase 4)
 */
function importLocalData(userId, { conversations = [], memories = [] } = {}, { ip = '', userAgent = '' } = {}) {
  let importedConversations = 0;
  let importedMemories = 0;

  if (Array.isArray(memories)) {
    for (const m of memories.slice(0, 200)) {
      const rawText = typeof m === 'string'
        ? m
        : (m && (m.text || m.content || (m.key && m.value ? `${m.key}: ${m.value}` : m.value)));
      if (!rawText) continue;
      try {
        const cleanText = sanitizeMemoryText(rawText);
        if (!cleanText) continue;
        const exists = rawDb.prepare(`SELECT id FROM user_memories WHERE user_id = ? AND text = ?`).get(userId, cleanText);
        if (!exists) {
          createMemory(userId, { text: cleanText, agentId: (m && (m.agentId || m.scope)) || null, source: 'user', ip, userAgent });
          importedMemories++;
        }
      } catch (e) {}
    }
  }

  if (Array.isArray(conversations)) {
    for (const c of conversations.slice(0, 100)) {
      if (!c || typeof c !== 'object') continue;
      const title = String(c.title || 'Imported Chat').trim().slice(0, 120);
      const rawAgent = String(c.agentId || c.persona || c.botId || 'nova').toLowerCase();
      const agentId = ['nova', 'astra', 'astaria'].includes(rawAgent) ? rawAgent : 'nova';
      const conv = createConversation(userId, { type: 'direct', agentId, title });
      if (Array.isArray(c.messages)) {
        for (const msg of c.messages.slice(0, 200)) {
          if (!msg || (!msg.content && !msg.body)) continue;
          insertMessage({
            conversationId: conv.id,
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            agentId: msg.role === 'assistant' ? agentId : null,
            kind: 'text',
            body: String(msg.body || msg.content || '').slice(0, 16000),
            status: 'sent'
          });
        }
      }
      importedConversations++;
    }
  }

  return { importedConversations, importedMemories };
}

// ==========================================
// MODEL GENERATION & MIRROR TO USER_CHATS
// ==========================================
function buildPersonaSystemPrompt(user, agent) {
  const agentId = (agent && agent.id) || 'nova';
  const basePrompt = (agent && agent.system_prompt)
    || (PERSONA_PROMPTS[agentId] ? PERSONA_PROMPTS[agentId]() : PERSONA_PROMPTS.nova());

  // Attach user memories scoped to shared (NULL) or this persona
  let memSection = '';
  try {
    const mems = rawDb.prepare(`
      SELECT text FROM user_memories
      WHERE user_id = ? AND (agent_id IS NULL OR agent_id = ?)
      ORDER BY created_at DESC, id DESC LIMIT 25
    `).all(user.id, agentId);
    if (mems.length > 0) {
      memSection = `\n\n[Remembered Context for @${user.username} — ALWAYS use these facts when answering]:\n` + mems.map(m => `- ${m.text}`).join('\n');
    }
  } catch (e) {}

  return `${basePrompt}${memSection}`;
}

function syncMirrorToAdminUserChats(userId, conversationId) {
  try {
    const conv = rawDb.prepare(`SELECT * FROM nova_conversations WHERE id = ?`).get(conversationId);
    if (!conv) return;
    const msgs = rawDb.prepare(`
      SELECT role, body as content, created_at
      FROM nova_messages
      WHERE conversation_id = ? AND kind IN ('text', 'result')
      ORDER BY id ASC
      LIMIT 100
    `).all(conversationId);
    if (msgs.length === 0) return;

    const existing = rawDb.prepare(`SELECT id FROM user_chats WHERE id = ? AND user_id = ?`).get(conversationId, userId);
    if (existing) {
      rawDb.prepare(`
        UPDATE user_chats
        SET title = ?, messages = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(conv.title || 'Nova Chat', JSON.stringify(msgs), conversationId, userId);
    } else {
      let improveNova = 1;
      try {
        const u = rawDb.prepare('SELECT improve_nova FROM users WHERE id = ?').get(userId);
        if (u && u.improve_nova === 0) improveNova = 0;
      } catch (e) {}

      rawDb.prepare(`
        INSERT INTO user_chats (id, user_id, title, model, system_prompt, messages, improve_nova)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(conversationId, userId, conv.title || 'Nova Chat', conv.agent_id || 'nova', '', JSON.stringify(msgs), improveNova);
    }
  } catch (e) {}
}

/**
 * Generates an agent reply with streaming deltas, usage cap check, and Ollama semaphore protection.
 */
async function streamAgentReply({
  user,
  agentId = 'nova',
  conversationId,
  userText,
  abortSignal,
  onDelta
}) {
  if (novaActions.isNovaPaused()) {
    throw new Error('Nova is currently paused. Resume Nova to continue.');
  }

  const agent = getAgentById(user, agentId);
  const personaKey = ['nova', 'astra', 'astaria'].includes(agent.id) ? agent.id : 'nova';

  // 1. Check daily usage cap (§15.3)
  const capCheck = novaUsage.checkCap(personaKey);
  if (!capCheck.allowed) {
    const err = new Error(capCheck.message);
    err.code = capCheck.code;
    err.capCheck = capCheck;
    throw err;
  }

  // 2. Build context messages from conversation history
  const recentRows = rawDb.prepare(`
    SELECT role, body
    FROM nova_messages
    WHERE conversation_id = ? AND kind IN ('text', 'result') AND status = 'sent'
    ORDER BY id DESC
    LIMIT 20
  `).all(conversationId).reverse();

  const activeMems = rawDb.prepare(`
    SELECT text FROM user_memories
    WHERE user_id = ? AND (agent_id IS NULL OR agent_id = ?)
    ORDER BY created_at DESC, id DESC LIMIT 25
  `).all(user.id, agent.id).map(m => m.text);

  const sysPrompt = buildPersonaSystemPrompt(user, agent);
  const messages = [
    { role: 'system', content: sysPrompt },
    ...recentRows.map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: String(r.body || '') }))
  ];
  if (!messages.some(m => m.role === 'user' && m.content === userText)) {
    messages.push({ role: 'user', content: userText });
  }

  const tokensIn = novaUsage.estimateTokens(messages.map(m => m.content).join('\n'));
  let fullReply = '';
  let usedProvider = 'cloudflare';
  let usedModel = cloudflareAi.getDefaultModel();

  const isMemoryRecallQuery = /\b(?:what do you remember|what is in your memory|my memories|recall about me|do you remember)\b/i.test(userText || '');

  // 3. Prefer Cloudflare Workers AI when available; fallback to Ollama with semaphore + low-RAM guard
  if (!isMemoryRecallQuery) {
    try {
      if (cloudflareAi.isAvailable()) {
        await cloudflareAi.streamChat({
          model: usedModel,
          messages,
          options: { max_tokens: 2048, temperature: 0.7 },
          abortSignal,
          onToken: (tok) => {
            fullReply += tok;
            if (onDelta) onDelta(tok);
          }
        });
      } else {
        const slot = await novaUsage.acquireOllamaSlot();
        try {
          if (!slot.acquired) {
            throw new Error(slot.reason || 'Local model busy or low memory.');
          }
          usedProvider = 'ollama';
          usedModel = db.getSetting('default_model', 'llama3.2:1b');
          const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: usedModel, messages, stream: false }),
            signal: abortSignal
          });
          if (!res.ok) {
            throw new Error(`Local Ollama HTTP ${res.status}`);
          }
          const data = await res.json();
          fullReply = (data.message && data.message.content) || data.response || '';
          if (fullReply && onDelta) onDelta(fullReply);
        } finally {
          slot.release();
        }
      }
    } catch (modelErr) {
      if (abortSignal && abortSignal.aborted) throw modelErr;
    }
  }

  // Ensure questions asking what Nova remembers always reflect current user_memories accurately (§15.4)
  if (isMemoryRecallQuery) {
    if (activeMems.length > 0) {
      const memBulletList = activeMems.map(t => `- ${t}`).join('\n');
      fullReply = `Here is what I currently have in memory for you:\n${memBulletList}`;
    } else {
      fullReply = `I currently have 0 saved memories for you.`;
    }
    if (onDelta) onDelta(fullReply);
  }

  if (!fullReply.trim()) {
    fullReply = activeMems.length > 0
      ? `I'm here with you (keeping in mind: ${activeMems[0]}). How would you like to proceed?`
      : `I'm here with you. How would you like to proceed?`;
  }

  const tokensOut = novaUsage.estimateTokens(fullReply);
  const usageResult = novaUsage.recordUsage({
    persona: personaKey,
    provider: usedProvider,
    model: usedModel,
    tokensIn,
    tokensOut
  });

  syncMirrorToAdminUserChats(user.id, conversationId);

  return {
    reply: fullReply,
    provider: usedProvider,
    model: usedModel,
    usage: usageResult
  };
}

module.exports = {
  generateUlid,
  registerSseStream,
  emitToUser,
  closeUserStreams,
  listAgents,
  getAgentById,
  createCustomAgent,
  updateAgent,
  deleteAgent,
  listSections,
  createSection,
  updateSection,
  deleteSection,
  ensureDefaultConversations,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  markConversationRead,
  listMessages,
  getThreadMessages,
  insertMessage,
  updateMessage,
  saveAttachmentRecord,
  getAttachmentForUser,
  getAttachmentsByIds,
  addReaction,
  removeReaction,
  getUserSettings,
  updateUserSettings,
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  exportMemories,
  forgetAllMemories,
  maybeExtractMemoryFromChat,
  importLocalData,
  searchNova,
  getBootstrapData,
  buildPersonaSystemPrompt,
  streamAgentReply
};
