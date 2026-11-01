/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 *
 * @llyverse/nova - Core Entrypoint
 */

const path = require('path');
const createNovaRouter = require('./lib/nova');
const novaChat = require('./lib/nova_chat');
const novaComputer = require('./lib/nova_computer');
const novaScreen = require('./lib/nova_screen');
const novaMcp = require('./lib/nova_mcp');
const novaPush = require('./lib/nova_push');
const novaJobs = require('./lib/nova_jobs');
const novaUsage = require('./lib/nova_usage');
const novaWidgets = require('./lib/nova_widgets');
const novaApprovals = require('./lib/nova_approvals');
const novaRoutines = require('./lib/nova_routines');
const novaSecrets = require('./lib/nova_secrets');
const novaActions = require('./lib/nova_actions');
const novaLockdown = require('./middleware/nova-lockdown');

module.exports = {
  createNovaRouter,
  novaChat,
  novaComputer,
  novaScreen,
  novaMcp,
  novaPush,
  novaJobs,
  novaUsage,
  novaWidgets,
  novaApprovals,
  novaRoutines,
  novaSecrets,
  novaActions,
  novaLockdown,
  viewsPath: path.join(__dirname, 'views'),
  publicPath: path.join(__dirname, 'public')
};
