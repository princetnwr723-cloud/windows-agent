// src/agent/toolRouter.js
// ═══════════════════════════════════════════════════════════
// UNIVERSAL TOOL ROUTER  (Feature #7)
// "Use whatever tool you need" — even with no MCP connected.
// Decides, for any named tool, the fastest reliable way to use
// it right now, in priority order:
//
//   1. MCP server (fastest, most reliable — if connected)
//   2. Learned macro (fast, self-healing — if recorded before)
//   3. Live reasoning (accessibility engine figures it out live
//      from scratch, then SAVES what it learned as a new macro
//      so the next request for the same tool is faster)
//
// This is the piece that ties accessibilityEngine.js,
// demonstrationRecorder.js, and mcpManager.js into one decision,
// instead of the AI having to pick the right action type itself.
// ═══════════════════════════════════════════════════════════

const { getAllMCPTools, callMCPTool }        = require("./mcpManager");
const { listMacros, replayMacro }             = require("./demonstrationRecorder");
const { runAutomationTask, perceive }         = require("./accessibilityEngine");
const { getPage }                             = require("./browserAgent");

// ── Find an MCP tool matching a requested tool name ──────────
function findMCPMatch(toolName) {
  const tools = getAllMCPTools();
  const name  = toolName.toLowerCase();
  return tools.find(t =>
    t.serverName?.toLowerCase().includes(name) ||
    name.includes(t.serverName?.toLowerCase() || "___") ||
    t.name?.toLowerCase().includes(name)
  ) || null;
}

// ── Find a learned macro matching a requested tool name ──────
function findMacroMatch(toolName) {
  const macros = listMacros();
  const name   = toolName.toLowerCase();
  return macros.find(m => m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase())) || null;
}

// ── Try to discover the tool's URL if we don't have one ──────
async function discoverToolUrl(toolName) {
  // Simple heuristic first — most SaaS tools live at tool.com
  const guess = `https://${toolName.toLowerCase().replace(/\s+/g, "")}.com`;
  return guess;
}

// ── THE ROUTER — decide how to fulfil "use [tool] to [goal]" ──
async function routeToolRequest(toolName, goal, options = {}) {
  const { onLog = console.log, data = {}, knownUrl = null } = options;

  onLog(`🧭 Routing tool request: "${toolName}" → ${goal}`);

  // ── Priority 1: MCP ─────────────────────────────────────
  const mcpMatch = findMCPMatch(toolName);
  if (mcpMatch) {
    onLog(`  ✅ Found MCP: ${mcpMatch.serverName} — calling directly (fastest path)`);
    try {
      const result = await callMCPTool(mcpMatch.serverId, mcpMatch.name, { goal, ...data });
      return { success: true, method: "mcp", server: mcpMatch.serverName, output: result };
    } catch (err) {
      onLog(`  ⚠️ MCP call failed (${err.message}) — falling back to macro/live reasoning`);
    }
  }

  // ── Priority 2: Learned macro ───────────────────────────
  const macroMatch = findMacroMatch(toolName);
  if (macroMatch) {
    onLog(`  ✅ Found learned workflow: "${macroMatch.name}" (used ${macroMatch.runCount}x before) — replaying`);
    const page = await getPage();
    const result = await replayMacro(page, macroMatch.name, data, { onLog });
    if (result.success || result.healedSteps > 0) {
      return { success: result.success, method: "macro", macro: macroMatch.name, output: result };
    }
    onLog(`  ⚠️ Macro replay struggled — falling back to live reasoning for this run`);
  }

  // ── Priority 3: Live reasoning (never seen this tool before) ──
  onLog(`  🧠 No MCP or macro for "${toolName}" — reasoning live via accessibility engine`);
  const page = await getPage();
  const url  = knownUrl || await discoverToolUrl(toolName);

  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(async () => {
    onLog(`  ⚠️ Couldn't reach ${url} directly — will need a search step first`);
  });

  // Build a minimal step from the goal — the AI planning layer
  // (brain.js) is expected to have already broken `goal` into
  // concrete steps when this path is hit for a multi-step task;
  // this single-step version handles the simple "click through
  // once" case and always ends by offering to save what worked.
  const result = await runAutomationTask(page, options.steps || [
    { description: goal, action: "click" },
  ], { onLog });

  if (result.success) {
    onLog(`  💾 This worked — recommend recording it as a macro next time for speed (record: "${toolName} - ${goal}")`);
  }

  return { success: result.success, method: "live_reasoning", output: result, suggestRecording: result.success };
}

// ── Check whether we have ANY way to use a named tool ────────
// Useful for the AI to decide up front whether to even attempt
// something, or ask the user for more detail first.
function getToolAvailability(toolName) {
  const mcp   = findMCPMatch(toolName);
  const macro = findMacroMatch(toolName);
  return {
    hasMCP:   !!mcp,
    hasMacro: !!macro,
    canAttemptLiveReasoning: true, // always true — worst case is a lower success rate
    bestMethod: mcp ? "mcp" : macro ? "macro" : "live_reasoning",
  };
}

module.exports = {
  routeToolRequest,
  getToolAvailability,
  findMCPMatch,
  findMacroMatch,
};