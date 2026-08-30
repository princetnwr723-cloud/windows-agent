// src/agent/simulationEngine.js
// ═══════════════════════════════════════════════════════════
// SIMULATION / PREVIEW MODE  (Feature #2)
// Before an irreversible or high-impact action runs for real,
// show exactly what WILL happen — no side effects — so the
// human can approve with full information instead of guessing.
// Natural extension of Smart Approval (confidence score) — this
// adds a second axis: IMPACT, not just confidence.
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const SIM_LOG = path.join(os.homedir(), ".vnus-agent", "simulation-log.json");

// ── Patterns that mark an action as irreversible / high-impact ──
const IMPACT_PATTERNS = [
  { pattern: /delete|remove|erase/i,                    impact: "high", category: "destructive" },
  { pattern: /\$\d+|budget|spend|payment|purchase|pay/i, impact: "high", category: "financial" },
  { pattern: /send\s+(email|message)\s+to\s+(all|everyone|list)/i, impact: "high", category: "mass_communication" },
  { pattern: /publish|post\s+(publicly|live)|go\s+live/i, impact: "medium", category: "public_facing" },
  { pattern: /deploy|production/i,                        impact: "medium", category: "deployment" },
  { pattern: /cancel|terminate|close\s+account/i,          impact: "high", category: "irreversible" },
];

function classifyImpact(command) {
  for (const p of IMPACT_PATTERNS) {
    if (p.pattern.test(command)) return { impact: p.impact, category: p.category };
  }
  return { impact: "low", category: "routine" };
}

// ── Build a dry-run preview WITHOUT executing anything ───────
// Uses the same action list the agent planned, but instead of
// running each action, describes its effect in plain language.
function buildPreview(command, plannedActions) {
  const { impact, category } = classifyImpact(command);

  const previewSteps = plannedActions.map((action, i) => {
    const desc = describeAction(action);
    return { step: i + 1, action: action.action, description: desc, reversible: isReversible(action) };
  });

  const irreversibleCount = previewSteps.filter(s => !s.reversible).length;

  const preview = {
    id:        `sim_${Date.now()}`,
    command,
    impact,
    category,
    steps:     previewSteps,
    totalSteps: previewSteps.length,
    irreversibleCount,
    createdAt: new Date().toISOString(),
    status:    "pending", // pending | approved | rejected
  };

  logSimulation(preview);
  return preview;
}

// ── Plain-language description of what an action will do ────
function describeAction(action) {
  const a = action.action;
  if (a === "write_file")     return `Create/overwrite file: ${action.path}`;
  if (a === "run_command")    return `Run system command: "${action.command}"`;
  if (a === "browser_click")  return `Click "${action.selector}" on the current page`;
  if (a === "smart_browser_task") return `Run ${action.steps?.length || 0}-step browser automation: ${action.label}`;
  if (a === "github_create_pr") return `Open a pull request: "${action.title}" (${action.head} → ${action.base})`;
  if (a === "mcp_call")       return `Call external tool "${action.tool}" on ${action.server}`;
  if (a === "replay_macro")   return `Replay learned workflow "${action.macroName}" with new data`;
  return `${a}${action.value ? `: ${JSON.stringify(action.value).slice(0, 60)}` : ""}`;
}

function isReversible(action) {
  const irreversibleActions = ["run_command", "github_create_pr", "mcp_call", "smart_browser_task", "replay_macro"];
  if (action.action === "run_command" && /del|rm |format/i.test(action.command || "")) return false;
  if (action.action === "write_file") return true; // usually can be overwritten/restored
  return !irreversibleActions.includes(action.action);
}

// ── Decide whether a command needs simulation before execution ──
// Combines impact classification with the confidence score from
// accessibilityEngine.js when available (low confidence + high
// impact = definitely simulate first; high confidence + low
// impact = just run it, don't slow the user down needlessly).
function shouldSimulate(command, options = {}) {
  const { impact } = classifyImpact(command);
  const confidence = options.confidence ?? 1.0;

  if (impact === "high") return true;
  if (impact === "medium" && confidence < 0.7) return true;
  return false;
}

// ── Approve / reject a pending simulation ────────────────────
function resolveSimulation(simId, approved) {
  const log = loadSimLog();
  const sim = log.find(s => s.id === simId);
  if (!sim) return null;
  sim.status = approved ? "approved" : "rejected";
  sim.resolvedAt = new Date().toISOString();
  saveSimLog(log);
  return sim;
}

function loadSimLog() {
  try { return JSON.parse(fs.readFileSync(SIM_LOG, "utf8")); }
  catch { return []; }
}
function saveSimLog(log) {
  fs.writeFileSync(SIM_LOG, JSON.stringify(log.slice(-100), null, 2));
}
function logSimulation(preview) {
  const log = loadSimLog();
  log.push(preview);
  saveSimLog(log);
}
function getPendingSimulations() {
  return loadSimLog().filter(s => s.status === "pending");
}
function getSimulation(simId) {
  return loadSimLog().find(s => s.id === simId) || null;
}

module.exports = {
  classifyImpact,
  buildPreview,
  shouldSimulate,
  resolveSimulation,
  getPendingSimulations,
  getSimulation,
};