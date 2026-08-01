// src/agent/listener.js
// ✅ Firebase Realtime Database — WebSocket persistent connection
// ✅ Zero polling — server pushes instantly
// ✅ Rate limiting + ownership verification
// ✅ Skills sync to RTDB for workspace UI

const { executeCommand, setAgentContext } = require("./brain");
const { listSkills }                       = require("./skills");
const { loadMemory }                       = require("./memory");
const https                                = require("https");
const http                                 = require("http");

const MAX_PER_MIN  = 20;
const rateLimiter  = new Map();

function isRateLimited(userId) {
  if (!userId) return false;
  const now  = Date.now();
  const data = rateLimiter.get(userId) || { count: 0, resetAt: now + 60000 };
  if (now > data.resetAt) { data.count = 0; data.resetAt = now + 60000; }
  data.count++;
  rateLimiter.set(userId, data);
  return data.count > MAX_PER_MIN;
}

// ── RTDB REST helpers ─────────────────────────────────────
function rtdbGet(rtdbUrl, path, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `${rtdbUrl}${path}.json?auth=${apiKey}`;
    const mod  = url.startsWith("https") ? https : http;
    mod.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
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
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: "DELETE" };
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(options, (res) => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", reject);
    req.end();
  });
}

// ── Firebase Realtime Database SSE listener ───────────────
// RTDB supports Server-Sent Events for real-time pushes
function listenRTDB(rtdbUrl, path, apiKey, onData) {
  const url     = `${rtdbUrl}${path}.json?auth=${apiKey}`;
  const urlObj  = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   "GET",
    headers:  { "Accept": "text/event-stream", "Cache-Control": "no-cache" },
  };

  const mod = urlObj.protocol === "https:" ? https : http;
  let req   = null;
  let retry = 1000;

  function connect() {
    req = mod.request(options, (res) => {
      retry = 1000; // reset backoff on successful connection
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let event = null;
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            event = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataStr = line.slice(6).trim();
          } else if (line === "" && event && dataStr) {
            try {
              const parsed = JSON.parse(dataStr);
              onData(event, parsed);
            } catch {}
            event   = null;
            dataStr = "";
          }
        }
      });

      res.on("end", () => {
        console.warn("⚠️ RTDB connection closed — reconnecting...");
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30000);
      });

      res.on("error", () => {
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30000);
      });
    });

    req.on("error", () => {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    });

    req.end();
  }

  connect();
  return () => { if (req) req.destroy(); };
}

// ── Main listener ─────────────────────────────────────────
function startCommandListener(workspaceId, firebaseConfig, modelConfig) {
  const { rtdbUrl, apiKey, projectId } = firebaseConfig;

  if (!rtdbUrl) {
    console.error("❌ RTDB URL not set in config — cannot start listener");
    return null;
  }

  console.log(`\n✅ RTDB Listener started (WebSocket — zero polling)`);
  console.log(`   Workspace : ${workspaceId}`);
  console.log(`   Model     : ${modelConfig.ollamaId}`);
  console.log(`   Vision    : ${modelConfig.visionEnabled ? "ON" : "OFF"}`);

  setAgentContext(workspaceId, firebaseConfig, {});

  const processing = new Set();
  let workspaceOwnerId = null;

  // Get workspace owner
  rtdbGet(rtdbUrl, `/workspaces/${workspaceId}`, apiKey)
    .then(data => {
      workspaceOwnerId = data?.userId || null;
      console.log(`✅ Owner verified: ${workspaceOwnerId}`);

      // Set agent online status
      rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}`, {
        agentOnline:    true,
        agentLastSeen:  Date.now(),
        agentModel:     modelConfig.ollamaId,
        agentVision:    modelConfig.visionEnabled,
      }, apiKey);
    })
    .catch(() => console.warn("⚠️ Could not fetch workspace owner"));

  // Sync skills to RTDB so workspace UI can show them
  syncSkillsToRTDB(rtdbUrl, workspaceId, apiKey);

  // Sync memory summary
  syncMemoryToRTDB(rtdbUrl, workspaceId, apiKey);

  // ── Listen for new commands ─────────────────────────────
  const stopCommands = listenRTDB(
    rtdbUrl,
    `/workspaces/${workspaceId}/commands`,
    apiKey,
    async (event, payload) => {
      if (event !== "put" && event !== "patch") return;

      const data = payload?.data;
      if (!data || typeof data !== "object") return;

      // payload.path is the command key or "/"
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

        // Security: ownership check
        if (workspaceOwnerId && cmdUserId && cmdUserId !== workspaceOwnerId) {
          console.error(`❌ Command from wrong user — rejecting`);
          await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}/status`, "rejected", apiKey);
          continue;
        }

        // Rate limit
        if (isRateLimited(cmdUserId || workspaceOwnerId)) {
          console.warn(`⚠️ Rate limited`);
          await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}/status`, "rate_limited", apiKey);
          if (chatId && messageId) {
            await updateMessage(rtdbUrl, workspaceId, chatId, messageId,
              "⚠️ Too many commands — please wait a moment.", "error", null, apiKey);
          }
          continue;
        }

        processing.add(cmdKey);
        console.log(`\n🎯 Command received: "${command}"`);

        // Update context for permissions
        setAgentContext(workspaceId, firebaseConfig, { chatId, messageId });

        // Mark processing
        await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}`, {
          status:    "processing",
          startedAt: Date.now(),
        }, apiKey);

        // Execute
        executeCommand(command, modelConfig)
          .then(async (result) => {
            if (chatId && messageId) {
              await updateMessage(rtdbUrl, workspaceId, chatId, messageId,
                result.message || "Done!", result.success ? "done" : "error",
                result.screenshot, apiKey);
            }
            await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}`, {
              status:      "completed",
              completedAt: Date.now(),
            }, apiKey);

            if (result.screenshot) {
              await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/liveView`, {
                screenshot: result.screenshot,
                takenAt:    Date.now(),
              }, apiKey);
            }

            // Re-sync skills after task (might have learned new ones)
            syncSkillsToRTDB(rtdbUrl, workspaceId, apiKey);
          })
          .catch(async (err) => {
            console.error(`❌ Execute error: ${err.message}`);
            if (chatId && messageId) {
              await updateMessage(rtdbUrl, workspaceId, chatId, messageId,
                `Failed: ${err.message}`, "error", null, apiKey);
            }
            await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/commands/${cmdKey}`, {
              status: "failed",
            }, apiKey);
          })
          .finally(() => {
            processing.delete(cmdKey);
            // Clean up old completed commands (keep last 50)
            cleanOldCommands(rtdbUrl, workspaceId, apiKey);
          });
      }
    }
  );

  // ── Listen for screenshot requests ──────────────────────
  const stopScreenshot = listenRTDB(
    rtdbUrl,
    `/workspaces/${workspaceId}/screenshotRequest`,
    apiKey,
    async (event, payload) => {
      if (!payload?.data?.requested) return;
      console.log("📸 Screenshot requested from workspace");
      const { takeScreenshot } = require("./brain");
      const shot = await takeScreenshot();
      if (shot) {
        await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/liveView`, {
          screenshot: shot,
          takenAt:    Date.now(),
        }, apiKey);
      }
      // Clear request
      await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/screenshotRequest`, null, apiKey);
    }
  );

  // ── Heartbeat — keep agent online status ────────────────
  const heartbeat = setInterval(async () => {
    await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}`, {
      agentOnline:   true,
      agentLastSeen: Date.now(),
    }, apiKey);
  }, 30000); // every 30 seconds

  // Return cleanup function
  return () => {
    stopCommands?.();
    stopScreenshot?.();
    clearInterval(heartbeat);
    rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}`, { agentOnline: false }, apiKey);
  };
}

// ── Sync skills list to RTDB ──────────────────────────────
async function syncSkillsToRTDB(rtdbUrl, workspaceId, apiKey) {
  try {
    const skills = listSkills();
    const slim   = skills.slice(0, 20).map(s => ({
      id:           s.id,
      name:         s.name,
      description:  s.description,
      trigger:      s.trigger,
      category:     s.category,
      successCount: s.successCount || 0,
      lastUsed:     s.lastUsed,
    }));
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/skills`, slim, apiKey);
  } catch {}
}

// ── Sync memory summary to RTDB ───────────────────────────
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

// ── Update message in RTDB ────────────────────────────────
async function updateMessage(rtdbUrl, workspaceId, chatId, messageId, content, status, screenshot, apiKey) {
  const update = { content, status, updatedAt: Date.now() };
  if (screenshot) update.screenshot = screenshot;
  await rtdbPatch(rtdbUrl, `/workspaces/${workspaceId}/chats/${chatId}/messages/${messageId}`, update, apiKey);
}

// ── Clean old commands ────────────────────────────────────
async function cleanOldCommands(rtdbUrl, workspaceId, apiKey) {
  try {
    const cmds = await rtdbGet(rtdbUrl, `/workspaces/${workspaceId}/commands`, apiKey);
    if (!cmds) return;
    const entries = Object.entries(cmds)
      .filter(([, v]) => v.status === "completed" || v.status === "failed")
      .sort(([, a], [, b]) => (a.completedAt || 0) - (b.completedAt || 0));
    if (entries.length > 50) {
      const toDelete = entries.slice(0, entries.length - 50);
      for (const [key] of toDelete) {
        await rtdbDelete(rtdbUrl, `/workspaces/${workspaceId}/commands/${key}`, apiKey);
      }
    }
  } catch {}
}

module.exports = { startCommandListener, rtdbSet, rtdbGet, rtdbPatch, rtdbDelete, syncSkillsToRTDB };