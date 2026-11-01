/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * LLYVerse Nova MCP Integration Test Suite
 * Validates Model Context Protocol (MCP) tool registrations, execution handlers,
 * Web Push notifications, and chat routing for Google Drive, Gmail, and LLYVerse Engine.
 */

const assert = require('assert');
const mcpServers = require('../services/mcp_servers');
const novaMcp = require('../services/nova_mcp');
const pushService = require('../services/nova_push');

async function runNovaMcpTests() {
 console.log('====================================================');
 console.log('⚡ LLYVERSE NOVA MCP TEST SUITE');
 console.log('====================================================\n');

 // TEST 1: Registered MCP Tools
 console.log('[TEST 1] Verifying Registered MCP Tools:');
 const tools = mcpServers.MCP_TOOLS;
 assert(tools.length >= 12, `Expected at least 12 registered MCP tools, found ${tools.length}`);
 console.log(` ✅ Registered ${tools.length} MCP tools across 3 servers (llyverse, gdrive, gmail).`);

 // TEST 2: LLYVerse Core MCP Tool Execution
 console.log('\n[TEST 2] Executing LLYVerse Telemetry MCP Tool:');
 const telemetryRes = await mcpServers.executeMcpTool('llyverse_get_telemetry');
 assert.strictEqual(telemetryRes.mcp_protocol, '2024-11-05');
 assert.strictEqual(telemetryRes.tool, 'llyverse_get_telemetry');
 assert.strictEqual(telemetryRes.result.success, true);
 console.log(` ✅ Telemetry retrieved via MCP: Active Sessions=${telemetryRes.result.data.activeSessions}, Nodes=${telemetryRes.result.data.nodes}`);

 // TEST 3: Task Dispatch MCP Tool Execution
 console.log('\n[TEST 3] Executing Fleet Task Dispatch MCP Tool:');
 const taskRes = await mcpServers.executeMcpTool('llyverse_dispatch_task', {
 title: 'Audit Zero-Trust API Key Integrity',
 target_agent: 'astaria'
 });
 assert.strictEqual(taskRes.result.success, true);
 assert(taskRes.result.task.id, 'Task ID expected');
 console.log(` ✅ Fleet Task Dispatched via MCP: Task ID #${taskRes.result.task.id}`);

 // TEST 4: Google Drive MCP Graceful Unauthenticated Handling
 console.log('\n[TEST 4] Testing Google Drive MCP Unauthenticated Fallback:');
 const gdriveRes = await mcpServers.executeMcpTool('gdrive_list_files', { query: 'test' });
 assert.strictEqual(gdriveRes.result.mcp_status, 'UNAUTHENTICATED');
 console.log(` ✅ Google Drive MCP returned clear auth guidance: "${gdriveRes.result.error.slice(0, 60)}..."`);

 // TEST 5: Google Mail (Gmail) MCP Graceful Unauthenticated Handling
 console.log('\n[TEST 5] Testing Gmail MCP Unauthenticated Fallback:');
 const gmailRes = await mcpServers.executeMcpTool('gmail_list_messages', { query: 'inbox' });
 assert.strictEqual(gmailRes.result.mcp_status, 'UNAUTHENTICATED');
 console.log(` ✅ Gmail MCP returned clear auth guidance: "${gmailRes.result.error.slice(0, 60)}..."`);

 // TEST 6: Web Push VAPID Key Generation & Push Dispatch
 console.log('\n[TEST 6] Testing Web Push VAPID Keypair & Notification Dispatch:');
 const pubKey = pushService.getPublicKey();
 assert(pubKey && typeof pubKey === 'string', 'Public VAPID key expected');
 const pushRes = await pushService.sendPushNotification({
 title: 'Nova MCP Execution Alert',
 body: 'Test Push Dispatch'
 });
 assert.strictEqual(pushRes.success, true);
 console.log(` ✅ Web Push Service Active! Public VAPID Key generated: ${pubKey.slice(0, 20)}...`);

 // TEST 7: Nova MCP Chat Agent Directive Routing
 console.log('\n[TEST 7] Testing Nova MCP Chat Directive Routing:');
 const chatRes = await novaMcp.processNovaMcpChat({
 user: { id: 3, username: 'mothyacorn' },
 message: 'Show live system telemetry stats'
 });
 assert.strictEqual(chatRes.success, true);
 assert.strictEqual(chatRes.target, 'nova');
 assert(chatRes.tool_executed, 'Expected tool_executed object');
 assert.strictEqual(chatRes.tool_executed.tool, 'llyverse_get_telemetry');
 console.log(` ✅ Nova Chat successfully invoked MCP tool llyverse_get_telemetry! Response preview:\n ${chatRes.response.split('\n')[0]}`);

 // TEST 8: MCP Server Status Reporting
 console.log('\n[TEST 8] Testing MCP Server Status Summary:');
 const status = mcpServers.getMcpServersStatus();
 assert.strictEqual(status.llyverse.status, 'ACTIVE');
 assert.strictEqual(status.gdrive.connected, false);
 assert.strictEqual(status.gmail.connected, false);
 console.log(' ✅ MCP Status summary verified: LLYVerse=ACTIVE, GDrive=AUTH_REQUIRED, Gmail=AUTH_REQUIRED.');

 console.log('\n====================================================');
 console.log('🎉 ALL NOVA MCP & WEB PUSH TESTS PASSED (100%)');
 console.log('====================================================');
}

runNovaMcpTests().catch(err => {
 console.error('❌ MCP TEST FAILED:', err);
 process.exit(1);
});
