/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Test Suite: Nova Linux Computer & Thunar Workstation Subsystem
 * Verifies:
 * 1. Workspace directory initialization (/home/lily/nova-computer/workspace)
 * 2. Thunar file explorer listing, file creation, folder creation & deletion
 * 3. Code file reading and saving
 * 4. Bash terminal execution and output capture
 * 5. Autonomous server daemon launch, status tracking, ping, and graceful shutdown
 * 6. Nova MCP integration for computer commands
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const novaComputer = require('../services/nova_computer');
const novaMcp = require('../services/nova_mcp');

async function runNovaComputerTests() {
  console.log('====================================================');
  console.log('💻  NOVA LINUX COMPUTER & THUNAR WORKSTATION TEST SUITE');
  console.log('====================================================\n');

  // STEP 1: Verify Workstation Directory Initialization
  console.log('[TEST 1] Verifying Nova Linux Workstation Environment:');
  assert(fs.existsSync(novaComputer.WORKSPACE_DIR), 'Nova workspace directory must exist');
  console.log(` ✅ Workspace directory verified at: ${novaComputer.WORKSPACE_DIR}\n`);

  // STEP 2: Thunar File System Listing
  console.log('[TEST 2] Testing Thunar File System Listing:');
  const listResult = novaComputer.listFiles('');
  assert.strictEqual(listResult.success, true);
  assert(Array.isArray(listResult.items), 'Items must be an array');
  const serverJsItem = listResult.items.find(i => i.name === 'server.js');
  assert(serverJsItem, 'server.js must exist in workspace');
  assert.strictEqual(serverJsItem.isDirectory, false);
  console.log(` ✅ Thunar listed ${listResult.items.length} items. Found starter server.js (${serverJsItem.size}B).\n`);

  // STEP 3: Create Folder and File in Thunar
  console.log('[TEST 3] Creating Folder & Custom Microservice File:');
  const folderRes = novaComputer.createFolder('services/api');
  assert.strictEqual(folderRes.success, true);

  const customServiceCode = `// Custom Microservice created by Nova
module.exports = {
  ping: () => ({ status: 'HEALTHY', timestamp: Date.now() })
};
`;
  const fileRes = novaComputer.writeFile('services/api/health.js', customServiceCode);
  assert.strictEqual(fileRes.success, true);

  const readRes = novaComputer.readFile('services/api/health.js');
  assert.strictEqual(readRes.success, true);
  assert(readRes.content.includes('Custom Microservice created by Nova'));
  console.log(` ✅ Thunar created folder & wrote file "services/api/health.js" (${readRes.size}B).\n`);

  // STEP 4: Bash Terminal Command Execution
  console.log('[TEST 4] Executing Commands in Nova Bash Terminal:');
  const bashRes1 = await novaComputer.executeBashCommand('node -e "console.log(require(\'./services/api/health\').ping().status)"');
  assert.strictEqual(bashRes1.success, true);
  assert.strictEqual(bashRes1.exitCode, 0);
  assert(bashRes1.stdout.includes('HEALTHY'));

  const bashRes2 = await novaComputer.executeBashCommand('uname -a && whoami');
  assert.strictEqual(bashRes2.success, true);
  console.log(` ✅ Bash execution success:\n    Output: ${bashRes1.stdout.trim()}\n`);

  // STEP 5: Autonomous Server Runner - Launch Background Server
  console.log('[TEST 5] Launching Autonomous Nova Microservice on Port 4255:');
  const startRes = novaComputer.startServer({
    serverId: 'nova-test-microservice',
    command: 'node server.js',
    port: 4255
  });
  assert.strictEqual(startRes.success, true);
  assert(startRes.server.pid > 0, 'Server PID must be valid');
  assert.strictEqual(startRes.server.port, 4255);
  console.log(` ✅ Nova Server launched! PID: ${startRes.server.pid}, Port: 4255.`);

  // Wait 1.5 seconds for server to bind
  await new Promise(r => setTimeout(r, 1500));

  // STEP 6: Ping the Autonomous Server via HTTP
  console.log('[TEST 6] Testing HTTP Ping to Nova Server:');
  const pingData = await new Promise((resolve, reject) => {
    http.get('http://localhost:4255', (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
  assert.strictEqual(pingData.status, 'ONLINE');
  assert(pingData.author.includes('Nova'));
  console.log(` ✅ Server Ping Response: ${JSON.stringify(pingData)}\n`);

  // STEP 7: Server Status Registry Check
  console.log('[TEST 7] Checking Active Servers Registry:');
  const servers = novaComputer.getServersStatus();
  const srv = servers.find(s => s.id === 'nova-test-microservice');
  assert(srv, 'Server must be present in active servers registry');
  assert.strictEqual(srv.status, 'RUNNING');
  console.log(` ✅ Registry confirmed 1 active autonomous server.\n`);

  // STEP 8: Graceful Server Shutdown
  console.log('[TEST 8] Shutting Down Nova Autonomous Server:');
  const stopRes = novaComputer.stopServer('nova-test-microservice');
  assert.strictEqual(stopRes.success, true);
  assert.strictEqual(novaComputer.getServersStatus().length, 0);
  console.log(` ✅ Server stopped cleanly.\n`);

  // STEP 9: Nova Chat & MCP Tool Routing
  console.log('[TEST 9] Testing Nova Chat Routing for Computer Commands:');
  const chatRes = await novaMcp.processNovaMcpChat({
    user: { id: 3, username: 'mothyacorn', role: 'admin' },
    message: 'show files in my computer workspace with thunar'
  });
  assert.strictEqual(chatRes.success, true);
  assert(chatRes.response.includes('Nova Computer (Files)'));
  assert(chatRes.response.includes('server.js'));
  console.log(` ✅ Nova Chat routed and rendered Thunar files via MCP.\n`);

  // STEP 10: Clean up ephemeral test file
  console.log('[TEST 10] Cleaning up ephemeral test files in Thunar:');
  const delRes = novaComputer.deleteItem('services');
  assert.strictEqual(delRes.success, true);
  console.log(` ✅ Cleanup complete.\n`);

  console.log('====================================================');
  console.log('🎉 ALL NOVA COMPUTER & THUNAR WORKSTATION TESTS PASSED (100%)');
  console.log('====================================================');
}

if (require.main === module) {
  runNovaComputerTests().catch(err => {
    console.error('❌ TEST SUITE FAILED:', err);
    process.exit(1);
  });
}

module.exports = runNovaComputerTests;
