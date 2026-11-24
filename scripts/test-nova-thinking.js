#!/usr/bin/env node
'use strict';

/**
 * Nova thinking parser: <think> tags split across stream chunks, replies
 * with no tags, and reasoning / reasoning_content fields from OpenAI-style
 * or Workers AI payloads. Raw tags must never appear in the split output.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const thinking = require('../lib/nova_thinking');

function feedChunks(chunks, extras = {}) {
  const parser = thinking.createStreamParser();
  if (extras.reasoning) parser.pushReasoning(extras.reasoning);
  for (const chunk of chunks) parser.pushText(chunk);
  return parser.finish();
}

function refuteTags(text, label) {
  assert.ok(!/<\/?think(?:ing)?>/i.test(text || ''), `${label} must not contain raw think tags: ${JSON.stringify(text)}`);
}

console.log('====================================================');
console.log('Nova thinking parser');
console.log('====================================================\n');

// Tags split across stream chunks
{
  const out = feedChunks(['<th', 'ink>Weigh the', ' request.</th', 'ink>\nHello there.']);
  assert.strictEqual(out.thinking, 'Weigh the request.');
  assert.strictEqual(out.answer, 'Hello there.');
  refuteTags(out.thinking, 'split thinking');
  refuteTags(out.answer, 'split answer');
  console.log('  ✔ tags split across stream chunks');
}

{
  const out = feedChunks(['OK, ', 'let me ', '<think>', 'plan', '</thinking>', 'Done.']);
  assert.strictEqual(out.thinking, 'plan');
  assert.strictEqual(out.answer, 'OK, let me Done.');
  refuteTags(out.thinking, 'mixed thinking');
  refuteTags(out.answer, 'mixed answer');
  console.log('  ✔ opening text stays in the answer; <thinking> is accepted');
}

{
  const out = feedChunks(['<THINK>', 'Quiet plan\n', '</THINK>\n\nVisible reply']);
  assert.strictEqual(out.thinking, 'Quiet plan');
  assert.strictEqual(out.answer, 'Visible reply');
  console.log('  ✔ tags are case-insensitive and the answer is trimmed after the close tag');
}

// No tags
{
  const out = feedChunks(['Just a normal ', 'reply with no plan tags.']);
  assert.strictEqual(out.thinking, '');
  assert.strictEqual(out.answer, 'Just a normal reply with no plan tags.');
  assert.strictEqual(out.hadThinking, false);
  console.log('  ✔ no tags: the full text is the answer');
}

{
  const out = thinking.splitThinking('Hello from Nova.');
  assert.strictEqual(out.thinking, '');
  assert.strictEqual(out.answer, 'Hello from Nova.');
  console.log('  ✔ splitThinking with no tags');
}

// Reasoning / reasoning_content fields
{
  const out = feedChunks(['The final answer.'], { reasoning: 'First I will outline the steps.' });
  assert.strictEqual(out.thinking, 'First I will outline the steps.');
  assert.strictEqual(out.answer, 'The final answer.');
  console.log('  ✔ reasoning field is treated as thinking, content as the answer');
}

{
  const assembler = thinking.createReplyAssembler();
  assembler.applyChunk({
    choices: [{ delta: { reasoning_content: 'Checking the date. ' } }]
  });
  assembler.applyChunk({
    choices: [{ delta: { reasoning: 'Then I answer. ' } }]
  });
  assembler.applyChunk({
    choices: [{ delta: { content: 'It is Tuesday.' } }]
  });
  const out = assembler.finish();
  assert.strictEqual(out.thinking, 'Checking the date. Then I answer.');
  assert.strictEqual(out.answer, 'It is Tuesday.');
  console.log('  ✔ OpenAI-style reasoning_content / reasoning / content deltas');
}

{
  const assembler = thinking.createReplyAssembler();
  assembler.applyChunk({
    result: { reasoning: 'Workers plan.', response: 'Workers answer.' }
  });
  const out = assembler.finish();
  assert.strictEqual(out.thinking, 'Workers plan.');
  assert.strictEqual(out.answer, 'Workers answer.');
  console.log('  ✔ Workers AI result.reasoning + result.response');
}

{
  const assembler = thinking.createReplyAssembler();
  assembler.applyChunk({
    message: { thinking: 'Ollama plan.', content: 'Ollama answer.' }
  });
  const out = assembler.finish();
  assert.strictEqual(out.thinking, 'Ollama plan.');
  assert.strictEqual(out.answer, 'Ollama answer.');
  console.log('  ✔ Ollama message.thinking + message.content');
}

{
  assert.strictEqual(
    thinking.extractReasoningFromPayload({ choices: [{ delta: { reasoning_content: 'abc' } }] }),
    'abc'
  );
  assert.strictEqual(
    thinking.extractContentFromPayload({ choices: [{ delta: { content: 'xyz' } }] }),
    'xyz'
  );
  assert.strictEqual(
    thinking.extractContentFromPayload({ message: { content: 'hi', thinking: 'secret' } }),
    'hi'
  );
  assert.strictEqual(thinking.extractReasoningFromPayload({ message: { thinking: 'secret' } }), 'secret');
  console.log('  ✔ extractReasoningFromPayload / extractContentFromPayload');
}

{
  const out = thinking.splitThinking('<think>hidden</think>Visible', { reasoning: 'field plan' });
  assert.ok(out.thinking.includes('field plan'));
  assert.ok(out.thinking.includes('hidden'));
  assert.strictEqual(out.answer, 'Visible');
  refuteTags(out.thinking, 'combined thinking');
  console.log('  ✔ reasoning field plus <think> tags are both kept, tags stripped');
}

{
  const unfinished = feedChunks(['<think>Still working']);
  assert.strictEqual(unfinished.thinking, 'Still working');
  assert.strictEqual(unfinished.answer, '');
  refuteTags(unfinished.thinking, 'unclosed thinking');
  console.log('  ✔ unclosed <think> at the end stays in thinking');
}

{
  const cleaned = thinking.stripThinkTags('Hi <think>secret</think> there <thinking>x</thinking>');
  assert.strictEqual(cleaned, 'Hi  there');
  assert.strictEqual(thinking.stripThinkTags('No tags here'), 'No tags here');
  console.log('  ✔ stripThinkTags removes both tag styles');
}

{
  assert.strictEqual(thinking.isAckPayload({ isAck: true }), true);
  assert.strictEqual(thinking.isAckPayload('{"isAck":true}'), true);
  assert.strictEqual(thinking.isAckPayload({ thinking: 'x' }), false);
  assert.strictEqual(thinking.formatThoughtLabel(3200), 'Thought for 3s');
  assert.strictEqual(thinking.formatThoughtLabel(200), 'Thought for 1s');
  assert.ok(thinking.THINKING_PROMPT.includes('<think>'));
  console.log('  ✔ ack helper, duration label, and thinking prompt');
}

// Source checks: canned ack strings must be gone; thinking is wired through
{
  const jobs = fs.readFileSync(path.join(root, 'lib/nova_jobs.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/js/nova/app.js'), 'utf8');
  const widget = fs.readFileSync(path.join(root, 'views/partials/nova_widget.ejs'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'lib/nova_chat.js'), 'utf8');

  assert.ok(!/On it — checking context now/.test(jobs), 'canned "checking context" ack must be removed');
  assert.ok(!/On it — breaking down your request now/.test(jobs), 'canned "breaking down" ack must be removed');
  assert.ok(!/On it ✨/.test(jobs), 'canned "On it" plugin fallback must be removed');
  assert.ok(!/Loaded conversation context & persona state/.test(jobs), 'canned progress step must be removed from jobs');
  assert.ok(!/Running reasoning & formatting pipeline/.test(jobs), 'canned reasoning progress step must be removed from jobs');
  assert.ok(jobs.includes('thinking'), 'jobs must persist thinking on the result message');

  assert.ok(app.includes('nova-thinking'), 'signed-in Nova must render a thinking block');
  assert.ok(app.includes('Thought for'), 'thinking block must collapse to "Thought for Ns"');
  assert.ok(app.includes('isAck'), 'signed-in UI must hide historical ack messages');

  assert.ok(widget.includes('nova-widget-thinking') || widget.includes('nova-thinking'), 'guest widget must render a thinking block');
  assert.ok(widget.includes('parsed.thinking'), 'guest widget must read thinking tokens from the stream');

  assert.ok(chat.includes('THINKING_PROMPT') || chat.includes('nova_thinking'), 'signed-in prompt must ask for a thinking pass');
  console.log('  ✔ source: canned acks removed and thinking wired through app, widget, and chat');
}

console.log('\n====================================================');
console.log('Nova thinking parser: all checks passed');
console.log('====================================================\n');
