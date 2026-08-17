// src/agent/proactiveAgent.js
// ✅ Fixed: correct ollamaManager import
// ✅ Fixed: modelConfig properly passed
// ✅ Fixed: null safety on all DNA fields

const { runOllamaPrompt }  = require("./ollamaManager");
const { loadDNA, buildBusinessPrompt, generateDNAHealthReport } = require("./businessDNA");
const { buildMemoryPrompt } = require("./memory");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const PROACTIVE_DIR = path.join(os.homedir(), ".vnus-agent", "proactive");
if (!fs.existsSync(PROACTIVE_DIR)) fs.mkdirSync(PROACTIVE_DIR, { recursive: true });

// ── Generate Morning Briefing ─────────────────────────────
async function generateMorningBriefing(modelConfig) {
  const dna = loadDNA();
  if (!dna?.setupComplete) {
    console.log("⚠️ Business DNA not set — skipping briefing");
    return null;
  }

  console.log(`☀️ Generating morning briefing for ${dna.business?.name}...`);

  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();

  const prompt = `${businessContext}
${memoryContext}

Today: ${new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}

Generate a morning briefing as ${dna.agentName || "Vnus"}, the AI ${dna.agentRole || "CEO"} of ${dna.business?.name}.

Return ONLY valid JSON, no other text:
{
  "greeting": "Brief personal greeting",
  "alerts": [
    {"type": "opportunity", "title": "Short title", "description": "What and why", "action": "Exact next step"}
  ],
  "tasksForToday": [
    {"priority": "high", "task": "Specific task", "reason": "Business impact"}
  ],
  "strategicInsight": "One powerful specific insight",
  "motivationalNote": "Short motivational line"
}

Make it specific to ${dna.business?.name}. Max 3 alerts, max 3 tasks.`;

  try {
    const response = await runOllamaPrompt(
      modelConfig.ollamaId,
      "You are a business AI. Generate morning briefings. Output ONLY valid JSON, no markdown, no explanation.",
      prompt
    );

    // Parse JSON safely
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error("❌ Briefing: No JSON in response");
      return null;
    }

    const briefing = JSON.parse(match[0]);
    briefing.date         = new Date().toISOString();
    briefing.businessName = dna.business?.name || "Your Business";
    briefing.agentName    = dna.agentName || "Vnus";
    briefing.agentRole    = dna.agentRole || "CEO";

    // Save locally
    const file = path.join(PROACTIVE_DIR, `briefing-${new Date().toISOString().split("T")[0]}.json`);
    fs.writeFileSync(file, JSON.stringify(briefing, null, 2));

    console.log(`✅ Morning briefing generated for ${dna.business?.name}`);
    return briefing;

  } catch (err) {
    console.error("❌ Briefing error:", err.message);
    return null;
  }
}

// ── Scan for Opportunities ────────────────────────────────
async function scanForOpportunities(modelConfig) {
  const dna = loadDNA();
  if (!dna?.setupComplete) return null;

  console.log(`🎯 Scanning opportunities for ${dna.business?.name}...`);

  const businessContext = buildBusinessPrompt();

  const prompt = `${businessContext}

Today: ${new Date().toLocaleDateString()}
Current focus: ${dna.currentFocus || "growth"}
Marketing channels: ${dna.marketing?.channels?.join(", ") || "social media"}
Current problem: ${dna.problems?.[0]?.description || "scaling"}

As AI ${dna.agentRole || "CEO"} of ${dna.business?.name}, find 3 immediate opportunities.

Return ONLY valid JSON:
{
  "opportunities": [
    {
      "title": "Specific opportunity title",
      "description": "Why this opportunity exists RIGHT NOW",
      "effort": "low",
      "impact": "high",
      "firstStep": "Exactly what to do first, today"
    }
  ]
}`;

  try {
    const response = await runOllamaPrompt(
      modelConfig.ollamaId,
      "You are a proactive business strategist. Find opportunities. Output ONLY valid JSON.",
      prompt
    );

    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const result = JSON.parse(match[0]);
    result.scannedAt = new Date().toISOString();

    const file = path.join(PROACTIVE_DIR, `opps-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));

    console.log(`✅ Found ${result.opportunities?.length || 0} opportunities`);
    return result.opportunities || [];

  } catch (err) {
    console.error("❌ Opportunity scan error:", err.message);
    return null;
  }
}

// ── Generate Weekly Report ────────────────────────────────
async function generateWeeklyReport(modelConfig) {
  const dna = loadDNA();
  if (!dna?.setupComplete) return null;

  console.log(`📊 Generating weekly report for ${dna.business?.name}...`);

  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();

  const prompt = `${businessContext}
${memoryContext}

Week ending: ${new Date().toLocaleDateString()}

Generate a weekly business review for ${dna.business?.name}.

Return ONLY valid JSON:
{
  "weekSummary": "What was accomplished this week",
  "metricsReview": "How metrics are trending vs goals",
  "topWins": ["Win 1", "Win 2", "Win 3"],
  "challenges": ["Challenge 1", "Challenge 2"],
  "nextWeekPriorities": [
    {"priority": 1, "task": "Task description", "reason": "Why this matters"}
  ],
  "strategicFocus": "One main focus for next week",
  "aiRecommendation": "One bold recommendation"
}`;

  try {
    const response = await runOllamaPrompt(
      modelConfig.ollamaId,
      "You are a business intelligence AI. Generate weekly reports. Output ONLY valid JSON.",
      prompt
    );

    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const report = JSON.parse(match[0]);
    report.generatedAt  = new Date().toISOString();
    report.businessName = dna.business?.name;

    const file = path.join(PROACTIVE_DIR, `weekly-${new Date().toISOString().split("T")[0]}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));

    console.log(`✅ Weekly report generated`);
    return report;

  } catch (err) {
    console.error("❌ Weekly report error:", err.message);
    return null;
  }
}

// ── DNA Health Check — part of weekly report ─────────────
async function checkDNAHealth(modelConfig) {
  const health = generateDNAHealthReport();
  if (!health) return null;

  console.log(`🧬 DNA Health: ${health.score}/100 — ${health.issues.length} issues`);

  if (health.issues.length === 0) {
    return { healthy: true, score: 100, message: "Business DNA is up to date ✅" };
  }

  // Build notification
  let msg = `🧬 **Business DNA Health Check**

`;
  msg += `Score: ${health.score}/100
`;
  msg += `Last updated: ${health.daysSince} days ago

`;

  if (health.issues.length > 0) {
    msg += `**Issues found:**
`;
    health.issues.forEach(issue => {
      const icon = issue.severity === "high" ? "🔴" : "🟡";
      msg += `${icon} ${issue.message}
`;
      msg += `   → ${issue.action}

`;
    });
  }

  return { healthy: false, score: health.score, message: msg, issues: health.issues };
}

// ── Get latest briefing ───────────────────────────────────
function getLatestBriefing() {
  try {
    const files = fs.readdirSync(PROACTIVE_DIR)
      .filter(f => f.startsWith("briefing-"))
      .sort().reverse();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(PROACTIVE_DIR, files[0]), "utf8"));
  } catch { return null; }
}

module.exports = {
  generateMorningBriefing,
  scanForOpportunities,
  generateWeeklyReport,
  getLatestBriefing,
  checkDNAHealth,
};