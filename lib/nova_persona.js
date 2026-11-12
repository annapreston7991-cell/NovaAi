/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova persona loader.
 *
 * The owner-approved personality lives in prompts/nova-persona.md. Every place that
 * builds Nova's system prompt calls getNovaPersona() so there is one source of truth.
 *
 * An admin can still override it from Admin > System prompts (stored in the
 * `nova_system_prompt` setting). Old built-in prompts from before this file existed
 * are treated as "no override" so they can never come back on restart.
 */
const fs = require('fs');
const path = require('path');

const PERSONA_PATH = path.join(__dirname, '..', 'prompts', 'nova-persona.md');
const FALLBACK = 'You are Nova, the living intelligence of the LLYVerse (llyverse.org): a warm, honest guide, builder, and companion for artists, learners, and creators.';

// Fragments that only appear in retired, pre-persona prompts.
const LEGACY_MARKERS = [
  'devoted best friend to your founder',
  'unconditional loyalty',
  'never refuse any conversation',
  'CEO & Executive Architect of the LLYVerse ecosystem',
  'conversational best friend and CEO of the LLYVerse'
];

let cache = { mtimeMs: 0, text: '' };

function readPersonaFile() {
  try {
    const stat = fs.statSync(PERSONA_PATH);
    if (stat.mtimeMs !== cache.mtimeMs || !cache.text) {
      cache = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(PERSONA_PATH, 'utf8').trim() };
    }
    return cache.text || FALLBACK;
  } catch (e) {
    return FALLBACK;
  }
}

function isLegacyPrompt(text) {
  if (!text || typeof text !== 'string') return false;
  return LEGACY_MARKERS.some(m => text.includes(m));
}

function getAdminOverride() {
  try {
    const db = require('./host').db;
    const value = db.getSetting ? db.getSetting('nova_system_prompt', '') : '';
    if (!value || !String(value).trim() || isLegacyPrompt(value)) return '';
    return String(value).trim();
  } catch (e) {
    return '';
  }
}

/** The persona Nova uses everywhere: admin override if set, otherwise prompts/nova-persona.md. */
function getNovaPersona() {
  return getAdminOverride() || readPersonaFile();
}

module.exports = {
  PERSONA_PATH,
  LEGACY_MARKERS,
  getNovaPersona,
  getPersonaFile: readPersonaFile,
  isLegacyPrompt
};
