/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Async Job Runner (§11.4, §15.2)
 * Manages conversation turn jobs (ack -> progress -> result), token streaming over SSE,
 * per-conversation cancellation, and immediate Stop Nova kill-switch cancellation.
 */

const novaChat = require('./nova_chat');
const novaActions = require('./nova_actions');
const novaPush = require('./nova_push');

// Map<jobId, { jobId, userId, conversationId, agentId, abortController, assistantMessageId, state }>
const activeJobs = new Map();

function cancelAllJobs({ userId = null, reason = 'Cancelled' } = {}) {
  let cancelledCount = 0;
  for (const [jobId, job] of activeJobs.entries()) {
    if (userId && job.userId !== Number(userId)) continue;
    try {
      job.state = 'cancelled';
      job.abortController.abort(new Error(reason));
      if (job.assistantMessageId) {
        const updated = novaChat.updateMessage(job.assistantMessageId, {
          status: 'cancelled'
        });
        if (updated) {
          novaChat.emitToUser(job.userId, 'message.updated', {
            conversationId: job.conversationId,
            messageId: updated.id,
            status: 'cancelled',
            body: updated.body
          });
        }
      }
      novaChat.emitToUser(job.userId, 'job.status', {
        jobId,
        conversationId: job.conversationId,
        agentId: job.agentId,
        state: 'idle',
        cancelled: true
      });
      activeJobs.delete(jobId);
      cancelledCount++;
    } catch (e) {}
  }
  return cancelledCount;
}

if (novaActions && typeof novaActions.registerStopHandler === 'function') {
  novaActions.registerStopHandler('nova_jobs_stop', () => {
    cancelAllJobs({ reason: 'Nova stopped by kill switch' });
  });
}

function cancelConversationJob(userId, conversationId) {
  let cancelled = 0;
  for (const [jobId, job] of activeJobs.entries()) {
    if (job.userId === Number(userId) && job.conversationId === conversationId) {
      job.state = 'cancelled';
      try { job.abortController.abort(new Error('Cancelled by user')); } catch (e) {}
      if (job.assistantMessageId) {
        const updated = novaChat.updateMessage(job.assistantMessageId, { status: 'cancelled' });
        if (updated) {
          novaChat.emitToUser(userId, 'message.updated', {
            conversationId,
            messageId: updated.id,
            status: 'cancelled',
            body: updated.body
          });
        }
      }
      novaChat.emitToUser(userId, 'job.status', {
        jobId,
        conversationId,
        agentId: job.agentId,
        state: 'idle',
        cancelled: true
      });
      activeJobs.delete(jobId);
      cancelled++;
    }
  }
  return { cancelled };
}

/**
 * Enqueue a user message and launch the async assistant turn.
 * Immediately returns { userMessage, jobId }.
 */
function enqueueConversationTurn({
  user,
  conversationId,
  text,
  parentId = null,
  attachmentIds = []
}) {
  if (novaActions.isNovaPaused()) {
    const err = new Error('Nova is paused. Resume Nova before sending new tasks.');
    err.status = 423;
    throw err;
  }

  const conv = novaChat.getConversation(user.id, conversationId);
  if (!conv) {
    const err = new Error('Conversation not found.');
    err.status = 404;
    throw err;
  }

  const cleanText = String(text || '').trim();
  if (!cleanText && (!Array.isArray(attachmentIds) || attachmentIds.length === 0)) {
    const err = new Error('Message text or attachment is required.');
    err.status = 400;
    throw err;
  }

  const jobId = novaChat.generateUlid('job_');

  // Extract mid-chat memory if user said "remember that ..." (§7, §15.4)
  const savedMemory = novaChat.maybeExtractMemoryFromChat({
    userId: user.id,
    agentId: conv.agentId || 'nova',
    conversationId,
    userText: cleanText
  });

  const msgPayload = {};
  if (attachmentIds.length > 0) msgPayload.attachmentIds = attachmentIds;
  if (savedMemory) msgPayload.savedMemory = savedMemory;

  const userMessage = novaChat.insertMessage({
    conversationId,
    parentId: parentId || null,
    role: 'user',
    agentId: null,
    kind: 'text',
    body: cleanText,
    payload: Object.keys(msgPayload).length > 0 ? msgPayload : null,
    status: 'sent',
    jobId
  });

  // Mark user's own message as read
  novaChat.markConversationRead(user.id, conversationId, userMessage.id);

  novaChat.emitToUser(user.id, 'message.created', {
    conversationId,
    message: userMessage,
    savedMemory
  }, userMessage.id);

  // Determine target agent(s)
  let targetAgents = [conv.agentId || 'nova'];
  if (conv.type === 'room') {
    const mentionMatch = cleanText.match(/@(nova|astra|astaria)\b/i);
    if (mentionMatch) {
      targetAgents = [mentionMatch[1].toLowerCase()];
    } else if (Array.isArray(conv.members) && conv.members.length > 0) {
      targetAgents = conv.members.slice(0, 3);
    }
  }

  const abortController = new AbortController();
  const jobRecord = {
    jobId,
    userId: Number(user.id),
    conversationId,
    agentId: targetAgents[0],
    abortController,
    assistantMessageId: null,
    state: 'working'
  };
  activeJobs.set(jobId, jobRecord);

  novaChat.emitToUser(user.id, 'job.status', {
    jobId,
    conversationId,
    agentId: targetAgents[0],
    state: 'working'
  });

  // Run async turn without blocking HTTP response
  setImmediate(async () => {
    try {
      const isPureThanks = /^\s*(thanks|thank you|thx|ty|thanks so much|thank you so much)[!.\s]*$/i.test(cleanText) && (!attachmentIds || attachmentIds.length === 0);
      const hasThanks = /\b(thanks|thank you|thx|appreciate it)\b/i.test(cleanText);

      if (hasThanks && targetAgents[0]) {
        try {
          novaChat.addReaction(user.id, userMessage.id, '👍', 'agent', targetAgents[0]);
        } catch (e) {}
      }

      if (isPureThanks) {
        novaChat.emitToUser(user.id, 'job.status', {
          jobId,
          conversationId,
          agentId: targetAgents[0],
          state: 'idle'
        });
        return;
      }

      for (const agentId of targetAgents) {
        if (abortController.signal.aborted) break;
        jobRecord.agentId = agentId;

        // 1. Immediate acknowledgement (<1s) (§4.7, §11.4)
        const ackText = cleanText.length > 80
          ? 'On it — breaking down your request now.'
          : 'On it — checking context now.';
        const ackMsg = novaChat.insertMessage({
          conversationId,
          parentId: parentId || null,
          role: 'assistant',
          agentId,
          kind: 'text',
          body: ackText,
          payload: { isAck: true },
          status: 'sent',
          jobId
        });
        novaChat.emitToUser(user.id, 'message.created', {
          conversationId,
          message: ackMsg
        }, ackMsg.id);

        if (abortController.signal.aborted) break;

        // 2. Progress milestone messages (kind: "progress") (§4.7, §11.4)
        const progressStep1 = novaChat.insertMessage({
          conversationId,
          parentId: parentId || null,
          role: 'assistant',
          agentId,
          kind: 'progress',
          body: 'Loaded conversation context & persona state',
          payload: {
            tool: 'nova.context',
            ms: 14,
            detail: `Agent: ${agentId} · Conversation: ${conversationId}`
          },
          status: 'sent',
          jobId
        });
        novaChat.emitToUser(user.id, 'message.created', {
          conversationId,
          message: progressStep1
        }, progressStep1.id);

        if (cleanText.length > 25 || /table|mermaid|code|file|check|list|step|math|analyze|search|status/i.test(cleanText)) {
          const progressStep2 = novaChat.insertMessage({
            conversationId,
            parentId: parentId || null,
            role: 'assistant',
            agentId,
            kind: 'progress',
            body: 'Running reasoning & formatting pipeline',
            payload: {
              tool: 'nova.reason',
              ms: 32,
              detail: 'Evaluating structured blocks, markdown, and safety constraints'
            },
            status: 'sent',
            jobId
          });
          novaChat.emitToUser(user.id, 'message.created', {
            conversationId,
            message: progressStep2
          }, progressStep2.id);
        }

        if (abortController.signal.aborted) break;

        // 3. Final result message (kind: "result") (§4.7, §11.4)
        const assistantMsg = novaChat.insertMessage({
          conversationId,
          parentId: parentId || null,
          role: 'assistant',
          agentId,
          kind: 'result',
          body: '',
          status: 'streaming',
          jobId
        });
        jobRecord.assistantMessageId = assistantMsg.id;

        novaChat.emitToUser(user.id, 'message.created', {
          conversationId,
          message: assistantMsg
        }, assistantMsg.id);

        let streamedBody = '';
        const gen = await novaChat.streamAgentReply({
          user,
          agentId,
          conversationId,
          userText: cleanText,
          abortSignal: abortController.signal,
          onDelta: (delta) => {
            streamedBody += delta;
            novaChat.emitToUser(user.id, 'message.delta', {
              conversationId,
              messageId: assistantMsg.id,
              agentId,
              delta
            });
          }
        });

        let finalBody = gen.reply || streamedBody;
        // Nova plugins: pull out any ```nova-plugin``` requests from the reply.
        let pluginReply = null;
        try {
          const parsed = require('./nova_plugins').parseToolCalls(finalBody);
          if (parsed.calls.length) {
            pluginReply = finalBody;
            finalBody = parsed.cleaned || 'On it ✨';
          }
        } catch (e) {}
        const updatedMsg = novaChat.updateMessage(assistantMsg.id, {
          body: finalBody,
          kind: 'result',
          status: 'sent',
          payload: savedMemory ? { savedMemory: { id: savedMemory.id, text: savedMemory.text } } : undefined
        });

        novaChat.emitToUser(user.id, 'message.updated', {
          conversationId,
          messageId: assistantMsg.id,
          agentId,
          kind: 'result',
          status: 'sent',
          body: finalBody,
          message: updatedMsg
        }, assistantMsg.id);

        if (pluginReply) {
          try {
            await require('./nova_plugins').handleReplyToolCalls({ user, conversationId, agentId, reply: pluginReply });
          } catch (e) {
            console.warn('[Nova plugins] tool call failed:', e.message);
          }
        }

        // Emit 80% usage notice chip if triggered (§15.3)
        if (gen.usage && Array.isArray(gen.usage.alerts) && gen.usage.alerts.length > 0) {
          for (const alert of gen.usage.alerts) {
            const noticeMsg = novaChat.insertMessage({
              conversationId,
              role: 'system',
              agentId,
              kind: 'notice',
              body: alert.message,
              payload: { type: 'usage_alert', pctUsed: alert.pctUsed, scope: alert.scope },
              status: 'sent',
              jobId
            });
            novaChat.emitToUser(user.id, 'message.created', {
              conversationId,
              message: noticeMsg
            }, noticeMsg.id);
          }
        }
      }

      const refreshedConv = novaChat.getConversation(user.id, conversationId);
      if (refreshedConv) {
        novaChat.emitToUser(user.id, 'unread', {
          conversationId,
          count: refreshedConv.unreadCount
        });
      }

      novaChat.emitToUser(user.id, 'job.status', {
        jobId,
        conversationId,
        agentId: jobRecord.agentId,
        state: 'idle'
      });

      if (novaPush && typeof novaPush.notifyTaskFinished === 'function') {
        novaPush.notifyTaskFinished({
          userId: user.id,
          persona: jobRecord.agentId || 'nova',
          conversationId
        }).catch(() => {});
      }
    } catch (err) {
      if (jobRecord.state !== 'cancelled') {
        if (jobRecord.assistantMessageId) {
          const errText = err.message || 'Generation failed.';
          const updated = novaChat.updateMessage(jobRecord.assistantMessageId, {
            body: errText,
            kind: 'error',
            status: 'failed',
            payload: { code: err.code || 'GENERATION_ERROR' }
          });
          novaChat.emitToUser(user.id, 'message.updated', {
            conversationId,
            messageId: jobRecord.assistantMessageId,
            status: 'failed',
            kind: 'error',
            body: errText,
            message: updated
          });
        } else {
          const errMsg = novaChat.insertMessage({
            conversationId,
            parentId: parentId || null,
            role: 'system',
            agentId: jobRecord.agentId,
            kind: 'error',
            body: err.message || 'Generation failed.',
            payload: { code: err.code || 'GENERATION_ERROR' },
            status: 'failed',
            jobId
          });
          novaChat.emitToUser(user.id, 'message.created', {
            conversationId,
            message: errMsg
          }, errMsg.id);
        }
        novaChat.emitToUser(user.id, 'job.status', {
          jobId,
          conversationId,
          agentId: jobRecord.agentId,
          state: 'failed',
          error: err.message
        });
      }
    } finally {
      activeJobs.delete(jobId);
    }
  });

  return {
    messageId: userMessage.id,
    jobId,
    message: userMessage,
    savedMemory
  };
}

module.exports = {
  enqueueConversationTurn,
  cancelConversationJob,
  cancelAllJobs
};
