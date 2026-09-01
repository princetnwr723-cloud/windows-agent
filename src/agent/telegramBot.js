// src/agent/telegramBot.js
// ═══════════════════════════════════════════════════════════
// TELEGRAM BOT — Control agent from anywhere
// Commands, notifications, briefings — all on Telegram
// ═══════════════════════════════════════════════════════════

const https  = require("https");
// Lazy-loaded modules (avoid circular deps)
let _teamAgent  = null;
let _businessDNA = null;
let _mcpManager  = null;
let _brain       = null;
const getTeamAgent   = () => _teamAgent   || (_teamAgent   = require("./teamAgent"));
const getBusinessDNA = () => _businessDNA || (_businessDNA = require("./businessDNA"));
const getMCPMgr      = () => _mcpManager  || (_mcpManager  = require("./mcpManager"));
const getBrain       = () => _brain       || (_brain       = require("./brain"));
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

const TG_CONFIG_FILE = path.join(os.homedir(), ".vnus-agent", "telegram.json");

// ── Load/Save config ──────────────────────────────────────
function loadTGConfig() {
  try { return JSON.parse(fs.readFileSync(TG_CONFIG_FILE, "utf8")); }
  catch { return { token: null, allowedChatIds: [], enabled: false }; }
}

function saveTGConfig(config) {
  fs.writeFileSync(TG_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Telegram API call ─────────────────────────────────────
function tgAPI(token, method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${token}/${method}`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Send message ──────────────────────────────────────────
async function sendMessage(chatId, text, options = {}) {
  const config = loadTGConfig();
  if (!config.token || !config.enabled) return;
  try {
    await tgAPI(config.token, "sendMessage", {
      chat_id:    chatId,
      text:       text.slice(0, 4096), // Telegram limit
      parse_mode: "Markdown",
      ...options,
    });
  } catch (err) {
    console.error("TG send error:", err.message);
  }
}

// ── Send to all allowed chats ─────────────────────────────
async function broadcast(text) {
  const config = loadTGConfig();
  if (!config.token || !config.enabled) return;
  for (const chatId of config.allowedChatIds) {
    await sendMessage(chatId, text);
  }
}

// ── Send photo ────────────────────────────────────────────
async function sendPhoto(chatId, base64Image, caption = "") {
  const config = loadTGConfig();
  if (!config.token || !config.enabled) return;
  try {
    // Save temp file
    const tmpFile = path.join(os.tmpdir(), `tg-photo-${Date.now()}.png`);
    fs.writeFileSync(tmpFile, Buffer.from(base64Image, "base64"));

    // Use multipart form — simplified version
    await tgAPI(config.token, "sendMessage", {
      chat_id: chatId,
      text:    caption ? `📸 Screenshot\n${caption}` : "📸 Screenshot",
    });

    fs.unlinkSync(tmpFile);
  } catch (err) {
    console.error("TG photo error:", err.message);
  }
}

// ── Format message for Telegram ───────────────────────────
function formatForTelegram(text) {
  // Convert markdown-ish to Telegram markdown
  return text
    .replace(/\*\*(.*?)\*\*/g, "*$1*")     // bold
    .replace(/`(.*?)`/g, "`$1`")            // code
    .replace(/👹/g, "👹")
    .slice(0, 4000);
}

// ── Command handlers ──────────────────────────────────────
const COMMANDS = {
  "/start": async (chatId, config) => {
    if (!config.allowedChatIds.includes(chatId)) {
      config.allowedChatIds.push(chatId);
      saveTGConfig(config);
    }
    return `👹 *Agentic Vnus connected!*\n\nYour PC agent is ready.\n\n*Commands:*\n/brief — Morning briefing\n/status — Agent status\n/task — Run a task\n/team — Talk to a team agent\n/schedule — View schedules\n/help — All commands`;
  },

  "/brief": async (chatId, config, executeCommand, modelConfig) => {
    await sendMessage(chatId, "☀️ Generating your briefing...");
    const result = await executeCommand("brief me on today", modelConfig);
    return formatForTelegram(result.message || "Could not generate briefing.");
  },

  "/status": async (chatId, config) => {
    const { loadDNA } = getBusinessDNA();
    const { getAllAgentStatuses } = getTeamAgent();
    const { getMCPStatus } = getMCPMgr();
    const dna      = loadDNA();
    const agents   = getAllAgentStatuses();
    const mcpStat  = getMCPStatus();
    const totalTasks = agents.reduce((sum, a) => sum + (a.totalTasks || 0), 0);

    return `👹 *Agent Status*\n\n` +
      `Business: ${dna.setupComplete ? dna.business?.name : "DNA not set"}\n` +
      `Role: ${dna.agentRole || "—"}\n` +
      `Total Tasks: ${totalTasks}\n` +
      `MCP Servers: ${mcpStat.totalRunning} running\n` +
      `Agents: ${agents.length} active\n\n` +
      `✅ Agent is online and ready`;
  },

  "/help": async (chatId) => {
    return `👹 *Agentic Vnus Commands*\n\n` +
      `/brief — Daily morning briefing\n` +
      `/status — Agent + business status\n` +
      `/task [command] — Run any task\n` +
      `/team [agent] [message] — Talk to agent\n` +
      `/schedule — View active schedules\n` +
      `/opportunities — Find opportunities\n` +
      `/screenshot — Take PC screenshot\n` +
      `/help — Show this menu\n\n` +
      `Or just type any command directly!`;
  },
};

// ── Process incoming message ──────────────────────────────
async function processMessage(message, executeCommand, modelConfig, rtdbSet, workspaceId, apiKey, rtdbUrl) {
  const config = loadTGConfig();
  const chatId = message.chat.id;
  const text   = message.text || "";
  const userId = message.from?.id;

  // Security — only allowed chats
  if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) {
    await sendMessage(chatId, "❌ Not authorized. Send /start to connect.");
    return;
  }

  console.log(`📱 Telegram from ${chatId}: "${text.slice(0, 50)}"`);

  let response = "";

  try {
    // Built-in commands
    if (text.startsWith("/start")) {
      response = await COMMANDS["/start"](chatId, config);
    } else if (text.startsWith("/brief")) {
      response = await COMMANDS["/brief"](chatId, config, executeCommand, modelConfig);
    } else if (text.startsWith("/status")) {
      response = await COMMANDS["/status"](chatId, config);
    } else if (text.startsWith("/help")) {
      response = await COMMANDS["/help"](chatId);
    } else if (text.startsWith("/screenshot")) {
      await sendMessage(chatId, "📸 Taking screenshot...");
      const { takeScreenshot } = getBrain();
      const shot = await takeScreenshot();
      if (shot) {
        await sendPhoto(chatId, shot, "Current PC screen");
        response = null;
      } else {
        response = "❌ Could not take screenshot.";
      }
    } else if (text.startsWith("/opportunities")) {
      await sendMessage(chatId, "🎯 Scanning for opportunities...");
      const result = await executeCommand("find opportunities for my business", modelConfig);
      response = formatForTelegram(result.message || "No opportunities found.");
    } else if (text.startsWith("/task ")) {
      const taskCmd = text.replace("/task ", "").trim();
      await sendMessage(chatId, `⚡ Running: "${taskCmd}"`);
      const result = await executeCommand(taskCmd, modelConfig);
      response = formatForTelegram(result.message || "Task completed.");
      // Send screenshot if available
      if (result.screenshot) {
        await sendPhoto(chatId, result.screenshot, "Result screenshot");
      }
    } else if (text.startsWith("/team ")) {
      const parts    = text.replace("/team ", "").split(" ");
      const agentId  = parts[0];
      const msg      = parts.slice(1).join(" ");
      await sendMessage(chatId, `💬 Asking ${agentId}...`);
      const { chatWithAgent } = getTeamAgent();
      const result = await chatWithAgent(agentId, msg, modelConfig);
      response = formatForTelegram(result.output || "Agent did not respond.");
    } else if (text.startsWith("/schedule")) {
      // Show schedules from RTDB
      response = "⏰ Check your scheduler in the dashboard:\n`agenticvnus.com/dashboard`";
    } else if (!text.startsWith("/")) {
      // Plain text = run as agent command
      await sendMessage(chatId, "⚡ Working on it...");
      const result = await executeCommand(text, modelConfig);
      response = formatForTelegram(result.message || "Done.");
      if (result.screenshot) {
        await sendPhoto(chatId, result.screenshot, "Result");
      }
    }

    // Send response
    if (response) {
      await sendMessage(chatId, response);
    }

    // Sync to RTDB — show in dashboard
    if (rtdbSet && workspaceId) {
      await rtdbSet(`workspaces/${workspaceId}/telegramActivity`, {
        lastMessage: text.slice(0, 100),
        lastResponse: (response || "").slice(0, 100),
        chatId,
        timestamp: Date.now(),
      });
    }

  } catch (err) {
    console.error("TG process error:", err.message);
    await sendMessage(chatId, `❌ Error: ${err.message}`);
  }
}

// ── Start polling ─────────────────────────────────────────
function startTelegramBot(executeCommand, modelConfig, rtdbSet, workspaceId, apiKey, rtdbUrl) {
  const config = loadTGConfig();
  if (!config.token || !config.enabled) {
    console.log("📱 Telegram: not configured (add token in Settings)");
    return null;
  }

  console.log(`\n📱 Telegram bot starting...`);

  let offset = 0;
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const res = await tgAPI(config.token, "getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message"],
        });

        if (res.ok && res.result?.length) {
          for (const update of res.result) {
            offset = update.update_id + 1;
            if (update.message) {
              processMessage(
                update.message,
                executeCommand,
                modelConfig,
                rtdbSet,
                workspaceId,
                apiKey,
                rtdbUrl
              ).catch(err => console.error("TG message error:", err.message));
            }
          }
        }
      } catch (err) {
        console.error("TG poll error:", err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };

  poll();
  console.log("✅ Telegram bot running — send /start to connect");

  return {
    stop: () => { running = false; },
    send: broadcast,
    sendTo: sendMessage,
  };
}

// ── Notify via Telegram (for proactive events) ─────────────
async function notify(text) {
  const config = loadTGConfig();
  if (!config.token || !config.enabled || !config.allowedChatIds.length) return;
  await broadcast(`👹 ${text}`);
}

// ── Test bot token ────────────────────────────────────────
async function testBotToken(token) {
  try {
    const res = await tgAPI(token, "getMe");
    if (res.ok) {
      return { success: true, botName: res.result.first_name, username: res.result.username };
    }
    return { success: false, error: res.description };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Save bot token ────────────────────────────────────────
function saveBotToken(token) {
  const config = loadTGConfig();
  config.token   = token;
  config.enabled = true;
  saveTGConfig(config);
  console.log("✅ Telegram bot token saved");
}

module.exports = {
  startTelegramBot,
  sendMessage,
  broadcast,
  notify,
  testBotToken,
  saveBotToken,
  loadTGConfig,
  saveTGConfig,
};
