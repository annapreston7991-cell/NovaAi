/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Redesign Express Router (§11.2, §15.3)
 * Mounted at /api/nova in server.js. All routes require authentication.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const novaChat = require('../services/nova_chat');
const novaJobs = require('../services/nova_jobs');
const novaUsage = require('../services/nova_usage');
const novaWidgets = require('../services/nova_widgets');
const novaRoutines = require('../services/nova_routines');
const novaScreen = require('../services/nova_screen');
const novaComputer = require('../services/nova_computer');
const novaActions = require('../services/nova_actions');
const requireApprovalToken = require('../middleware/requireApprovalToken');
const db = require('../data/db');

const ATTACHMENTS_ROOT = path.resolve(__dirname, '../data/nova_attachments');
try {
  fs.mkdirSync(ATTACHMENTS_ROOT, { recursive: true, mode: 0o700 });
} catch (e) {}

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.webm', '.ogg', '.mp3', '.wav', '.m4a',
  '.txt', '.md', '.json', '.csv', '.pdf',
  '.js', '.ts', '.py', '.sh', '.log', '.html', '.css', '.sql', '.yaml', '.yml'
]);

const ALLOWED_MIME_PREFIXES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4',
  'text/', 'application/json', 'application/pdf', 'application/javascript', 'application/x-sh'
];

function isUploadAllowed(originalname, mimetype) {
  const ext = path.extname(String(originalname || '')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  const mime = String(mimetype || '').toLowerCase();
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(ATTACHMENTS_ROOT, String(req.user.id));
    try {
      fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
      cb(null, userDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const safeId = novaChat.generateUlid('file_');
    cb(null, `${safeId}${ext}`);
  }
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB per file (§4.4)
    files: 4
  },
  fileFilter: (req, file, cb) => {
    if (!isUploadAllowed(file.originalname, file.mimetype)) {
      const err = new Error('Unsupported file type or extension.');
      err.status = 415;
      return cb(err);
    }
    cb(null, true);
  }
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // §12: 20 uploads/min
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many uploads. Limit is 20 per minute.' }
});

const widgetAnswerRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // §12: 30 widget answers/min
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many widget answers. Limit is 30 per minute.' }
});

const secureFormRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // §12: 5 secure forms/min
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many secure form submissions. Limit is 5 per minute.' }
});

function createNovaRouter({ requireAuth, requireAdmin, aiRateLimiter }) {
  const router = express.Router();

  // Bootstrap initial app state
  router.get('/bootstrap', requireAuth, (req, res) => {
    try {
      const data = novaChat.getBootstrapData(req.user);
      const connectors = novaWidgets.getConnectorsStatus(req.user.id);
      const routines = novaRoutines.listRoutines(req.user.id);
      res.json({ success: true, ...data, connectors, routines });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // SSE Stream for all conversations of the signed-in user (§11.3)
  router.get('/stream', requireAuth, (req, res) => {
    novaChat.registerSseStream(req, res);
  });

  // Agents CRUD (§11.2)
  router.get('/agents', requireAuth, (req, res) => {
    try {
      res.json({ success: true, agents: novaChat.listAgents(req.user) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/agents', requireAuth, (req, res) => {
    try {
      const agent = novaChat.createCustomAgent(req.user, req.body || {});
      res.json({ success: true, agent });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/agents/:id', requireAuth, (req, res) => {
    try {
      const agent = novaChat.updateAgent(req.user, req.params.id, req.body || {});
      res.json({ success: true, agent });
    } catch (err) {
      res.status(err.message === 'Forbidden' ? 403 : 400).json({ success: false, error: err.message });
    }
  });

  router.delete('/agents/:id', requireAuth, (req, res) => {
    try {
      const out = novaChat.deleteAgent(req.user, req.params.id, req.clientIp || req.ip);
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(err.message === 'Forbidden' ? 403 : 400).json({ success: false, error: err.message });
    }
  });

  // Sidebar Sections CRUD (§11.2)
  router.get('/sections', requireAuth, (req, res) => {
    try {
      res.json({ success: true, sections: novaChat.listSections(req.user.id) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/sections', requireAuth, (req, res) => {
    try {
      const section = novaChat.createSection(req.user.id, req.body || {});
      res.json({ success: true, section });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/sections/:id', requireAuth, (req, res) => {
    try {
      const section = novaChat.updateSection(req.user.id, req.params.id, req.body || {});
      res.json({ success: true, section });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.delete('/sections/:id', requireAuth, (req, res) => {
    try {
      const out = novaChat.deleteSection(req.user.id, req.params.id);
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Conversations & Rooms CRUD (§11.2)
  router.get('/conversations', requireAuth, (req, res) => {
    try {
      res.json({ success: true, conversations: novaChat.listConversations(req.user.id) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/conversations', requireAuth, (req, res) => {
    try {
      const conversation = novaChat.createConversation(req.user.id, req.body || {});
      res.json({ success: true, conversation });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/conversations/:id', requireAuth, (req, res) => {
    try {
      const conversation = novaChat.updateConversation(req.user.id, req.params.id, req.body || {});
      res.json({ success: true, conversation });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.delete('/conversations/:id', requireAuth, (req, res) => {
    try {
      const out = novaChat.deleteConversation(req.user.id, req.params.id);
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/conversations/:id/read', requireAuth, (req, res) => {
    try {
      const out = novaChat.markConversationRead(req.user.id, req.params.id, (req.body && req.body.lastMessageId) || null);
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.post('/conversations/:id/cancel', requireAuth, (req, res) => {
    try {
      const out = novaJobs.cancelConversationJob(req.user.id, req.params.id);
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Messages & Threads (§11.2)
  router.get('/conversations/:id/messages', requireAuth, (req, res) => {
    try {
      const messages = novaChat.listMessages(req.user.id, req.params.id, {
        before: req.query.before || null,
        limit: req.query.limit || 50
      });
      res.json({ success: true, messages });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  const messageMiddleware = aiRateLimiter ? [requireAuth, aiRateLimiter] : [requireAuth];
  router.post('/conversations/:id/messages', ...messageMiddleware, (req, res) => {
    try {
      const { text, body, parentId = null, attachmentIds = [] } = req.body || {};
      const result = novaJobs.enqueueConversationTurn({
        user: req.user,
        conversationId: req.params.id,
        text: text !== undefined ? text : body,
        parentId,
        attachmentIds
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(err.status || 400).json({ success: false, error: err.message });
    }
  });

  router.get('/messages/:id/thread', requireAuth, (req, res) => {
    try {
      const thread = novaChat.getThreadMessages(req.user.id, req.params.id);
      res.json({ success: true, ...thread });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  // Reactions (§11.2)
  router.post('/messages/:id/reactions', requireAuth, (req, res) => {
    try {
      const out = novaChat.addReaction(req.user.id, req.params.id, (req.body && req.body.emoji) || '👍');
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.delete('/messages/:id/reactions', requireAuth, (req, res) => {
    try {
      const emoji = (req.body && req.body.emoji) || req.query.emoji;
      const out = novaChat.removeReaction(req.user.id, req.params.id, emoji);
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Uploads & Owner-Only Attachments (§4.4, §11.2, §12)
  router.post('/uploads', requireAuth, uploadRateLimiter, (req, res) => {
    const handler = uploadMiddleware.any();
    handler(req, res, (err) => {
      if (err) {
        return res.status(err.status || 400).json({ success: false, error: err.message });
      }
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ success: false, error: 'No file provided.' });
      }
      try {
        const saved = files.map((f) =>
          novaChat.saveAttachmentRecord({
            userId: req.user.id,
            messageId: (req.body && req.body.messageId) || null,
            mime: f.mimetype,
            name: path.basename(f.originalname),
            size: f.size,
            path: f.path,
            width: (req.body && Number(req.body.width)) || null,
            height: (req.body && Number(req.body.height)) || null,
            durationMs: (req.body && Number(req.body.durationMs)) || null,
            transcript: (req.body && req.body.transcript) || null
          })
        );
        res.json({
          success: true,
          attachment: saved[0],
          attachments: saved
        });
      } catch (saveErr) {
        res.status(500).json({ success: false, error: saveErr.message });
      }
    });
  });

  router.get('/attachments/:id', requireAuth, (req, res) => {
    try {
      const att = novaChat.getAttachmentForUser(req.user.id, req.params.id);
      if (!att || !att.path || !fs.existsSync(att.path)) {
        return res.status(404).json({ success: false, error: 'Attachment not found.' });
      }
      const safeName = String(att.name || 'attachment').replace(/["\r\n]/g, '_');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Content-Type', att.mime || 'application/octet-stream');
      const isInlineAllowed = /^(image\/|audio\/|text\/|application\/json)/.test(att.mime || '');
      const disposition = req.query.download === '1' || !isInlineAllowed ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
      res.sendFile(path.resolve(att.path));
    } catch (err) {
      res.status(404).json({ success: false, error: 'Attachment not found.' });
    }
  });

  // Command Palette Search (§11.2)
  router.get('/search', requireAuth, (req, res) => {
    try {
      const results = novaChat.searchNova(req.user.id, req.query.q || '');
      res.json({ success: true, ...results });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // User Settings (§11.2)
  router.get('/settings', requireAuth, (req, res) => {
    try {
      res.json({ success: true, settings: novaChat.getUserSettings(req.user.id) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/settings', requireAuth, (req, res) => {
    try {
      const settings = novaChat.updateUserSettings(req.user.id, req.body || {});
      res.json({ success: true, settings });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Usage & Daily Caps (§15.3)
  router.get('/usage', requireAuth, (req, res) => {
    try {
      const summary = novaUsage.getUsageSummary(req.query.day || undefined);
      res.json({ success: true, ...summary });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.get('/usage/limits', requireAdmin, (req, res) => {
    try {
      const summary = novaUsage.getUsageSummary();
      res.json({ success: true, limits: summary.limits });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/usage/limits', requireAdmin, (req, res) => {
    try {
      const { scope, ...updates } = req.body || {};
      const updated = novaUsage.updateUsageLimits(scope || 'global', updates);
      res.json({ success: true, limit: updated });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Interactive Cards, Widget Answers & Secure Forms (§5.1–§5.3, §11.2, §12)
  router.post('/cards', requireAuth, (req, res) => {
    try {
      const { conversationId, agentId = 'nova', type, spec, body = '' } = req.body || {};
      const created = novaWidgets.createCardMessage({
        userId: req.user.id,
        conversationId,
        agentId,
        type,
        spec,
        body
      });
      res.json({ success: true, ...created });
    } catch (err) {
      res.status(err.status || 400).json({ success: false, error: err.message });
    }
  });

  router.post('/widgets/:widgetId/answer', requireAuth, widgetAnswerRateLimiter, (req, res) => {
    try {
      const out = novaWidgets.answerWidget({
        user: req.user,
        widgetId: req.params.widgetId,
        body: req.body || {},
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(err.status || 400).json({ success: false, error: err.message });
    }
  });

  router.post('/secure-forms/:formId/submit', requireAuth, secureFormRateLimiter, (req, res) => {
    try {
      // Never log req.body on secure form submissions (§5.2, §12)
      const out = novaWidgets.submitSecureForm({
        user: req.user,
        formId: req.params.formId,
        values: req.body || {},
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.json({
        success: true,
        ...out,
        connectors: novaWidgets.getConnectorsStatus(req.user.id)
      });
    } catch (err) {
      res.status(err.status || 400).json({ success: false, error: err.message });
    }
  });

  router.get('/connectors', requireAuth, (req, res) => {
    try {
      res.json({
        success: true,
        connectors: novaWidgets.getConnectorsStatus(req.user.id)
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==========================================
  // VISIBLE, EDITABLE MEMORIES (§6.4, §7, §11.2, §15.4)
  // ==========================================
  router.get('/memories/export', requireAuth, (req, res) => {
    try {
      const payload = novaChat.exportMemories(req.user.id, {
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="nova-memories-${req.user.username}.json"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post(
    '/memories/forget-all',
    requireAuth,
    requireApprovalToken(() => ({
      actionType: 'memory.forget_all',
      args: {}
    })),
    (req, res) => {
      try {
        const out = novaChat.forgetAllMemories(req.user.id, {
          approvalId: req.approvalId || null,
          ip: req.clientIp || req.ip,
          userAgent: req.get('user-agent') || ''
        });
        res.json({ success: true, ...out });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    }
  );

  router.get('/memories', requireAuth, (req, res) => {
    try {
      const memories = novaChat.listMemories(req.user.id, {
        q: req.query.q || '',
        agent: req.query.agent || ''
      });
      res.json({ success: true, count: memories.length, memories });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/memories', requireAuth, (req, res) => {
    try {
      const memory = novaChat.createMemory(req.user.id, {
        ...(req.body || {}),
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.json({ success: true, memory });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/memories/:id', requireAuth, (req, res) => {
    try {
      const memory = novaChat.updateMemory(req.user.id, req.params.id, req.body || {}, {
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.json({ success: true, memory });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.delete('/memories/:id', requireAuth, (req, res) => {
    try {
      const out = novaChat.deleteMemory(req.user.id, req.params.id, {
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  // ==========================================
  // ROUTINES (§6.3, §11.2, §15.2)
  // ==========================================
  router.get('/routines', requireAuth, (req, res) => {
    try {
      const routines = novaRoutines.listRoutines(req.user.id, req.query.agentId || null);
      res.json({ success: true, routines });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/routines', requireAuth, (req, res) => {
    try {
      const routine = novaRoutines.createRoutine(
        req.user,
        req.body || {},
        req.clientIp || req.ip,
        req.get('user-agent') || ''
      );
      res.json({ success: true, routine });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/routines/:id', requireAuth, (req, res) => {
    try {
      const routine = novaRoutines.updateRoutine(
        req.user,
        req.params.id,
        req.body || {},
        req.clientIp || req.ip,
        req.get('user-agent') || ''
      );
      res.json({ success: true, routine });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.delete('/routines/:id', requireAuth, (req, res) => {
    try {
      const out = novaRoutines.deleteRoutine(
        req.user,
        req.params.id,
        req.clientIp || req.ip,
        req.get('user-agent') || ''
      );
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.post('/routines/:id/run', requireAuth, async (req, res) => {
    try {
      const out = await novaRoutines.runRoutineNow(req.params.id, {
        trigger: 'manual',
        userOverride: req.user
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(err.message === 'Forbidden' ? 403 : 400).json({ success: false, error: err.message });
    }
  });

  // ==========================================
  // ONE-TIME LOCALSTORAGE IMPORT (§11.2, §13 Phase 4)
  // ==========================================
  router.post('/import-local', requireAuth, (req, res) => {
    try {
      const out = novaChat.importLocalData(req.user.id, req.body || {}, {
        ip: req.clientIp || req.ip,
        userAgent: req.get('user-agent') || ''
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==========================================
  // NOVA COMPUTER LIVE SCREEN, EVENTS & RESET (§6.2, §11.2, §12)
  // ==========================================
  router.post('/computer/screen/token', requireAdmin, (req, res) => {
    try {
      const sessionId = (req.cookies && req.cookies.lly_session) || req.sessionId || null;
      const issued = novaScreen.issueStreamToken({ userId: req.user.id, sessionId });
      res.json({ success: true, ...issued });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.get('/computer/screen/stream', requireAdmin, (req, res) => {
    novaScreen.handleScreenStream(req, res, db);
  });

  router.get('/computer/screen/ws', requireAdmin, (req, res) => {
    novaScreen.handleScreenStream(req, res, db);
  });

  router.post('/computer/screen/offer', requireAdmin, (req, res) => {
    res.json({
      success: true,
      transport: 'sse-svg',
      streamUrl: '/api/nova/computer/screen/stream'
    });
  });

  router.post('/computer/screen/window', requireAdmin, (req, res) => {
    try {
      const win = novaScreen.openDesktopWindow(req.body || {});
      res.json({ success: true, window: win });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.get('/computer/events', requireAdmin, (req, res) => {
    novaScreen.handleComputerEventsStream(req, res, db);
  });

  router.post(
    '/computer/reset',
    requireAdmin,
    requireApprovalToken(() => ({
      actionType: 'nova_computer.reset',
      args: {}
    })),
    (req, res) => {
      try {
        const result = novaComputer.resetWorkspace();
        novaActions.logNovaAction({
          userId: req.user.id,
          persona: 'nova',
          action: 'nova_computer.reset',
          target: 'workspace',
          source: process.env.NODE_ENV === 'test' ? 'test' : 'user',
          approvalId: req.approvalId || null,
          ip: req.clientIp || req.ip,
          userAgent: req.get('user-agent') || '',
          result: result.success ? 'ok' : 'error',
          details: { message: result.message }
        });
        if (db.logAudit) {
          db.logAudit(
            req.user.id,
            req.user.username,
            'NOVA_COMPUTER_RESET',
            JSON.stringify({ approvalId: req.approvalId || null, workspace: 'reset' }),
            req.clientIp || req.ip,
            process.env.NODE_ENV === 'test' ? 'test' : 'human'
          );
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    }
  );

  return router;
}

module.exports = createNovaRouter;
