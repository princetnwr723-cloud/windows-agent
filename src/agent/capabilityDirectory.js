// src/agent/capabilityDirectory.js
// ═══════════════════════════════════════════════════════════
// CAPABILITY DIRECTORY  (Features #8 + #9)
// Single source of truth for "who can do what" — per-agent MCP
// assignments, active macros, pending tasks, training state.
// Boss Agent's context is built from THIS, not a guess — so the
// same data the dashboard shows the user is what the Boss reasons
// over. No more asymmetry between what the user sees and what
// the Boss "knows".
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const DIR_FILE = path.join(os.homedir(), ".vnus-agent", "capability-directory.json");

function loadDirectory() {
  try { return JSON.parse(fs.readFileSync(DIR_FILE, "utf8")); }
  catch { return { assignments: {}, updatedAt: null }; }
}
function saveDirectory(d) {
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(DIR_FILE, JSON.stringify(d, null, 2));
}

// ── Assign an MCP server to a specific agent (or "all") ─────
function assignMCPToAgent(agentId, mcpServerId) {
  const dir = loadDirectory();
  if (!dir.assignments[agentId]) dir.assignments[agentId] = { mcps: [] };
  if (!dir.assignments[agentId].mcps.includes(mcpServerId)) {
    dir.assignments[agentId].mcps.push(mcpServerId);
  }
  saveDirectory(dir);
  return dir.assignments[agentId];
}

function unassignMCPFromAgent(agentId, mcpServerId) {
  const dir = loadDirectory();
  if (!dir.assignments[agentId]) return null;
  dir.assignments[agentId].mcps = dir.assignments[agentId].mcps.filter(m => m !== mcpServerId);
  saveDirectory(dir);
  return dir.assignments[agentId];
}

function getAgentMCPs(agentId) {
  const dir = loadDirectory();
  const own   = dir.assignments[agentId]?.mcps || [];
  const shared = dir.assignments["all"]?.mcps || [];
  return [...new Set([...own, ...shared])];
}

// ── Build the full capability map — this is what both the
// dashboard AND the Boss Agent's prompt read from ───────────
function buildCapabilityMap() {
  const { getAllAgentStatuses, loadAgentData } = require("./teamAgent");
  const { getMCPStatus } = require("./mcpManager");
  const { listMacros } = require("./demonstrationRecorder");
  const { listTasks } = require("./sessionPersistence");

  const agents    = getAllAgentStatuses();
  const mcpStatus = getMCPStatus();
  const allMacros = listMacros();
  const allTasks  = listTasks();
  const runningMCPs = [...mcpStatus.builtin, ...mcpStatus.custom].filter(m => m.running);

  return agents.map(agent => {
    const data       = loadAgentData(agent.id);
    const assignedIds = getAgentMCPs(agent.id);
    const assignedMCPs = runningMCPs.filter(m => assignedIds.includes(m.id));
    const pendingTasks = allTasks.filter(t => t.agentId === agent.id && ["running", "paused", "waiting_approval"].includes(t.status));

    return {
      id:          agent.id,
      name:        agent.name,
      role:        agent.role,
      mcps:        assignedMCPs.map(m => ({ id: m.id, name: m.name, tools: m.toolCount || 0 })),
      training:    data.preferences.map(p => p.instruction),
      macros:      allMacros.filter(m => m.owner === agent.id || !m.owner).map(m => ({ name: m.name, runCount: m.runCount })),
      pendingTasks: pendingTasks.map(t => ({ id: t.id, label: t.label, status: t.status })),
      totalTasks:  agent.totalTasks,
    };
  });
}

// ── Render the map as prompt text for the Boss Agent ────────
function buildCapabilityPrompt() {
  const map = buildCapabilityMap();
  if (!map.length) return "";

  let out = `\n═══ TEAM CAPABILITY DIRECTORY (live, always current) ═══\n`;
  out += `This is the SAME data the user sees on their dashboard right now.\n`;
  out += `Use it to decide who should handle a task — don't guess.\n\n`;

  map.forEach(a => {
    out += `${a.name} (${a.role}):\n`;
    out += `  MCP tools: ${a.mcps.length ? a.mcps.map(m => `${m.name} (${m.tools} tools)`).join(", ") : "none assigned"}\n`;
    if (a.training.length) out += `  Trained rules: ${a.training.join(" | ")}\n`;
    if (a.macros.length) out += `  Learned workflows: ${a.macros.map(m => `"${m.name}" (used ${m.runCount}x)`).join(", ")}\n`;
    if (a.pendingTasks.length) out += `  ⚠️ Currently busy with: ${a.pendingTasks.map(t => `${t.label} (${t.status})`).join(", ")}\n`;
    out += `  Lifetime tasks completed: ${a.totalTasks}\n\n`;
  });

  out += `Route new tasks to the agent whose MCPs/macros already match the\n`;
  out += `need — that will be faster and more reliable than one with no\n`;
  out += `matching tools. Avoid routing to an agent already busy above\n`;
  out += `unless the task is urgent.\n═══════════════════════════════════════\n`;

  return out;
}

module.exports = {
  assignMCPToAgent,
  unassignMCPFromAgent,
  getAgentMCPs,
  buildCapabilityMap,
  buildCapabilityPrompt,
  loadDirectory,
};