// src/agent/powerManager.js
// ═══════════════════════════════════════════════════════════
// POWER MANAGER
// Keeps the PC awake while automation tasks are running, and
// releases the lock automatically once nothing needs it.
//
// HONEST SCOPE: this does NOT make tasks run while the PC is
// fully powered off or asleep before a task starts — that
// requires a persistent cloud VM (which is a different, opt-in
// architecture, not something a local agent can do). What this
// DOES fix: the far more common failure mode where a task is
// mid-flight and the PC drops to sleep from inactivity, silently
// killing a 20-minute job at minute 12. This closes that gap.
// ═══════════════════════════════════════════════════════════

const { listTasks } = require("./sessionPersistence");

let powerSaveBlocker = null;
let blockerId         = null;
let syncInterval       = null;

// ── Start blocking sleep ─────────────────────────────────────
function startKeepAwake(reason = "Agent task running") {
  try {
    if (!powerSaveBlocker) powerSaveBlocker = require("electron").powerSaveBlocker;
  } catch {
    console.warn("⚠️ powerManager: electron not available (non-Electron context) — skipping wake lock");
    return false;
  }

  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    return true; // already active
  }

  blockerId = powerSaveBlocker.start("prevent-app-suspension");
  console.log(`🔆 Keeping PC awake — ${reason}`);
  return true;
}

// ── Stop blocking sleep — let the PC sleep normally again ────
function stopKeepAwake() {
  if (!powerSaveBlocker || blockerId === null) return;
  if (powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
    console.log("💤 Released wake lock — PC can sleep normally again");
  }
  blockerId = null;
}

function isAwakeLockActive() {
  return !!(powerSaveBlocker && blockerId !== null && powerSaveBlocker.isStarted(blockerId));
}

// ── Auto-sync with the task registry ─────────────────────────
// Checks every N seconds: any task actively "running" or
// "waiting_approval" right now? Keep the PC awake. Otherwise
// (all tasks paused/completed/failed, or no tasks at all),
// release the lock so the PC can sleep and save power/battery.
function startAutoSync(intervalMs = 20000) {
  if (syncInterval) return;

  syncInterval = setInterval(() => {
    try {
      const tasks = listTasks();
      const needsAwake = tasks.some(t => t.status === "running" || t.status === "waiting_approval");

      if (needsAwake && !isAwakeLockActive()) {
        const active = tasks.find(t => t.status === "running" || t.status === "waiting_approval");
        startKeepAwake(`Task in progress: ${active?.label || "automation"}`);
      } else if (!needsAwake && isAwakeLockActive()) {
        stopKeepAwake();
      }
    } catch (err) {
      console.error("powerManager sync error:", err.message);
    }
  }, intervalMs);

  console.log(`🔋 Power manager auto-sync started (checking every ${intervalMs / 1000}s)`);
}

function stopAutoSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  stopKeepAwake();
}

module.exports = {
  startKeepAwake,
  stopKeepAwake,
  isAwakeLockActive,
  startAutoSync,
  stopAutoSync,
};
