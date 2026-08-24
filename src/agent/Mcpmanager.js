// src/agent/mcpManager.js
// ═══════════════════════════════════════════════════════════
// MCP Manager — Connect any MCP server
// User dashboard se add kare → agent use kare
// Supports: NPM packages, GitHub repos, local, HTTP
// ═══════════════════════════════════════════════════════════

const { execSync, spawn } = require("child_process");
const path   = require("path");
const fs     = require("fs");
const os     = require("os");
const https  = require("https");

const MCP_DIR      = path.join(os.homedir(), ".vnus-agent", "mcp");
const MCP_CONFIG   = path.join(MCP_DIR, "servers.json");
const MCP_LOGS_DIR = path.join(MCP_DIR, "logs");

if (!fs.existsSync(MCP_DIR))      fs.mkdirSync(MCP_DIR, { recursive: true });
if (!fs.existsSync(MCP_LOGS_DIR)) fs.mkdirSync(MCP_LOGS_DIR, { recursive: true });

// ── Running MCP processes ─────────────────────────────────
const runningServers = new Map(); // id → { process, tools }

// ── Built-in MCP definitions ──────────────────────────────
const BUILTIN_MCPS = [
  {
    id:          "filesystem",
    name:        "Filesystem",
    icon:        "📁",
    description: "Read, write, and manage files on your PC",
    package:     "@modelcontextprotocol/server-filesystem",
    args:        [os.homedir()],
    category:    "system",
    official:    true,
  },
  {
    id:          "brave-search",
    name:        "Web Search",
    icon:        "🔍",
    description: "Real-time web search in every task",
    package:     "@modelcontextprotocol/server-brave-search",
    envRequired: ["BRAVE_API_KEY"],
    category:    "search",
    official:    true,
  },
  {
    id:          "github-mcp",
    name:        "GitHub Enhanced",
    icon:        "🐙",
    description: "Enhanced GitHub — more operations than REST API",
    package:     "@modelcontextprotocol/server-github",
    envRequired: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    category:    "dev",
    official:    true,
  },
  {
    id:          "google-drive",
    name:        "Google Drive",
    icon:        "📂",
    description: "Access and manage Google Drive files",
    package:     "@modelcontextprotocol/server-google-drive",
    category:    "google",
    official:    true,
  },
  {
    id:          "slack",
    name:        "Slack",
    icon:        "💬",
    description: "Send messages, read channels, manage workspace",
    package:     "@modelcontextprotocol/server-slack",
    envRequired: ["SLACK_BOT_TOKEN"],
    category:    "communication",
    official:    true,
  },
  {
    id:          "postgres",
    name:        "PostgreSQL",
    icon:        "🗄️",
    description: "Direct database access and query execution",
    package:     "@modelcontextprotocol/server-postgres",
    envRequired: ["DATABASE_URL"],
    category:    "database",
    official:    true,
  },
  {
    id:          "puppeteer",
    name:        "Puppeteer Browser",
    icon:        "🌐",
    description: "Enhanced browser automation via Puppeteer",
    package:     "@modelcontextprotocol/server-puppeteer",
    category:    "browser",
    official:    true,
  },
  {
    id:          "memory-mcp",
    name:        "Enhanced Memory",
    icon:        "🧠",
    description: "Vector-based persistent memory with semantic search",
    package:     "@modelcontextprotocol/server-memory",
    category:    "memory",
    official:    true,
  },
];

// ── Load saved MCP config ─────────────────────────────────
function loadMCPConfig() {
  try {
    return JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8"));
  } catch {
    return { servers: [] };
  }
}

function saveMCPConfig(config) {
  fs.writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2));
}

// ── Install MCP server ────────────────────────────────────
async function installMCPServer(source, type = "npm") {
  const installDir = path.join(MCP_DIR, "servers");
  if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

  console.log(`📦 Installing MCP: ${source}`);

  if (type === "npm") {
    execSync(`npm install -g ${source} --prefix "${installDir}"`, {
      stdio: "pipe",
      timeout: 120000,
    });
    return path.join(installDir, "node_modules", ".bin", source.split("/").pop());
  }

  if (type === "github") {
    const repoName = source.split("/").pop();
    const repoDir  = path.join(installDir, repoName);
    execSync(`git clone https://github.com/${source} "${repoDir}"`, { stdio: "pipe" });
    execSync(`cd "${repoDir}" && npm install`, { stdio: "pipe" });
    return repoDir;
  }

  if (type === "local") {
    return source; // already installed
  }

  return null;
}

// ── Start MCP server process ──────────────────────────────
async function startMCPServer(serverConfig) {
  const { id, command, args, env } = serverConfig;

  if (runningServers.has(id)) {
    console.log(`⚡ MCP already running: ${id}`);
    return true;
  }

  const logFile = path.join(MCP_LOGS_DIR, `${id}.log`);

  try {
    const proc = spawn(command, args || [], {
      env:   { ...process.env, ...env },
      stdio: ["pipe", "pipe", fs.openSync(logFile, "a")],
    });

    const serverData = {
      process: proc,
      tools:   [],
      id,
      name:    serverConfig.name,
      icon:    serverConfig.icon,
    };

    runningServers.set(id, serverData);

    // Initialize — list tools
    await new Promise(resolve => setTimeout(resolve, 1500));
    const tools = await listMCPTools(id);
    serverData.tools = tools;

    console.log(`✅ MCP started: ${serverConfig.name} (${tools.length} tools)`);
    return true;
  } catch (err) {
    console.error(`❌ MCP start failed: ${id} — ${err.message}`);
    return false;
  }
}

// ── Stop MCP server ───────────────────────────────────────
function stopMCPServer(id) {
  const server = runningServers.get(id);
  if (!server) return;
  try {
    server.process.kill();
    runningServers.delete(id);
    console.log(`🛑 MCP stopped: ${id}`);
  } catch {}
}

// ── List tools from MCP server ────────────────────────────
async function listMCPTools(serverId) {
  return new Promise((resolve) => {
    const server = runningServers.get(serverId);
    if (!server) return resolve([]);

    const request = JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "tools/list",
      params:  {},
    }) + "\n";

    let response = "";
    const timeout = setTimeout(() => resolve([]), 5000);

    server.process.stdout.once("data", (data) => {
      clearTimeout(timeout);
      response += data.toString();
      try {
        const json = JSON.parse(response.split("\n")[0]);
        resolve(json.result?.tools || []);
      } catch {
        resolve([]);
      }
    });

    server.process.stdin.write(request);
  });
}

// ── Call MCP tool ─────────────────────────────────────────
async function callMCPTool(serverId, toolName, params) {
  return new Promise((resolve, reject) => {
    const server = runningServers.get(serverId);
    if (!server) return reject(new Error(`MCP server not running: ${serverId}`));

    const request = JSON.stringify({
      jsonrpc: "2.0",
      id:      Date.now(),
      method:  "tools/call",
      params:  { name: toolName, arguments: params },
    }) + "\n";

    let response = "";
    const timeout = setTimeout(() => reject(new Error("MCP timeout")), 30000);

    server.process.stdout.once("data", (data) => {
      clearTimeout(timeout);
      response += data.toString();
      try {
        const json   = JSON.parse(response.split("\n")[0]);
        const result = json.result?.content?.[0]?.text || JSON.stringify(json.result);
        resolve(result);
      } catch (err) {
        reject(new Error("MCP parse error: " + err.message));
      }
    });

    server.process.stdin.write(request);
  });
}

// ── Add new MCP server ────────────────────────────────────
async function addMCPServer(config) {
  // config = { id, name, icon, source, type, env, args, description }
  const mcpConfig = loadMCPConfig();

  // Check duplicate
  if (mcpConfig.servers.find(s => s.id === config.id)) {
    return { success: false, error: "Server already exists" };
  }

  let command = null;

  // Install based on type
  if (config.type === "npm") {
    command = await installMCPServer(config.source, "npm");
    command = `node`;
    config.args = [
      path.join(MCP_DIR, "servers", "node_modules", config.source, "dist", "index.js"),
      ...(config.args || []),
    ];
  } else if (config.type === "github") {
    const installPath = await installMCPServer(config.source, "github");
    command = "node";
    config.args = [path.join(installPath, "index.js")];
  } else if (config.type === "local") {
    command = "node";
    config.args = [config.source];
  } else if (config.type === "http") {
    // HTTP-based MCP — no process needed
    command = "http";
  }

  const serverEntry = {
    ...config,
    command,
    enabled:   true,
    addedAt:   new Date().toISOString(),
  };

  mcpConfig.servers.push(serverEntry);
  saveMCPConfig(mcpConfig);

  // Start it
  if (command !== "http") {
    const started = await startMCPServer(serverEntry);
    if (!started) return { success: false, error: "Failed to start MCP server" };
  }

  console.log(`✅ MCP added: ${config.name}`);
  return { success: true, server: serverEntry };
}

// ── Remove MCP server ─────────────────────────────────────
function removeMCPServer(id) {
  stopMCPServer(id);
  const config = loadMCPConfig();
  config.servers = config.servers.filter(s => s.id !== id);
  saveMCPConfig(config);
  console.log(`🗑️ MCP removed: ${id}`);
}

// ── Get all tools across all running servers ───────────────
function getAllMCPTools() {
  const tools = [];
  for (const [id, server] of runningServers) {
    server.tools.forEach(tool => {
      tools.push({
        ...tool,
        serverId:   id,
        serverName: server.name,
        serverIcon: server.icon,
      });
    });
  }
  return tools;
}

// ── Build MCP context for AI ──────────────────────────────
function buildMCPPrompt() {
  const tools = getAllMCPTools();
  if (!tools.length) return "";

  let prompt = "\n═══ MCP TOOLS AVAILABLE ═══\n";
  prompt += "You have access to these MCP tools:\n";

  const grouped = {};
  tools.forEach(t => {
    if (!grouped[t.serverName]) grouped[t.serverName] = [];
    grouped[t.serverName].push(t);
  });

  Object.entries(grouped).forEach(([serverName, serverTools]) => {
    prompt += `\n${serverName}:\n`;
    serverTools.forEach(t => {
      prompt += `  - ${t.name}: ${t.description || ""}\n`;
    });
  });

  prompt += `
To use an MCP tool, include this action:
{"action":"mcp_call","server":"server-id","tool":"tool-name","params":{}}

═══════════════════════\n`;

  return prompt;
}

// ── Get status for dashboard ──────────────────────────────
function getMCPStatus() {
  const config  = loadMCPConfig();
  const running = Array.from(runningServers.keys());

  const builtin = BUILTIN_MCPS.map(b => ({
    ...b,
    installed: config.servers.find(s => s.id === b.id)?.enabled || false,
    running:   running.includes(b.id),
    toolCount: runningServers.get(b.id)?.tools?.length || 0,
  }));

  const custom = config.servers
    .filter(s => !BUILTIN_MCPS.find(b => b.id === s.id))
    .map(s => ({
      ...s,
      running:   running.includes(s.id),
      toolCount: runningServers.get(s.id)?.tools?.length || 0,
    }));

  return { builtin, custom, totalRunning: running.length };
}

// ── Init — start all enabled servers on boot ───────────────
async function initMCPManager() {
  const config = loadMCPConfig();
  console.log(`\n🔌 MCP Manager starting: ${config.servers.length} servers configured`);

  for (const server of config.servers) {
    if (server.enabled) {
      await startMCPServer(server).catch(err => {
        console.error(`Failed to start ${server.name}: ${err.message}`);
      });
    }
  }

  console.log(`✅ MCP Manager ready: ${runningServers.size} servers running`);
}

module.exports = {
  BUILTIN_MCPS,
  initMCPManager,
  addMCPServer,
  removeMCPServer,
  startMCPServer,
  stopMCPServer,
  callMCPTool,
  listMCPTools,
  getAllMCPTools,
  buildMCPPrompt,
  getMCPStatus,
  loadMCPConfig,
};
