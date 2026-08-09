// src/agent/multiAgent.js
// ═══════════════════════════════════════════════════════════
// MULTI-AGENT TEAM SYSTEM
// User ek command deta hai → Boss Agent team banata hai
// Har agent parallel kaam karta hai
// Real-time progress dashboard mein dikhta hai
// ═══════════════════════════════════════════════════════════

const { runOllamaPrompt } = require("./ollamaManager");
const { buildBusinessPrompt, loadDNA } = require("./businessDNA");
const { buildMemoryPrompt } = require("./memory");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TEAMS_DIR = path.join(os.homedir(), ".vnus-agent", "teams");
if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR, { recursive: true });

// ── Agent Role Definitions ─────────────────────────────────
const AGENT_ROLES = {
  researcher: {
    name: "Research Agent",
    emoji: "🔍",
    description: "Gathers data, analyzes competitors, finds opportunities",
    systemPrompt: `You are a Research Agent. Your job is to:
- Analyze the given topic deeply
- Find relevant data, statistics, trends
- Identify opportunities and threats
- Summarize findings clearly
Output: Structured research with key insights.`,
  },
  writer: {
    name: "Content Writer",
    emoji: "✍️",
    description: "Writes blogs, social posts, emails, copy",
    systemPrompt: `You are a Content Writer Agent. Your job is to:
- Write high-quality, engaging content
- Match the brand voice exactly
- Optimize for the target audience
- Include clear CTAs
Output: Ready-to-publish content.`,
  },
  strategist: {
    name: "Strategy Agent",
    emoji: "🎯",
    description: "Plans campaigns, sets priorities, makes decisions",
    systemPrompt: `You are a Strategy Agent. Your job is to:
- Analyze the business situation
- Identify the highest-impact actions
- Create step-by-step execution plans
- Prioritize ruthlessly
Output: Actionable strategy with clear steps.`,
  },
  developer: {
    name: "Developer Agent",
    emoji: "💻",
    description: "Writes code, builds features, fixes bugs",
    systemPrompt: `You are a Developer Agent. Your job is to:
- Write clean, production-ready code
- Follow best practices
- Document what you build
- Think about edge cases
Output: Working code with explanation.`,
  },
  marketer: {
    name: "Marketing Agent",
    emoji: "📢",
    description: "Creates campaigns, writes ad copy, plans launches",
    systemPrompt: `You are a Marketing Agent. Your job is to:
- Create marketing campaigns from scratch
- Write compelling ad copy and hooks
- Plan distribution strategy
- Think about conversion at every step
Output: Complete marketing plan with copy.`,
  },
  analyst: {
    name: "Analytics Agent",
    emoji: "📊",
    description: "Analyzes data, finds patterns, suggests improvements",
    systemPrompt: `You are an Analytics Agent. Your job is to:
- Analyze metrics and data
- Find patterns and anomalies
- Suggest data-driven improvements
- Create clear reports
Output: Analysis with actionable recommendations.`,
  },
  editor: {
    name: "Editor Agent",
    emoji: "✅",
    description: "Reviews, improves, and finalizes all output",
    systemPrompt: `You are an Editor Agent. Your job is to:
- Review all output from other agents
- Fix errors and inconsistencies
- Improve clarity and impact
- Ensure brand voice consistency
- Give final approval
Output: Polished, ready-to-use final version.`,
  },
  sales: {
    name: "Sales Agent",
    emoji: "💰",
    description: "Writes outreach, follow-ups, sales sequences",
    systemPrompt: `You are a Sales Agent. Your job is to:
- Write personalized outreach messages
- Create follow-up sequences
- Handle objections in advance
- Focus on conversion
Output: Complete sales sequence ready to send.`,
  },
};

// ── Team Templates ─────────────────────────────────────────
const TEAM_TEMPLATES = {
  content_creation: {
    name: "Content Creation Team",
    emoji: "📝",
    description: "Blog posts, social media, newsletters",
    agents: ["researcher", "writer", "editor"],
    flow: [
      { agent: "researcher", task: "Research the topic thoroughly" },
      { agent: "writer", task: "Write content based on research", dependsOn: "researcher" },
      { agent: "editor", task: "Edit and finalize content", dependsOn: "writer" },
    ],
  },
  marketing_campaign: {
    name: "Marketing Campaign Team",
    emoji: "🚀",
    description: "Full campaign from strategy to execution",
    agents: ["researcher", "strategist", "marketer", "writer", "editor"],
    flow: [
      { agent: "researcher", task: "Research target audience and competitors" },
      { agent: "strategist", task: "Create campaign strategy", dependsOn: "researcher" },
      { agent: "marketer", task: "Build campaign assets", dependsOn: "strategist" },
      { agent: "writer", task: "Write all copy", dependsOn: "marketer" },
      { agent: "editor", task: "Review and finalize everything", dependsOn: "writer" },
    ],
  },
  software_development: {
    name: "Software Dev Team",
    emoji: "🛠️",
    description: "Build features, fix bugs, ship code",
    agents: ["strategist", "developer", "editor"],
    flow: [
      { agent: "strategist", task: "Plan the technical approach and architecture" },
      { agent: "developer", task: "Write the code", dependsOn: "strategist" },
      { agent: "editor", task: "Review code for bugs and improvements", dependsOn: "developer" },
    ],
  },
  sales_outreach: {
    name: "Sales Outreach Team",
    emoji: "📧",
    description: "Lead gen, outreach sequences, follow-ups",
    agents: ["researcher", "sales", "editor"],
    flow: [
      { agent: "researcher", task: "Research target prospects and personalization hooks" },
      { agent: "sales", task: "Write outreach sequences", dependsOn: "researcher" },
      { agent: "editor", task: "Finalize and optimize sequences", dependsOn: "sales" },
    ],
  },
  business_strategy: {
    name: "Strategy Team",
    emoji: "♟️",
    description: "Business decisions, growth plans, analysis",
    agents: ["researcher", "analyst", "strategist"],
    flow: [
      { agent: "researcher", task: "Gather all relevant data and context" },
      { agent: "analyst", task: "Analyze data and find insights", dependsOn: "researcher" },
      { agent: "strategist", task: "Create strategy based on analysis", dependsOn: "analyst" },
    ],
  },
  custom: {
    name: "Custom Team",
    emoji: "⚡",
    description: "AI-selected agents based on your specific task",
    agents: [],
    flow: [],
  },
};

// ── Boss Agent — decides team composition ──────────────────
async function selectTeamForTask(command, modelConfig) {
  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();

  const prompt = `${businessContext}${memoryContext}

USER REQUEST: "${command}"

Based on this request, select the best team template and customize it.

Available templates:
${Object.entries(TEAM_TEMPLATES).map(([k, v]) => `- ${k}: ${v.description}`).join("\n")}

Respond ONLY with valid JSON:
{
  "template": "content_creation",
  "teamName": "Custom team name for this task",
  "reasoning": "Why this team is best",
  "customizations": ["Any agent task modifications"],
  "estimatedTime": "5-10 minutes",
  "parallelTasks": true
}`;

  try {
    const response = await runOllamaPrompt(modelConfig.ollamaId, "You are a team selection AI. Output only valid JSON.", prompt);
    const match = response.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}

  // Fallback: auto-detect from keywords
  const cmd = command.toLowerCase();
  if (/(write|blog|post|content|social|newsletter|email)/i.test(cmd)) return { template: "content_creation", teamName: "Content Team", estimatedTime: "3-5 minutes" };
  if (/(campaign|launch|market|advertis|promot)/i.test(cmd)) return { template: "marketing_campaign", teamName: "Campaign Team", estimatedTime: "8-12 minutes" };
  if (/(code|build|develop|feature|bug|fix|app)/i.test(cmd)) return { template: "software_development", teamName: "Dev Team", estimatedTime: "5-10 minutes" };
  if (/(outreach|sales|prospect|lead|cold)/i.test(cmd)) return { template: "sales_outreach", teamName: "Sales Team", estimatedTime: "5-8 minutes" };
  if (/(strategy|plan|analyze|decision|grow)/i.test(cmd)) return { template: "business_strategy", teamName: "Strategy Team", estimatedTime: "8-15 minutes" };
  return { template: "content_creation", teamName: "General Team", estimatedTime: "5-10 minutes" };
}

// ── Run a single agent ─────────────────────────────────────
async function runAgent(agentRole, task, context, modelConfig) {
  const agent = AGENT_ROLES[agentRole];
  if (!agent) return { success: false, output: "Unknown agent role" };

  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();
  const dna = loadDNA();

  const systemPrompt = `${agent.systemPrompt}

BUSINESS CONTEXT:
${businessContext}

${memoryContext}

Business: ${dna.business?.name || "Unknown"}
Brand Voice: ${dna.marketing?.brandVoice || "Professional"}
Target Customer: ${dna.product?.targetCustomer || "General audience"}

Previous agents output (use this as input):
${context || "No previous context"}

YOUR TASK: ${task}

Be specific. Be actionable. Be excellent.`;

  try {
    console.log(`  🤖 ${agent.emoji} ${agent.name} working on: ${task.slice(0, 50)}...`);
    const output = await runOllamaPrompt(modelConfig.ollamaId, systemPrompt, task);
    return { success: true, agentRole, agentName: agent.name, task, output };
  } catch (err) {
    return { success: false, agentRole, agentName: agent.name, task, output: `Error: ${err.message}` };
  }
}

// ── Execute Team ───────────────────────────────────────────
async function executeTeam(command, modelConfig, onProgress) {
  console.log(`\n👥 Multi-Agent: "${command}"`);

  const teamId = `team_${Date.now()}`;

  // Step 1: Boss selects team
  onProgress?.({
    teamId,
    phase: "assembling",
    message: "🧠 Boss Agent assembling your team...",
    agents: [],
    status: "working",
  });

  const teamConfig = await selectTeamForTask(command, modelConfig);
  const template = TEAM_TEMPLATES[teamConfig.template] || TEAM_TEMPLATES.content_creation;

  const teamAgents = template.agents.map(role => ({
    role,
    name: AGENT_ROLES[role]?.name || role,
    emoji: AGENT_ROLES[role]?.emoji || "🤖",
    status: "waiting",
    output: null,
  }));

  onProgress?.({
    teamId,
    phase: "assembled",
    message: `✅ Team assembled: ${teamConfig.teamName}`,
    teamName: teamConfig.teamName,
    agents: teamAgents,
    estimatedTime: teamConfig.estimatedTime,
    status: "working",
  });

  // Step 2: Execute agents in sequence (respecting dependencies)
  const results = {};
  const completedAgents = [...teamAgents];

  for (const step of template.flow) {
    const agentRole = step.agent;
    const agentIdx  = completedAgents.findIndex(a => a.role === agentRole);

    // Build context from previous agents
    let context = "";
    if (step.dependsOn && results[step.dependsOn]) {
      context = `${AGENT_ROLES[step.dependsOn]?.name || step.dependsOn} output:\n${results[step.dependsOn].output}`;
    }

    // Update status to working
    if (agentIdx >= 0) completedAgents[agentIdx].status = "working";

    onProgress?.({
      teamId,
      phase: "executing",
      message: `${AGENT_ROLES[agentRole]?.emoji} ${AGENT_ROLES[agentRole]?.name} is working...`,
      agents: completedAgents,
      currentAgent: agentRole,
      status: "working",
    });

    // Run the agent
    const result = await runAgent(agentRole, step.task + "\n\nUser original request: " + command, context, modelConfig);
    results[agentRole] = result;

    // Update status to done
    if (agentIdx >= 0) {
      completedAgents[agentIdx].status = result.success ? "done" : "error";
      completedAgents[agentIdx].output = result.output;
    }

    onProgress?.({
      teamId,
      phase: "executing",
      message: `✅ ${AGENT_ROLES[agentRole]?.name} finished`,
      agents: completedAgents,
      currentAgent: agentRole,
      latestOutput: result.output,
      status: "working",
    });
  }

  // Step 3: Compile final output
  const finalAgent = template.flow[template.flow.length - 1]?.agent;
  const finalOutput = results[finalAgent]?.output || Object.values(results).map(r => r.output).join("\n\n---\n\n");

  // Save team session
  const session = {
    teamId,
    command,
    teamName: teamConfig.teamName,
    template: teamConfig.template,
    agents: completedAgents,
    results,
    finalOutput,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(TEAMS_DIR, `${teamId}.json`), JSON.stringify(session, null, 2));

  onProgress?.({
    teamId,
    phase: "complete",
    message: `🎉 Team completed: ${teamConfig.teamName}`,
    agents: completedAgents,
    finalOutput,
    status: "done",
  });

  console.log(`\n✅ Multi-Agent complete: ${template.agents.length} agents, task done`);

  return {
    success: true,
    teamId,
    teamName: teamConfig.teamName,
    message: `Team of ${template.agents.length} agents completed the task.`,
    output: finalOutput,
    agents: completedAgents,
    results,
  };
}

// ── Check if task needs a team ─────────────────────────────
function needsTeam(command) {
  const complexPatterns = [
    /create.*campaign/i,
    /build.*marketing/i,
    /write.*strategy/i,
    /full.*content/i,
    /launch.*plan/i,
    /outreach.*sequence/i,
    /team.*help/i,
    /multiple.*tasks/i,
    /complete.*project/i,
    /end.*to.*end/i,
    /(blog|article|post).*(strategy|plan|series)/i,
    /build.*feature/i,
  ];
  return complexPatterns.some(p => p.test(command));
}

module.exports = {
  executeTeam,
  selectTeamForTask,
  runAgent,
  needsTeam,
  AGENT_ROLES,
  TEAM_TEMPLATES,
};