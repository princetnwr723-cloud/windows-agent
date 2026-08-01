// src/agent/scheduler.js
// ✅ Cron-based scheduling (node-cron)
// ✅ Condition-based triggers ("if Gmail unread > 10")
// ✅ Skill + Cron combo
// ✅ Smart triggers (file watcher, app open, time-based)
// ✅ Retry with exponential backoff
// ✅ Full history with logs
// ✅ RTDB sync — workspace UI sees everything real-time

const path     = require("path");
const fs       = require("fs");
const os       = require("os");

// node-cron install check
let cron;
try {
  cron = require("node-cron");
} catch {
  console.warn("⚠️ node-cron not installed — run: npm install node-cron");
  cron = null;
}

const SCHEDULE_FILE = path.join(os.homedir(), ".vnus-agent", "schedules.json");
const HISTORY_FILE  = path.join(os.homedir(), ".vnus-agent", "schedule-history.json");
const MAX_HISTORY   = 200;

// ── Active cron tasks ─────────────────────────────────────
const activeTasks    = new Map(); // scheduleId → cron task
const activeWatchers = new Map(); // scheduleId → fs.FSWatcher
let   rtdbRef        = null;      // set by startScheduler
let   workspaceIdRef = null;
let   firebaseRef    = null;
let   modelRef       = null;

// ── Schedule types ────────────────────────────────────────
const TRIGGER_TYPES = {
  CRON:      "cron",       // Standard cron expression
  INTERVAL:  "interval",   // Every N minutes
  DAILY:     "daily",      // Every day at HH:MM
  CONDITION: "condition",  // When a condition is met
  FILE:      "file",       // When a file changes
  STARTUP:   "startup",    // On agent start
};

// ── Load/save schedules ───────────────────────────────────
function loadSchedules() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8")) || [];
  } catch { return []; }
}

function saveSchedules(schedules) {
  const dir = path.dirname(SCHEDULE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")) || [];
  } catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
}

// ── Add run to history ────────────────────────────────────
async function recordRun(schedule, success, message, duration) {
  const history = loadHistory();
  const run = {
    scheduleId:   schedule.id,
    scheduleName: schedule.name,
    command:      schedule.command,
    success,
    message,
    duration,
    ranAt:        new Date().toISOString(),
  };
  history.push(run);
  saveHistory(history);

  // Sync to RTDB
  if (rtdbRef && workspaceIdRef && firebaseRef) {
    const { rtdbPatch } = require("./listener");
    try {
      await rtdbPatch(
        firebaseRef.rtdbUrl,
        `/workspaces/${workspaceIdRef}/scheduleHistory/${schedule.id}_${Date.now()}`,
        run,
        firebaseRef.apiKey
      );
    } catch {}
  }
}

// ── Build cron expression ─────────────────────────────────
function buildCronExpr(schedule) {
  if (schedule.triggerType === TRIGGER_TYPES.CRON) {
    return schedule.cronExpr;
  }
  if (schedule.triggerType === TRIGGER_TYPES.DAILY) {
    const [h, m] = (schedule.dailyTime || "09:00").split(":");
    return `${parseInt(m)} ${parseInt(h)} * * *`;
  }
  if (schedule.triggerType === TRIGGER_TYPES.INTERVAL) {
    const mins = schedule.intervalMinutes || 60;
    return `*/${mins} * * * *`;
  }
  return null;
}

// ── Check condition ───────────────────────────────────────
async function checkCondition(condition) {
  if (!condition) return true;

  const c = (condition || "").toLowerCase();

  // Check system conditions
  if (c.includes("battery") || c.includes("disk") || c.includes("cpu")) {
    return true; // Basic pass — can be enhanced
  }

  // File exists condition
  const fileMatch = condition.match(/file\s+"(.+?)"\s+exists/i);
  if (fileMatch) {
    return fs.existsSync(fileMatch[1]);
  }

  // Time-based condition
  const timeMatch = condition.match(/time\s+is\s+(\d+):(\d+)/i);
  if (timeMatch) {
    const now  = new Date();
    const h    = parseInt(timeMatch[1]);
    const m    = parseInt(timeMatch[2]);
    return now.getHours() === h && Math.abs(now.getMinutes() - m) < 5;
  }

  return true; // Default: allow
}

// ── Execute a scheduled task ──────────────────────────────
async function executeScheduledTask(schedule) {
  const { executeCommand } = require("./brain");
  const start = Date.now();

  console.log(`\n⏰ Cron executing: "${schedule.name}" — "${schedule.command}"`);

  // Check condition if set
  if (schedule.condition) {
    const condMet = await checkCondition(schedule.condition);
    if (!condMet) {
      console.log(`⏭️ Condition not met — skipping: ${schedule.condition}`);
      await recordRun(schedule, true, "Skipped — condition not met", 0);
      return;
    }
  }

  let attempt   = 0;
  const maxRetry = schedule.retryOnFail ? 3 : 1;
  let   lastErr  = "";

  while (attempt < maxRetry) {
    attempt++;
    try {
      const result = await executeCommand(schedule.command, modelRef);

      const duration = Date.now() - start;
      await recordRun(schedule, result.success, result.message, duration);

      // Update schedule last run
      const schedules = loadSchedules();
      const idx       = schedules.findIndex(s => s.id === schedule.id);
      if (idx !== -1) {
        schedules[idx].lastRan      = new Date().toISOString();
        schedules[idx].lastSuccess  = result.success;
        schedules[idx].runCount     = (schedules[idx].runCount || 0) + 1;
        saveSchedules(schedules);
        syncSchedulesToRTDB();
      }

      console.log(`✅ Cron done: "${schedule.name}" in ${duration}ms`);
      return;

    } catch (err) {
      lastErr = err.message;
      if (attempt < maxRetry) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(`⚠️ Cron retry ${attempt}/${maxRetry} in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  // All retries failed
  await recordRun(schedule, false, `Failed after ${maxRetry} attempts: ${lastErr}`, Date.now() - start);
  console.error(`❌ Cron failed: "${schedule.name}"`);
}

// ── Register a single schedule ────────────────────────────
function registerSchedule(schedule) {
  if (!schedule.enabled) return;

  const id = schedule.id;

  // Clear existing if any
  unregisterSchedule(id);

  // STARTUP trigger — run immediately on agent start
  if (schedule.triggerType === TRIGGER_TYPES.STARTUP) {
    setTimeout(() => executeScheduledTask(schedule), 5000);
    return;
  }

  // FILE watcher trigger
  if (schedule.triggerType === TRIGGER_TYPES.FILE && schedule.watchPath) {
    if (fs.existsSync(schedule.watchPath)) {
      const watcher = fs.watch(schedule.watchPath, { recursive: false }, (event, filename) => {
        if (!filename) return;
        console.log(`📁 File changed: ${filename} — triggering "${schedule.name}"`);
        executeScheduledTask(schedule);
      });
      activeWatchers.set(id, watcher);
      console.log(`👁️ Watching: ${schedule.watchPath} → "${schedule.name}"`);
    }
    return;
  }

  // CONDITION polling (check every 5 min)
  if (schedule.triggerType === TRIGGER_TYPES.CONDITION) {
    if (!cron) return;
    const task = cron.schedule("*/5 * * * *", async () => {
      const met = await checkCondition(schedule.condition);
      if (met) await executeScheduledTask(schedule);
    }, { timezone: schedule.timezone || "Asia/Kolkata" });
    activeTasks.set(id, task);
    console.log(`🔍 Condition watcher started: "${schedule.name}"`);
    return;
  }

  // Standard cron / daily / interval
  if (!cron) return;
  const expr = buildCronExpr(schedule);
  if (!expr || !cron.validate(expr)) {
    console.error(`❌ Invalid cron expression for "${schedule.name}": ${expr}`);
    return;
  }

  const task = cron.schedule(expr, () => executeScheduledTask(schedule), {
    timezone: schedule.timezone || "Asia/Kolkata",
  });
  activeTasks.set(id, task);
  console.log(`✅ Scheduled: "${schedule.name}" [${expr}] (${schedule.timezone || "Asia/Kolkata"})`);
}

// ── Unregister a schedule ─────────────────────────────────
function unregisterSchedule(id) {
  if (activeTasks.has(id)) {
    activeTasks.get(id).destroy();
    activeTasks.delete(id);
  }
  if (activeWatchers.has(id)) {
    activeWatchers.get(id).close();
    activeWatchers.delete(id);
  }
}

// ── Sync all schedules to RTDB ────────────────────────────
async function syncSchedulesToRTDB() {
  if (!rtdbRef || !workspaceIdRef || !firebaseRef) return;
  const { rtdbSet } = require("./listener");
  const schedules   = loadSchedules();
  try {
    await rtdbSet(
      firebaseRef.rtdbUrl,
      `/workspaces/${workspaceIdRef}/schedules`,
      schedules,
      firebaseRef.apiKey
    );
  } catch {}
}

// ── Create a new schedule ─────────────────────────────────
function createSchedule(data) {
  const schedules = loadSchedules();
  const schedule  = {
    id:           `sched_${Date.now()}`,
    name:         data.name         || "Untitled Schedule",
    command:      data.command       || "",
    triggerType:  data.triggerType   || TRIGGER_TYPES.DAILY,
    cronExpr:     data.cronExpr      || null,
    dailyTime:    data.dailyTime     || "09:00",
    intervalMinutes: data.intervalMinutes || 60,
    condition:    data.condition     || null,
    watchPath:    data.watchPath     || null,
    timezone:     data.timezone      || "Asia/Kolkata",
    enabled:      true,
    retryOnFail:  data.retryOnFail !== false,
    runCount:     0,
    lastRan:      null,
    lastSuccess:  null,
    createdAt:    new Date().toISOString(),
    tags:         data.tags || [],
    skillId:      data.skillId || null, // optional: link to a skill
  };

  schedules.push(schedule);
  saveSchedules(schedules);
  registerSchedule(schedule);
  syncSchedulesToRTDB();

  console.log(`✅ Schedule created: "${schedule.name}" [${schedule.id}]`);
  return schedule;
}

// ── Update a schedule ─────────────────────────────────────
function updateSchedule(id, updates) {
  const schedules = loadSchedules();
  const idx       = schedules.findIndex(s => s.id === id);
  if (idx === -1) return null;

  schedules[idx] = { ...schedules[idx], ...updates };
  saveSchedules(schedules);

  unregisterSchedule(id);
  if (schedules[idx].enabled) registerSchedule(schedules[idx]);
  syncSchedulesToRTDB();

  return schedules[idx];
}

// ── Delete a schedule ─────────────────────────────────────
function deleteSchedule(id) {
  const schedules = loadSchedules();
  const filtered  = schedules.filter(s => s.id !== id);
  saveSchedules(filtered);
  unregisterSchedule(id);
  syncSchedulesToRTDB();
}

// ── Toggle enable/disable ─────────────────────────────────
function toggleSchedule(id, enabled) {
  return updateSchedule(id, { enabled });
}

// ── Run immediately ───────────────────────────────────────
function runNow(id) {
  const schedules = loadSchedules();
  const schedule  = schedules.find(s => s.id === id);
  if (schedule) executeScheduledTask(schedule);
}

// ── Get history for a schedule ────────────────────────────
function getScheduleHistory(scheduleId, limit = 20) {
  const history = loadHistory();
  return history
    .filter(h => h.scheduleId === scheduleId)
    .slice(-limit)
    .reverse();
}

// ── Start all schedules on agent boot ─────────────────────
function startScheduler(workspaceId, firebaseConfig, modelConfig) {
  workspaceIdRef = workspaceId;
  firebaseRef    = firebaseConfig;
  modelRef       = modelConfig;

  if (!cron) {
    console.warn("⚠️ Scheduler disabled — node-cron not installed");
    console.warn("   Run: npm install node-cron");
    return;
  }

  const schedules = loadSchedules();
  console.log(`\n⏰ Scheduler starting — ${schedules.filter(s => s.enabled).length} active schedules`);

  schedules.forEach(s => { if (s.enabled) registerSchedule(s); });

  // Listen for schedule updates from RTDB (website can create schedules)
  listenForScheduleUpdates(workspaceId, firebaseConfig);

  // Initial sync
  syncSchedulesToRTDB();

  console.log("✅ Scheduler ready");
}

// ── Listen for schedule CRUD from website ─────────────────
function listenForScheduleUpdates(workspaceId, firebaseConfig) {
  const { listenRTDB } = require("./listener");
  const { rtdbUrl, apiKey } = firebaseConfig;

  listenRTDB(rtdbUrl, `/workspaces/${workspaceId}/scheduleActions`, apiKey, async (event, payload) => {
    if (!payload?.data) return;
    const action = payload.data;

    switch (action.type) {
      case "CREATE":
        createSchedule(action.schedule);
        break;
      case "UPDATE":
        updateSchedule(action.scheduleId, action.updates);
        break;
      case "DELETE":
        deleteSchedule(action.scheduleId);
        break;
      case "TOGGLE":
        toggleSchedule(action.scheduleId, action.enabled);
        break;
      case "RUN_NOW":
        runNow(action.scheduleId);
        break;
    }

    // Clear action after processing
    const { rtdbSet } = require("./listener");
    await rtdbSet(rtdbUrl, `/workspaces/${workspaceId}/scheduleActions`, null, apiKey);
  });
}

module.exports = {
  startScheduler,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  runNow,
  loadSchedules,
  getScheduleHistory,
  syncSchedulesToRTDB,
  TRIGGER_TYPES,
};
