// src/agent/sessionPersistence.js
// ═══════════════════════════════════════════════════════════
// SESSION PERSISTENCE
// Pause/resume for long-running browser tasks.
// Saves browser state (cookies/storage/URL) + task progress
// so a task can survive an agent restart, an approval wait,
// or a multi-day scheduled job — and continue exactly where
// it left off instead of starting over.
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const SESSIONS_DIR = path.join(os.homedir(), ".vnus-agent", "sessions");
const STATE_DIR     = path.join(SESSIONS_DIR, "browser-state");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(STATE_DIR))    fs.mkdirSync(STATE_DIR, { recursive: true });

// ── Task registry — index of all long-running tasks ────────
const REGISTRY_FILE = path.join(SESSIONS_DIR, "registry.json");

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")); }
  catch { return { tasks: {} }; }
}
function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

// ── Create a new persistent task ────────────────────────────
function createTask(taskId, meta = {}) {
  const reg = loadRegistry();
  reg.tasks[taskId] = {
    id:           taskId,
    label:        meta.label || taskId,
    status:       "running",       // running | paused | waiting_approval | completed | failed
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    currentStep:  0,
    totalSteps:   meta.totalSteps || null,
    stepData:     {},
    pauseReason:  null,
    ...meta,
  };
  saveRegistry(reg);
  return reg.tasks[taskId];
}

// ── Save browser state (cookies, localStorage, current URL) ──
async function saveBrowserState(context, page, taskId) {
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);

  const storageState = await context.storageState();
  const currentUrl   = page ? page.url() : null;
  const scrollPos    = page
    ? await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 }))
    : { x: 0, y: 0 };

  fs.writeFileSync(stateFile, JSON.stringify({
    storageState,
    currentUrl,
    scrollPos,
    savedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`💾 Browser state saved for task: ${taskId}`);
  return stateFile;
}

// ── Restore browser state into a fresh context ──────────────
async function restoreBrowserState(browser, taskId) {
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);
  if (!fs.existsSync(stateFile)) {
    return { context: await browser.newContext(), page: null, restored: false };
  }

  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const context = await browser.newContext({ storageState: saved.storageState });
  const page = await context.newPage();

  if (saved.currentUrl) {
    await page.goto(saved.currentUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (saved.scrollPos) {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), saved.scrollPos).catch(() => {});
    }
  }

  console.log(`♻️ Browser state restored for task: ${taskId} (was at ${saved.currentUrl})`);
  return { context, page, restored: true, savedAt: saved.savedAt };
}

// ── Save task progress checkpoint ───────────────────────────
function saveProgress(taskId, step, data = {}) {
  const reg = loadRegistry();
  if (!reg.tasks[taskId]) createTask(taskId);
  const t = reg.tasks[taskId];

  t.currentStep = step;
  t.stepData    = { ...t.stepData, ...data };
  t.updatedAt   = new Date().toISOString();
  saveRegistry(reg);

  return t;
}

// ── Pause a task (waiting for approval, rate limit, etc.) ──
function pauseTask(taskId, reason) {
  const reg = loadRegistry();
  if (!reg.tasks[taskId]) return null;

  reg.tasks[taskId].status      = reason?.includes("approval") ? "waiting_approval" : "paused";
  reg.tasks[taskId].pauseReason = reason;
  reg.tasks[taskId].updatedAt   = new Date().toISOString();
  saveRegistry(reg);

  console.log(`⏸️ Task paused: ${taskId} — ${reason}`);
  return reg.tasks[taskId];
}

// ── Resume a paused task ─────────────────────────────────────
function resumeTask(taskId) {
  const reg = loadRegistry();
  if (!reg.tasks[taskId]) return null;

  reg.tasks[taskId].status      = "running";
  reg.tasks[taskId].pauseReason = null;
  reg.tasks[taskId].updatedAt   = new Date().toISOString();
  saveRegistry(reg);

  console.log(`▶️ Task resumed: ${taskId} — continuing from step ${reg.tasks[taskId].currentStep}`);
  return reg.tasks[taskId];
}

// ── Mark task complete / failed ──────────────────────────────
function completeTask(taskId, success = true, result = null) {
  const reg = loadRegistry();
  if (!reg.tasks[taskId]) return null;

  reg.tasks[taskId].status    = success ? "completed" : "failed";
  reg.tasks[taskId].result    = result;
  reg.tasks[taskId].updatedAt = new Date().toISOString();
  saveRegistry(reg);

  // Clean up browser state file — task is done, no need to keep it
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);
  try { fs.unlinkSync(stateFile); } catch {}

  return reg.tasks[taskId];
}

// ── Get single task ───────────────────────────────────────────
function getTask(taskId) {
  const reg = loadRegistry();
  return reg.tasks[taskId] || null;
}

// ── List all tasks — for dashboard display ──────────────────
function listTasks(filterStatus = null) {
  const reg = loadRegistry();
  let tasks = Object.values(reg.tasks);
  if (filterStatus) tasks = tasks.filter(t => t.status === filterStatus);
  return tasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// ── Get tasks that need human attention right now ───────────
function getTasksNeedingApproval() {
  return listTasks("waiting_approval");
}

// ── Clean up old completed/failed tasks (housekeeping) ──────
function pruneOldTasks(olderThanDays = 30) {
  const reg = loadRegistry();
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const [id, task] of Object.entries(reg.tasks)) {
    if (["completed", "failed"].includes(task.status) && new Date(task.updatedAt).getTime() < cutoff) {
      delete reg.tasks[id];
      const stateFile = path.join(STATE_DIR, `${id}.json`);
      try { fs.unlinkSync(stateFile); } catch {}
      pruned++;
    }
  }
  saveRegistry(reg);
  return pruned;
}

// ── Delete a task entirely (user-initiated) ─────────────────
function deleteTask(taskId) {
  const reg = loadRegistry();
  delete reg.tasks[taskId];
  saveRegistry(reg);
  const stateFile = path.join(STATE_DIR, `${taskId}.json`);
  try { fs.unlinkSync(stateFile); } catch {}
}

module.exports = {
  createTask,
  saveBrowserState,
  restoreBrowserState,
  saveProgress,
  pauseTask,
  resumeTask,
  completeTask,
  getTask,
  listTasks,
  getTasksNeedingApproval,
  pruneOldTasks,
  deleteTask,
};