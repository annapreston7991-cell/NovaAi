/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Host bridge. Nova runs inside a host site (LLYVerse) and borrows a few of its
 * services instead of owning them: the database helpers, the AI client and the
 * MCP server registry. The host calls configure() once at start-up, before it
 * loads any other Nova module:
 *
 *   require('@llyverse/nova').configure({
 *     rootDir: __dirname,                         // where .env and data/ live
 *     db: () => require('./data/db'),             // getRawDb, getSetting, logAudit ...
 *     cloudflareAi: () => require('./services/cloudflare-ai'),
 *     mcpServers: () => require('./services/mcp_servers')
 *   });
 *
 * Each service may be the object itself or a function that returns it (lazy,
 * which avoids circular-require problems in the host).
 */

const path = require('path');

const providers = {};
let rootDir = null;

function configure(opts = {}) {
  if (opts.rootDir) rootDir = path.resolve(opts.rootDir);
  for (const key of ['db', 'cloudflareAi', 'mcpServers']) {
    if (opts[key] !== undefined) providers[key] = opts[key];
  }
  return module.exports;
}

function resolve(key) {
  const p = providers[key];
  if (p === undefined) {
    throw new Error(`@llyverse/nova: host service "${key}" is not configured. Call require('@llyverse/nova').configure({ ${key}: ... }) before loading Nova.`);
  }
  const value = typeof p === 'function' && !p.__novaObject ? p() : p;
  return value;
}

function isConfigured(key) {
  return providers[key] !== undefined;
}

/** A stand-in object that forwards every property to the host service on first use. */
function lazyService(key) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
      const real = resolve(key);
      const v = real[prop];
      return typeof v === 'function' ? v.bind(real) : v;
    },
    set(_t, prop, value) { resolve(key)[prop] = value; return true; },
    has(_t, prop) { return prop in resolve(key); }
  });
}

/** Folder of the host site (holds .env and data/). Defaults to NOVA_HOST_ROOT or the working directory. */
function getRootDir() {
  return rootDir || process.env.NOVA_HOST_ROOT || process.cwd();
}

module.exports = {
  configure,
  resolve,
  isConfigured,
  getRootDir,
  db: lazyService('db'),
  cloudflareAi: lazyService('cloudflareAi'),
  mcpServers: lazyService('mcpServers')
};
