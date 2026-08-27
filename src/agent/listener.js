// src/agent/listener.js
// ✅ Firebase Realtime Database WebSocket — zero polling (original)
// ✅ Rate limiting + ownership verification (original)
// ✅ Skills sync to RTDB (original)
// ✅ Screenshot listener (original)
// ✅ Heartbeat (original)
// ✅ Business DNA setup flow handling (new)
// ✅ Team progress sync to RTDB (new)
// ✅ Proactive scheduler — briefing + opportunities (new)

const { executeCommand, setAgentContext, takeScreenshot } = require("./brain");
const { listSkills }                       = require("./skills");
const { loadMemory }                       = require("./memory");
const { isDNASetup, loadDNA }              = require("./businessDNA");
const { generateMorningBriefing, monitorCompetitors, scanForOpportunities, generateWeeklyReport, checkDNAHealth } = require("./proactiveAgent");
const { handleConnectorAction, syncConnectorsToRTDB } = require("./connectorHandler");
const { initMCPManager, addMCPServer, removeMCPServer, startMCPServer, stopMCPServer, getMCPStatus, buildMCPPrompt, BUILTIN_MCPS } = require("./mcpManager");
const { listMacros, deleteMacro } = require("./demonstrationRecorder");
const { listTasks, getTasksNeedingApproval, resumeTask, deleteTask } = require("./sessionPersistence");
const { startTelegramBot, notify, loadTGConfig, saveBotToken, testBotToken, saveTGConfig } = require("./telegramBot");
const { chatWithAgent, executeTeamTask, getAllAgentStatuses, getRecentLog, addToLog } = require("./teamAgent");
const https                                = require("https");
const http                                 = require("http");

const MAX_PER_MIN = 20;
const rateLimiter = new Map();

// ── Rate-limit tracker for approval notifications ──────────
const lastApprovalNotify = {};

function isRateLimited(userId) {
  if (!userId) return false;
  const now  = Date.now();
  const data = rateLimiter.get(userId) || { count:0, resetAt:now+60000 };
  if (now > data.resetAt) { data.count=0; data.resetAt=now+60000; }
  data.count++;
  rateLimiter.set(userId, data);
  return data.count > MAX_PER_MIN;
}

// ── RTDB REST helpers (original) ─────────────────────────
function rtdbGet(rtdbUrl, path, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `${rtdbUrl}${path}.json?auth=${apiKey}`;
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on("error", reject);
  });
}

function rtdbSet(rtdbUrl, path, data, apiKey, method = "PUT") {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(data);
    const urlObj  = new URL(`${rtdbUrl}${path}.json?auth=${apiKey}`);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method,
      headers: { "Content-Type":"application/json", "Content-Length":Buffer.byteLength(body) },
    };
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(options, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d || "null")));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function rtdbPatch(rtdbUrl, path, data, apiKey) {
  return rtdbSet(rtdbUrl, path, data, apiKey, "PATCH");
}

function rtdbDelete(rtdbUrl, path, apiKey) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(`${rtdbUrl}${path}.json?auth=${apiKey}`);
    const options = { hostname:urlObj.hostname, path:urlObj.pathname+urlObj.search, method:"DELETE" };
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(options, (res) => { res.on("data",()=>{}); res.on("end", resolve); });
    req.on("error", reject);
    req.end();
  });
}

// ── Firebase RTDB SSE listener (original) ─────────────────
function listenRTDB(rtdbUrl, path, apiKey, onData) {
  const url     = `${rtdbUrl}${path}.json?auth=${apiKey}`;
  const urlObj  = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   "GET",
    headers:  { "Accept":"text/event-stream", "Cache-Control":"no-cache" },
  };
  const mod = urlObj.protocol === "https:" ? https : http;
  let retry = 1000;

  function connect() {
    const req = mod.request(options, (res) => {
      retry = 1000;
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let event = null, dataStr = "";
        for (const line of lines) {
          if (line.startsWith("event: "))      event   = line.slice(7).trim();
          else if (line.startsWith("data: "))  dataStr = line.slice(6).trim();
          else if (line === "" && event && dataStr) {
            try { const parsed = JSON.parse(dataStr); onData(event, parsed); } catch {}
            event = null; dataStr = "";
          }
        }
      });
      res.on("end", () => { console.warn("⚠️ RTDB closed — reconnecting..."); setTimeout(connect, retry); retry = Math.min(retry*2, 30000); });
      res.on("error", () => { setTimeout(connect, retry); retry = Math.min(retry*2, 30000); });
    });
    req.on("error", () => { setTimeout(connect, retry); retry = Math.min(retry*2, 30000); });
    req.end();
  }

  connect();
}

// ── Update message in RTDB (original) ────────────────────
async function updateMessage(rtdbUrl, workspaceId, chatId, messageId, content, status, screenshot, apiKey) {
  const update = { content, status, updatedAt:Date.now() };
  if (screenshot) update.screenshot = screenshot;
  await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/chats/${chatId}/messages/${messageId}`, update, apiKey);
}

// ── Sync skills (original) ────────────────────────────────
async function syncSkillsToRTDB(rtdbUrl, workspaceId, apiKey) {
  try {
    const skills = listSkills();
    const slim   = skills.slice(0,20).map(s => ({ id:s.id, name:s.name, description:s.description, trigger:s.trigger, category:s.category, successCount:s.successCount||0, lastUsed:s.lastUsed }));
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/skills`, slim, apiKey);
  } catch {}
}

// ── Sync memory (original) ────────────────────────────────
async function syncMemoryToRTDB(rtdbUrl, workspaceId, apiKey) {
  try {
    const mem = loadMemory();
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/memorySummary`, {
      totalTasks:  mem.agent?.totalTasksCompleted || 0,
      sessions:    mem.sessionCount || 0,
      factsCount:  (mem.facts || []).length,
      skillsCount: 0,
      userName:    mem.user?.name || null,
      updatedAt:   Date.now(),
    }, apiKey);
  } catch {}
}

// ── Sync Business DNA to RTDB (new) ──────────────────────
async function syncDNAToRTDB(rtdbUrl, workspaceId, apiKey) {
  try {
    const dna = loadDNA();
    if (dna.setupComplete) {
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/businessDNA`, dna, apiKey);
      console.log(`🧬 DNA synced to RTDB: ${dna.business?.name}`);
    }
  } catch {}
}

// ── Clean old commands (original) ────────────────────────
async function cleanOldCommands(rtdbUrl, workspaceId, apiKey) {
  try {
    const cmds = await rtdbGet(rtdbUrl, `/workspaces/${workspaceId}/commands`, apiKey);
    if (!cmds) return;
    const entries = Object.entries(cmds)
      .filter(([,v]) => v.status==="completed"||v.status==="failed")
      .sort(([,a],[,b]) => (a.completedAt||0)-(b.completedAt||0));
    if (entries.length > 50) {
      const toDelete = entries.slice(0, entries.length-50);
      for (const [key] of toDelete) {
        await rtdbDelete(rtdbUrl, `/workspaces/${workspaceId}/commands/${key}`, apiKey);
      }
    }
  } catch {}
}

// ── Proactive scheduler (new) ─────────────────────────────
function setupProactiveScheduler(rtdbUrl, workspaceId, apiKey, modelConfig) {
  const dna = loadDNA();
  if (!dna.setupComplete) return;

  console.log(`\n⏰ Proactive scheduler started for ${dna.business?.name}`);

  // Morning briefing — 9am daily
  scheduleDaily("09:00", async () => {
    console.log("☀️ Generating morning briefing...");
    try {
      const briefing = await generateMorningBriefing(modelConfig);
      if (briefing) {
        await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/briefing`, briefing, apiKey);
        console.log("✅ Morning briefing sent");
      }
    } catch (err) { console.error("Briefing error:", err.message); }
  });

  // Opportunity scan — every 6 hours (first run after 5min)
  setTimeout(async () => {
    try {
      const opps = await scanForOpportunities(modelConfig);
      if (opps?.length) {
        await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/opportunities`, { items:opps, scannedAt:Date.now() }, apiKey);
      }
    } catch {}
    setInterval(async () => {
      try {
        const opps = await scanForOpportunities(modelConfig);
        if (opps?.length) {
          await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/opportunities`, { items:opps, scannedAt:Date.now() }, apiKey);
        }
      } catch {}
    }, 6 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Weekly report — Monday 8am
  scheduleWeekly(1, "08:00", async () => {
    try {
      const report = await generateWeeklyReport(modelConfig);
      if (report) await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/weeklyReport`, report, apiKey);
    } catch {}
  });
}

function scheduleDaily(timeStr, fn) {
  const [h, m] = timeStr.split(":").map(Number);
  function tick() {
    const now = new Date(), next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate()+1);
    const diff = next.getTime() - now.getTime();
    setTimeout(() => { fn(); scheduleDaily(timeStr, fn); }, diff);
    console.log(`⏰ Next daily at ${timeStr} — in ${Math.round(diff/60000)} min`);
  }
  tick();
}

function scheduleWeekly(day, timeStr, fn) {
  const [h, m] = timeStr.split(":").map(Number);
  function tick() {
    const now = new Date(), next = new Date();
    const diff = (day - now.getDay() + 7) % 7;
    next.setDate(now.getDate() + (diff===0 ? 7 : diff));
    next.setHours(h, m, 0, 0);
    setTimeout(() => { fn(); tick(); }, next.getTime()-now.getTime());
  }
  tick();
}

// ── Main listener (original structure + new features) ─────
function startCommandListener(workspaceId, firebaseConfig, modelConfig) {
  const { rtdbUrl, apiKey } = firebaseConfig;

  if (!rtdbUrl) {
    console.error("❌ RTDB URL not set in config — cannot start listener");
    return null;
  }

  console.log(`\n✅ RTDB Listener started (WebSocket — zero polling)`);
  console.log(`   Workspace : ${workspaceId}`);
  console.log(`   Model     : ${modelConfig.ollamaId}`);
  console.log(`   Vision    : ${modelConfig.visionEnabled ? "ON" : "OFF"}`);
  console.log(`   DNA Setup : ${isDNASetup() ? "✅ " + loadDNA().business?.name : "❌ Not set"}`);

  setAgentContext(workspaceId, firebaseConfig, {});

  const processing = new Set();
  let workspaceOwnerId = null;

  // Get workspace owner + set online status
  rtdbGet(rtdbUrl, `/workspaces/${workspaceId}`, apiKey)
    .then(data => {
      workspaceOwnerId = data?.userId || null;
      console.log(`✅ Owner verified: ${workspaceOwnerId}`);
      rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}`, {
        agentOnline:    true,
        agentLastSeen:  Date.now(),
        agentModel:     modelConfig.ollamaId,
        agentVision:    modelConfig.visionEnabled,
        businessDNASet: isDNASetup(),
        businessName:   isDNASetup() ? loadDNA().business?.name : null,
        agentRole:      isDNASetup() ? loadDNA().agentRole : null,
      }, apiKey);
    })
    .catch(() => console.warn("⚠️ Could not fetch workspace owner"));

  // Sync on startup
  syncSkillsToRTDB(rtdbUrl, workspaceId, apiKey);
  syncMemoryToRTDB(rtdbUrl, workspaceId, apiKey);
  syncDNAToRTDB(rtdbUrl, workspaceId, apiKey);
  syncConnectorsToRTDB(workspaceId, (path, data) => rtdbSet(rtdbUrl, `/${path}`, data, apiKey));

  // Init MCP Manager on startup
  initMCPManager().then(async () => {
    const status = getMCPStatus();
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/mcpStatus`, status, apiKey);
    console.log(`🔌 MCP status synced: ${status.totalRunning} running`);
  }).catch(err => console.error("MCP init error:", err.message));

  // Start Telegram bot
  const tgBot = startTelegramBot(
    executeCommand,
    modelConfig,
    (path, data) => rtdbSet(rtdbUrl, `/${path}`, data, apiKey),
    workspaceId,
    apiKey,
    rtdbUrl
  );

  // Sync agent statuses on startup
  try {
    const statuses = getAllAgentStatuses();
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/agentStatuses`, statuses, apiKey);
    const log = getRecentLog(30);
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/activityLog`, log, apiKey);
    console.log(`✅ Agent statuses synced: ${statuses.length} agents`);
  } catch (err) { console.error("Agent sync error:", err.message); }

  // Start proactive scheduler if DNA is set
  setupProactiveScheduler(rtdbUrl, workspaceId, apiKey, modelConfig);

  // ── Listen for commands ─────────────────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/commands`, apiKey, async (event, payload) => {
    if (event !== "put" && event !== "patch") return;
    const data = payload?.data;
    if (!data || typeof data !== "object") return;

    const commandPath = payload.path;
    const commands    = commandPath === "/" ? data : { [commandPath.slice(1)]: data };

    for (const [cmdKey, cmdData] of Object.entries(commands || {})) {
      if (!cmdData || cmdData.status !== "pending") continue;
      if (processing.has(cmdKey)) continue;

      const command   = cmdData.command;
      const chatId    = cmdData.chatId;
      const messageId = cmdData.messageId;
      const cmdUserId = cmdData.userId;

      if (!command) continue;

      // Security checks (original)
      if (workspaceOwnerId && cmdUserId && cmdUserId !== workspaceOwnerId) {
        console.error(`❌ Command from wrong user — rejecting`);
        await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}/status`, "rejected", apiKey);
        continue;
      }

      if (isRateLimited(cmdUserId || workspaceOwnerId)) {
        console.warn(`⚠️ Rate limited`);
        await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}/status`, "rate_limited", apiKey);
        if (chatId && messageId) {
          await updateMessage(rtdbUrl, workspaceId, chatId, messageId, "⚠️ Too many commands — please wait a moment.", "error", null, apiKey);
        }
        continue;
      }

      processing.add(cmdKey);
      console.log(`\n🎯 Command: "${command}"`);
      setAgentContext(workspaceId, firebaseConfig, { chatId, messageId });

      await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}`, { status:"processing", startedAt:Date.now() }, apiKey);

      executeCommand(command, modelConfig)
        .then(async (result) => {
          // Handle setup flow — send to setupFlow node
          if (result.isSetupFlow) {
            await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/setupFlow`, {
              message:       result.message,
              options:       result.options || null,
              setupComplete: result.setupComplete || false,
              dna:           result.setupComplete ? loadDNA() : null,
              sentAt:        Date.now(),
            }, apiKey);

            // Sync DNA when setup completes
            if (result.setupComplete) {
              await syncDNAToRTDB(rtdbUrl, workspaceId, apiKey);
              // Start proactive scheduler now
              setupProactiveScheduler(rtdbUrl, workspaceId, apiKey, modelConfig);
            }
          }

          // Team progress — sync agents to RTDB
          if (result.isTeamTask && result.agents) {
            await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/teamProgress`, {
              teamName:    result.teamName,
              agents:      result.agents,
              finalOutput: result.output,
              phase:       "complete",
              message:     "Team completed",
              status:      "done",
              teamId:      `team_${Date.now()}`,
            }, apiKey);
          }

          // Update chat message
          if (chatId && messageId) {
            const msg = result.message || "Done!";
            await updateMessage(rtdbUrl, workspaceId, chatId, messageId, msg, result.success ? "done" : "error", result.screenshot, apiKey);
          }

          // Screenshot to live view
          if (result.screenshot) {
            await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/liveView`, { screenshot:result.screenshot, takenAt:Date.now() }, apiKey);
          }

          await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}`, { status:"completed", completedAt:Date.now() }, apiKey);

          // Re-sync skills (original)
          syncSkillsToRTDB(rtdbUrl, workspaceId, apiKey);
        })
        .catch(async (err) => {
          console.error(`❌ Execute error: ${err.message}`);
          if (chatId && messageId) {
            await updateMessage(rtdbUrl, workspaceId, chatId, messageId, `Failed: ${err.message}`, "error", null, apiKey);
          }
          await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}`, { status:"failed" }, apiKey);
        })
        .finally(() => {
          processing.delete(cmdKey);
          cleanOldCommands(rtdbUrl, workspaceId, apiKey);
        });
    }
  });

  // ── Screenshot requests (original) ─────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/screenshotRequest`, apiKey, async (event, payload) => {
    if (!payload?.data?.requested) return;
    console.log("📸 Screenshot requested");
    // takeScreenshot imported at top
    const shot = await takeScreenshot();
    if (shot) {
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/liveView`, { screenshot:shot, takenAt:Date.now() }, apiKey);
    }
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/screenshotRequest`, null, apiKey);
  });

  // ── Connector Actions ────────────────────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/connectorAction`, apiKey, async (event, payload) => {
    if (!payload?.data) return;
    await handleConnectorAction(
      payload.data,
      workspaceId,
      (path, data) => rtdbSet(rtdbUrl, `/${path}`, data, apiKey),
      (path, data) => rtdbPatch(rtdbUrl, `/${path}`, data, apiKey)
    );
    // Clear action after handling
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/connectorAction`, null, apiKey);
  });

  // ── Telegram Config ──────────────────────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/telegramConfig`, apiKey, async (event, payload) => {
    if (!payload?.data) return;
    const { action, token, sentAt } = payload.data;
    if (Date.now() - (sentAt || 0) > 30000) return;


    if (action === "test") {
      const result = await testBotToken(token);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/telegramTestResult`, {
        ...result, timestamp: Date.now(),
      }, apiKey);
    } else if (action === "save") {
      saveBotToken(token);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/telegramStatus`, {
        enabled: true, savedAt: Date.now(),
      }, apiKey);
    } else if (action === "disable") {
      const cfg = loadTGConfig();
      cfg.enabled = false;
      saveTGConfig(cfg);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/telegramStatus`, {
        enabled: false,
      }, apiKey);
    }
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/telegramConfig`, null, apiKey);
  });

  // ── Automation Tasks & Macros ─────────────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/automationAction`, apiKey, async (event, payload) => {
    if (!payload?.data) return;
    const { action, taskId, macroName, sentAt } = payload.data;
    if (Date.now() - (sentAt || 0) > 30000) return;

    console.log(`\n🤖 Automation action: ${action} → ${taskId || macroName}`);

    try {
      if (action === "resume_task") {
        resumeTask(taskId);
      } else if (action === "delete_task") {
        deleteTask(taskId);
      } else if (action === "delete_macro") {
        deleteMacro(macroName);
      }

      // Sync updated lists back
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/automationTasks`, listTasks(), apiKey);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/automationMacros`, listMacros(), apiKey);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/pendingApprovals`, getTasksNeedingApproval(), apiKey);
    } catch (err) {
      console.error("Automation action error:", err.message);
    }

    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/automationAction`, null, apiKey);
  });

  // ── MCP Actions ──────────────────────────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/mcpAction`, apiKey, async (event, payload) => {
    if (!payload?.data) return;
    const { action, serverId, server, config, sentAt } = payload.data;
    if (Date.now() - (sentAt || 0) > 30000) return;

    console.log(`\n🔌 MCP action: ${action} → ${serverId || config?.id}`);

    try {
      let result = { success: false, message: "Unknown action" };

      if (action === "install") {
        // Install builtin MCP
        const builtin = BUILTIN_MCPS.find(b => b.id === serverId);
        if (builtin) {
          const res = await addMCPServer({ ...builtin, type: "npm", source: builtin.package });
          result = { success: res.success, message: res.success ? `${builtin.name} installed and running` : res.error };
        }
      } else if (action === "remove") {
        removeMCPServer(serverId);
        result = { success: true, message: "MCP server removed" };
      } else if (action === "add_custom") {
        const res = await addMCPServer(config);
        result = { success: res.success, message: res.success ? `${config.name} installed successfully` : res.error };
      }

      // Sync updated status
      const status = getMCPStatus();
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/mcpStatus`, status, apiKey);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/mcpActionResult`, {
        ...result, timestamp: Date.now(),
      }, apiKey);

    } catch (err) {
      console.error("MCP action error:", err.message);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/mcpActionResult`, {
        success: false, message: err.message, timestamp: Date.now(),
      }, apiKey);
    }

    // Clear action
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/mcpAction`, null, apiKey);
  });

  // ── Direct Agent Chat ────────────────────────────────────
  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/agentDirectChat`, apiKey, async (event, payload) => {
    if (!payload?.data) return;
    const { agentId, message, messageId, sentAt } = payload.data;
    if (!agentId || !message || Date.now() - (sentAt || 0) > 30000) return;

    console.log(`\n💬 Direct chat → ${agentId}: "${message.slice(0,50)}"`);

    try {
      const result = await chatWithAgent(agentId, message, modelConfig);

      // Update message in RTDB if messageId provided
      if (messageId) {
        await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/agentChats/${agentId}/${messageId}`, {
          content: result.output,
          status:  "done",
          updatedAt: Date.now(),
        }, apiKey);
      }

      // Push new agent message
      const msgKey = `msg_${Date.now()}`;
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/agentChats/${agentId}/${msgKey}`, {
        role:      "agent",
        content:   result.output,
        type:      result.type || "chat",
        timestamp: Date.now(),
        status:    "done",
      }, apiKey);

      // Sync updated agent status + log
      const statuses = getAllAgentStatuses();
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/agentStatuses`, statuses, apiKey);
      const log = getRecentLog(30);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/activityLog`, log, apiKey);

    } catch (err) {
      console.error("Direct chat error:", err.message);
    }

    // Clear action
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/agentDirectChat`, null, apiKey);
  });

  // ── Heartbeat (original) ────────────────────────────────
  const heartbeat = setInterval(async () => {
    const dna = loadDNA();
    // Sync MCP status in heartbeat
    try {
      const mcpStatus = getMCPStatus();
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/mcpStatus`, mcpStatus, apiKey);
    } catch {}

    // Sync automation tasks + macros, notify Telegram if approval needed
    // (rate-limited to once per 15 min per task so it doesn't spam every 30s)
    try {
      const tasks    = listTasks();
      const macros   = listMacros();
      const pending  = getTasksNeedingApproval();
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/automationTasks`, tasks, apiKey);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/automationMacros`, macros, apiKey);
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/pendingApprovals`, pending, apiKey);

      if (pending.length > 0) {
        const now = Date.now();
        const freshlyPending = pending.filter(t => now - (lastApprovalNotify[t.id] || 0) > 15 * 60 * 1000);
        if (freshlyPending.length > 0) {
          await notify(`⏸️ ${freshlyPending.length} task(s) waiting on your approval: ${freshlyPending.map(t => t.label).join(", ")}`);
          freshlyPending.forEach(t => { lastApprovalNotify[t.id] = now; });
        }
      }
    } catch {}
    const agentLog = getRecentLog(20);
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/activityLog`, agentLog, apiKey);
    await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}`, {
      agentOnline:    true,
      agentLastSeen:  Date.now(),
      businessDNASet: dna.setupComplete,
      businessName:   dna.setupComplete ? dna.business?.name : null,
      agentCount:     8,
    }, apiKey);
  }, 30000);

  return () => {
    clearInterval(heartbeat);
    rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}`, { agentOnline:false }, apiKey);
  };
}

module.exports = { startCommandListener, rtdbSet, rtdbGet, rtdbPatch, rtdbDelete, syncSkillsToRTDB };