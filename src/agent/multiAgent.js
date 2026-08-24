// src/agent/multiAgent.js
// ✅ Fixed: correct imports from memory.js, skills.js, ollamaManager.js
// ✅ Fixed: error handling when agent fails
// ✅ Fixed: context passing between agents

const { runOllamaPrompt }  = require("./ollamaManager");
const { buildBusinessPrompt, loadDNA } = require("./businessDNA");
const { buildMemoryPrompt } = require("./memory");
const { getSkillsSummary }  = require("./skills");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TEAMS_DIR = path.join(os.homedir(), ".vnus-agent", "teams");
if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR, { recursive: true });

// ── Agent Role Definitions ─────────────────────────────────
const AGENT_ROLES = {
  researcher: {
    name: "Research Agent", emoji: "🔍",
    description: "Gathers data, analyzes competitors, finds opportunities",
    systemPrompt: `You are a Research Agent. Your job:
- Analyze the topic deeply
- Find relevant data, statistics, trends
- Identify opportunities and threats
- Summarize findings clearly
Output structured research with key insights.`,
  },
  writer: {
    name: "Content Writer", emoji: "✍️",
    description: "Writes blogs, social posts, emails, copy",
    systemPrompt: `You are a Content Writer Agent. Your job:
- Write high-quality, engaging content
- Match the brand voice exactly
- Optimize for the target audience
- Include clear CTAs
Output ready-to-publish content.`,
  },
  strategist: {
    name: "Strategy Agent", emoji: "🎯",
    description: "Plans campaigns, sets priorities, makes decisions",
    systemPrompt: `You are a Strategy Agent. Your job:
- Analyze the business situation
- Identify the highest-impact actions
- Create step-by-step execution plans
- Prioritize ruthlessly
Output actionable strategy with clear steps.`,
  },
  developer: {
    name: "Developer Agent", emoji: "💻",
    description: "Writes code, builds features, fixes bugs",
    systemPrompt: `You are a Developer Agent. Your job:
- Write clean, production-ready code
- Follow best practices
- Document what you build
- Think about edge cases
Output working code with explanation.`,
  },
  marketer: {
    name: "Marketing Agent", emoji: "📢",
    description: "Creates campaigns, writes ad copy, plans launches",
    systemPrompt: `You are a Marketing Agent. Your job:
- Create marketing campaigns from scratch
- Write compelling ad copy and hooks
- Plan distribution strategy
- Think about conversion at every step
Output complete marketing plan with copy.`,
  },
  analyst: {
    name: "Analytics Agent", emoji: "📊",
    description: "Analyzes data, finds patterns, suggests improvements",
    systemPrompt: `You are an Analytics Agent. Your job:
- Analyze metrics and data
- Find patterns and anomalies
- Suggest data-driven improvements
Output analysis with actionable recommendations.`,
  },
  editor: {
    name: "Editor Agent", emoji: "✅",
    description: "Reviews, improves, and finalizes all output",
    systemPrompt: `You are an Editor Agent. Your job:
- Review all output from other agents
- Fix errors and inconsistencies
- Improve clarity and impact
- Ensure brand voice consistency
Output polished, ready-to-use final version.`,
  },
  sales: {
    name: "Sales Agent", emoji: "💰",
    description: "Writes outreach, follow-ups, sales sequences",
    systemPrompt: `You are a Sales Agent. Your job:
- Write personalized outreach messages
- Create follow-up sequences
- Handle objections in advance
- Focus on conversion
Output complete sales sequence ready to send.`,
  },
};

// ── Team Templates ─────────────────────────────────────────
const TEAM_TEMPLATES = {
  content_creation: {
    name: "Content Creation Team", emoji: "📝",
    description: "Blog posts, social media, newsletters",
    agents: ["researcher", "writer", "editor"],
    flow: [
      { agent:"researcher", task:"Research the topic thoroughly. Find data, examples, and angles." },
      { agent:"writer",     task:"Write content based on research.", dependsOn:"researcher" },
      { agent:"editor",     task:"Edit and finalize content. Fix anything unclear.", dependsOn:"writer" },
    ],
  },
  marketing_campaign: {
    name: "Marketing Campaign Team", emoji: "🚀",
    description: "Full campaign from strategy to execution",
    agents: ["researcher", "strategist", "marketer", "writer", "editor"],
    flow: [
      { agent:"researcher", task:"Research target audience and competitors." },
      { agent:"strategist", task:"Create campaign strategy based on research.", dependsOn:"researcher" },
      { agent:"marketer",   task:"Build campaign assets based on strategy.", dependsOn:"strategist" },
      { agent:"writer",     task:"Write all copy for the campaign.", dependsOn:"marketer" },
      { agent:"editor",     task:"Review and finalize everything.", dependsOn:"writer" },
    ],
  },
  software_development: {
    name: "Software Dev Team", emoji: "🛠️",
    description: "Build features, fix bugs, ship code",
    agents: ["strategist", "developer", "editor"],
    flow: [
      { agent:"strategist", task:"Plan the technical approach and architecture." },
      { agent:"developer",  task:"Write the code based on the plan.", dependsOn:"strategist" },
      { agent:"editor",     task:"Review code for bugs, security, improvements.", dependsOn:"developer" },
    ],
  },
  sales_outreach: {
    name: "Sales Outreach Team", emoji: "📧",
    description: "Lead gen, outreach sequences, follow-ups",
    agents: ["researcher", "sales", "editor"],
    flow: [
      { agent:"researcher", task:"Research target prospects and find personalization hooks." },
      { agent:"sales",      task:"Write outreach sequences based on research.", dependsOn:"researcher" },
      { agent:"editor",     task:"Finalize and optimize sequences.", dependsOn:"sales" },
    ],
  },
  business_strategy: {
    name: "Strategy Team", emoji: "♟️",
    description: "Business decisions, growth plans, analysis",
    agents: ["researcher", "analyst", "strategist"],
    flow: [
      { agent:"researcher", task:"Gather all relevant data and business context." },
      { agent:"analyst",    task:"Analyze data and find key insights.", dependsOn:"researcher" },
      { agent:"strategist", task:"Create strategy based on analysis.", dependsOn:"analyst" },
    ],
  },
};

// ── Select team for task ──────────────────────────────────
async function selectTeamForTask(command, modelConfig) {
  // Fast keyword detection — no AI call needed for speed
  const cmd = command.toLowerCase();

  if (/(write|blog|post|content|social|newsletter|article)/i.test(cmd))
    return { template:"content_creation",      teamName:"Content Team",   estimatedTime:"3-5 min" };
  if (/(campaign|launch|market|advertis|promot|brand)/i.test(cmd))
    return { template:"marketing_campaign",    teamName:"Campaign Team",  estimatedTime:"8-12 min" };
  if (/(code|build|develop|feature|bug|fix|app|script)/i.test(cmd))
    return { template:"software_development",  teamName:"Dev Team",       estimatedTime:"5-10 min" };
  if (/(outreach|sales|prospect|lead|cold email)/i.test(cmd))
    return { template:"sales_outreach",        teamName:"Sales Team",     estimatedTime:"5-8 min" };
  if (/(strategy|plan|analyz|decision|grow|business plan)/i.test(cmd))
    return { template:"business_strategy",     teamName:"Strategy Team",  estimatedTime:"8-15 min" };

  // Default to content creation
  return { template:"content_creation", teamName:"General Team", estimatedTime:"5-10 min" };
}

// ── Run a single agent ────────────────────────────────────
async function runAgent(agentRole, task, context, command, modelConfig) {
  const agent = AGENT_ROLES[agentRole];
  if (!agent) return { success:false, output:"Unknown agent role: " + agentRole };

  const dna             = loadDNA();
  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();
  const skillsContext   = getSkillsSummary();

  const systemPrompt = `${agent.systemPrompt}

BUSINESS CONTEXT:
${businessContext}

${memoryContext}
${skillsContext}

Business: ${dna.business?.name || "Not set"}
Brand Voice: ${dna.marketing?.brandVoice || "Professional"}
Target Customer: ${dna.product?.targetCustomer || "General audience"}

${context ? `PREVIOUS AGENT OUTPUT (use as input):\n${context}\n` : ""}

YOUR SPECIFIC TASK: ${task}

Original user request: "${command}"

Be specific. Be actionable. Be excellent. Output your complete work.`;

  try {
    console.log(`  ${agent.emoji} ${agent.name} working...`);
    const output = await runOllamaPrompt(modelConfig.ollamaId, systemPrompt, task);
    console.log(`  ${agent.emoji} ${agent.name} done ✅`);
    return { success:true, agentRole, agentName:agent.name, emoji:agent.emoji, task, output };
  } catch (err) {
    console.error(`  ❌ ${agent.name} failed: ${err.message}`);
    return { success:false, agentRole, agentName:agent.name, emoji:agent.emoji, task, output:`Agent failed: ${err.message}. Skipping to next agent.` };
  }
}

// ── Execute Team ──────────────────────────────────────────
async function executeTeam(command, modelConfig, onProgress) {
  console.log(`\n👥 Team assembling for: "${command}"`);

  const teamId     = `team_${Date.now()}`;
  const teamConfig = await selectTeamForTask(command, modelConfig);
  const template   = TEAM_TEMPLATES[teamConfig.template] || TEAM_TEMPLATES.content_creation;

  // Build agent list with initial status
  const teamAgents = template.agents.map(role => ({
    role,
    name:   AGENT_ROLES[role]?.name  || role,
    emoji:  AGENT_ROLES[role]?.emoji || "🤖",
    status: "waiting",
    output: null,
  }));

  // Notify: assembled
  onProgress?.({
    teamId,
    phase:         "assembled",
    message:       `✅ Team assembled: ${teamConfig.teamName}`,
    teamName:      teamConfig.teamName,
    agents:        teamAgents,
    estimatedTime: teamConfig.estimatedTime,
    status:        "working",
  });

  const results      = {};
  const agentsCopy   = teamAgents.map(a => ({ ...a }));

  // Execute agents in sequence
  for (const step of template.flow) {
    const agentRole = step.agent;
    const agentIdx  = agentsCopy.findIndex(a => a.role === agentRole);

    // Build context from previous agent
    let context = "";
    if (step.dependsOn && results[step.dependsOn]) {
      const prev = results[step.dependsOn];
      if (prev.success) {
        context = `${AGENT_ROLES[step.dependsOn]?.name || step.dependsOn} completed:\n${prev.output}`;
      }
    }

    // Set working
    if (agentIdx >= 0) agentsCopy[agentIdx].status = "working";
    onProgress?.({
      teamId, phase:"executing",
      message:      `${AGENT_ROLES[agentRole]?.emoji} ${AGENT_ROLES[agentRole]?.name} is working...`,
      agents:       agentsCopy,
      currentAgent: agentRole,
      status:       "working",
    });

    // Run
    const result = await runAgent(agentRole, step.task, context, command, modelConfig);
    results[agentRole] = result;

    // Update status
    if (agentIdx >= 0) {
      agentsCopy[agentIdx].status = result.success ? "done" : "error";
      agentsCopy[agentIdx].output = result.output;
    }

    onProgress?.({
      teamId, phase:"executing",
      message:      `${result.success ? "✅" : "⚠️"} ${AGENT_ROLES[agentRole]?.name} finished`,
      agents:       agentsCopy,
      latestOutput: result.output,
      status:       "working",
    });
  }

  // Final output = last agent's output
  const lastAgent   = template.flow[template.flow.length - 1]?.agent;
  const finalOutput = results[lastAgent]?.output
    || Object.values(results).filter(r => r.success).map(r => r.output).join("\n\n---\n\n")
    || "Team completed but no output generated.";

  // Save session
  try {
    const session = { teamId, command, teamName:teamConfig.teamName, template:teamConfig.template, agents:agentsCopy, results, finalOutput, completedAt:new Date().toISOString() };
    fs.writeFileSync(path.join(TEAMS_DIR, `${teamId}.json`), JSON.stringify(session, null, 2));
  } catch {}

  onProgress?.({
    teamId, phase:"complete",
    message:     `🎉 ${teamConfig.teamName} completed!`,
    teamName:    teamConfig.teamName,
    agents:      agentsCopy,
    finalOutput,
    status:      "done",
  });

  console.log(`\n✅ Team done: ${template.agents.length} agents | Task: "${command.slice(0,50)}"`);

  return {
    success:  true,
    teamId,
    teamName: teamConfig.teamName,
    message:  `Team of ${template.agents.length} agents completed the task.`,
    output:   finalOutput,
    agents:   agentsCopy,
    results,
  };
}

// ── Check if task needs a team ────────────────────────────
function needsTeam(command) {
  const complexPatterns = [
    /create.*campaign/i, /build.*marketing/i, /write.*strategy/i,
    /full.*content/i,    /launch.*plan/i,      /outreach.*sequence/i,
    /complete.*project/i,/end.*to.*end/i,
    /(blog|article|post).*(strategy|plan|series)/i,
    /marketing.*plan/i,  /business.*plan/i,    /growth.*strategy/i,
    /content.*calendar/i,/sales.*sequence/i,
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