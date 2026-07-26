// src/agent/memory.js
// Agentic Vnus — Persistent Memory System (Hermes-inspired)
// SQLite se memory store hoti hai — session ke baad bhi yaad rehta hai
// Teen layers: User Profile, Agent Memory, Session History

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const MEMORY_DIR  = path.join(os.homedir(), ".vnus-agent");
const MEMORY_FILE = path.join(MEMORY_DIR, "memory.json");
const SKILLS_DIR  = path.join(MEMORY_DIR, "skills");
const SESSIONS_DIR= path.join(MEMORY_DIR, "sessions");

// ── Init ──────────────────────────────────────────────────
function initMemory() {
  if (!fs.existsSync(MEMORY_DIR))   fs.mkdirSync(MEMORY_DIR,   { recursive: true });
  if (!fs.existsSync(SKILLS_DIR))   fs.mkdirSync(SKILLS_DIR,   { recursive: true });
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  if (!fs.existsSync(MEMORY_FILE)) {
    const defaultMemory = {
      user: {
        name:              null,
        preferredBrowser:  "chrome",
        preferredEditor:   "vscode",
        defaultSaveLocation: path.join(os.homedir(), "Desktop"),
        language:          "english",
        workingDir:        os.homedir(),
        timezone:          Intl.DateTimeFormat().resolvedOptions().timeZone,
        corrections:       [],    // User ne agent ko jo correct kiya
        preferences:       {},    // Key-value preferences
      },
      agent: {
        totalTasksCompleted: 0,
        totalTasksFailed:    0,
        lastActive:          null,
        learnedPatterns:     [],  // Repeated patterns
        knownPaths:          {},  // App paths, file locations
        githubUsername:      null,
        installedApps:       [],  // Jo apps user ke PC pe hain
      },
      facts: [],                  // Important facts about user/system
      sessionCount: 0,
    };
    saveMemory(defaultMemory);
    return defaultMemory;
  }

  return loadMemory();
}

// ── Load ──────────────────────────────────────────────────
function loadMemory() {
  try {
    const data = fs.readFileSync(MEMORY_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return initMemory();
  }
}

// ── Save ──────────────────────────────────────────────────
function saveMemory(memory) {
  ensureDir(MEMORY_DIR);
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ── Update user preference ────────────────────────────────
function learnPreference(key, value) {
  const memory = loadMemory();
  memory.user.preferences[key] = value;
  memory.user.lastUpdated = new Date().toISOString();
  saveMemory(memory);
  console.log(`🧠 Learned: ${key} = ${value}`);
}

// ── Add a fact ────────────────────────────────────────────
function rememberFact(fact) {
  const memory = loadMemory();
  // Duplicate check
  if (!memory.facts.includes(fact)) {
    memory.facts.push(fact);
    // Max 50 facts — oldest removed
    if (memory.facts.length > 50) memory.facts.shift();
    saveMemory(memory);
    console.log(`🧠 Remembered fact: ${fact}`);
  }
}

// ── Add correction (user ne agent ko fix kiya) ───────────
function rememberCorrection(original, corrected) {
  const memory     = loadMemory();
  const correction = { original, corrected, at: new Date().toISOString() };
  memory.user.corrections.push(correction);
  // Max 20 corrections
  if (memory.user.corrections.length > 20) memory.user.corrections.shift();
  saveMemory(memory);
  console.log(`🧠 Correction learned: "${original}" → "${corrected}"`);
}

// ── Update task stats ─────────────────────────────────────
function recordTaskResult(command, success) {
  const memory = loadMemory();
  if (success) {
    memory.agent.totalTasksCompleted++;
  } else {
    memory.agent.totalTasksFailed++;
  }
  memory.agent.lastActive = new Date().toISOString();
  saveMemory(memory);
}

// ── Learn known path (app location etc) ───────────────────
function rememberPath(key, filePath) {
  const memory = loadMemory();
  memory.agent.knownPaths[key] = filePath;
  saveMemory(memory);
}

// ── Save session ──────────────────────────────────────────
function saveSession(commands, results) {
  const memory = loadMemory();
  memory.sessionCount++;

  const session = {
    id:        memory.sessionCount,
    at:        new Date().toISOString(),
    commands:  commands.map(c => ({
      command: c.command,
      success: c.success,
      message: c.message,
    })),
    summary:   generateSessionSummary(commands, results),
  };

  // Save session file
  const sessionFile = path.join(SESSIONS_DIR, `session_${memory.sessionCount}.json`);
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

  // Keep only last 100 sessions
  const sessionFiles = fs.readdirSync(SESSIONS_DIR).sort();
  if (sessionFiles.length > 100) {
    fs.unlinkSync(path.join(SESSIONS_DIR, sessionFiles[0]));
  }

  saveMemory(memory);
  return session;
}

// ── Search past sessions ──────────────────────────────────
function searchSessions(query) {
  const sessionFiles = fs.readdirSync(SESSIONS_DIR).sort().reverse();
  const results      = [];
  const queryLower   = query.toLowerCase();

  for (const file of sessionFiles.slice(0, 20)) { // last 20 sessions
    try {
      const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
      const match   = session.commands?.some(c =>
        c.command?.toLowerCase().includes(queryLower) ||
        c.message?.toLowerCase().includes(queryLower)
      ) || session.summary?.toLowerCase().includes(queryLower);

      if (match) results.push(session);
    } catch {}
  }

  return results;
}

// ── Generate memory-enriched system prompt ────────────────
function buildMemoryPrompt() {
  const memory  = loadMemory();
  const skills  = listSkills();
  const u       = memory.user;
  const a       = memory.agent;

  let prompt = "\n═══ AGENT MEMORY ═══\n";

  // User profile
  prompt += `\nUSER PROFILE:\n`;
  if (u.name)             prompt += `- Name: ${u.name}\n`;
  prompt += `- Preferred Browser: ${u.preferredBrowser}\n`;
  prompt += `- Preferred Editor: ${u.preferredEditor}\n`;
  prompt += `- Default Save Location: ${u.defaultSaveLocation}\n`;
  prompt += `- Working Directory: ${u.workingDir}\n`;

  // Custom preferences
  const prefs = Object.entries(u.preferences);
  if (prefs.length > 0) {
    prompt += `\nLEARNED PREFERENCES:\n`;
    prefs.slice(-10).forEach(([k, v]) => { prompt += `- ${k}: ${v}\n`; });
  }

  // Important facts
  if (memory.facts.length > 0) {
    prompt += `\nIMPORTANT FACTS:\n`;
    memory.facts.slice(-10).forEach(f => { prompt += `- ${f}\n`; });
  }

  // Past corrections
  if (u.corrections.length > 0) {
    prompt += `\nPAST CORRECTIONS (avoid repeating these mistakes):\n`;
    u.corrections.slice(-5).forEach(c => {
      prompt += `- Instead of "${c.original}", do: "${c.corrected}"\n`;
    });
  }

  // Known paths
  const knownPaths = Object.entries(a.knownPaths);
  if (knownPaths.length > 0) {
    prompt += `\nKNOWN PATHS:\n`;
    knownPaths.forEach(([k, v]) => { prompt += `- ${k}: ${v}\n`; });
  }

  // Available skills
  if (skills.length > 0) {
    prompt += `\nAVAILABLE SKILLS (use these for known tasks — faster & more reliable):\n`;
    skills.slice(0, 10).forEach(s => {
      prompt += `- ${s.name}: ${s.description} (trigger: "${s.trigger}")\n`;
    });
  }

  // Agent stats
  prompt += `\nAGENT STATS:\n`;
  prompt += `- Tasks Completed: ${a.totalTasksCompleted}\n`;
  prompt += `- Sessions: ${memory.sessionCount}\n`;
  if (a.githubUsername) prompt += `- GitHub: ${a.githubUsername}\n`;

  prompt += "═══════════════════\n";

  return prompt;
}

// ── Helper ────────────────────────────────────────────────
function generateSessionSummary(commands, results) {
  if (!commands?.length) return "No commands";
  const successful = results?.filter(r => r.success)?.length || 0;
  const cmds       = commands.slice(0, 3).map(c => c.command || "").join(", ");
  return `${successful}/${commands.length} tasks done. Commands: ${cmds}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Extract learnings from a completed task ───────────────
function extractLearnings(command, actions, success) {
  const memory  = loadMemory();
  const cmdLower = command.toLowerCase();

  // Learn browser preference
  if (cmdLower.includes("chrome"))   learnPreference("preferredBrowser", "chrome");
  if (cmdLower.includes("firefox"))  learnPreference("preferredBrowser", "firefox");

  // Learn save location
  const saveMatch = command.match(/save.*?(Desktop|Documents|Downloads|D:|C:\/Users\/\w+\/\w+)/i);
  if (saveMatch) {
    learnPreference("defaultSaveLocation", saveMatch[1]);
  }

  // Learn editor preference
  if (cmdLower.includes("vscode") || cmdLower.includes("vs code")) {
    learnPreference("preferredEditor", "vscode");
  }
  if (cmdLower.includes("notepad")) {
    learnPreference("preferredEditor", "notepad");
  }

  // Learn GitHub username from auth
  const ghMatch = command.match(/github.*?@(\w+)/);
  if (ghMatch) {
    memory.agent.githubUsername = ghMatch[1];
    saveMemory(memory);
  }

  // Record task result
  recordTaskResult(command, success);
}

// ── Skills system ─────────────────────────────────────────
function listSkills() {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getSkillForCommand(command) {
  const skills   = listSkills();
  const cmdLower = command.toLowerCase();
  return skills.find(s =>
    s.triggers?.some(t => cmdLower.includes(t.toLowerCase())) ||
    cmdLower.includes((s.trigger || "").toLowerCase())
  );
}

module.exports = {
  initMemory,
  loadMemory,
  saveMemory,
  learnPreference,
  rememberFact,
  rememberCorrection,
  recordTaskResult,
  rememberPath,
  saveSession,
  searchSessions,
  buildMemoryPrompt,
  extractLearnings,
  listSkills,
  getSkillForCommand,
  SKILLS_DIR,
  MEMORY_DIR,
};