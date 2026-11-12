/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Approval Token Middleware (§15.1)
 * Enforces single-use, 5-minute, action-hash-bound human approval tokens before Nova
 * runs terminal commands, deletes/overwrites files, transfers Sparks/Flames, makes payments,
 * sends outbound emails/messages, or performs DB writes (including NOVA_CONSENTED_WRITE).
 */

const novaApprovals = require('../lib/nova_approvals');

/**
 * Factory for Express middleware that requires a valid single-use approval token.
 * @param {(req: import('express').Request) => { actionType: string, args?: object, target?: string|null, conversationId?: string|null, skipIfHumanAdminDirect?: boolean }} buildActionSpec
 */
function requireApprovalToken(buildActionSpec) {
  return (req, res, next) => {
    try {
      const spec = typeof buildActionSpec === 'function'
        ? buildActionSpec(req)
        : (buildActionSpec || {});

      const rawToken =
        req.headers['x-nova-approval-token'] ||
        req.headers['x-approval-token'] ||
        (req.body && req.body.approvalToken) ||
        (req.query && req.query.approvalToken) ||
        null;

      // If an endpoint allows direct admin typing (e.g., admin typing into Terminal tab directly
      // with X-Admin-Direct: 1 and no approval token), only skip when explicitly marked and no token was supplied.
      if (spec.skipIfHumanAdminDirect && !rawToken && req.headers['x-admin-direct'] === '1' && req.user && req.user.role === 'admin') {
        req.approvalId = null;
        req.actionSource = 'user';
        return next();
      }

      const userId = req.user ? req.user.id : null;
      const result = novaApprovals.verifyAndConsumeApprovalToken({
        token: rawToken,
        userId,
        actionType: spec.actionType,
        args: spec.args || {},
        target: spec.target || null,
        conversationId: spec.conversationId || (req.body && req.body.conversationId) || null
      });

      if (!result.ok) {
        return res.status(result.status || 403).json({
          success: false,
          code: result.code || 'APPROVAL_REJECTED',
          error: result.error || 'Approval token rejected.'
        });
      }

      req.approvalId = result.approvalId;
      req.approvalRecord = result.approval;
      req.actionSource = 'user';
      return next();
    } catch (err) {
      return res.status(403).json({
        success: false,
        code: 'APPROVAL_ERROR',
        error: err.message
      });
    }
  };
}

module.exports = requireApprovalToken;
