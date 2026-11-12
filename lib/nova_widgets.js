/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Interactive Cards & Secure Forms Service (§5.1–§5.3, §12, §13 Phase 3, §15.1)
 * Validates Question, Approval, and Secure Form specs with Ajv, enforces single-use
 * and expiry rules, strips server-side `action` from client payloads, executes only
 * stored server actions on approval, and routes secure-form secrets directly into
 * AES-256-GCM `nova_secrets` without ever logging or storing secret values in chat.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const db = require('./host').db;
const novaChat = require('./nova_chat');
const novaSecrets = require('./nova_secrets');
const novaApprovals = require('./nova_approvals');
const novaActions = require('./nova_actions');
const novaComputer = require('./nova_computer');

const rawDb = db.getRawDb();
const ajv = new Ajv({ allErrors: true });

const questionSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../schemas/nova/question.json'), 'utf8')
);
const approvalSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../schemas/nova/approval.json'), 'utf8')
);
const secureFormSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../schemas/nova/secure_form.json'), 'utf8')
);

const validateQuestion = ajv.compile(questionSchema);
const validateApproval = ajv.compile(approvalSchema);
const validateSecureForm = ajv.compile(secureFormSchema);

/**
 * Validate a card spec against its JSON Schema + §5 semantic rules.
 */
function validateCardSpec(type, spec) {
  if (!spec || typeof spec !== 'object') {
    return { valid: false, reason: 'Card spec must be an object.' };
  }
  if (type === 'question') {
    const ok = validateQuestion(spec);
    if (!ok) {
      return { valid: false, reason: ajv.errorsText(validateQuestion.errors) };
    }
    const primaryCount = (spec.options || []).filter(o => o.style === 'primary').length;
    if (primaryCount > 1) {
      return { valid: false, reason: 'Question card may have at most one primary option (§5.1).' };
    }
    return { valid: true };
  }
  if (type === 'approval') {
    const ok = validateApproval(spec);
    if (!ok) {
      return { valid: false, reason: ajv.errorsText(validateApproval.errors) };
    }
    return { valid: true };
  }
  if (type === 'secure_form') {
    const ok = validateSecureForm(spec);
    if (!ok) {
      return { valid: false, reason: ajv.errorsText(validateSecureForm.errors) };
    }
    return { valid: true };
  }
  return { valid: false, reason: `Unknown card type: ${type}` };
}

/**
 * Strip server-only fields (`action`) from an approval spec before sending to client (§5.3).
 */
function sanitizeSpecForClient(type, spec, widgetRow = null) {
  const clone = JSON.parse(JSON.stringify(spec || {}));
  if (type === 'approval') {
    if (clone.action && clone.action.type) {
      clone.actionType = clone.action.type;
    }
    delete clone.action;
  }
  if (widgetRow) {
    clone.answered = Boolean(widgetRow.answered_at);
    clone.answeredAt = widgetRow.answered_at || null;
    if (widgetRow.answer) {
      try { clone.answer = JSON.parse(widgetRow.answer); } catch (e) {}
    }
    if (widgetRow.expires_at) {
      clone.expiresAt = widgetRow.expires_at;
      clone.expired = !widgetRow.answered_at && new Date(widgetRow.expires_at).getTime() <= Date.now();
    }
  }
  return clone;
}

/**
 * Create a Question, Approval, or Secure Form card message in a conversation.
 */
function createCardMessage({
  userId,
  conversationId,
  agentId = 'nova',
  type,
  spec,
  body = ''
}) {
  const conv = novaChat.getConversation(userId, conversationId);
  if (!conv) {
    const err = new Error('Conversation not found.');
    err.status = 404;
    throw err;
  }

  const normalizedSpec = { ...spec };
  if (type === 'question') {
    normalizedSpec.widgetId = normalizedSpec.widgetId || novaChat.generateUlid('wq_');
    normalizedSpec.multiSelect = Boolean(normalizedSpec.multiSelect);
    normalizedSpec.allowCustom = Boolean(normalizedSpec.allowCustom);
    normalizedSpec.expiresAt = normalizedSpec.expiresAt || null;
  } else if (type === 'approval') {
    normalizedSpec.widgetId = normalizedSpec.widgetId || novaChat.generateUlid('wa_');
    normalizedSpec.confirm = normalizedSpec.confirm || {
      label: 'Confirm',
      style: 'danger',
      doubleConfirm: true
    };
    if (normalizedSpec.confirm.style === undefined) normalizedSpec.confirm.style = 'danger';
    if (normalizedSpec.confirm.doubleConfirm === undefined) normalizedSpec.confirm.doubleConfirm = true;
    normalizedSpec.cancel = normalizedSpec.cancel || { label: 'Cancel' };
    normalizedSpec.expiresAt = normalizedSpec.expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString();
  } else if (type === 'secure_form') {
    normalizedSpec.formId = normalizedSpec.formId || novaChat.generateUlid('sf_');
    normalizedSpec.submitLabel = normalizedSpec.submitLabel || 'Connect';
    normalizedSpec.expiresAt = normalizedSpec.expiresAt || new Date(Date.now() + 10 * 60 * 1000).toISOString();
  }

  const validation = validateCardSpec(type, normalizedSpec);
  if (!validation.valid) {
    const err = new Error(`Invalid ${type} card spec: ${validation.reason}`);
    err.status = 422;
    throw err;
  }

  const widgetId = type === 'secure_form' ? normalizedSpec.formId : normalizedSpec.widgetId;
  const clientPayload = sanitizeSpecForClient(type, normalizedSpec);

  const message = novaChat.insertMessage({
    conversationId,
    role: 'assistant',
    agentId,
    kind: type,
    body: body || normalizedSpec.prompt || normalizedSpec.title || '',
    payload: clientPayload,
    status: 'sent'
  });

  rawDb.prepare(`
    INSERT INTO nova_widgets (id, message_id, user_id, type, spec, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    widgetId,
    message.id,
    Number(userId),
    type,
    JSON.stringify(normalizedSpec),
    normalizedSpec.expiresAt || null
  );

  novaChat.emitToUser(userId, 'message.created', {
    conversationId,
    message
  }, message.id);

  if (type === 'approval') {
    try {
      const novaPush = require('./nova_push');
      novaPush.notifyApprovalNeeded({
        userId,
        persona: agentId || 'nova',
        conversationId,
        widgetId
      }).catch(() => {});
    } catch (e) {}
  }

  return {
    widgetId,
    message
  };
}

/**
 * Execute a server-stored approval action (§5.3, §15.1).
 * Never uses any client-supplied action object.
 */
function executeStoredApprovalAction({ user, storedAction, approvalTokenRecord, ip, userAgent }) {
  const actionType = storedAction.type;
  const args = storedAction.args || {};
  let result = { executed: true, actionType };

  if (actionType === 'nova_computer.delete') {
    const paths = Array.isArray(args.paths) ? args.paths : (args.path ? [args.path] : []);
    const deleted = [];
    for (const relPath of paths) {
      const safeTarget = novaComputer.resolveSafePath(relPath);
      if (fs.existsSync(safeTarget)) {
        const stat = fs.lstatSync(safeTarget);
        if (stat.isDirectory()) {
          fs.rmSync(safeTarget, { recursive: true, force: true });
        } else {
          fs.unlinkSync(safeTarget);
        }
        deleted.push(relPath);
      }
    }
    result.deleted = deleted;
  } else if (actionType === 'nova_computer.write') {
    const safeTarget = novaComputer.resolveSafePath(args.path || 'output.txt');
    fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
    fs.writeFileSync(safeTarget, String(args.content || ''), 'utf8');
    result.written = args.path;
  } else if (actionType === 'nova_computer.exec') {
    result.command = args.command;
    result.approvedToken = approvalTokenRecord.token;
  } else if (actionType === 'nova_computer.reset') {
    result.reset = true;
  } else if (actionType === 'nova.resume') {
    novaActions.resumeNova({
      user,
      approvalId: approvalTokenRecord.approvalId,
      ip,
      userAgent
    });
    result.resumed = true;
  } else if (actionType === 'nova.forget_all_memories') {
    const info = rawDb.prepare(`DELETE FROM user_memories WHERE user_id = ?`).run(Number(user.id));
    result.deletedMemories = info.changes;
  } else if (actionType === 'plugin.run') {
    // Nova plugin write action (send/post/create). runWrite() verifies and consumes
    // the single-use token bound to these exact args before any network call.
    result = {
      ...result,
      ...require('./nova_plugins').executeApproved({ user, args, approvalToken: approvalTokenRecord.token })
    };
  } else if (actionType === 'nova.delete_agent') {
    if (args.agentId) {
      novaChat.deleteAgent(user, args.agentId, ip);
      result.deletedAgentId = args.agentId;
    }
  } else {
    // pantheon.consent_write, economy.transfer_sparks, economy.transfer_flames, economy.payment_xmr, mail.send, db.write
    result.approvedToken = approvalTokenRecord.token;
    result.approvalId = approvalTokenRecord.approvalId;
  }

  novaActions.logNovaAction({
    userId: user.id,
    persona: 'nova',
    action: actionType,
    target: JSON.stringify(args).slice(0, 200),
    source: 'user',
    approvalId: approvalTokenRecord.approvalId,
    ip,
    userAgent,
    result: 'ok',
    details: { widgetApproved: true, actionType }
  });

  try {
    if (typeof db.logAudit === 'function') {
      db.logAudit(
        user.id,
        'NOVA_CARD_APPROVAL',
        JSON.stringify({
          actor_type: 'human',
          approvalId: approvalTokenRecord.approvalId,
          actionType,
          args: novaSecrets.redact(args)
        }),
        ip || ''
      );
    }
  } catch (e) {}

  return result;
}

/**
 * Answer a Question or Approval card (`POST /api/nova/widgets/:widgetId/answer`).
 */
function answerWidget({ user, widgetId, body = {}, ip = null, userAgent = null }) {
  const row = rawDb.prepare(`SELECT * FROM nova_widgets WHERE id = ?`).get(String(widgetId || ''));
  if (!row || row.user_id !== Number(user.id) || row.type === 'secure_form') {
    const err = new Error('Widget not found.');
    err.status = 404;
    throw err;
  }

  if (row.answered_at) {
    const err = new Error('This card has already been answered.');
    err.status = 409;
    throw err;
  }

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    const err = new Error('This card has expired.');
    err.status = 410;
    throw err;
  }

  const spec = JSON.parse(row.spec);
  const msgRow = rawDb.prepare(`SELECT * FROM nova_messages WHERE id = ?`).get(row.message_id);
  const conversationId = msgRow ? msgRow.conversation_id : null;

  if (row.type === 'question') {
    const selected = Array.isArray(body.selected) ? body.selected.map(String) : [];
    const custom = body.custom !== undefined && body.custom !== null ? String(body.custom).trim() : null;
    const validIds = new Set((spec.options || []).map(o => o.id));

    for (const selId of selected) {
      if (!validIds.has(selId)) {
        const err = new Error(`Invalid option id: ${selId}`);
        err.status = 422;
        throw err;
      }
    }

    if (!spec.multiSelect && selected.length > 1) {
      const err = new Error('Multiple options are not allowed for this question.');
      err.status = 422;
      throw err;
    }

    if (custom && !spec.allowCustom) {
      const err = new Error('Custom answer is not enabled for this question.');
      err.status = 422;
      throw err;
    }

    if (selected.length === 0 && !custom) {
      const err = new Error('Please select an option or provide a custom answer.');
      err.status = 422;
      throw err;
    }

    const labels = selected.map(id => {
      const opt = (spec.options || []).find(o => o.id === id);
      return opt ? opt.label : id;
    });
    if (custom) labels.push(custom);

    const answerObj = { widgetId: row.id, selected, custom, labels };
    rawDb.prepare(`
      UPDATE nova_widgets
      SET answer = ?, answered_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(answerObj), row.id);

    // Update original card message payload to mark answered
    if (msgRow) {
      const updatedWidgetRow = rawDb.prepare(`SELECT * FROM nova_widgets WHERE id = ?`).get(row.id);
      const clientPayload = sanitizeSpecForClient('question', spec, updatedWidgetRow);
      const updatedCardMsg = novaChat.updateMessage(msgRow.id, { payload: clientPayload });
      novaChat.emitToUser(user.id, 'message.updated', {
        conversationId,
        messageId: msgRow.id,
        payload: clientPayload,
        message: updatedCardMsg
      });
    }

    // Append user answer message (§5.1)
    let answerMessage = null;
    if (conversationId) {
      answerMessage = novaChat.insertMessage({
        conversationId,
        role: 'user',
        agentId: null,
        kind: 'answer',
        body: labels.join(', '),
        payload: answerObj,
        status: 'sent'
      });
      novaChat.emitToUser(user.id, 'message.created', {
        conversationId,
        message: answerMessage
      }, answerMessage.id);
    }

    novaChat.emitToUser(user.id, 'widget.answered', {
      widgetId: row.id,
      conversationId,
      selected,
      custom,
      labels
    });

    return {
      widgetId: row.id,
      answer: answerObj,
      message: answerMessage
    };
  }

  if (row.type === 'approval') {
    // Note: Any client-supplied body.action is strictly ignored (§5.3)
    const selected = Array.isArray(body.selected) ? body.selected.map(String) : [];
    const decision = selected[0] || (body.decision ? String(body.decision) : '');
    if (decision !== 'confirm' && decision !== 'cancel') {
      const err = new Error('Approval decision must be "confirm" or "cancel".');
      err.status = 422;
      throw err;
    }

    let executionResult = null;
    let approvalToken = null;
    let approvalId = null;

    if (decision === 'confirm') {
      // Mint single-use human approval token bound to the STORED spec.action (§15.1)
      const minted = novaApprovals.issueApprovalToken({
        userId: user.id,
        widgetId: row.id,
        actionType: spec.action.type,
        args: spec.action.args || {},
        ip,
        userAgent
      });
      approvalToken = minted.token;
      approvalId = minted.approvalId;

      // Consume token for direct server-side execution unless caller needs the token for a follow-up endpoint
      if (['nova_computer.delete', 'nova_computer.write', 'nova_computer.reset', 'nova.resume', 'nova.forget_all_memories', 'nova.delete_agent'].includes(spec.action.type)) {
        novaApprovals.verifyAndConsumeApprovalToken({
          token: approvalToken,
          userId: user.id,
          actionType: spec.action.type,
          args: spec.action.args || {}
        });
      }

      executionResult = executeStoredApprovalAction({
        user,
        storedAction: spec.action,
        approvalTokenRecord: minted,
        ip,
        userAgent
      });
    } else {
      novaActions.logNovaAction({
        userId: user.id,
        persona: 'nova',
        action: spec.action.type,
        target: 'cancelled_by_user',
        source: 'user',
        ip,
        userAgent,
        result: 'blocked',
        details: { widgetId: row.id, decision: 'cancel' }
      });
    }

    const label = decision === 'confirm'
      ? (spec.confirm && spec.confirm.label ? spec.confirm.label : 'Approved')
      : (spec.cancel && spec.cancel.label ? spec.cancel.label : 'Cancelled');

    const answerObj = {
      widgetId: row.id,
      selected: [decision],
      decision,
      label,
      approvalId
    };

    rawDb.prepare(`
      UPDATE nova_widgets
      SET answer = ?, answered_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(answerObj), row.id);

    if (msgRow) {
      const updatedWidgetRow = rawDb.prepare(`SELECT * FROM nova_widgets WHERE id = ?`).get(row.id);
      const clientPayload = sanitizeSpecForClient('approval', spec, updatedWidgetRow);
      const updatedCardMsg = novaChat.updateMessage(msgRow.id, { payload: clientPayload });
      novaChat.emitToUser(user.id, 'message.updated', {
        conversationId,
        messageId: msgRow.id,
        payload: clientPayload,
        message: updatedCardMsg
      });
    }

    let answerMessage = null;
    if (conversationId) {
      answerMessage = novaChat.insertMessage({
        conversationId,
        role: 'user',
        agentId: null,
        kind: 'answer',
        body: `${decision === 'confirm' ? 'Approved' : 'Cancelled'}: ${spec.title}`,
        payload: answerObj,
        status: 'sent'
      });
      novaChat.emitToUser(user.id, 'message.created', {
        conversationId,
        message: answerMessage
      }, answerMessage.id);
    }

    novaChat.emitToUser(user.id, 'widget.answered', {
      widgetId: row.id,
      conversationId,
      selected: [decision],
      decision,
      label
    });

    return {
      widgetId: row.id,
      decision,
      approvalId,
      // Plugin write tokens are consumed server-side right away; never hand them out.
      approvalToken: spec.action && spec.action.type === 'plugin.run' ? null : approvalToken,
      executionResult,
      answer: answerObj
    };
  }
}

/**
 * Submit a Secure Form (`POST /api/nova/secure-forms/:formId/submit`) (§5.2, §12).
 * NEVER logs or persists secret values in messages, audit logs, or model context.
 */
function submitSecureForm({ user, formId, values = {}, ip = null, userAgent = null }) {
  const row = rawDb.prepare(`SELECT * FROM nova_widgets WHERE id = ? AND type = 'secure_form'`).get(String(formId || ''));
  if (!row || row.user_id !== Number(user.id)) {
    const err = new Error('Secure form not found.');
    err.status = 404;
    throw err;
  }

  if (row.answered_at) {
    const err = new Error('This secure form has already been submitted.');
    err.status = 409;
    throw err;
  }

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    const err = new Error('This secure form has expired.');
    err.status = 410;
    throw err;
  }

  const spec = JSON.parse(row.spec);
  const msgRow = rawDb.prepare(`SELECT * FROM nova_messages WHERE id = ?`).get(row.message_id);
  const conversationId = msgRow ? msgRow.conversation_id : null;

  if (values && values._cancel) {
    const cancelResult = { formId: row.id, status: 'cancelled', fields: [] };
    rawDb.prepare(`UPDATE nova_widgets SET answer = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      JSON.stringify(cancelResult),
      row.id
    );
    return cancelResult;
  }

  // Validate required fields without ever echoing values in error messages
  const allowedFieldNames = new Set((spec.fields || []).map(f => f.name));
  const cleanValues = {};
  const submittedFieldNames = [];

  for (const field of spec.fields || []) {
    const rawVal = values && values[field.name] !== undefined ? String(values[field.name]).trim() : '';
    if (field.required && !rawVal) {
      const err = new Error(`Missing required field: ${field.label || field.name}`);
      err.status = 422;
      throw err;
    }
    if (rawVal && allowedFieldNames.has(field.name)) {
      cleanValues[field.name] = rawVal;
      submittedFieldNames.push(field.name);
    }
  }

  // Route directly to allow-listed target handler and encrypt at rest in nova_secrets (§5.2, §12)
  const target = spec.target || {};
  let secretKeyName = '';
  let connectorServer = null;

  if (target.type === 'mcp_credentials') {
    connectorServer = String(target.server || 'custom').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    secretKeyName = `mcp_credentials:${connectorServer}`;
    novaSecrets.saveSecret({
      userId: user.id,
      target: secretKeyName,
      payload: {
        ...cleanValues,
        connected: true,
        updatedBy: user.id,
        updatedAt: new Date().toISOString()
      }
    });
  } else if (target.type === 'voice:elevenlabs') {
    secretKeyName = 'voice:elevenlabs';
    novaSecrets.saveSecret({
      userId: user.id,
      target: secretKeyName,
      payload: {
        apiKey: cleanValues.apiKey || cleanValues.token || cleanValues.key || Object.values(cleanValues)[0] || '',
        voiceId: cleanValues.voiceId || null,
        updatedAt: new Date().toISOString()
      }
    });
  } else if (target.type === 'secret') {
    const customKey = String(target.key || row.id).replace(/[^a-zA-Z0-9_:-]/g, '');
    secretKeyName = `secret:${customKey}`;
    novaSecrets.saveSecret({
      userId: user.id,
      target: secretKeyName,
      payload: cleanValues
    });
  } else {
    const err = new Error('Disallowed secure form target.');
    err.status = 422;
    throw err;
  }

  // Only metadata (never field values!) is stored in nova_widgets or nova_messages
  const resultPayload = {
    formId: row.id,
    status: 'submitted',
    fields: submittedFieldNames,
    target: {
      type: target.type,
      server: connectorServer,
      label: target.label
    }
  };

  rawDb.prepare(`
    UPDATE nova_widgets
    SET answer = ?, answered_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(resultPayload), row.id);

  if (msgRow) {
    const updatedWidgetRow = rawDb.prepare(`SELECT * FROM nova_widgets WHERE id = ?`).get(row.id);
    const clientPayload = sanitizeSpecForClient('secure_form', spec, updatedWidgetRow);
    const updatedCardMsg = novaChat.updateMessage(msgRow.id, { payload: clientPayload });
    novaChat.emitToUser(user.id, 'message.updated', {
      conversationId,
      messageId: msgRow.id,
      payload: clientPayload,
      message: updatedCardMsg
    });
  }

  let resultMessage = null;
  if (conversationId) {
    resultMessage = novaChat.insertMessage({
      conversationId,
      role: 'system',
      agentId: 'nova',
      kind: 'secure_form_result',
      body: `User submitted the ${target.label || 'credentials'} form (success)`,
      payload: resultPayload,
      status: 'sent'
    });
    novaChat.emitToUser(user.id, 'message.created', {
      conversationId,
      message: resultMessage
    }, resultMessage.id);
  }

  novaActions.logNovaAction({
    userId: user.id,
    persona: 'nova',
    action: `secure_form.${target.type}`,
    target: target.label || secretKeyName,
    source: 'user',
    ip,
    userAgent,
    result: 'ok',
    details: { formId: row.id, fields: submittedFieldNames }
  });

  try {
    if (typeof db.logAudit === 'function') {
      db.logAudit(
        user.id,
        'NOVA_SECURE_FORM_SUBMIT',
        JSON.stringify({
          actor_type: 'human',
          formId: row.id,
          target: target.label || target.type,
          fields: submittedFieldNames
        }),
        ip || ''
      );
    }
  } catch (e) {}

  novaChat.emitToUser(user.id, 'widget.answered', {
    widgetId: row.id,
    formId: row.id,
    conversationId,
    status: 'submitted',
    fields: submittedFieldNames,
    connectorServer
  });

  return resultPayload;
}

/**
 * Helper to check connector status from encrypted nova_secrets (§5.2, §6.5).
 */
function getConnectorsStatus(userId) {
  const servers = ['gmail', 'drive', 'notion', 'calendar'];
  const connectors = {};
  for (const srv of servers) {
    const sec = novaSecrets.getSecret({ userId, target: `mcp_credentials:${srv}` }) ||
                novaSecrets.getSecret({ userId: 3, target: `mcp_credentials:${srv}` });
    connectors[srv] = {
      server: srv,
      connected: Boolean(sec && (sec.connected || Object.keys(sec).length > 0)),
      updatedAt: (sec && sec.updatedAt) || null
    };
  }
  const eleven = novaSecrets.getSecret({ userId, target: 'voice:elevenlabs' }) ||
                 novaSecrets.getSecret({ userId: 3, target: 'voice:elevenlabs' });
  connectors.elevenlabs = {
    server: 'elevenlabs',
    connected: Boolean(eleven && eleven.apiKey),
    updatedAt: (eleven && eleven.updatedAt) || null
  };
  return connectors;
}

module.exports = {
  validateCardSpec,
  sanitizeSpecForClient,
  createCardMessage,
  answerWidget,
  submitSecureForm,
  getConnectorsStatus
};
