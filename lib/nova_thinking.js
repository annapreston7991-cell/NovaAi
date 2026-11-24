/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Split a model stream into a thinking pass and a user-facing answer.
 * Understands <think> / <thinking> tags (including tags split across chunks)
 * and OpenAI / Workers AI / Ollama reasoning fields. Raw tags are never
 * included in the returned text.
 */

'use strict';

const THINKING_PROMPT = [
  'When you reply, start with a brief, genuine thinking pass inside <think>...</think> tags:',
  'the plan or the points you are weighing.',
  'After </think>, write only the user-facing answer.',
  'Do not mention the tags or that you were asked to think this way.'
].join(' ');

const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;
const ANY_TAG_RE = /<\/?think(?:ing)?>/gi;
const BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;

function isPartialTagSuffix(suffix) {
  return /^<\/?(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i.test(suffix);
}

function heldPartialTag(buf) {
  const lt = buf.lastIndexOf('<');
  if (lt === -1) return '';
  const suffix = buf.slice(lt);
  if (suffix.includes('>')) return '';
  return isPartialTagSuffix(suffix) ? suffix : '';
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function extractReasoningFromPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  const delta = choice && choice.delta;
  const message = (choice && choice.message)
    || parsed.message
    || (parsed.result && parsed.result.message)
    || null;
  const result = parsed.result && typeof parsed.result === 'object' ? parsed.result : null;
  return firstString([
    delta && (delta.reasoning_content || delta.reasoning || delta.reasoning_text || delta.thinking),
    message && (message.reasoning_content || message.reasoning || message.reasoning_text || message.thinking),
    parsed.reasoning_content,
    parsed.reasoning,
    parsed.thinking,
    result && (result.reasoning_content || result.reasoning || result.thinking)
  ]);
}

function extractContentFromPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.response === 'string') return parsed.response;
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  if (choice && choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (parsed.message && typeof parsed.message.content === 'string') return parsed.message.content;
  const result = parsed.result;
  if (result && typeof result === 'object') {
    if (typeof result.response === 'string') return result.response;
    const rChoice = Array.isArray(result.choices) ? result.choices[0] : null;
    if (rChoice && rChoice.delta && typeof rChoice.delta.content === 'string') return rChoice.delta.content;
    if (rChoice && rChoice.message && typeof rChoice.message.content === 'string') return rChoice.message.content;
  }
  return '';
}

function mergeDeltas(target, more) {
  if (!more) return target;
  if (more.thinkingDelta) target.thinkingDelta += more.thinkingDelta;
  if (more.answerDelta) target.answerDelta += more.answerDelta;
  return target;
}

function createStreamParser() {
  let mode = 'unknown'; // unknown | thinking | answer
  let thinking = '';
  let answer = '';
  let buffer = '';

  function emit(kind, text, ev) {
    if (!text) return ev;
    if (kind === 'thinking') {
      thinking += text;
      ev.thinkingDelta += text;
      mode = 'thinking';
    } else {
      answer += text;
      ev.answerDelta += text;
      mode = 'answer';
    }
    return ev;
  }

  function consume(raw, ev) {
    let rest = raw;
    while (rest) {
      if (mode === 'thinking') {
        const close = rest.search(CLOSE_RE);
        if (close === -1) {
          const hold = heldPartialTag(rest);
          const ready = hold ? rest.slice(0, rest.length - hold.length) : rest;
          emit('thinking', ready, ev);
          buffer = hold;
          return ev;
        }
        emit('thinking', rest.slice(0, close), ev);
        rest = rest.slice(close).replace(CLOSE_RE, '');
        if (rest.startsWith('\n')) rest = rest.slice(1);
        mode = 'answer';
        continue;
      }

      const open = rest.search(OPEN_RE);
      if (open === -1) {
        const hold = heldPartialTag(rest);
        const ready = hold ? rest.slice(0, rest.length - hold.length) : rest;
        if (ready) emit('answer', ready, ev);
        buffer = hold;
        return ev;
      }
      if (open > 0) emit('answer', rest.slice(0, open), ev);
      rest = rest.slice(open).replace(OPEN_RE, '');
      mode = 'thinking';
    }
    buffer = '';
    return ev;
  }

  function pushText(chunk) {
    const ev = { thinkingDelta: '', answerDelta: '' };
    if (chunk == null || chunk === '') return ev;
    return consume(buffer + String(chunk), ev);
  }

  function pushReasoning(chunk) {
    const ev = { thinkingDelta: '', answerDelta: '' };
    if (chunk == null || chunk === '') return ev;
    // Reasoning fields are a separate channel. Following content is the
    // answer unless the parser is already inside a <think> tag.
    thinking += String(chunk);
    ev.thinkingDelta += String(chunk);
    if (mode === 'unknown') mode = 'answer';
    return ev;
  }

  function finish() {
    const ev = { thinkingDelta: '', answerDelta: '' };
    if (buffer) {
      const leftover = buffer.replace(ANY_TAG_RE, '');
      buffer = '';
      if (leftover) {
        if (mode === 'thinking') emit('thinking', leftover, ev);
        else emit('answer', leftover, ev);
      }
    }
    return {
      thinking: thinking.trim(),
      answer: answer.replace(/^\n/, ''),
      thinkingDelta: ev.thinkingDelta,
      answerDelta: ev.answerDelta,
      hadThinking: thinking.trim().length > 0
    };
  }

  function state() {
    return { mode, thinking, answer, pending: buffer };
  }

  return { pushText, pushReasoning, finish, state };
}

function createReplyAssembler() {
  const parser = createStreamParser();
  return {
    pushText(text) { return parser.pushText(text); },
    pushReasoning(text) { return parser.pushReasoning(text); },
    applyChunk(parsed) {
      const ev = { thinkingDelta: '', answerDelta: '' };
      const reasoning = extractReasoningFromPayload(parsed);
      const content = extractContentFromPayload(parsed);
      if (reasoning) mergeDeltas(ev, parser.pushReasoning(reasoning));
      if (content) mergeDeltas(ev, parser.pushText(content));
      return ev;
    },
    finish() { return parser.finish(); },
    state() { return parser.state(); }
  };
}

function splitThinking(text, { reasoning = '' } = {}) {
  const parser = createStreamParser();
  if (reasoning) parser.pushReasoning(reasoning);
  if (text) parser.pushText(text);
  return parser.finish();
}

function stripThinkTags(text) {
  return String(text || '')
    .replace(BLOCK_RE, '')
    .replace(ANY_TAG_RE, '')
    .trim();
}

function isAckPayload(payload) {
  if (!payload) return false;
  try {
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return !!(value && value.isAck);
  } catch (e) {
    return false;
  }
}

function formatThoughtLabel(ms) {
  const sec = Math.max(1, Math.round(Number(ms || 0) / 1000));
  return `Thought for ${sec}s`;
}

function writeThinkingSse(res, ev) {
  if (!res || !ev) return;
  if (ev.thinkingDelta) res.write(`data: ${JSON.stringify({ thinking: ev.thinkingDelta })}\n\n`);
  if (ev.answerDelta) res.write(`data: ${JSON.stringify({ message: { role: 'assistant', content: ev.answerDelta } })}\n\n`);
}

module.exports = {
  THINKING_PROMPT,
  createStreamParser,
  createReplyAssembler,
  splitThinking,
  stripThinkTags,
  extractReasoningFromPayload,
  extractContentFromPayload,
  isAckPayload,
  formatThoughtLabel,
  writeThinkingSse
};
