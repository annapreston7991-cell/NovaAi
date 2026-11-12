/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 *
 * @llyverse/nova - Core Entrypoint
 *
 * Call configure() first (see lib/host.js), then use the exports. Everything except
 * configure, runMigrations, viewsPath and publicPath loads lazily on first use, so
 * the host can configure Nova before any Nova module touches the database.
 */

const path = require('path');
const host = require('./lib/host');
const { runMigrations } = require('./lib/migrations');

const api = {
  configure: host.configure,
  runMigrations,
  viewsPath: path.join(__dirname, 'views'),
  publicPath: path.join(__dirname, 'public'),
  promptsPath: path.join(__dirname, 'prompts')
};

const lazy = {
  createNovaRouter: './lib/nova',
  createNovaPluginsRouter: './lib/nova_plugins_router',
  novaChat: './lib/nova_chat',
  novaComputer: './lib/nova_computer',
  novaScreen: './lib/nova_screen',
  novaMcp: './lib/nova_mcp',
  novaPush: './lib/nova_push',
  novaJobs: './lib/nova_jobs',
  novaUsage: './lib/nova_usage',
  novaWidgets: './lib/nova_widgets',
  novaApprovals: './lib/nova_approvals',
  novaRoutines: './lib/nova_routines',
  novaSecrets: './lib/nova_secrets',
  novaActions: './lib/nova_actions',
  novaPersona: './lib/nova_persona',
  novaMenu: './lib/nova_menu',
  novaPlugins: './lib/nova_plugins',
  novaLockdown: './middleware/nova-lockdown',
  requireNovaUser: './middleware/requireNovaUser',
  requireApprovalToken: './middleware/requireApprovalToken'
};

for (const [name, file] of Object.entries(lazy)) {
  Object.defineProperty(api, name, { enumerable: true, get: () => require(file) });
}

module.exports = api;
