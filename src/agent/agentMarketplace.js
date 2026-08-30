// src/agent/agentMarketplace.js
// ═══════════════════════════════════════════════════════════
// AGENT & TEAM MARKETPLACE  (Feature #6)
// SECURITY NOTE — read before extending this file:
// Only CONFIG-LEVEL sharing is implemented here on purpose.
// A shared "agent" or "team" is JSON data (prompt text, MCP
// requirement names, training instructions, example commands) —
// never executable code. This is what makes it safe to install
// something a stranger uploaded: worst case, it's a bad prompt,
// not a data-stealing script. A future "source-level" agent type
// (user-supplied JS handlers) needs a real sandboxing story
// (vm2 / worker_threads with no fs/net by default + a permission
// manifest + review queue) before it ships — do not bolt that on
// to this file without that design in place.
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { loadAgentData, AGENT_DEFS, trainAgent } = require("./teamAgent");
const { getAgentMCPs } = require("./capabilityDirectory");

const LOCAL_LIBRARY = path.join(os.homedir(), ".vnus-agent", "marketplace-library.json");

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(LOCAL_LIBRARY, "utf8")); }
  catch { return { installed: [] }; }
}
function saveLibrary(l) {
  fs.writeFileSync(LOCAL_LIBRARY, JSON.stringify(l, null, 2));
}

// ── Export the CURRENT state of one agent as a shareable bundle ──
function exportAgent(agentId) {
  const def  = AGENT_DEFS[agentId];
  const data = loadAgentData(agentId);
  if (!def) return { success: false, error: "Unknown agent" };

  const bundle = {
    bundleType:   "agent",
    schemaVersion: 1,
    name:         def.name,
    baseRole:     agentId,
    description:  def.description,
    customPrompt: def.systemPrompt,
    training:     data.preferences.map(p => p.instruction),
    mcpRequirements: getAgentMCPs(agentId), // names only, not the servers themselves
    sampleCommands: data.taskHistory.slice(0, 3).map(t => t.task),
    exportedAt:   new Date().toISOString(),
  };

  return { success: true, bundle };
}

// ── Export a full team (Boss + members) ──────────────────────
function exportTeam(teamName, memberAgentIds) {
  const members = memberAgentIds.map(id => exportAgent(id)).filter(r => r.success).map(r => r.bundle);

  return {
    success: true,
    bundle: {
      bundleType:    "team",
      schemaVersion: 1,
      teamName,
      members,
      memberCount:   members.length,
      exportedAt:    new Date().toISOString(),
    },
  };
}

// ── Validate a bundle before install — reject anything that
// isn't plain data, regardless of what it CLAIMS to be ──────
function validateBundle(bundle) {
  const errors = [];

  if (!bundle.bundleType || !["agent", "team"].includes(bundle.bundleType)) {
    errors.push("Unknown or missing bundleType");
  }
  if (bundle.schemaVersion !== 1) {
    errors.push(`Unsupported schema version: ${bundle.schemaVersion}`);
  }

  // Reject if any field contains something that looks like code,
  // not configuration — this is a heuristic safety net, not a
  // full sandbox (there is no code execution path here at all,
  // this just refuses to even STORE anything suspicious)
  const dangerousPatterns = [/require\s*\(/, /child_process/, /eval\s*\(/, /process\.(env|exit)/, /fs\.(unlink|rm|write)/, /<script/i];
  const flatText = JSON.stringify(bundle);
  const suspicious = dangerousPatterns.filter(p => p.test(flatText));
  if (suspicious.length) {
    errors.push(`Bundle contains code-like patterns that aren't allowed in a config bundle (${suspicious.length} flagged)`);
  }

  // Size sanity check — a legit prompt/training bundle is small text
  if (flatText.length > 200_000) {
    errors.push("Bundle is unexpectedly large for a config-only agent/team");
  }

  return { valid: errors.length === 0, errors };
}

// ── Install a validated bundle into the local team ───────────
function installBundle(bundle) {
  const validation = validateBundle(bundle);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const installedAgents = [];

  const install = (agentBundle) => {
    // Config bundles apply ON TOP of an existing base role
    // (researcher/writer/etc.) — they customize, they don't
    // fabricate a brand-new execution path
    if (!agentBundle.baseRole) return null;
    agentBundle.training.forEach(instruction => trainAgent(agentBundle.baseRole, instruction));
    installedAgents.push(agentBundle.baseRole);
    return agentBundle.baseRole;
  };

  if (bundle.bundleType === "agent") {
    install(bundle);
  } else if (bundle.bundleType === "team") {
    bundle.members.forEach(install);
  }

  const library = loadLibrary();
  library.installed.push({
    name:        bundle.teamName || bundle.name,
    type:        bundle.bundleType,
    installedAt: new Date().toISOString(),
    agentIds:    installedAgents,
  });
  saveLibrary(library);

  console.log(`✅ Installed ${bundle.bundleType}: ${bundle.teamName || bundle.name} (${installedAgents.length} agent(s) configured)`);
  return { success: true, installedAgents, requiresMCPs: collectRequiredMCPs(bundle) };
}

function collectRequiredMCPs(bundle) {
  if (bundle.bundleType === "agent") return bundle.mcpRequirements || [];
  return [...new Set((bundle.members || []).flatMap(m => m.mcpRequirements || []))];
}

function listInstalled() {
  return loadLibrary().installed;
}

module.exports = {
  exportAgent,
  exportTeam,
  validateBundle,
  installBundle,
  listInstalled,
};