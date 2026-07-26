// src/agent/skills.js
// Agentic Vnus — Self-Improving Skills System (Hermes-inspired)
// Successful tasks se automatically skills generate hoti hain
// Next time same task aaye to skill directly use hoti hai — LLM call nahi

const path = require("path");
const fs   = require("fs");
const { SKILLS_DIR, listSkills, getSkillForCommand, rememberFact } = require("./memory");

// ── Task pattern detection ────────────────────────────────
// In patterns ko detect karke skills banate hain
const SKILL_PATTERNS = [
  {
    name:        "open_and_search",
    pattern:     /open\s+(\w+)\s+and\s+(?:search|go to|navigate)/i,
    category:    "browser",
    minSuccess:  1,
  },
  {
    name:        "send_email",
    pattern:     /send\s+(?:an?\s+)?email\s+to/i,
    category:    "communication",
    minSuccess:  1,
  },
  {
    name:        "create_file",
    pattern:     /create\s+(?:a\s+)?(?:file|script|document)/i,
    category:    "files",
    minSuccess:  1,
  },
  {
    name:        "github_operation",
    pattern:     /(?:push|commit|pull|clone|create\s+repo|open\s+pr)/i,
    category:    "github",
    minSuccess:  1,
  },
  {
    name:        "open_app",
    pattern:     /open\s+(\w+)/i,
    category:    "apps",
    minSuccess:  2, // 2 baar ho tab skill bane
  },
];

// ── Pending task tracker (skill banane ke liye) ───────────
const pendingTasks = new Map(); // command → {count, actions, lastSuccess}

// ── Check agar skill banana chahiye ──────────────────────
function shouldCreateSkill(command, actions, success) {
  if (!success || !actions?.length) return false;

  const key     = normalizeCommand(command);
  const current = pendingTasks.get(key) || { count: 0, actions: [], command };
  current.count++;
  current.actions = actions;
  current.command = command;
  pendingTasks.set(key, current);

  // Pattern check
  for (const pattern of SKILL_PATTERNS) {
    if (pattern.pattern.test(command) && current.count >= pattern.minSuccess) {
      return { pattern, count: current.count };
    }
  }

  // Generic — 3 baar same task ho
  if (current.count >= 3) {
    return { pattern: { name: "custom", category: "general", minSuccess: 3 }, count: current.count };
  }

  return false;
}

// ── Generate skill from successful task ───────────────────
function generateSkill(command, actions, result) {
  const skillId   = generateSkillId(command);
  const existing  = getSkillByName(skillId);

  // Extract meaningful triggers from command
  const triggers  = extractTriggers(command);
  const category  = detectCategory(command, actions);

  // Build action summary (without sensitive data)
  const actionSummary = actions
    .filter(a => a.action !== "done" && a.action !== "error")
    .map(a => ({
      action:   a.action,
      app:      a.app,
      url:      a.url ? maskUrl(a.url) : undefined,
      selector: a.selector,
    }))
    .slice(0, 10); // max 10 actions per skill

  const skill = {
    id:          skillId,
    name:        generateSkillName(command),
    description: generateSkillDescription(command, result),
    trigger:     triggers[0] || command.slice(0, 30),
    triggers,
    category,
    actions:     actionSummary,
    successCount: (existing?.successCount || 0) + 1,
    lastUsed:    new Date().toISOString(),
    createdAt:   existing?.createdAt || new Date().toISOString(),
    template:    buildSkillTemplate(command, actions),
  };

  // Save skill
  const skillFile = path.join(SKILLS_DIR, `${skillId}.json`);
  fs.writeFileSync(skillFile, JSON.stringify(skill, null, 2));

  console.log(`⚡ Skill generated/updated: ${skill.name} (used ${skill.successCount}x)`);
  rememberFact(`Skill available: "${skill.name}" — use when user asks to ${triggers[0]}`);

  return skill;
}

// ── Use existing skill ────────────────────────────────────
function applySkill(skill, command) {
  console.log(`⚡ Using skill: ${skill.name} (${skill.successCount} successful uses)`);

  // Update usage stats
  const skillFile = path.join(SKILLS_DIR, `${skill.id}.json`);
  try {
    const existing = JSON.parse(fs.readFileSync(skillFile, "utf8"));
    existing.lastUsed    = new Date().toISOString();
    existing.successCount++;
    fs.writeFileSync(skillFile, JSON.stringify(existing, null, 2));
  } catch {}

  return skill;
}

// ── List all skills (for system prompt) ───────────────────
function getSkillsSummary() {
  const skills = listSkills();
  if (!skills.length) return "";

  let summary = "\n⚡ AVAILABLE SKILLS (auto-generated from your usage):\n";
  skills
    .sort((a, b) => b.successCount - a.successCount)
    .slice(0, 8)
    .forEach(s => {
      summary += `- [${s.category}] ${s.name}: triggered by "${s.trigger}" (used ${s.successCount}x)\n`;
    });
  return summary;
}

// ── Delete a skill ────────────────────────────────────────
function deleteSkill(skillId) {
  const skillFile = path.join(SKILLS_DIR, `${skillId}.json`);
  if (fs.existsSync(skillFile)) {
    fs.unlinkSync(skillFile);
    console.log(`🗑️ Skill deleted: ${skillId}`);
    return true;
  }
  return false;
}

// ── Get skill by name ─────────────────────────────────────
function getSkillByName(name) {
  const skillFile = path.join(SKILLS_DIR, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(skillFile, "utf8"));
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────
function normalizeCommand(command) {
  return command.toLowerCase()
    .replace(/\b(a|an|the|my|your|our|and|or|to|in|on|at|for)\b/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

function generateSkillId(command) {
  return normalizeCommand(command)
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .slice(0, 30);
}

function generateSkillName(command) {
  // Capitalize first word and trim
  const words = command.split(" ").slice(0, 5);
  return words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(" ");
}

function generateSkillDescription(command, result) {
  const base = `Automates: ${command.slice(0, 60)}`;
  const outcome = result?.message ? ` → ${result.message.slice(0, 40)}` : "";
  return base + outcome;
}

function extractTriggers(command) {
  const lower   = command.toLowerCase();
  const triggers = [];

  // Extract key phrases
  const patterns = [
    /(?:open|launch|start)\s+(\w+)/i,
    /(?:send|write|create|make)\s+(?:an?\s+)?(\w+)/i,
    /(?:search|find|look)\s+(?:for\s+)?(.+?)(?:\s+on|\s+in|$)/i,
    /(?:go\s+to|navigate\s+to|open)\s+(https?:\/\/\S+)/i,
  ];

  patterns.forEach(p => {
    const m = command.match(p);
    if (m) triggers.push(m[0].toLowerCase());
  });

  // Always add full command (first 30 chars) as fallback trigger
  triggers.push(lower.slice(0, 30));

  return [...new Set(triggers)].slice(0, 3);
}

function detectCategory(command, actions) {
  const lower = command.toLowerCase();
  if (lower.includes("email") || lower.includes("gmail") || lower.includes("outlook")) return "communication";
  if (lower.includes("github") || lower.includes("git") || lower.includes("repo"))     return "github";
  if (lower.includes("chrome") || lower.includes("browser") || lower.includes("http")) return "browser";
  if (lower.includes("file") || lower.includes("folder") || lower.includes("desktop")) return "files";
  if (lower.includes("code") || lower.includes("script") || lower.includes("python"))  return "coding";
  if (actions?.some(a => a.action?.startsWith("browser_")))                             return "browser";
  if (actions?.some(a => a.action?.startsWith("github_")))                              return "github";
  return "general";
}

function buildSkillTemplate(command, actions) {
  // Build a template that can be reused with variable substitution
  return {
    commandPattern: command.replace(/["'].*?["']/g, "{text}").slice(0, 100),
    actionCount:    actions.length,
    hasWebActions:  actions.some(a => a.action?.startsWith("browser_")),
    hasFileActions: actions.some(a => a.action === "write_file" || a.action === "read_file"),
    hasGithub:      actions.some(a => a.action?.startsWith("github_")),
  };
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch { return url.slice(0, 30); }
}

module.exports = {
  shouldCreateSkill,
  generateSkill,
  applySkill,
  getSkillsSummary,
  deleteSkill,
  getSkillByName,
  getSkillForCommand,
  listSkills,
};