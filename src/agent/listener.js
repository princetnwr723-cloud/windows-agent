// src/agent/listener-v2.js
// Complete listener with Multi-Agent + Business DNA + Proactive

const { executeCommand }           = require("./brain-v2");
const { isDNASetup, loadDNA, saveDNA } = require("./businessDNA");
const { generateMorningBriefing, monitorCompetitors, scanForOpportunities, generateWeeklyReport } = require("./proactiveAgent");
const { executeTeam }              = require("./multiAgent");

const POLL_INTERVAL = 3000;

// ── RTDB REST helpers ──────────────────────────────────────
function rtdbUrl(firebaseConfig, path) {
  return `https://${firebaseConfig.projectId}-default-rtdb.firebaseio.com/${path}.json`;
}

async function rtdbGet(firebaseConfig, path) {
  try {
    const res  = await fetch(rtdbUrl(firebaseConfig, path));
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function rtdbSet(firebaseConfig, path, data) {
  try {
    await fetch(rtdbUrl(firebaseConfig, path), {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(data),
    });
  } catch {}
}

async function rtdbPatch(firebaseConfig, path, data) {
  try {
    await fetch(rtdbUrl(firebaseConfig, path), {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(data),
    });
  } catch {}
}

// ── Send team progress to RTDB ─────────────────────────────
function makeTeamProgressSender(workspaceId, firebaseConfig) {
  return async (progress) => {
    await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/teamProgress`, progress);
  };
}

// ── Send setup flow message to RTDB ───────────────────────
async function sendSetupFlow(workspaceId, firebaseConfig, data) {
  await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/setupFlow`, {
    ...data,
    sentAt: Date.now(),
  });
}

// ── Update chat message ────────────────────────────────────
async function updateMessage(workspaceId, chatId, messageId, content, status, screenshot, firebaseConfig) {
  const path = `workspaces/${workspaceId}/chats/${chatId}/messages/${messageId}`;
  const data = { content, status, updatedAt: Date.now() };
  if (screenshot) data.screenshot = screenshot;
  await rtdbPatch(firebaseConfig, path, data);

  // Also update lastMessage in chat
  await rtdbPatch(firebaseConfig, `workspaces/${workspaceId}/chats/${chatId}`, {
    lastMessage: content.slice(0, 100),
    updatedAt: Date.now(),
  });
}

// ── Sync Business DNA to RTDB ──────────────────────────────
async function syncDNAToRTDB(workspaceId, firebaseConfig) {
  const dna = loadDNA();
  if (dna.setupComplete) {
    await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/businessDNA`, dna);
    console.log("🧬 DNA synced to RTDB");
  }
}

// ── Format result message ──────────────────────────────────
function formatResult(result) {
  if (!result) return "Task completed.";

  // Team task
  if (result.isTeamTask) {
    return `👥 **${result.teamName}** completed!\n\n${result.output || result.message}`;
  }

  // Briefing
  if (result.isBriefing) {
    return result.message;
  }

  // Setup flow — handled separately
  if (result.isSetupFlow) {
    return result.message;
  }

  // Opportunities
  if (Array.isArray(result.output)) {
    return result.message + "\n\n" + JSON.stringify(result.output, null, 2);
  }

  return result.message || result.output || "Task completed.";
}

// ── Main Command Listener ──────────────────────────────────
function startCommandListener(workspaceId, firebaseConfig, modelConfig) {
  console.log(`\n✅ Command listener started (v2 — Multi-Agent + Business DNA)`);
  console.log(`   Workspace : ${workspaceId}`);
  console.log(`   Model     : ${modelConfig.ollamaId}`);
  console.log(`   DNA Setup : ${isDNASetup() ? "✅ " + loadDNA().business?.name : "❌ Not set"}`);

  // Sync DNA on start
  syncDNAToRTDB(workspaceId, firebaseConfig);

  // Sync DNA on startup
  const dna = loadDNA();
  if (dna.setupComplete) {
    console.log(`   Business  : ${dna.business?.name} | Role: ${dna.agentRole}`);
  }

  // ── Setup proactive scheduler ────────────────────────────
  setupProactiveScheduler(workspaceId, firebaseConfig, modelConfig);

  // ── Main polling loop ────────────────────────────────────
  const poll = setInterval(async () => {
    try {
      const commands = await rtdbGet(firebaseConfig, `workspaces/${workspaceId}/commands`);
      if (!commands) return;

      for (const [docId, cmd] of Object.entries(commands)) {
        if (!cmd || cmd.status !== "pending") continue;

        const command   = cmd.command;
        const chatId    = cmd.chatId;
        const messageId = cmd.messageId;
        const isSetup   = cmd.isSetupFlow;

        if (!command) continue;

        console.log(`\n🎯 "${command}"`);

        // Mark processing
        await rtdbPatch(firebaseConfig, `workspaces/${workspaceId}/commands/${docId}`, {
          status: "processing",
        });

        try {
          // Execute command (brain-v2 handles all routing)
          const result = await executeCommand(
            command,
            modelConfig,
            workspaceId,
            firebaseConfig,
          );

          // Handle setup flow
          if (result.isSetupFlow) {
            await sendSetupFlow(workspaceId, firebaseConfig, {
              message: result.message,
              options: result.options || null,
              setupComplete: result.setupComplete || false,
              dna: result.setupComplete ? loadDNA() : null,
            });

            // Sync DNA if setup complete
            if (result.setupComplete) {
              await syncDNAToRTDB(workspaceId, firebaseConfig);
            }
          }

          // Update chat message
          if (chatId && messageId) {
            const msg = formatResult(result);
            await updateMessage(
              workspaceId, chatId, messageId,
              msg,
              result.success ? "done" : "error",
              result.screenshot || null,
              firebaseConfig
            );
          }

          // Save screenshot to live view
          if (result.screenshot) {
            await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/liveView`, {
              screenshot: result.screenshot,
              takenAt: Date.now(),
            });
          }

          // Mark completed
          await rtdbPatch(firebaseConfig, `workspaces/${workspaceId}/commands/${docId}`, {
            status: "completed",
            completedAt: Date.now(),
          });

        } catch (err) {
          console.error(`❌ Error: ${err.message}`);
          if (chatId && messageId) {
            await updateMessage(
              workspaceId, chatId, messageId,
              `❌ Failed: ${err.message}`,
              "error", null, firebaseConfig
            );
          }
          await rtdbPatch(firebaseConfig, `workspaces/${workspaceId}/commands/${docId}`, {
            status: "failed",
            error: err.message,
          });
        }
      }
    } catch (err) {
      console.error(`❌ Listener error: ${err.message}`);
    }
  }, POLL_INTERVAL);

  return poll;
}

// ── Proactive Scheduler ────────────────────────────────────
function setupProactiveScheduler(workspaceId, firebaseConfig, modelConfig) {
  const dna = loadDNA();
  if (!dna.setupComplete) return;

  console.log(`\n⏰ Proactive scheduler started for ${dna.business?.name}`);

  // Morning briefing — 9:00 AM daily
  scheduleDaily("09:00", async () => {
    console.log("☀️ Generating morning briefing...");
    const briefing = await generateMorningBriefing(modelConfig, async (key, data) => {
      await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/${key}`, data);
    });
    if (briefing) {
      await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/briefing`, briefing);
      console.log("✅ Morning briefing sent to dashboard");
    }
  });

  // Opportunity scan — Every 6 hours
  scheduleInterval(6 * 60 * 60 * 1000, async () => {
    console.log("🎯 Scanning for opportunities...");
    const opps = await scanForOpportunities(modelConfig, async (key, data) => {
      await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/${key}`, data);
    });
    if (opps) {
      await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/opportunities`, {
        items: opps,
        scannedAt: Date.now(),
      });
    }
  });

  // Weekly report — Every Monday 8:00 AM
  scheduleWeekly(1, "08:00", async () => {
    console.log("📊 Generating weekly report...");
    const report = await generateWeeklyReport(modelConfig, async (key, data) => {
      await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/${key}`, data);
    });
    if (report) {
      await rtdbSet(firebaseConfig, `workspaces/${workspaceId}/weeklyReport`, report);
    }
  });

  // Heartbeat — every 30s
  setInterval(async () => {
    await rtdbPatch(firebaseConfig, `workspaces/${workspaceId}`, {
      agentOnline:    true,
      lastHeartbeat:  Date.now(),
      agentModel:     modelConfig.ollamaId,
      businessDNASet: dna.setupComplete,
      businessName:   dna.business?.name || null,
      agentRole:      dna.agentRole || null,
    });
  }, 30000);
}

// ── Schedule Helpers ───────────────────────────────────────
function scheduleDaily(timeStr, fn) {
  const [h, m] = timeStr.split(":").map(Number);
  function tick() {
    const now  = new Date();
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const diff = next.getTime() - now.getTime();
    setTimeout(() => { fn(); scheduleDaily(timeStr, fn); }, diff);
    console.log(`⏰ Scheduled daily at ${timeStr} — in ${Math.round(diff / 60000)} min`);
  }
  tick();
}

function scheduleInterval(ms, fn) {
  // Run after 5 min on startup, then every interval
  setTimeout(() => {
    fn();
    setInterval(fn, ms);
  }, 5 * 60 * 1000);
}

function scheduleWeekly(dayOfWeek, timeStr, fn) {
  const [h, m] = timeStr.split(":").map(Number);
  function tick() {
    const now  = new Date();
    const next = new Date();
    const day  = now.getDay();
    const diff = (dayOfWeek - day + 7) % 7;
    next.setDate(now.getDate() + (diff === 0 ? 7 : diff));
    next.setHours(h, m, 0, 0);
    const ms = next.getTime() - now.getTime();
    setTimeout(() => { fn(); tick(); }, ms);
  }
  tick();
}

module.exports = { startCommandListener };