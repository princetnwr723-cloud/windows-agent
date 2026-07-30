// src/agent/listener.js
// ✅ Rate limiting — max 20 commands per minute per user
// ✅ Command userId verification — sirf owner ke commands execute honge
// ✅ Context pass to brain for permission system

const { executeCommand, setAgentContext } = require("./brain");

const POLL_INTERVAL = 3000;
const MAX_PER_MIN   = 20;

// ── Rate limiter ──────────────────────────────────────────
const rateLimiter = new Map(); // userId → { count, resetAt }

function isRateLimited(userId) {
  if (!userId) return false;
  const now  = Date.now();
  const data = rateLimiter.get(userId) || { count: 0, resetAt: now + 60000 };

  // Reset every minute
  if (now > data.resetAt) {
    data.count   = 0;
    data.resetAt = now + 60000;
  }

  data.count++;
  rateLimiter.set(userId, data);

  if (data.count > MAX_PER_MIN) {
    console.warn(`⚠️ Rate limited: ${userId} (${data.count} commands this minute)`);
    return true;
  }
  return false;
}

// ── Main listener ─────────────────────────────────────────
function startCommandListener(workspaceId, firebaseConfig, modelConfig) {
  const BASE    = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const API_KEY = firebaseConfig.apiKey;

  console.log(`\n✅ Command listener started`);
  console.log(`   Workspace : ${workspaceId}`);
  console.log(`   Model     : ${modelConfig.ollamaId}`);
  console.log(`   Vision    : ${modelConfig.visionEnabled ? "ON — " + modelConfig.visionOllamaId : "OFF"}`);
  console.log(`   Rate limit: ${MAX_PER_MIN} commands/min`);
  console.log(`   Polling every ${POLL_INTERVAL / 1000}s...\n`);

  // Set context for permission system
  setAgentContext(workspaceId, firebaseConfig, {});

  // Get workspace owner ID upfront for verification
  let workspaceOwnerId = null;
  fetchWorkspaceOwner(BASE, API_KEY, workspaceId)
    .then(id => {
      workspaceOwnerId = id;
      console.log(`✅ Workspace owner verified: ${workspaceOwnerId}`);
    })
    .catch(() => console.warn("⚠️ Could not fetch workspace owner"));

  const processing = new Set();

  const poll = setInterval(async () => {
    try {
      const url = `${BASE}/agent_connections/${workspaceId}/commands?key=${API_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;

      const data = await res.json();
      if (!data.documents?.length) return;

      for (const docSnap of data.documents) {
        const fields    = docSnap.fields;
        const status    = fields?.status?.stringValue;
        const command   = fields?.command?.stringValue;
        const chatId    = fields?.chatId?.stringValue;
        const messageId = fields?.messageId?.stringValue;
        const cmdUserId = fields?.userId?.stringValue;
        const docId     = docSnap.name.split("/").pop();

        if (status !== "pending" || !command) continue;
        if (processing.has(docId)) continue;

        // ── Security Check 1: userId verification ─────────
        if (workspaceOwnerId && cmdUserId && cmdUserId !== workspaceOwnerId) {
          console.error(`❌ Command from wrong user — rejecting: ${cmdUserId}`);
          await updateCommandStatus(workspaceId, docId, "rejected", firebaseConfig);
          continue;
        }

        // ── Security Check 2: Rate limiting ───────────────
        if (isRateLimited(cmdUserId || workspaceOwnerId)) {
          console.warn(`⚠️ Rate limited — skipping command: "${command.slice(0, 40)}"`);
          await updateCommandStatus(workspaceId, docId, "rate_limited", firebaseConfig);

          // Notify user in chat
          if (chatId && messageId) {
            await updateMessage(
              workspaceId, chatId, messageId,
              "⚠️ Rate limit reached — max 20 commands per minute. Please wait a moment.",
              "error", null, firebaseConfig
            );
          }
          continue;
        }

        processing.add(docId);
        console.log(`\n🎯 Executing: "${command}"`);

        // Update chat context for permissions
        setAgentContext(workspaceId, firebaseConfig, { chatId, messageId });

        await updateCommandStatus(workspaceId, docId, "processing", firebaseConfig);

        executeCommand(command, modelConfig)
          .then(async (result) => {
            if (chatId && messageId) {
              await updateMessage(
                workspaceId, chatId, messageId,
                result.message || "Done!",
                result.success ? "done" : "error",
                result.screenshot,
                firebaseConfig
              );
            }
            await updateCommandStatus(workspaceId, docId, "completed", firebaseConfig);
            if (result.screenshot) {
              await saveScreenshot(workspaceId, result.screenshot, firebaseConfig);
            }
          })
          .catch(async (err) => {
            console.error(`❌ Execute error: ${err.message}`);
            if (chatId && messageId) {
              await updateMessage(
                workspaceId, chatId, messageId,
                `Failed: ${err.message}`, "error", null, firebaseConfig
              );
            }
            await updateCommandStatus(workspaceId, docId, "failed", firebaseConfig);
          })
          .finally(() => processing.delete(docId));
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error(`❌ Listener error: ${err.message}`);
      }
    }
  }, POLL_INTERVAL);

  return poll;
}

// ── Fetch workspace owner ─────────────────────────────────
async function fetchWorkspaceOwner(BASE, API_KEY, workspaceId) {
  try {
    const res  = await fetch(`${BASE}/agent_connections/${workspaceId}?key=${API_KEY}`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data?.fields?.userId?.stringValue || null;
  } catch { return null; }
}

// ── Firestore helpers ─────────────────────────────────────
async function updateCommandStatus(workspaceId, docId, status, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/commands/${docId}?key=${firebaseConfig.apiKey}&updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`;
  try {
    await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        fields: {
          status:    { stringValue: status },
          updatedAt: { stringValue: new Date().toISOString() },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function updateMessage(workspaceId, chatId, messageId, content, status, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/chats/${chatId}/messages/${messageId}?key=${firebaseConfig.apiKey}`;
  try {
    const fields = {
      content:   { stringValue: content },
      status:    { stringValue: status },
      updatedAt: { stringValue: new Date().toISOString() },
    };
    if (screenshot) fields.screenshot = { stringValue: screenshot };
    await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ fields }),
      signal:  AbortSignal.timeout(5000),
    });
  } catch {}
}

async function saveScreenshot(workspaceId, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/screenshots/latest?key=${firebaseConfig.apiKey}`;
  try {
    await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        fields: {
          data:    { stringValue: screenshot },
          takenAt: { stringValue: new Date().toISOString() },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

module.exports = { startCommandListener };