/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova plugins API, mounted at /api/nova/plugins (before the main Nova router).
 * Members only see and use plugins that are set up in .env. Tokens never leave
 * the server. Write actions only run through the in-chat confirmation card.
 */
const express = require('express');
const novaPlugins = require('./nova_plugins');

// Cross-site forms cannot send JSON without a CORS preflight, so this blocks CSRF on state changes.
function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({ success: false, error: 'Send JSON.' });
  }
  next();
}

function sendError(res, err) {
  res.status(err.status || 400).json({ success: false, error: err.message, code: err.code || undefined });
}

module.exports = function createNovaPluginsRouter({ requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    try {
      res.json({ success: true, plugins: novaPlugins.listForUser(req.user) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Start connecting the member's own account (browser navigation).
  router.get('/:pluginId/connect', requireAuth, (req, res) => {
    try {
      const url = novaPlugins.beginConnect(req.user, req.params.pluginId, { shop: req.query.shop });
      res.redirect(302, url);
    } catch (err) {
      res.redirect(302, `/novaai/plugins?error=${encodeURIComponent(err.message)}`);
    }
  });

  router.get('/oauth/callback/:pluginId', requireAuth, async (req, res) => {
    try {
      await novaPlugins.completeConnect(req.user, req.params.pluginId, req.query || {});
      res.redirect(302, `/novaai/plugins?connected=${encodeURIComponent(req.params.pluginId)}`);
    } catch (err) {
      res.redirect(302, `/novaai/plugins?error=${encodeURIComponent(err.message)}`);
    }
  });

  router.post('/:pluginId/disconnect', requireAuth, requireJson, async (req, res) => {
    try {
      res.json({ success: true, ...(await novaPlugins.disconnect(req.user, req.params.pluginId)) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Run a read action now, or (for a write action) put a confirmation card in a chat.
  router.post('/:pluginId/actions/:actionId', requireAuth, requireJson, async (req, res) => {
    const { params = {}, conversationId = null } = req.body || {};
    try {
      const plugin = novaPlugins.getPlugin(req.params.pluginId);
      const action = plugin && plugin.actions.find(a => a.id === req.params.actionId);
      if (action && action.kind === 'write') {
        if (!conversationId) {
          return res.status(403).json({ success: false, code: 'CONFIRMATION_REQUIRED', error: 'This action changes something, so it has to be confirmed in a Nova chat.' });
        }
        const card = novaPlugins.requestWriteConfirmation({
          user: req.user,
          conversationId: String(conversationId),
          pluginId: req.params.pluginId,
          actionId: req.params.actionId,
          params
        });
        return res.status(202).json({ success: true, status: 'awaiting_confirmation', widgetId: card.widgetId });
      }
      const result = await novaPlugins.runRead(req.user, req.params.pluginId, req.params.actionId, params);
      res.json({ success: true, result });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
};
