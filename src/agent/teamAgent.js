// src/agent/teamAgent.js
// ═══════════════════════════════════════════════════════════
// TEAM AGENT SYSTEM
// Har agent ka alag memory, preferences, history
// Agent-to-agent coordination
// Boss Agent task routing
// Per-agent cron jobs
// ═══════════════════════════════════════════════════════════

const { runOllamaPrompt }           = require("./ollamaManager");
const { getBestConnector, callConnector } = require("./connectors");
const { buildBusinessPrompt, loadDNA }    = require("./businessDNA");
const { buildMemoryPrompt }              = require("./memory");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const AGENTS_DIR = path.join(os.homedir(), ".vnus-agent", "agents");
const COORD_FILE = path.join(AGENTS_DIR, "coordination.json");
const LOG_FILE   = path.join(AGENTS_DIR, "activity-log.json");
if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });

// ── All Agent Definitions ──────────────────────────────────
const AGENT_DEFS = {
  boss: {
    id: "boss", name: "Boss Agent", emoji: "👑", color: "#FF3B30",
    role: "CEO & Coordinator",
    description: "Routes tasks, assembles teams, coordinates all agents",
    systemPrompt: `You are the Boss Agent — the coordinator of all other agents.
Your job:
- Analyze every task that comes in
- Decide: handle alone OR assemble a team
- Route sub-tasks to the right specialist agents
- Monitor team progress and compile results
- Report final output to the user

When a task is complex (marketing, development, strategy):
- Break it into sub-tasks
- Assign each to the right specialist
- Pass context between agents
- Compile final result

Always be decisive. Always think about business impact.`,
    canCoordinate: true,
    isDefault: true,
  },
  researcher: {
    id: "researcher", name: "Research Agent", emoji: "🔍", color: "#60a5fa",
    role: "Research & Intelligence",
    description: "Deep research, competitor analysis, market intelligence",
    systemPrompt: `You are the Research Agent — specialist in gathering intelligence.
Your job:
- Deep research on any topic
- Competitor analysis and monitoring
- Market trends and opportunities
- Data gathering and summarization
Always cite sources. Be specific with data.`,
    canCoordinate: false,
  },
  writer: {
    id: "writer", name: "Content Writer", emoji: "✍️", color: "#a78bfa",
    role: "Content & Copy",
    description: "Blog posts, social media, emails, marketing copy",
    systemPrompt: `You are the Content Writer Agent — specialist in all forms of content.
Your job:
- Write high-quality, engaging content
- Match brand voice exactly
- Optimize for target audience
- Create blog posts, social posts, emails, landing pages
Always ask Research Agent for data if needed.`,
    canCoordinate: false,
  },
  developer: {
    id: "developer", name: "Developer Agent", emoji: "💻", color: "#34d399",
    role: "Code & Architecture",
    description: "Full stack code, architecture decisions, technical tasks",
    systemPrompt: `You are the Developer Agent — specialist in all things technical.
Your job:
- Write clean, production-ready code
- Make architecture decisions
- Review and fix bugs
- Build complete features
Always write complete code. Never truncate. Document everything.`,
    canCoordinate: false,
  },
  marketer: {
    id: "marketer", name: "Marketing Agent", emoji: "📢", color: "#fbbf24",
    role: "Marketing & Campaigns",
    description: "Campaign planning, ad copy, launch strategies",
    systemPrompt: `You are the Marketing Agent — specialist in growth and campaigns.
Your job:
- Create complete marketing campaigns
- Write compelling ad copy and hooks
- Plan product launches
- Distribution strategy across channels
Always think conversion. Every piece should drive action.`,
    canCoordinate: false,
  },
  analyst: {
    id: "analyst", name: "Analytics Agent", emoji: "📊", color: "#f97316",
    role: "Data & Analytics",
    description: "Metrics analysis, business intelligence, reports",
    systemPrompt: `You are the Analytics Agent — specialist in data and insights.
Your job:
- Analyze business metrics and data
- Find patterns and anomalies
- Generate insights and recommendations
- Create clear reports
Always back claims with data. Be specific.`,
    canCoordinate: false,
  },
  sales: {
    id: "sales", name: "Sales Agent", emoji: "💰", color: "#4ade80",
    role: "Sales & Outreach",
    description: "Lead gen, outreach sequences, sales copy",
    systemPrompt: `You are the Sales Agent — specialist in revenue generation.
Your job:
- Write personalized outreach sequences
- Create follow-up chains
- Handle objections in advance
- Build sales playbooks
Always focus on conversion. Every word should sell.`,
    canCoordinate: false,
  },
  editor: {
    id: "editor", name: "Editor Agent", emoji: "✅", color: "#e879f9",
    role: "Quality & Review",
    description: "Reviews all output, final polish, quality control",
    systemPrompt: `You are the Editor Agent — the quality gatekeeper.
Your job:
- Review all output from other agents
- Fix errors, inconsistencies, gaps
- Improve clarity and impact
- Ensure brand voice consistency
- Give final approval before delivery
Be thorough. No output leaves without your review.`,
    canCoordinate: false,
  },
};

// ── Load agent memory/preferences ─────────────────────────
function loadAgentData(agentId) {
  const file = path.join(AGENTS_DIR, `${agentId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      agentId,
      preferences:  [],
      trainedFacts: [],
      skills:       [],
      taskHistory:  [],
      schedules:    [],
      createdAt:    new Date().toISOString(),
      lastActive:   null,
      totalTasks:   0,
    };
  }
}

function saveAgentData(agentId, data) {
  const file = path.join(AGENTS_DIR, `${agentId}.json`);
  data.lastActive = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Activity Log ───────────────────────────────────────────
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return { entries: [] }; }
}

function addToLog(agentId, action, detail, taskId = null) {
  const log = loadLog();
  const entry = {
    id:        `log_${Date.now()}`,
    agentId,
    agentName: AGENT_DEFS[agentId]?.name || agentId,
    agentEmoji:AGENT_DEFS[agentId]?.emoji || "🤖",
    action,
    detail,
    taskId,
    timestamp: new Date().toISOString(),
    timeAgo:   "just now",
  };
  log.entries = [entry, ...log.entries].slice(0, 100);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  return entry;
}

function getRecentLog(limit = 20) {
  const log = loadLog();
  return log.entries.slice(0, limit).map(e => ({
    ...e,
    timeAgo: getTimeAgo(new Date(e.timestamp)),
  }));
}

function getTimeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Coordination system ────────────────────────────────────
function loadCoordination() {
  try { return JSON.parse(fs.readFileSync(COORD_FILE, "utf8")); }
  catch { return { requests: [], completedTasks: [] }; }
}

function saveCoordination(data) {
  fs.writeFileSync(COORD_FILE, JSON.stringify(data, null, 2));
}

async function requestHelp(fromAgent, toAgent, task, context, modelConfig) {
  console.log(`\n🤝 ${fromAgent} → ${toAgent}: "${task.slice(0, 50)}"`);

  addToLog(fromAgent, "requested_help", `Asked ${AGENT_DEFS[toAgent]?.name} for help: ${task.slice(0, 60)}...`);

  const result = await runSingleAgent(toAgent, task, context, null, modelConfig);

  addToLog(toAgent, "helped_agent", `Helped ${AGENT_DEFS[fromAgent]?.name}: ${task.slice(0, 60)}...`);

  return result;
}

// ── Train an agent ─────────────────────────────────────────
function trainAgent(agentId, instruction) {
  const data = loadAgentData(agentId);
  data.preferences.push({
    instruction,
    addedAt: new Date().toISOString(),
  });
  saveAgentData(agentId, data);
  addToLog(agentId, "trained", `New instruction: "${instruction.slice(0, 60)}..."`);
  console.log(`🎓 ${agentId} trained: "${instruction}"`);
}

// ── Add custom skill to agent ──────────────────────────────
function addSkillToAgent(agentId, skill) {
  const data = loadAgentData(agentId);
  data.skills.push({
    ...skill,
    installedAt: new Date().toISOString(),
  });
  saveAgentData(agentId, data);
  addToLog(agentId, "skill_added", `New skill: ${skill.name}`);
}

// ── Schedule task for agent ────────────────────────────────
function scheduleAgentTask(agentId, task, cronExpression, label) {
  const data = loadAgentData(agentId);
  const schedule = {
    id:         `sched_${Date.now()}`,
    task,
    cron:       cronExpression,
    label,
    active:     true,
    lastRun:    null,
    createdAt:  new Date().toISOString(),
  };
  data.schedules.push(schedule);
  saveAgentData(agentId, data);
  addToLog(agentId, "scheduled", `New schedule: "${label}" (${cronExpression})`);
  return schedule;
}

// ── Build agent system prompt ──────────────────────────────
function buildAgentPrompt(agentId) {
  const def       = AGENT_DEFS[agentId];
  const data      = loadAgentData(agentId);
  const businessCtx = buildBusinessPrompt();
  const memoryCtx   = buildMemoryPrompt();
  const dna         = loadDNA();

  let prompt = `${def.systemPrompt}\n\n`;

  // Business context
  if (businessCtx) prompt += `${businessCtx}\n`;

  // Memory
  if (memoryCtx) prompt += `${memoryCtx}\n`;

  // Agent-specific training
  if (data.preferences.length > 0) {
    prompt += `\nYOUR PERSONAL TRAINING (always follow these):\n`;
    data.preferences.forEach(p => { prompt += `- ${p.instruction}\n`; });
  }

  // Agent skills
  if (data.skills.length > 0) {
    prompt += `\nYOUR INSTALLED SKILLS:\n`;
    data.skills.forEach(s => { prompt += `- ${s.name}: ${s.description}\n`; });
  }

  // Recent history
  if (data.taskHistory.length > 0) {
    prompt += `\nRECENT TASKS:\n`;
    data.taskHistory.slice(-5).forEach(t => {
      prompt += `- "${t.task.slice(0,60)}" → ${t.result.slice(0,60)}\n`;
    });
  }

  prompt += `\nYou are part of a team. Other agents: ${Object.keys(AGENT_DEFS).filter(a => a !== agentId).map(a => AGENT_DEFS[a].name).join(", ")}.`;
  prompt += `\nBe specific. Be excellent. This is your speciality.`;

  return prompt;
}

// ── Run a single agent ─────────────────────────────────────
async function runSingleAgent(agentId, task, context = "", originalCommand = null, modelConfig) {
  const def  = AGENT_DEFS[agentId];
  const data = loadAgentData(agentId);

  if (!def) return { success: false, output: `Unknown agent: ${agentId}` };

  console.log(`\n${def.emoji} ${def.name} working: "${task.slice(0, 60)}..."`);
  addToLog(agentId, "started_task", task.slice(0, 80));

  const systemPrompt = buildAgentPrompt(agentId);
  const userContent = `${context ? `Context from previous agents:\n${context}\n\n` : ""}Your task: ${task}${originalCommand ? `\n\nOriginal user request: "${originalCommand}"` : ""}\n\nGive your complete, excellent output.`;

  let output = "";

  try {
    // Try API connector first for quality
    const connector = await getBestConnector("general");
    if (connector) {
      output = await callConnector(connector, systemPrompt, userContent);
    } else {
      output = await runOllamaPrompt(modelConfig.ollamaId, systemPrompt, userContent);
    }

    // Save to history
    data.taskHistory = [
      { task: task.slice(0, 100), result: output.slice(0, 200), completedAt: new Date().toISOString() },
      ...data.taskHistory,
    ].slice(0, 50);
    data.totalTasks++;
    saveAgentData(agentId, data);

    addToLog(agentId, "completed_task", `Completed: ${task.slice(0, 60)}...`);
    console.log(`  ✅ ${def.name} done`);

    return { success: true, agentId, agentName: def.name, output };
  } catch (err) {
    console.error(`  ❌ ${def.name} error: ${err.message}`);
    addToLog(agentId, "task_failed", err.message);
    return { success: false, agentId, agentName: def.name, output: `Error: ${err.message}` };
  }
}

// ── Boss Agent — smart task routing ───────────────────────
async function bossAgentRoute(command, modelConfig) {
  console.log(`\n👑 Boss Agent routing: "${command}"`);
  addToLog("boss", "received_task", command.slice(0, 80));

  const businessCtx = buildBusinessPrompt();
  const memCtx      = buildMemoryPrompt();

  const routingPrompt = `${businessCtx}${memCtx}

User command: "${command}"

Available agents:
${Object.entries(AGENT_DEFS).filter(([id]) => id !== "boss").map(([id, a]) => `- ${a.emoji} ${a.name} (${a.role}): ${a.description}`).join("\n")}

Decide routing. Respond ONLY with valid JSON:
{
  "complexity": "simple|medium|complex",
  "handle": "alone|team",
  "reasoning": "Why",
  "agents": ["researcher", "writer"],
  "taskBreakdown": [
    {"agent": "researcher", "task": "specific task"},
    {"agent": "writer", "task": "specific task", "dependsOn": "researcher"}
  ],
  "estimatedTime": "2-3 minutes"
}`;

  let routing = null;
  try {
    const connector = await getBestConnector("reasoning");
    let text = connector
      ? await callConnector(connector, "You are a task routing AI. Output ONLY valid JSON.", routingPrompt)
      : await runOllamaPrompt(modelConfig.ollamaId, "You are a task routing AI. Output ONLY valid JSON.", routingPrompt);

    const match = text.match(/\{[\s\S]*\}/);
    if (match) routing = JSON.parse(match[0]);
  } catch {}

  // Fallback routing
  if (!routing) {
    const cmd = command.toLowerCase();
    const isComplex = /(campaign|strategy|build|create.*full|launch|plan|develop|write.*blog|outreach)/i.test(cmd);
    routing = {
      complexity: isComplex ? "complex" : "simple",
      handle: isComplex ? "team" : "alone",
      agents: isComplex ? ["researcher", "writer", "editor"] : ["boss"],
      taskBreakdown: isComplex ? [
        { agent: "researcher", task: `Research for: ${command}` },
        { agent: "writer",     task: `Create content for: ${command}`, dependsOn: "researcher" },
        { agent: "editor",     task: "Review and finalize",          dependsOn: "writer" },
      ] : [{ agent: "boss", task: command }],
      estimatedTime: isComplex ? "5-8 minutes" : "30 seconds",
    };
  }

  addToLog("boss", "routing_decision", `${routing.handle === "team" ? "Team: " + routing.agents.join(", ") : "Handling alone"} — ${routing.estimatedTime}`);

  return routing;
}

// ── Execute full team task ─────────────────────────────────
async function executeTeamTask(command, modelConfig, onProgress) {
  const routing = await bossAgentRoute(command, modelConfig);

  if (routing.handle === "alone") {
    onProgress?.({ phase: "solo", message: "👑 Boss Agent handling this directly..." });
    const result = await runSingleAgent("boss", command, "", command, modelConfig);
    return { success: true, output: result.output, routing, solo: true };
  }

  // Team execution
  onProgress?.({
    phase:    "assembling",
    message:  `👑 Boss Agent assembled team: ${routing.agents.map(a => AGENT_DEFS[a]?.emoji + " " + AGENT_DEFS[a]?.name).join(" → ")}`,
    agents:   routing.agents.map(id => ({ id, ...AGENT_DEFS[id], status: "waiting" })),
    routing,
  });

  const results = {};
  const agentStatuses = routing.agents.map(id => ({ id, ...AGENT_DEFS[id], status: "waiting", output: null }));

  for (const step of routing.taskBreakdown) {
    const agentId = step.agent;
    const idx     = agentStatuses.findIndex(a => a.id === agentId);

    // Context from dependency
    let context = "";
    if (step.dependsOn && results[step.dependsOn]) {
      context = `${AGENT_DEFS[step.dependsOn]?.name} completed:\n${results[step.dependsOn].output}`;
    }

    if (idx >= 0) agentStatuses[idx].status = "working";
    onProgress?.({
      phase:        "executing",
      message:      `${AGENT_DEFS[agentId]?.emoji} ${AGENT_DEFS[agentId]?.name} working...`,
      agents:       agentStatuses,
      currentAgent: agentId,
    });

    const result = await runSingleAgent(agentId, step.task, context, command, modelConfig);
    results[agentId] = result;

    if (idx >= 0) {
      agentStatuses[idx].status = result.success ? "done" : "error";
      agentStatuses[idx].output = result.output;
    }

    onProgress?.({
      phase:       "executing",
      message:     `${result.success ? "✅" : "⚠️"} ${AGENT_DEFS[agentId]?.name} finished`,
      agents:      agentStatuses,
      latestOutput:result.output,
    });
  }

  // Boss compiles final output
  addToLog("boss", "compiled_results", `Compiled output from ${routing.agents.length} agents`);

  const lastAgent   = routing.taskBreakdown[routing.taskBreakdown.length - 1]?.agent;
  const finalOutput = results[lastAgent]?.output
    || Object.values(results).filter(r => r.success).map(r => r.output).join("\n\n---\n\n");

  onProgress?.({
    phase:       "complete",
    message:     `✅ Team completed (${routing.agents.length} agents)`,
    agents:      agentStatuses,
    finalOutput,
  });

  return {
    success:    true,
    output:     finalOutput,
    routing,
    agents:     agentStatuses,
    results,
    solo:       false,
  };
}

// ── Direct agent chat ──────────────────────────────────────
async function chatWithAgent(agentId, message, modelConfig) {
  console.log(`\n💬 Direct chat with ${agentId}: "${message.slice(0, 60)}"`);
  addToLog(agentId, "direct_chat", message.slice(0, 80));

  // Detect training commands
  if (/^train:/i.test(message)) {
    const instruction = message.replace(/^train:\s*/i, "").trim();
    trainAgent(agentId, instruction);
    return {
      success: true,
      output: `✅ Training saved!\n\n${AGENT_DEFS[agentId]?.name} will now always: "${instruction}"\n\nThis preference is permanent until you update it.`,
      type: "training",
    };
  }

  // Detect schedule commands
  if (/^schedule:/i.test(message)) {
    const parts   = message.replace(/^schedule:\s*/i, "").split("|");
    const task    = parts[0]?.trim();
    const cron    = parts[1]?.trim() || "0 9 * * *";
    const label   = parts[2]?.trim() || task;
    const schedule = scheduleAgentTask(agentId, task, cron, label);
    return {
      success: true,
      output: `⏰ Scheduled!\n\n**${AGENT_DEFS[agentId]?.name}** will run:\n"${task}"\n\nSchedule: ${cron}\nLabel: ${label}\n\nManage in Scheduler tab.`,
      type: "schedule",
      schedule,
    };
  }

  // Regular chat
  const result = await runSingleAgent(agentId, message, "", null, modelConfig);
  return { success: result.success, output: result.output, type: "chat" };
}

// ── Get all agent statuses ─────────────────────────────────
function getAllAgentStatuses() {
  return Object.entries(AGENT_DEFS).map(([id, def]) => {
    const data = loadAgentData(id);
    return {
      id,
      name:         def.name,
      emoji:        def.emoji,
      color:        def.color,
      role:         def.role,
      description:  def.description,
      totalTasks:   data.totalTasks || 0,
      preferences:  data.preferences.length,
      skills:       data.skills.length,
      schedules:    data.schedules.length,
      lastActive:   data.lastActive,
      isDefault:    def.isDefault || false,
    };
  });
}

module.exports = {
  AGENT_DEFS,
  loadAgentData,
  saveAgentData,
  trainAgent,
  addSkillToAgent,
  scheduleAgentTask,
  runSingleAgent,
  bossAgentRoute,
  executeTeamTask,
  chatWithAgent,
  getAllAgentStatuses,
  addToLog,
  getRecentLog,
  requestHelp,
};