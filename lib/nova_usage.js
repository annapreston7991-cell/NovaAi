/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Usage Limits, Cost Tracking & Ollama Memory/Concurrency Semaphore (§15.3)
 * - Enforces per-persona and global daily caps on tokens and cost (resets at 12:00 AM PT)
 * - Emits one-time 80% threshold alert per day per scope
 * - Guards local Ollama calls with a concurrency=1 semaphore + os.freemem() low-RAM protection
 */

const os = require('os');
const db = require('./host').db;

const rawDb = db.getRawDb ? db.getRawDb() : db.db;

function ensureUsageTables() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS nova_usage (
      day TEXT NOT NULL,
      persona TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      calls INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      PRIMARY KEY (day, persona, provider, model)
    );

    CREATE TABLE IF NOT EXISTS nova_usage_limits (
      scope TEXT PRIMARY KEY,
      daily_token_cap INTEGER NOT NULL,
      daily_cost_cap_usd REAL NOT NULL,
      ollama_max_concurrency INTEGER DEFAULT 1,
      alert_pct INTEGER DEFAULT 80,
      alerted_day TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const seed = rawDb.prepare(`
    INSERT OR IGNORE INTO nova_usage_limits (scope, daily_token_cap, daily_cost_cap_usd, ollama_max_concurrency, alert_pct)
    VALUES (?, ?, ?, 1, 80)
  `);
  seed.run('global', 500000, 5.00);
  seed.run('nova', 250000, 2.50);
  seed.run('astra', 150000, 1.50);
  seed.run('astaria', 150000, 1.50);
}

ensureUsageTables();

function getTodayPt(nowDate = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(nowDate);
}

function formatPersonaLabel(persona) {
  const p = String(persona || 'nova').toLowerCase();
  if (p === 'astra') return 'Astra';
  if (p === 'astaria') return 'Astaria';
  if (p === 'global') return 'All Personas';
  return 'Nova';
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function estimateCostUsd(provider, tokensIn, tokensOut) {
  if (provider === 'ollama' || provider === 'local') return 0;
  // Approximate Cloudflare Workers AI / cloud rate: $0.30 per 1M input, $0.80 per 1M output
  return Number((((tokensIn * 0.30) + (tokensOut * 0.80)) / 1000000).toFixed(6));
}

function getScopeTotals(day, scope) {
  if (scope === 'global') {
    const row = rawDb.prepare(`
      SELECT
        COALESCE(SUM(calls), 0) AS calls,
        COALESCE(SUM(tokens_in), 0) AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM nova_usage
      WHERE day = ?
    `).get(day);
    return {
      calls: row.calls || 0,
      tokensIn: row.tokens_in || 0,
      tokensOut: row.tokens_out || 0,
      totalTokens: (row.tokens_in || 0) + (row.tokens_out || 0),
      costUsd: Number((row.cost_usd || 0).toFixed(6))
    };
  }
  const row = rawDb.prepare(`
    SELECT
      COALESCE(SUM(calls), 0) AS calls,
      COALESCE(SUM(tokens_in), 0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM nova_usage
    WHERE day = ? AND persona = ?
  `).get(day, scope);
  return {
    calls: row.calls || 0,
    tokensIn: row.tokens_in || 0,
    tokensOut: row.tokens_out || 0,
    totalTokens: (row.tokens_in || 0) + (row.tokens_out || 0),
    costUsd: Number((row.cost_usd || 0).toFixed(6))
  };
}

function getLimitsMap() {
  const rows = rawDb.prepare(`SELECT * FROM nova_usage_limits`).all();
  const map = {};
  for (const r of rows) {
    map[r.scope] = r;
  }
  return map;
}

/**
 * Check if a persona / global call is within today's token & cost caps.
 */
function checkCap(persona = 'nova', day = getTodayPt()) {
  const cleanPersona = String(persona || 'nova').toLowerCase();
  const limits = getLimitsMap();
  const scopesToCheck = [cleanPersona, 'global'];

  for (const scope of scopesToCheck) {
    const lim = limits[scope];
    if (!lim) continue;
    const totals = getScopeTotals(day, scope);
    const tokenReached = lim.daily_token_cap > 0 && totals.totalTokens >= lim.daily_token_cap;
    const costReached = lim.daily_cost_cap_usd > 0 && totals.costUsd >= lim.daily_cost_cap_usd;

    if (tokenReached || costReached) {
      const label = formatPersonaLabel(scope === 'global' ? cleanPersona : scope);
      return {
        allowed: false,
        code: 'DAILY_LIMIT_REACHED',
        scope,
        persona: cleanPersona,
        day,
        totals,
        limit: lim,
        message: `Daily limit reached for ${label}; resets at 12:00 AM PT`
      };
    }
  }

  return { allowed: true, persona: cleanPersona, day };
}

/**
 * Record usage after a model call and check if the 80% alert threshold was crossed.
 */
function recordUsage({
  persona = 'nova',
  provider = 'cloudflare',
  model = 'default',
  tokensIn = 0,
  tokensOut = 0,
  costUsd = null,
  day = getTodayPt()
}) {
  const cleanPersona = String(persona || 'nova').toLowerCase();
  const inTok = Math.max(0, Math.round(Number(tokensIn) || 0));
  const outTok = Math.max(0, Math.round(Number(tokensOut) || 0));
  const calcCost = costUsd !== null && costUsd !== undefined
    ? Number(costUsd)
    : estimateCostUsd(provider, inTok, outTok);

  rawDb.prepare(`
    INSERT INTO nova_usage (day, persona, provider, model, calls, tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, persona, provider, model) DO UPDATE SET
      calls = nova_usage.calls + 1,
      tokens_in = nova_usage.tokens_in + excluded.tokens_in,
      tokens_out = nova_usage.tokens_out + excluded.tokens_out,
      cost_usd = ROUND(nova_usage.cost_usd + excluded.cost_usd, 6)
  `).run(day, cleanPersona, String(provider), String(model), inTok, outTok, calcCost);

  // Check if 80% alert threshold was crossed on either persona or global scope
  const limits = getLimitsMap();
  const alerts = [];
  for (const scope of [cleanPersona, 'global']) {
    const lim = limits[scope];
    if (!lim || lim.alerted_day === day) continue;
    const totals = getScopeTotals(day, scope);
    const alertPct = (lim.alert_pct || 80) / 100;
    const tokenRatio = lim.daily_token_cap > 0 ? (totals.totalTokens / lim.daily_token_cap) : 0;
    const costRatio = lim.daily_cost_cap_usd > 0 ? (totals.costUsd / lim.daily_cost_cap_usd) : 0;
    const maxRatio = Math.max(tokenRatio, costRatio);

    if (maxRatio >= alertPct) {
      rawDb.prepare(`UPDATE nova_usage_limits SET alerted_day = ?, updated_at = CURRENT_TIMESTAMP WHERE scope = ?`).run(day, scope);
      const pctUsed = Math.min(100, Math.round(maxRatio * 100));
      alerts.push({
        scope,
        persona: cleanPersona,
        pctUsed,
        totals,
        limit: lim,
        message: `${formatPersonaLabel(scope)} has reached ${pctUsed}% of today's daily usage limit (${totals.totalTokens.toLocaleString()} / ${lim.daily_token_cap.toLocaleString()} tokens).`
      });
    }
  }

  return {
    day,
    persona: cleanPersona,
    tokensIn: inTok,
    tokensOut: outTok,
    costUsd: calcCost,
    alerts
  };
}

// --- Ollama Concurrency Semaphore & Low-RAM Guard ---
let activeOllamaJobs = 0;
const ollamaQueue = [];
const MIN_FREE_MEM_BYTES = Number(process.env.NOVA_OLLAMA_MIN_FREE_MB || 120) * 1024 * 1024;

function getMaxOllamaConcurrency() {
  try {
    const row = rawDb.prepare(`SELECT ollama_max_concurrency FROM nova_usage_limits WHERE scope = 'global'`).get();
    return Math.max(1, (row && row.ollama_max_concurrency) || 1);
  } catch (e) {
    return 1;
  }
}

function drainOllamaQueue() {
  const maxConc = getMaxOllamaConcurrency();
  while (activeOllamaJobs < maxConc && ollamaQueue.length > 0) {
    const next = ollamaQueue.shift();
    activeOllamaJobs++;
    let released = false;
    next.resolve({
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        activeOllamaJobs = Math.max(0, activeOllamaJobs - 1);
        drainOllamaQueue();
      }
    });
  }
}

/**
 * Acquire a slot for local Ollama execution.
 * Refuses to start Ollama when os.freemem() is below threshold so the 2.7 GB box never swaps.
 */
function acquireOllamaSlot({ forceMemoryCheck = true, minFreeBytes = MIN_FREE_MEM_BYTES } = {}) {
  const freeBytes = os.freemem();
  if (forceMemoryCheck && freeBytes < minFreeBytes) {
    return Promise.resolve({
      acquired: false,
      fallbackToCloud: true,
      reason: `Free memory (${Math.round(freeBytes / (1024 * 1024))} MB) is below safe local threshold (${Math.round(minFreeBytes / (1024 * 1024))} MB).`,
      release: () => {}
    });
  }

  return new Promise((resolve) => {
    ollamaQueue.push({ resolve });
    drainOllamaQueue();
  });
}

function getUsageSummary(day = getTodayPt()) {
  const rows = rawDb.prepare(`
    SELECT day, persona, provider, model, calls, tokens_in, tokens_out, cost_usd
    FROM nova_usage
    WHERE day = ?
    ORDER BY persona ASC, provider ASC
  `).all(day);

  const limits = getLimitsMap();
  const byPersona = {};
  for (const p of ['nova', 'astra', 'astaria']) {
    byPersona[p] = {
      ...getScopeTotals(day, p),
      limit: limits[p] || null
    };
  }
  const globalTotals = getScopeTotals(day, 'global');

  return {
    day,
    timezone: 'America/Los_Angeles',
    resetsAt: '12:00 AM PT',
    global: {
      ...globalTotals,
      limit: limits.global || null
    },
    personas: byPersona,
    breakdown: rows,
    limits,
    ollama: {
      activeJobs: activeOllamaJobs,
      queueLength: ollamaQueue.length,
      maxConcurrency: getMaxOllamaConcurrency(),
      freeMemBytes: os.freemem(),
      totalMemBytes: os.totalmem(),
      minFreeMemBytes: MIN_FREE_MEM_BYTES
    }
  };
}

function updateUsageLimits(scope, updates = {}) {
  const cleanScope = String(scope || '').toLowerCase();
  if (!['global', 'nova', 'astra', 'astaria'].includes(cleanScope)) {
    throw new Error('Invalid usage limit scope. Must be global, nova, astra, or astaria.');
  }
  const current = rawDb.prepare(`SELECT * FROM nova_usage_limits WHERE scope = ?`).get(cleanScope);
  if (!current) {
    throw new Error(`Scope ${cleanScope} not found.`);
  }
  const dailyTokenCap = updates.daily_token_cap !== undefined ? Math.max(0, Number(updates.daily_token_cap)) : current.daily_token_cap;
  const dailyCostCapUsd = updates.daily_cost_cap_usd !== undefined ? Math.max(0, Number(updates.daily_cost_cap_usd)) : current.daily_cost_cap_usd;
  const ollamaMaxConcurrency = updates.ollama_max_concurrency !== undefined ? Math.max(1, Number(updates.ollama_max_concurrency)) : current.ollama_max_concurrency;
  const alertPct = updates.alert_pct !== undefined ? Math.min(100, Math.max(1, Number(updates.alert_pct))) : current.alert_pct;

  rawDb.prepare(`
    UPDATE nova_usage_limits
    SET daily_token_cap = ?,
        daily_cost_cap_usd = ?,
        ollama_max_concurrency = ?,
        alert_pct = ?,
        alerted_day = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE scope = ?
  `).run(dailyTokenCap, dailyCostCapUsd, ollamaMaxConcurrency, alertPct, cleanScope);

  return rawDb.prepare(`SELECT * FROM nova_usage_limits WHERE scope = ?`).get(cleanScope);
}

module.exports = {
  getTodayPt,
  estimateTokens,
  estimateCostUsd,
  checkCap,
  recordUsage,
  acquireOllamaSlot,
  getUsageSummary,
  updateUsageLimits
};
