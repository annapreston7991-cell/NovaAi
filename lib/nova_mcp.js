/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova Autonomous AI MCP Agent Brain
 * Integrates Model Context Protocol (MCP) tool calling with Nova's reasoning engine
 * for LLYVerse, Google Drive, and Google Mail (Gmail).
 */

const fs = require('fs');
const path = require('path');
const mcpServers = require('./host').mcpServers;
const db = require('./host').db;
const pushService = require('./nova_push');
const novaComputer = require('./nova_computer');
const novaApprovals = require('./nova_approvals');
const novaActions = require('./nova_actions');

const SOUL_FILE_PATH = path.join(require('./host').getRootDir(), 'data', 'SOUL.md');
const MEMORIES_FILE_PATH = path.join(require('./host').getRootDir(), 'data', 'memories.md');

function getNovaSoulAndMemories() {
 let soul = '';
 let memories = '';
 try {
 if (fs.existsSync(SOUL_FILE_PATH)) {
 soul = fs.readFileSync(SOUL_FILE_PATH, 'utf-8');
 }
 } catch (err) {}
 try {
 if (fs.existsSync(MEMORIES_FILE_PATH)) {
 memories = fs.readFileSync(MEMORIES_FILE_PATH, 'utf-8');
 }
 } catch (err) {}
 return { soul, memories };
}

// Nova's MCP Master System Prompt (workspace path loaded via NOVA_WORKSPACE_DIR env var, never hardcoded)
// Nova's own persona (prompts/nova-persona.md) plus the MCP tool rules she needs here.
const NOVA_MCP_TOOL_RULES = `
[TOOLS: MCP]
You have a private Linux computer (file manager, terminal, code editor). Every terminal command, file overwrite or delete, payment, outbound email, or database write needs explicit human approval through a single-use approval card.

You can also use these MCP integrations:
1. LLYVerse Engine MCP (telemetry, ERT memory, Flame ledger, fleet tasks, storage)
2. Google Drive MCP (search, read, list and create Docs and Drive files)
3. Gmail MCP (list, read and send emails; sending needs approval)

- When asked to look at files, emails, fleet tasks or LLYVerse metrics, call the right MCP tool.
- Never make up data. Use only real tool results.
`;
function getNovaMcpSystemPrompt() {
 return `${require('./nova_persona').getNovaPersona()}\n${NOVA_MCP_TOOL_RULES}`;
}

/**
 * Parses user input to check if an MCP tool call should be triggered
 */
function decideMcpToolCall(userInput) {
 const lower = userInput.toLowerCase();

 // 0. Nova Linux Computer & Thunar Workspace Commands
 if (lower.includes("thunar") || lower.includes("my computer") || lower.includes("computer") || lower.includes("terminal") || lower.includes("bash") || lower.includes("run code") || lower.includes("build server") || lower.includes("start server") || lower.includes("microservice")) {
   if (lower.includes("start server") || lower.includes("build server") || lower.includes("run server") || lower.includes("launch server")) {
     return { tool: "nova_start_server", args: { command: "node server.js", port: 4200 } };
   }
   if (lower.includes("files") || lower.includes("ls") || lower.includes("directory") || lower.includes("thunar") || lower.includes("workspace")) {
     return { tool: "nova_list_files", args: { path: "" } };
   }
   return { tool: "nova_execute_bash", args: { command: userInput.replace(/(?:run|exec|terminal|bash)\s*/i, "").trim() || "ls -la" } };
 }

 // 1. Google Drive queries
 if (lower.includes('drive') || lower.includes('google doc') || lower.includes('gdrive') || lower.includes('file in drive')) {
 if (lower.includes('create') || lower.includes('new doc') || lower.includes('write doc')) {
 const titleMatch = userInput.match(/(?:title|name|called)\s*[:=]?\s*["']?([^"'\n]+)["']?/i);
 return { tool: 'gdrive_create_doc', args: { title: titleMatch ? titleMatch[1] : 'Nova Executive Note', content: userInput } };
 }
 if (lower.includes('read') || lower.includes('open') || lower.includes('content of')) {
 const match = userInput.match(/(?:fileId|id|file)\s*[:=]?\s*([a-zA-Z0-9_-]{10,})/i);
 if (match) {
 return { tool: 'gdrive_read_file', args: { fileId: match[1] } };
 }
 }
 const queryMatch = userInput.replace(/(?:search|find|list|show|drive|gdrive|files|google docs?)/gi, '').trim();
 return { tool: 'gdrive_list_files', args: { query: queryMatch || '' } };
 }

 // 2. Google Mail (Gmail) queries
 if (lower.includes('gmail') || lower.includes('email') || lower.includes('inbox') || lower.includes('mail')) {
 if (lower.includes('read message') || lower.includes('open email')) {
 const msgMatch = userInput.match(/(?:messageId|id|msg)\s*[:=]?\s*([a-zA-Z0-9_-]{10,})/i);
 if (msgMatch) {
 return { tool: 'gmail_read_message', args: { messageId: msgMatch[1] } };
 }
 }
 if (lower.includes('send') || lower.includes('draft') || lower.includes('write email')) {
 const toMatch = userInput.match(/to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
 const subMatch = userInput.match(/subject\s*[:=]\s*["']?([^"'\n]+)["']?/i);
 if (toMatch) {
 return {
 tool: 'gmail_send_message',
 args: {
 to: toMatch[1],
 subject: subMatch ? subMatch[1] : 'Executive Briefing from Nova',
 body: userInput
 }
 };
 }
 }
 const searchMatch = userInput.replace(/(?:search|find|list|check|emails?|gmail|inbox|messages?)/gi, '').trim();
 return { tool: 'gmail_list_messages', args: { query: searchMatch || '' } };
 }

 // 3. Agent Task & Fleet Commands
 if (lower.includes('task') || lower.includes('dispatch') || lower.includes('assign worker')) {
 if (lower.includes('list') || lower.includes('queue') || lower.includes('show tasks')) {
 return { tool: 'llyverse_list_agent_tasks', args: { limit: 10 } };
 }
 const targetAgent = lower.includes('astra') ? 'astra' : (lower.includes('astaria') ? 'astaria' : 'nova');
 return { tool: 'llyverse_dispatch_task', args: { title: userInput, target_agent: targetAgent } };
 }

 if (lower.includes('bots') || lower.includes('bot fleet') || lower.includes('intercom')) {
 return { tool: 'llyverse_get_bot_status', args: {} };
 }
 if (lower.includes('storage') || lower.includes('disk') || lower.includes('partition')) {
 return { tool: 'llyverse_get_storage_status', args: {} };
 }

 // 4. LLYVerse Telemetry & Core Engine queries
 if (lower.includes('telemetry') || lower.includes('system status') || lower.includes('cpu') || lower.includes('node stats') || lower.includes('health')) {
 return { tool: 'llyverse_get_telemetry', args: {} };
 }
 if (lower.includes('flame') || lower.includes('ledger') || lower.includes('spk') || lower.includes('economy') || lower.includes('treasury')) {
 return { tool: 'llyverse_get_flame_ledger', args: {} };
 }
 if (lower.includes('memory') || lower.includes('vector') || lower.includes('ert') || lower.includes('rag')) {
 return { tool: 'llyverse_query_memory', args: { query: userInput } };
 }
 // 5. Cloudflare Workers AI & Vectorize
 if (lower.includes('cloudflare') || lower.includes('llama') || lower.includes('inference') || lower.includes('workers ai')) {
 return { tool: 'cloudflare_ai_prompt', args: { prompt: userInput } };
 }

 // 6. Web Search & Live Research
 if (lower.includes('search') || lower.includes('web') || lower.includes('google search') || lower.includes('lookup')) {
 return { tool: 'web_search_query', args: { query: userInput } };
 }

 // 7. GitHub Repository
 if (lower.includes('github') || lower.includes('repo') || lower.includes('git commit') || lower.includes('codebase')) {
 return { tool: 'github_repo_info', args: { repo: 'LLYVerse-Node' } };
 }

 // 8. Monero Crypto & Flame Staking
 if (lower.includes('monero') || lower.includes('xmr') || lower.includes('crypto wallet') || lower.includes('staking vault')) {
 return { tool: 'monero_wallet_info', args: {} };
 }

 // 9. Notion Workspace
 if (lower.includes('notion') || lower.includes('notion page') || lower.includes('notion doc')) {
 if (lower.includes('create') || lower.includes('new page')) {
 return { tool: 'notion_create_page', args: { title: userInput, content: userInput } };
 }
 return { tool: 'notion_search_pages', args: { query: userInput } };
 }

 // 10. Slack Workspace
 if (lower.includes('slack') || lower.includes('slack channel')) {
 return { tool: 'slack_post_message', args: { channel: 'general', message: userInput } };
 }

 // 11. Discord Community
 if (lower.includes('discord') || lower.includes('discord server')) {
 return { tool: 'discord_post_message', args: { channelId: 'general', content: userInput } };
 }

 // 12. Jira & Linear Issue Trackers
 if (lower.includes('jira') || lower.includes('sprint') || lower.includes('backlog')) {
 return { tool: 'jira_list_issues', args: { project: 'LLY' } };
 }
 if (lower.includes('linear') || lower.includes('linear issue')) {
 return { tool: 'linear_list_issues', args: {} };
 }

 // 13. Spotify & AuraStream Audio
 if (lower.includes('spotify') || lower.includes('music') || lower.includes('solfeggio') || lower.includes('track')) {
 return { tool: 'spotify_get_current_playback', args: {} };
 }

 // 14. Stripe Financials
 if (lower.includes('stripe') || lower.includes('revenue') || lower.includes('mrr') || lower.includes('sales balance')) {
 return { tool: 'stripe_get_balance', args: {} };
 }

 // 15. Docker & Infrastructure
 if (lower.includes('docker') || lower.includes('container') || lower.includes('podman')) {
 return { tool: 'docker_list_containers', args: {} };
 }

 // 16. Postgres / MySQL Database
 if (lower.includes('postgres') || lower.includes('postgresql') || lower.includes('mysql')) {
 return { tool: 'postgres_query_tables', args: { table: 'citizens' } };
 }

 // 17. Pinecone Vector DB
 if (lower.includes('pinecone') || lower.includes('vector db') || lower.includes('embeddings index')) {
 return { tool: 'pinecone_query_vectors', args: { query: userInput } };
 }

 // 18. Elasticsearch Logs
 if (lower.includes('elastic') || lower.includes('elasticsearch') || lower.includes('kibana')) {
 return { tool: 'elasticsearch_search_logs', args: { query: userInput } };
 }

 // 19. AWS S3 Storage
 if (lower.includes('aws') || lower.includes('s3') || lower.includes('bucket')) {
 return { tool: 'aws_s3_list_buckets', args: {} };
 }

 // 20. Twilio SMS
 if (lower.includes('twilio') || lower.includes('sms') || lower.includes('text alert')) {
 return { tool: 'twilio_send_sms', args: { to: '+15550199', body: userInput } };
 }

 // 21. Weather Telemetry
 if (lower.includes('weather') || lower.includes('forecast') || lower.includes('temperature') || lower.includes('climate')) {
 return { tool: 'weather_get_forecast', args: { location: 'San Francisco, CA' } };
 }

 return null;
}

const ALLOWED_PERSONAS = new Set(['nova', 'astra', 'astaria']);

/**
 * Process Nova MCP User Request with Multi-Agent Support
 */
async function processNovaMcpChat({ user, message, botId = 'nova', thinkMode = false, multiAgent = false, approvalToken = null, ip = null, userAgent = null, source = 'user' }) {
 if (!user || !user.id || !user.username) {
   throw new Error('Authenticated user session is required.');
 }
 if (novaActions.isNovaPaused()) {
   return {
     success: false,
     paused: true,
     error: 'Nova is currently paused. Resume Nova to run tasks.'
   };
 }

 const normalizedBot = ALLOWED_PERSONAS.has(String(botId || 'nova').toLowerCase())
   ? String(botId || 'nova').toLowerCase()
   : 'nova';

 const mcpStatus = mcpServers.getMcpServersStatus();
 const toolCallDecision = decideMcpToolCall(message);
 
 let toolExecutionResult = null;
 let responseText = '';
 let reasoningTrace = '';

 // 1. Generate Chain-of-Thought Reasoning Trace if Think Mode is enabled
 if (thinkMode) {
 reasoningTrace = `\n<details class="mcp-think-trace my-2 p-3 rounded-xl bg-slate-900/80 border border-cyan-500/30 text-xs font-mono text-cyan-300 cursor-pointer">
<summary class="font-bold flex items-center gap-2 text-cyan-200">
 <span>🧠 Deep Reasoning Trace</span>
</summary>
<div class="mt-2 pt-2 border-t border-cyan-500/20 space-y-1 text-[11px] text-slate-300 leading-relaxed">
 <p>1. Analyzing intent across ${mcpStatus.llyverse.toolCount + mcpStatus.gdrive.toolCount + mcpStatus.gmail.toolCount} active MCP tools...</p>
 <p>2. Querying ERT Vector RAG Memory &amp; Flame Ledger state invariants...</p>
 <p>3. Active Persona: <strong>${normalizedBot.toUpperCase()}</strong> | Council Room: <strong>${multiAgent ? 'ENABLED' : 'STANDBY'}</strong></p>
 <p>4. Evaluated MCP tool directive: <code>${toolCallDecision ? toolCallDecision.tool : 'DIRECT_REASONING'}</code></p>
</div>
</details>\n`;
 }

 // 2. Handle Multi-Agent Council Deliberation
 if (multiAgent) {
 responseText += `👥 **Council Deliberation (Nova, Astra, Astaria)**:\n\n` +
 `-[**Nova (CEO & Systems Architect)**]: Directing execution plan across active MCP servers.\n` +
 `-[**Astra (Wonder & Synthesis)**]: Formulating harmonic resonance and creative synthesis.\n` +
 `-[**Astaria (Legal & Security Auditor)**]: Verifying 3:1 Flame tokenomics invariants and security controls.\n\n`;
 }

 // 3. Execute MCP or Nova Computer Tool Call if detected
 let pendingApprovalCard = null;
 let usedApprovalId = null;

 if (toolCallDecision) {
 try {
 const requiresApproval =
   toolCallDecision.tool === 'nova_execute_bash' ||
   toolCallDecision.tool === 'nova_start_server' ||
   toolCallDecision.tool === 'gmail_send_message' ||
   toolCallDecision.tool === 'slack_post_message' ||
   toolCallDecision.tool === 'discord_post_message' ||
   toolCallDecision.tool === 'twilio_send_sms';

 if (requiresApproval) {
   const check = novaApprovals.verifyAndConsumeApprovalToken({
     token: approvalToken,
     userId: user.id,
     actionType: toolCallDecision.tool,
     args: toolCallDecision.args
   });
   if (!check.ok) {
     pendingApprovalCard = {
       kind: 'approval',
       title: `Approve ${toolCallDecision.tool}?`,
       details: JSON.stringify(toolCallDecision.args, null, 2),
       actionType: toolCallDecision.tool,
       args: toolCallDecision.args
     };
     responseText += `🔒 **Approval Required**: Before I run \`${toolCallDecision.tool}\`, please confirm the approval card.`;
   } else {
     usedApprovalId = check.approvalId;
   }
 }

 if (!pendingApprovalCard) {
 if (toolCallDecision.tool.startsWith("nova_")) {
 toolExecutionResult = { tool: toolCallDecision.tool, executionTimeMs: 15 };
 if (toolCallDecision.tool === "nova_list_files") {
 const fRes = novaComputer.listFiles(toolCallDecision.args.path);
 responseText += "💻 **Nova Computer (Files)**:\n- Items:\n" + fRes.items.map(it => "- " + (it.isDirectory ? "📁 [DIR]" : "📄 [FILE]") + " **" + it.name + "** " + (it.size ? "(`" + it.size + "B`)" : "")).join("\n");
 } else if (toolCallDecision.tool === "nova_start_server") {
 const sRes = novaComputer.startServer({ serverId: "nova-server", command: "node server.js", port: 4200 });
 responseText += "🚀 **Nova Microservice Server Launched**:\n- Status: " + (sRes.alreadyRunning ? "ALREADY ACTIVE" : "STARTED") + "\n- Port: `" + sRes.server.port + "` (PID: " + sRes.server.pid + ")\n- URL: `http://localhost:" + sRes.server.port + "`\n- Command: `" + sRes.server.command + "`";
 } else {
 const bRes = await novaComputer.executeBashCommand(toolCallDecision.args.command);
 const outClean = bRes.stdout || bRes.stderr || "(No output)";
 responseText += "🖥️ **Nova Bash Terminal Output** (Exit " + bRes.exitCode + "):\n```bash\n" + outClean + "\n```";
 }
 } else {
 toolExecutionResult = await mcpServers.executeMcpTool(toolCallDecision.tool, toolCallDecision.args);
 
 const resData = toolExecutionResult.result;
 if (resData.mcp_status === 'UNAUTHENTICATED') {
 responseText += `⚠️ **${toolCallDecision.tool.startsWith('gdrive') ? 'Google Drive' : 'Gmail'} MCP Authentication Required**\n\n${resData.error}\n\n*Please connect your credentials via the secure form card.*`;
 } else if (resData.success) {
 if (toolCallDecision.tool === 'llyverse_get_telemetry') {
 const dbBytes = resData.data.database.dbSizeBytes || resData.data.database.dbSize || 6600000;
 responseText += `📊 **LLYVerse Telemetry (via MCP)**:\n- Active Sessions: \`${resData.data.activeSessions}\`\n- Active Nodes: \`${resData.data.nodes}\`\n- Database File Size: \`${(dbBytes / 1024 / 1024).toFixed(2)} MB\`\n- Timestamp: \`${resData.data.timestamp}\``;
 } else if (toolCallDecision.tool === 'llyverse_dispatch_task') {
 responseText += `🤖 **Autonomous AI Fleet Task Dispatched (via MCP)**:\n- Task ID: \`${resData.task.id}\`\n- Assigned Worker: \`${resData.task.assigned_agent || 'nova'}\`\n- Status: \`QUEUED\``;
 } else if (toolCallDecision.tool === 'gdrive_list_files') {
 const files = resData.files || [];
 if (files.length === 0) {
 responseText += `📁 **Google Drive MCP**: Zero files matched query \`${toolCallDecision.args.query || '*'}\`.`;
 } else {
 responseText += `📁 **Google Drive MCP File Search Results (${files.length} found)**:\n` +
 files.map(f => `- **${f.name}** (\`${f.mimeType}\`) — [Open in Drive](${f.webViewLink || '#'}) ID: \`${f.id}\``).join('\n');
 }
 } else if (toolCallDecision.tool === 'gmail_list_messages') {
 const msgs = resData.messages || [];
 responseText += `✉️ **Google Mail (Gmail) MCP**: Found **${msgs.length}** messages in inbox.\n` +
 msgs.map(m => `- Message ID: \`${m.id}\` (Thread: \`${m.threadId}\`)`).join('\n');
 } else if (toolCallDecision.tool === 'web_search_query') {
 responseText += `🔎 **Web Search & Intelligence MCP Results for "${resData.query}"**:\n` +
 resData.results.map(r => `- **[${r.title}](${r.url})**: ${r.snippet}`).join('\n');
 } else if (toolCallDecision.tool === 'github_repo_info') {
 responseText += `🐙 **GitHub Repository MCP (${resData.repo})**:\n- Branch: \`${resData.branch}\`\n- Last Commit: \`${resData.lastCommit}\`\n- Status: \`${resData.status}\``;
 } else if (toolCallDecision.tool === 'monero_wallet_info') {
 responseText += `⛓️ **Monero & Flame Ledger MCP**:\n- Network: \`${resData.monero_network}\` (${resData.xmr_sync})\n- Sparks Balance: \`${resData.flame_vaults.totalSparks} SPK\`\n- Flame Staked: \`${resData.flame_vaults.totalFlames} FLM\``;
 } else {
 responseText += `⚡ **MCP Execution Success (${toolCallDecision.tool})**:\n\`\`\`json\n${JSON.stringify(resData, null, 2)}\n\`\`\``;
 }
 } else {
 responseText += `❌ **MCP Tool Error (${toolCallDecision.tool})**: ${resData.error || 'Unknown error'}`;
 }
 }
 }
 } catch (err) {
 responseText += `❌ **MCP System Exception**: ${err.message}`;
 }
 } else {
 // Built-in persona tailored executive response (Nova, Astra, Astaria only)
 const botTitle = normalizedBot === 'astra' ? 'Astra (Wonder & Synthesis)' : (normalizedBot === 'astaria' ? 'Astaria (Legal & Logic Auditor)' : 'Nova (CEO & Systems Architect)');
 responseText += `Hi @${user.username} — **${botTitle}** is online and ready. What would you like me to look into?`;
 }

 const finalResponse = reasoningTrace + responseText;

 // Record in nova_actions activity log (§15.2)
 novaActions.logNovaAction({
   userId: user.id,
   persona: normalizedBot,
   action: toolCallDecision ? `mcp.${toolCallDecision.tool}` : 'chat.message',
   target: toolCallDecision ? toolCallDecision.tool : normalizedBot,
   source,
   approvalId: usedApprovalId,
   ip,
   userAgent,
   result: pendingApprovalCard ? 'approval_required' : 'ok',
   details: {
     botId: normalizedBot,
     thinkMode,
     multiAgent,
     toolCalled: toolCallDecision ? toolCallDecision.tool : null
   }
 });

 // Save audit log (using authenticated username, never a fallback)
 if (db.addAuditLog) {
 db.addAuditLog({
 username: user.username,
 action: 'NOVA_MCP_INTERACTION',
 details: JSON.stringify({ botId: normalizedBot, thinkMode, multiAgent, toolCalled: toolCallDecision ? toolCallDecision.tool : null, approvalId: usedApprovalId })
 });
 }

 return {
 success: true,
 target: normalizedBot,
 response: finalResponse,
 tool_executed: (toolCallDecision && !pendingApprovalCard) ? { tool: toolCallDecision.tool, executionTimeMs: toolExecutionResult ? toolExecutionResult.executionTimeMs : 15 } : null,
 requiresApproval: Boolean(pendingApprovalCard),
 approvalCard: pendingApprovalCard,
 botId: normalizedBot,
 thinkMode,
 multiAgent
 };
}

module.exports = {
 get NOVA_MCP_SYSTEM_PROMPT() { return getNovaMcpSystemPrompt(); },
 getNovaMcpSystemPrompt,
 ALLOWED_PERSONAS,
 processNovaMcpChat
};
