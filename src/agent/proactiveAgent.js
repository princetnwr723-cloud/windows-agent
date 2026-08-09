// src/agent/proactiveAgent.js
// ═══════════════════════════════════════════════════════════
// PROACTIVE AGENT — 24/7 Business Monitoring
// Agent khud se kaam dhundta hai — user ke bina bole
// Daily briefings, competitor monitoring, opportunity detection
// ═══════════════════════════════════════════════════════════

const { runOllamaPrompt }     = require("./ollamaManager");
const { loadDNA, generateDailyBriefing, buildBusinessPrompt } = require("./businessDNA");
const { buildMemoryPrompt }   = require("./memory");
const { executeTeam }         = require("./multiAgent");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const PROACTIVE_DIR  = path.join(os.homedir(), ".vnus-agent", "proactive");
const INSIGHTS_FILE  = path.join(PROACTIVE_DIR, "insights.json");
const MONITORING_FILE = path.join(PROACTIVE_DIR, "monitoring.json");

if (!fs.existsSync(PROACTIVE_DIR)) fs.mkdirSync(PROACTIVE_DIR, { recursive: true });

// ── Load/Save Insights ─────────────────────────────────────
function loadInsights() {
  try { return JSON.parse(fs.readFileSync(INSIGHTS_FILE, "utf8")); }
  catch { return { insights: [], lastChecked: null }; }
}

function saveInsights(data) {
  fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(data, null, 2));
}

// ── Generate Morning Briefing ──────────────────────────────
async function generateMorningBriefing(modelConfig, sendToRTDB) {
  const dna = loadDNA();
  if (!dna.setupComplete) return null;

  console.log(`\n☀️  Generating morning briefing for ${dna.business.name}...`);

  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();
  const insights        = loadInsights();

  const prompt = `${businessContext}${memoryContext}

Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Based on the business context, generate a morning briefing as ${dna.agentName || "Vnus"}, the ${dna.agentRole || "CEO"} of ${dna.business.name}.

Recent insights: ${JSON.stringify(insights.insights?.slice(-5) || [])}

Generate a JSON briefing:
{
  "greeting": "Good morning message",
  "keyMetricStatus": "How are we doing vs goals?",
  "alerts": [{"type": "warning/opportunity/info", "title": "Alert title", "description": "What happened", "action": "What to do"}],
  "tasksForToday": [{"priority": "high/medium", "task": "Specific task", "reason": "Why this matters", "estimatedImpact": "Expected outcome"}],
  "strategicInsight": "One powerful insight or recommendation",
  "motivationalNote": "Brief motivational message tied to the business goal"
}

Make it specific to ${dna.business.name}, not generic.`;

  try {
    const response = await runOllamaPrompt(
      modelConfig.ollamaId,
      "You are a world-class business AI. Generate specific, actionable briefings. Output only valid JSON.",
      prompt
    );

    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const briefing = JSON.parse(match[0]);
    briefing.date       = new Date().toISOString();
    briefing.businessName = dna.business.name;
    briefing.agentName  = dna.agentName || "Vnus";
    briefing.agentRole  = dna.agentRole || "CEO";

    // Save briefing
    const file = path.join(PROACTIVE_DIR, `briefing-${new Date().toISOString().split("T")[0]}.json`);
    fs.writeFileSync(file, JSON.stringify(briefing, null, 2));

    // Send to RTDB so dashboard shows it
    if (sendToRTDB) await sendToRTDB("briefing", briefing);

    console.log(`✅ Morning briefing generated for ${dna.business.name}`);
    return briefing;
  } catch (err) {
    console.error("Briefing error:", err.message);
    return null;
  }
}

// ── Competitor Monitoring ──────────────────────────────────
async function monitorCompetitors(modelConfig, browserAgent, sendToRTDB) {
  const dna = loadDNA();
  if (!dna.setupComplete || !dna.competitors?.length) return null;

  console.log(`\n🔍 Monitoring ${dna.competitors.length} competitors...`);

  const competitorInsights = [];

  for (const competitor of dna.competitors.slice(0, 3)) {
    try {
      // Use browser to check competitor website
      if (competitor.name && browserAgent) {
        console.log(`  Checking ${competitor.name}...`);

        const businessContext = buildBusinessPrompt();
        const analysis = await runOllamaPrompt(
          modelConfig.ollamaId,
          `You are a competitive intelligence analyst for ${dna.business.name}. Analyze competitor information and find opportunities.`,
          `${businessContext}
          
Competitor: ${competitor.name}
Their weakness: ${competitor.weakness}
Our edge over them: ${competitor.ourEdge}

Based on what you know about this competitor, generate:
1. What is likely happening with them right now?
2. What opportunity can ${dna.business.name} exploit?
3. What threat might they pose soon?

Respond in JSON:
{
  "competitor": "${competitor.name}",
  "opportunity": "Specific opportunity to exploit their weakness",
  "threat": "Potential threat to watch for",
  "action": "Immediate action ${dna.business.name} should take"
}`
        );

        const match = analysis.match(/\{[\s\S]*\}/);
        if (match) competitorInsights.push(JSON.parse(match[0]));
      }
    } catch {}
  }

  if (competitorInsights.length > 0) {
    const insights = loadInsights();
    insights.insights = [
      ...insights.insights,
      ...competitorInsights.map(i => ({
        type: "competitor",
        data: i,
        detectedAt: new Date().toISOString(),
      })),
    ].slice(-50); // Keep last 50
    insights.lastChecked = new Date().toISOString();
    saveInsights(insights);

    if (sendToRTDB) await sendToRTDB("competitive_insights", competitorInsights);
    console.log(`✅ Competitor monitoring done: ${competitorInsights.length} insights`);
  }

  return competitorInsights;
}

// ── Opportunity Scanner ────────────────────────────────────
async function scanForOpportunities(modelConfig, sendToRTDB) {
  const dna = loadDNA();
  if (!dna.setupComplete) return null;

  console.log(`\n🎯 Scanning for opportunities for ${dna.business.name}...`);

  const businessContext = buildBusinessPrompt();

  const prompt = `${businessContext}

Today is ${new Date().toLocaleDateString()}.

As the AI ${dna.agentRole || "CEO"} of ${dna.business.name}, proactively identify opportunities the user might have missed.

Think about:
1. Seasonal trends relevant to their business
2. Recent developments in their industry
3. Quick wins based on their current focus: ${dna.currentFocus || "growth"}
4. Underexplored channels in: ${dna.marketing?.channels?.join(", ") || "social media"}

Generate 3 specific opportunities in JSON:
{
  "opportunities": [
    {
      "title": "Opportunity title",
      "description": "Why this is an opportunity RIGHT NOW",
      "effort": "low/medium/high",
      "impact": "low/medium/high",
      "firstStep": "Exactly what to do first"
    }
  ]
}`;

  try {
    const response = await runOllamaPrompt(
      modelConfig.ollamaId,
      "You are a proactive business strategist. Find opportunities. Output JSON only.",
      prompt
    );

    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const result = JSON.parse(match[0]);
    result.scannedAt = new Date().toISOString();

    const file = path.join(PROACTIVE_DIR, `opportunities-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));

    if (sendToRTDB) await sendToRTDB("opportunities", result.opportunities);

    console.log(`✅ Found ${result.opportunities?.length || 0} opportunities`);
    return result.opportunities;
  } catch (err) {
    console.error("Opportunity scan error:", err.message);
    return null;
  }
}

// ── Weekly Report Generator ────────────────────────────────
async function generateWeeklyReport(modelConfig, sendToRTDB) {
  const dna = loadDNA();
  if (!dna.setupComplete) return null;

  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();

  const prompt = `${businessContext}${memoryContext}

Generate a weekly business review report for ${dna.business.name}.

Week ending: ${new Date().toLocaleDateString()}

Create a comprehensive report in JSON:
{
  "weekSummary": "What was accomplished this week",
  "metricsReview": "How metrics are trending vs goals",
  "topWins": ["Win 1", "Win 2", "Win 3"],
  "challenges": ["Challenge 1", "Challenge 2"],
  "nextWeekPriorities": [
    {"priority": 1, "task": "Task", "reason": "Why"},
    {"priority": 2, "task": "Task", "reason": "Why"},
    {"priority": 3, "task": "Task", "reason": "Why"}
  ],
  "strategicFocus": "One thing to focus on most next week",
  "aiRecommendation": "One bold recommendation from the AI"
}`;

  try {
    const response = await runOllamaPrompt(
      modelConfig.ollamaId,
      "You are a business intelligence AI. Generate insightful weekly reports. JSON only.",
      prompt
    );

    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const report = JSON.parse(match[0]);
    report.generatedAt = new Date().toISOString();
    report.businessName = dna.business.name;

    const file = path.join(PROACTIVE_DIR, `weekly-report-${new Date().toISOString().split("T")[0]}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));

    if (sendToRTDB) await sendToRTDB("weekly_report", report);

    console.log(`✅ Weekly report generated`);
    return report;
  } catch (err) {
    console.error("Weekly report error:", err.message);
    return null;
  }
}

// ── Get latest briefing ────────────────────────────────────
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
  monitorCompetitors,
  scanForOpportunities,
  generateWeeklyReport,
  getLatestBriefing,
  loadInsights,
};