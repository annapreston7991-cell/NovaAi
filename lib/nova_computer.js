/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova OS & Computer Subsystem Service
 * Provides an isolated Linux environment (workspace), Thunar-style visual file manager,
 * code editor, bash terminal emulator, and background server process runner.
 */

const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const WORKSPACE_DIR = path.resolve(process.env.NOVA_WORKSPACE_DIR || '/home/lily/nova-computer/workspace');
const NOVA_BASE_DIR = path.dirname(WORKSPACE_DIR);

// In-memory registry for Nova's active servers and background processes
const activeServers = new Map();
const activeCommands = new Set();

// Ensure base directories exist and seed default starter project
function initNovaComputer() {
  if (!fs.existsSync(NOVA_BASE_DIR)) {
    fs.mkdirSync(NOVA_BASE_DIR, { recursive: true });
  }
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  // Seed default server and code files if workspace is empty
  const defaultFiles = [
    {
      file: 'server.js',
      content: `// Nova's Autonomous Microservice
const http = require('http');
const PORT = process.env.PORT || 4200;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ONLINE',
    author: 'Nova (Autonomous CEO & Systems Architect)',
    node: 'Nova-Linux-Station',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    message: 'Greetings from Nova microservice running on port ' + PORT
  }, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(\`[Nova Server] Listening at http://localhost:\${PORT}\`);
});
`
    },
    {
      file: 'README.md',
      content: `# Nova Linux Computer System
Welcome to Nova's private Linux workstation running File Manager, Bash Terminal, Code Studio, and Autonomous Server Runner.

- **Workspace**: \`~/workspace\`
- **Terminal Shell**: \`/bin/bash\`
- **File Manager**: Workspace File Browser & Tree
- **Background Servers**: Autonomous HTTP server runner on ports 4200-4299
`
    },
    {
      file: 'package.json',
      content: JSON.stringify({
        name: 'nova-microservices',
        version: '1.0.0',
        description: 'Nova autonomous microservice backend',
        main: 'server.js',
        scripts: {
          start: 'node server.js'
        }
      }, null, 2)
    }
  ];

  for (const item of defaultFiles) {
    const target = path.join(WORKSPACE_DIR, item.file);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, item.content, 'utf8');
    }
  }

  // Subdirectories for organization
  const subDirs = ['src', 'public', 'logs'];
  for (const dir of subDirs) {
    const dPath = path.join(WORKSPACE_DIR, dir);
    if (!fs.existsSync(dPath)) {
      fs.mkdirSync(dPath, { recursive: true });
    }
  }

  const srcIndex = path.join(WORKSPACE_DIR, 'src', 'index.js');
  if (!fs.existsSync(srcIndex)) {
    fs.writeFileSync(srcIndex, `// Nova Core Logic Module\nmodule.exports = { version: '2.0.0', name: 'NovaCore' };\n`, 'utf8');
  }
}

initNovaComputer();

function resolveSafePath(targetRelPath = '') {
  const safeRel = path.normalize(String(targetRelPath || '')).replace(/^(\.\.[\/\\])+/, '');
  const absPath = path.resolve(WORKSPACE_DIR, safeRel);
  const realWorkspace = fs.existsSync(WORKSPACE_DIR) ? fs.realpathSync(WORKSPACE_DIR) : WORKSPACE_DIR;

  if (absPath !== WORKSPACE_DIR && !absPath.startsWith(WORKSPACE_DIR + path.sep)) {
    return WORKSPACE_DIR;
  }

  // Symlink escape guard
  try {
    const checkTarget = fs.existsSync(absPath) ? absPath : path.dirname(absPath);
    if (fs.existsSync(checkTarget)) {
      const realTarget = fs.realpathSync(checkTarget);
      if (realTarget !== realWorkspace && !realTarget.startsWith(realWorkspace + path.sep)) {
        return WORKSPACE_DIR;
      }
    }
  } catch (e) {
    return WORKSPACE_DIR;
  }

  return absPath;
}

/**
 * List directory entries formatted for Thunar file explorer
 */
function listFiles(relPath = '') {
  const absPath = resolveSafePath(relPath);
  if (!fs.existsSync(absPath)) {
    return { success: false, error: 'Directory does not exist' };
  }

  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) {
    return { success: false, error: 'Target path is not a directory' };
  }

  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const items = entries.map(ent => {
    const entPath = path.join(absPath, ent.name);
    let entStat;
    try {
      entStat = fs.statSync(entPath);
    } catch (e) {
      entStat = { size: 0, mtime: new Date() };
    }

    const itemRel = path.relative(WORKSPACE_DIR, entPath);

    return {
      name: ent.name,
      path: itemRel,
      isDirectory: ent.isDirectory(),
      size: ent.isDirectory() ? null : entStat.size,
      mtime: entStat.mtime,
      ext: ent.isDirectory() ? 'dir' : path.extname(ent.name).toLowerCase().replace('.', '')
    };
  });

  // Sort folders first, then alphabetical
  items.sort((a, b) => {
    if (a.isDirectory === b.isDirectory) {
      return a.name.localeCompare(b.name);
    }
    return a.isDirectory ? -1 : 1;
  });

  const currentRel = path.relative(WORKSPACE_DIR, absPath);

  return {
    success: true,
    currentPath: currentRel || '',
    absolutePath: absPath,
    items
  };
}

/**
 * Read file content
 */
function readFile(relPath) {
  const absPath = resolveSafePath(relPath);
  if (!fs.existsSync(absPath)) {
    return { success: false, error: 'File does not exist' };
  }
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return { success: false, error: 'Path is a directory, not a file' };
  }

  try {
    const content = fs.readFileSync(absPath, 'utf8');
    return {
      success: true,
      path: path.relative(WORKSPACE_DIR, absPath),
      content,
      size: stat.size,
      mtime: stat.mtime
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Write or save file content
 */
function writeFile(relPath, content) {
  const absPath = resolveSafePath(relPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    fs.writeFileSync(absPath, content, 'utf8');
    const stat = fs.statSync(absPath);
    const outRel = path.relative(WORKSPACE_DIR, absPath);
    try {
      require('./nova_screen').recordFsChange('write', outRel);
    } catch (e) {}
    return {
      success: true,
      path: outRel,
      size: stat.size,
      mtime: stat.mtime
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Create folder
 */
function createFolder(relPath) {
  const absPath = resolveSafePath(relPath);
  try {
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(absPath, { recursive: true });
    }
    const outRel = path.relative(WORKSPACE_DIR, absPath);
    try {
      require('./nova_screen').recordFsChange('mkdir', outRel);
    } catch (e) {}
    return { success: true, path: outRel };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Delete file or folder
 */
function deleteItem(relPath) {
  const absPath = resolveSafePath(relPath);
  if (absPath === WORKSPACE_DIR) {
    return { success: false, error: 'Cannot delete root workspace' };
  }
  if (!fs.existsSync(absPath)) {
    return { success: false, error: 'Item does not exist' };
  }

  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      fs.rmSync(absPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(absPath);
    }
    try {
      require('./nova_screen').recordFsChange('delete', relPath);
    } catch (e) {}
    return { success: true, path: relPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Execute command in Nova's computer shell
 */
function executeBashCommand(command, cwdRel = '') {
  return new Promise((resolve) => {
    let execCwd = cwdRel ? resolveSafePath(cwdRel) : WORKSPACE_DIR;
    const trimmed = (command || '').trim();

    // Built-in cd navigation handling for persistent directory context
    if (trimmed === 'cd' || trimmed === 'cd ~' || trimmed === 'cd /') {
      return resolve({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        cwd: ''
      });
    }

    if (trimmed.startsWith('cd ')) {
      const targetDir = trimmed.slice(3).trim().replace(/^['"]|['"]$/g, '');
      let resolvedTarget;
      if (targetDir === '~' || targetDir === '/') {
        resolvedTarget = WORKSPACE_DIR;
      } else if (targetDir === '.') {
        resolvedTarget = execCwd;
      } else {
        resolvedTarget = path.resolve(execCwd, targetDir);
      }

      // Security check: must remain inside WORKSPACE_DIR
      if (!resolvedTarget.startsWith(WORKSPACE_DIR)) {
        resolvedTarget = WORKSPACE_DIR;
      }

      if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
        const newRel = path.relative(WORKSPACE_DIR, resolvedTarget);
        return resolve({
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          cwd: newRel
        });
      } else {
        return resolve({
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `cd: no such file or directory: ${targetDir}`,
          cwd: path.relative(WORKSPACE_DIR, execCwd)
        });
      }
    }

    // Safety timeout: 15 seconds, output cap: 512 KB
    const child = exec(command, {
      cwd: execCwd,
      timeout: 15000,
      maxBuffer: 512 * 1024,
      env: {
        ...process.env,
        HOME: NOVA_BASE_DIR,
        USER: 'nova',
        NODE_ENV: 'development',
        WORKSPACE: WORKSPACE_DIR
      }
    }, (error, stdout, stderr) => {
      activeCommands.delete(child);
      const outStdout = String(stdout || '').slice(0, 65536);
      const outStderr = String(stderr || (error ? error.message : '')).slice(0, 65536);
      const code = error ? (error.code || 1) : 0;
      try {
        require('./nova_screen').recordTerminalActivity(command, outStdout, outStderr, code);
      } catch (e) {}
      resolve({
        success: !error,
        exitCode: code,
        stdout: outStdout,
        stderr: outStderr,
        cwd: path.relative(WORKSPACE_DIR, execCwd)
      });
    });
    activeCommands.add(child);
  });
}

/**
 * Start a server or long-running microservice
 */
function startServer({ serverId = 'nova-server', command = 'node server.js', port = 4200 }) {
  // If already running, return existing info
  if (activeServers.has(serverId)) {
    const existing = activeServers.get(serverId);
    return {
      success: true,
      alreadyRunning: true,
      server: {
        id: serverId,
        port: existing.port,
        pid: existing.pid,
        command: existing.command,
        startedAt: existing.startedAt,
        status: 'RUNNING'
      }
    };
  }

  try {
    const logPath = path.join(WORKSPACE_DIR, 'logs', `${serverId}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const parts = command.split(' ');
    const cmdBin = parts[0];
    const cmdArgs = parts.slice(1);

    const child = spawn(cmdBin, cmdArgs, {
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        HOME: NOVA_BASE_DIR,
        USER: 'nova'
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    const serverEntry = {
      id: serverId,
      port,
      command,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      child,
      logPath
    };

    child.on('exit', () => {
      activeServers.delete(serverId);
    });

    activeServers.set(serverId, serverEntry);

    return {
      success: true,
      server: {
        id: serverId,
        port,
        pid: child.pid,
        command,
        startedAt: serverEntry.startedAt,
        status: 'RUNNING'
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Stop a running server
 */
function stopServer(serverId = 'nova-server') {
  if (!activeServers.has(serverId)) {
    return { success: false, error: 'Server is not running' };
  }

  const s = activeServers.get(serverId);
  try {
    if (s.child) {
      process.kill(-s.child.pid, 'SIGTERM');
    }
  } catch (e) {
    try {
      if (s.child) s.child.kill();
    } catch (e2) {}
  }

  activeServers.delete(serverId);
  return { success: true, message: `Server ${serverId} stopped.` };
}

/**
 * Kill all active terminal commands and servers (invoked by Stop Nova §15.2)
 */
function stopAllProcesses() {
  let killedCommands = 0;
  for (const child of activeCommands) {
    try {
      child.kill('SIGKILL');
      killedCommands++;
    } catch (e) {}
  }
  activeCommands.clear();

  let stoppedServers = 0;
  for (const serverId of Array.from(activeServers.keys())) {
    stopServer(serverId);
    stoppedServers++;
  }
  return { killedCommands, stoppedServers };
}

// Register with Nova kill switch if available
try {
  const novaActions = require('./nova_actions');
  if (novaActions && novaActions.registerStopHandler) {
    novaActions.registerStopHandler(() => stopAllProcesses());
  }
} catch (e) {}

/**
 * Reset Nova's workspace cleanly (stops all processes, wipes workspace, re-seeds defaults)
 */
function resetWorkspace() {
  stopAllProcesses();
  try {
    if (fs.existsSync(WORKSPACE_DIR)) {
      const entries = fs.readdirSync(WORKSPACE_DIR);
      for (const entry of entries) {
        const target = path.join(WORKSPACE_DIR, entry);
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    initNovaComputer();
    try {
      require('./nova_screen').recordFsChange('reset', '/');
    } catch (e) {}
    return { success: true, message: 'Workspace reset to clean starter template.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * List all running servers and processes
 */
function getServersStatus() {
  const list = [];
  for (const [id, s] of activeServers.entries()) {
    list.push({
      id,
      port: s.port,
      pid: s.pid,
      command: s.command,
      startedAt: s.startedAt,
      status: 'RUNNING',
      url: `http://localhost:${s.port}`
    });
  }
  return list;
}

module.exports = {
  NOVA_BASE_DIR,
  WORKSPACE_DIR,
  initNovaComputer,
  resolveSafePath,
  listFiles,
  readFile,
  writeFile,
  createFolder,
  deleteItem,
  executeBashCommand,
  startServer,
  stopServer,
  stopAllProcesses,
  resetWorkspace,
  getServersStatus
};
