// src/agent/brain-v2.js
// ═══════════════════════════════════════════════════════════
// UPGRADED BRAIN — Multi-Agent + Business DNA + Proactive
// ═══════════════════════════════════════════════════════════

const { execSync }       = require("child_process");
const path               = require("path");
const fs                 = require("fs");
const os                 = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");
const { buildMemoryPrompt, updateMemory }  = require("./memory");
const { buildSkillPrompt, saveSkill }      = require("./skills");
const { buildBusinessPrompt, loadDNA, isDNASetup, SETUP_QUESTIONS, processSetupAnswer, completeSetup } = require("./businessDNA");
const { executeTeam, needsTeam }           = require("./multiAgent");
const { generateMorningBriefing, scanForOpportunities } = require("./proactiveAgent");
const {
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect,
  browserScroll, browserGetInfo, browserHover,
  browserExists, browserEval, browserNewTab,
  browserSmartLogin, initBrowser,
} = require("./browserAgent");
const {
  githubAuth, githubListRepos, githubListFiles, githubReadFile,
  githubWriteFile, githubDeleteFile, githubCreateRepo,
  githubCreateBranch, githubCreatePR, githubListIssues,
  githubCreateIssue, githubSearch, githubCloneLocally,
  githubCommitMultiple,
} = require("./githubAgent");

// ── Setup Conversation State ───────────────────────────────
const SETUP_STATE_FILE = path.join(os.homedir(), ".vnus-agent", "setup-state.json");

function loadSetupState() {
  try { return JSON.parse(fs.readFileSync(SETUP_STATE_FILE, "utf8")); }
  catch { return { inProgress: false, currentQuestion: 0, answers: {}, dna: null }; }
}

function saveSetupState(state) {
  const dir = path.dirname(SETUP_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify(state, null, 2));
}

function clearSetupState() {
  try { fs.unlinkSync(SETUP_STATE_FILE); } catch {}
}

// ── Detect if user wants to setup Business DNA ────────────
function isBusinessSetupRequest(command) {
  return /introduce.*business|setup.*business|business.*dna|meet.*business|tell.*about.*business|my.*business.*is|set.*up.*agent.*role|configure.*agent/i.test(command);
}

// ── Detect if asking for team ──────────────────────────────
function isTeamRequest(command) {
  return /assemble.*team|create.*team|use.*team|multi.*agent|get.*team|build.*with.*team/i.test(command) || needsTeam(command);
}

// ── Detect briefing request ────────────────────────────────
function isBriefingRequest(command) {
  return /morning.*brief|daily.*brief|brief.*me|what.*today|daily.*update|status.*update|how.*business.*doing/i.test(command);
}

// ── Main System Prompt Builder ─────────────────────────────
function buildSystemPrompt(modelConfig) {
  const businessContext = buildBusinessPrompt();
  const memoryContext   = buildMemoryPrompt();
  const skillContext    = buildSkillPrompt();
  const dna             = loadDNA();
  const hasDNA          = isDNASetup();

  const agentIdentity = hasDNA
    ? `You are ${dna.agentName || "Vnus"}, the AI ${dna.agentRole || "CEO"} of ${dna.business?.name || "the user's business"}.`
    : `You are Vnus, an advanced AI agent running on the user's PC.`;

  return `${agentIdentity}
You execute tasks through a JSON array of actions.

${businessContext}
${memoryContext}
${skillContext}

═══ SPECIAL COMMANDS ═══
- If user wants to introduce their business → respond with: [{"action":"start_business_setup"}]
- If task needs multiple agents → respond with: [{"action":"assemble_team","task":"full task description"}]
- If user asks for briefing → respond with: [{"action":"generate_briefing"}]
- If user asks for opportunities → respond with: [{"action":"scan_opportunities"}]

═══ PC CONTROL ACTIONS ═══
- { "action": "open", "app": "chrome|firefox|vscode|terminal|explorer|notepad" }
- { "action": "click", "x": number, "y": number }
- { "action": "type", "text": "string" }
- { "action": "key", "key": "Enter|Tab|Escape|ctrl+s|ctrl+n|ctrl+v|ctrl+c" }
- { "action": "scroll", "x": number, "y": number, "direction": "up|down", "amount": number }
- { "action": "wait", "ms": number }
- { "action": "screenshot" }
- { "action": "write_file", "path": "/path/file.ext", "content": "full content" }
- { "action": "read_file", "path": "/path/file.ext" }
- { "action": "run_command", "command": "shell command" }

═══ BROWSER ACTIONS ═══
- { "action": "browser_goto", "url": "https://..." }
- { "action": "browser_click", "selector": "button.submit" }
- { "action": "browser_type", "selector": "#input", "text": "hello" }
- { "action": "browser_fill", "selector": "#input", "text": "hello" }
- { "action": "browser_wait", "selector": ".element", "state": "visible" }
- { "action": "browser_extract", "selector": ".content", "what": "text|html|all_text" }
- { "action": "browser_screenshot" }
- { "action": "browser_eval", "script": "return document.title" }

═══ GITHUB ACTIONS ═══
- { "action": "github_read_file", "owner": "user", "repo": "repo", "path": "src/index.js" }
- { "action": "github_write_file", "owner": "user", "repo": "repo", "path": "file.js", "content": "...", "message": "commit msg" }
- { "action": "github_create_repo", "name": "my-repo", "description": "..." }
- { "action": "github_create_pr", "owner": "user", "repo": "repo", "title": "...", "body": "...", "head": "feature/x" }
- { "action": "github_list_issues", "owner": "user", "repo": "repo" }

═══ FLOW CONTROL ═══
- { "action": "done", "message": "Task complete", "output": "result" }
- { "action": "error", "message": "Cannot complete because..." }

═══ RULES ═══
1. Business DNA is always your context — every response should serve the business.
2. Complex tasks → assemble_team action.
3. If user seems stressed or asks for status → generate_briefing.
4. Always end with done or error.
5. Respond ONLY with valid JSON array.`;
}

// ── Screenshot ─────────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms;$s=$([System.Windows.Forms.Screen]::PrimaryScreen.Bounds);$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size);$b.Save('${tmpPath.replace(/\\/g, "\\\\")}');$g.Dispose();$b.Dispose();`.replace(/\n/g, " ");
      execSync(`powershell -Command "${ps}"`);
    } else if (os.platform() === "darwin") {
      execSync(`screencapture -x "${tmpPath}"`);
    } else {
      execSync(`scrot "${tmpPath}"`);
    }
    const base64 = fs.readFileSync(tmpPath).toString("base64");
    fs.unlinkSync(tmpPath);
    return base64;
  } catch { return null; }
}

// ── File ops ───────────────────────────────────────────────
async function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); }
  catch { return null; }
}

async function runCommand(command) {
  return execSync(command, { encoding: "utf8", shell: true, timeout: 60000 });
}

function resolvePath(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith("Desktop/")) return path.join(os.homedir(), "Desktop", p.slice(8));
  return p;
}

async function openApp(appName) {
  const p = os.platform();
  const map = {
    chrome:   { win32:"start chrome", darwin:"open -a 'Google Chrome'", linux:"google-chrome &" },
    firefox:  { win32:"start firefox", darwin:"open -a Firefox", linux:"firefox &" },
    vscode:   { win32:"start code", darwin:"open -a 'Visual Studio Code'", linux:"code &" },
    terminal: { win32:"start cmd", darwin:"open -a Terminal", linux:"x-terminal-emulator &" },
    explorer: { win32:"start explorer", darwin:"open ~", linux:"nautilus ~ &" },
    notepad:  { win32:"start notepad", darwin:"open -a TextEdit", linux:"gedit &" },
  };
  const cmd = map[appName?.toLowerCase()]?.[p];
  execSync(cmd || (p === "win32" ? `start ${appName}` : `open -a "${appName}"`), { shell: true });
}

// ── Execute Actions ────────────────────────────────────────
async function executeActions(actions, modelConfig, workspaceId, firebaseConfig, onTeamProgress) {
  const results = [];

  for (const action of actions) {
    console.log(`▶ ${action.action}${action.url ? " → " + action.url : action.path ? " → " + action.path : ""}`);

    try {
      let output = null;

      // ── Special Agent Actions ───────────────────────────
      if (action.action === "assemble_team") {
        const teamResult = await executeTeam(
          action.task,
          modelConfig,
          (progress) => onTeamProgress?.(progress)
        );
        output = teamResult.output;
        results.push({ success: true, action, output });
        break;
      }

      if (action.action === "start_business_setup") {
        output = "BUSINESS_SETUP_STARTED";
        results.push({ success: true, action, output });
        break;
      }

      if (action.action === "generate_briefing") {
        const briefing = await generateMorningBriefing(modelConfig, null);
        output = briefing ? JSON.stringify(briefing) : "Briefing generation failed";
        results.push({ success: true, action, output });
        break;
      }

      if (action.action === "scan_opportunities") {
        const opps = await scanForOpportunities(modelConfig, null);
        output = opps ? JSON.stringify(opps) : "No opportunities found";
        results.push({ success: true, action, output });
        break;
      }

      // ── PC Actions ──────────────────────────────────────
      if (action.action === "open")         await openApp(action.app);
      else if (action.action === "wait")    await new Promise(r => setTimeout(r, action.ms || 500));
      else if (action.action === "write_file")  output = await writeFile(resolvePath(action.path), action.content);
      else if (action.action === "read_file")   output = readFile(resolvePath(action.path));
      else if (action.action === "run_command") output = await runCommand(action.command);
      else if (action.action === "screenshot")  output = await takeScreenshot();

      // ── Browser Actions ─────────────────────────────────
      else if (action.action === "browser_goto")          output = await browserGoto(action.url, action.waitUntil);
      else if (action.action === "browser_click")         await browserClick(action.selector, action.options);
      else if (action.action === "browser_type")          await browserType(action.selector, action.text, action.clear);
      else if (action.action === "browser_fill")          await browserFill(action.selector, action.text);
      else if (action.action === "browser_wait")          await browserWait(action.selector, action.state, action.timeout);
      else if (action.action === "browser_extract")       output = await browserExtract(action.selector, action.what);
      else if (action.action === "browser_extract_table") output = await browserExtractTable(action.selector);
      else if (action.action === "browser_screenshot")    output = await browserScreenshot(action.selector);
      else if (action.action === "browser_key")           await browserKey(action.key);
      else if (action.action === "browser_select")        await browserSelect(action.selector, action.value);
      else if (action.action === "browser_scroll")        await browserScroll(action.direction, action.amount);
      else if (action.action === "browser_hover")         await browserHover(action.selector);
      else if (action.action === "browser_eval")          output = await browserEval(action.script);
      else if (action.action === "browser_new_tab")       await browserNewTab(action.url);

      // ── GitHub Actions ──────────────────────────────────
      else if (action.action === "github_auth")           output = await githubAuth(action.token);
      else if (action.action === "github_list_repos")     output = await githubListRepos();
      else if (action.action === "github_read_file")      output = await githubReadFile(action.owner, action.repo, action.path, action.branch);
      else if (action.action === "github_write_file")     output = await githubWriteFile(action.owner, action.repo, action.path, action.content, action.message, action.branch);
      else if (action.action === "github_create_repo")    output = await githubCreateRepo(action.name, action.description, action.private);
      else if (action.action === "github_create_branch")  output = await githubCreateBranch(action.owner, action.repo, action.branch, action.from);
      else if (action.action === "github_create_pr")      output = await githubCreatePR(action.owner, action.repo, action.title, action.body, action.head, action.base);
      else if (action.action === "github_list_issues")    output = await githubListIssues(action.owner, action.repo, action.state);
      else if (action.action === "github_create_issue")   output = await githubCreateIssue(action.owner, action.repo, action.title, action.body, action.labels);
      else if (action.action === "github_search")         output = await githubSearch(action.query, action.owner, action.repo);
      else if (action.action === "github_clone")          output = await githubCloneLocally(action.owner, action.repo, action.target);
      else if (action.action === "github_commit_multiple") output = await githubCommitMultiple(action.owner, action.repo, action.files, action.message, action.branch);

      results.push({ success: true, action, output });
      if (action.action === "done" || action.action === "error") break;

      const noDelay = ["write_file","read_file","github_read_file","github_write_file","github_list_repos","github_commit_multiple"];
      if (!noDelay.includes(action.action)) {
        await new Promise(r => setTimeout(r, 300));
      }

    } catch (err) {
      console.error(`❌ ${action.action}: ${err.message}`);
      results.push({ success: false, action, error: err.message });
    }
  }

  return results;
}

// ── Handle Business DNA Setup Conversation ─────────────────
async function handleBusinessSetup(command, setupState) {
  const { currentQuestion, answers, dna: dnaInProgress } = setupState;
  const questions = SETUP_QUESTIONS;

  // First time
  if (!setupState.inProgress) {
    const newState = {
      inProgress: true,
      currentQuestion: 0,
      answers: {},
      dna: null,
    };
    saveSetupState(newState);

    const q = questions[0];
    return {
      setupInProgress: true,
      message: `🧬 Let's set up your Business DNA!\n\nThis takes about 5 minutes and I'll never ask again. I'll remember everything forever.\n\n**Question 1/${questions.length}:**\n${q.question}\n\n💡 ${q.example}`,
      questionIndex: 0,
    };
  }

  // Save answer to current question
  const q = questions[currentQuestion];
  const updatedAnswers = { ...answers, [q.id]: command };

  // Load or create DNA
  const { loadDNA: loadCurrentDNA } = require("./businessDNA");
  let dna = loadCurrentDNA();
  dna = processSetupAnswer(q.id, command, dna);

  // Check if more questions
  const nextQuestion = currentQuestion + 1;

  if (nextQuestion >= questions.length) {
    // Setup complete
    dna = completeSetup(dna);
    clearSetupState();

    const dnaData = loadCurrentDNA();
    return {
      setupInProgress: false,
      setupComplete: true,
      message: `🎉 Business DNA stored!\n\n**${dnaData.business?.name}** — I now know everything about your business.\n\nAs your ${dnaData.agentRole || "CEO"}, I'll:\n→ Brief you every morning\n→ Monitor your space\n→ Assemble teams for complex tasks\n→ Work proactively 24/7\n\nTry: *"Brief me on today"* or *"Create a marketing campaign for my launch"*`,
      dna: dnaData,
    };
  }

  // Next question
  const newState = {
    inProgress: true,
    currentQuestion: nextQuestion,
    answers: updatedAnswers,
    dna: null,
  };
  saveSetupState(newState);

  const nextQ = questions[nextQuestion];
  return {
    setupInProgress: true,
    message: `✅ Got it!\n\n**Question ${nextQuestion + 1}/${questions.length}:**\n${nextQ.question}\n\n💡 ${nextQ.example}`,
    questionIndex: nextQuestion,
    options: nextQ.options || null,
  };
}

// ── Format Briefing Response ───────────────────────────────
function formatBriefing(briefing) {
  if (!briefing) return "Could not generate briefing.";

  let msg = `☀️ **Good morning from ${briefing.agentName}**\n\n`;
  msg += `${briefing.greeting}\n\n`;

  if (briefing.alerts?.length) {
    msg += `**🔔 Alerts:**\n`;
    briefing.alerts.forEach(a => {
      const icon = a.type === "warning" ? "⚠️" : a.type === "opportunity" ? "🎯" : "ℹ️";
      msg += `${icon} **${a.title}**\n${a.description}\n→ ${a.action}\n\n`;
    });
  }

  if (briefing.tasksForToday?.length) {
    msg += `**📋 Today's priorities:**\n`;
    briefing.tasksForToday.forEach((t, i) => {
      msg += `${i + 1}. ${t.task}\n   ↳ ${t.reason}\n`;
    });
    msg += "\n";
  }

  if (briefing.strategicInsight) {
    msg += `**💡 Strategic insight:**\n${briefing.strategicInsight}\n\n`;
  }

  if (briefing.motivationalNote) {
    msg += `*${briefing.motivationalNote}* 👹`;
  }

  return msg;
}

// ── Format Opportunities ───────────────────────────────────
function formatOpportunities(opps) {
  if (!opps?.length) return "No immediate opportunities found.";

  let msg = `🎯 **Opportunities I found for you:**\n\n`;
  opps.forEach((o, i) => {
    const effortColor = o.effort === "low" ? "🟢" : o.effort === "medium" ? "🟡" : "🔴";
    msg += `**${i + 1}. ${o.title}** ${effortColor}\n`;
    msg += `${o.description}\n`;
    msg += `→ First step: *${o.firstStep}*\n`;
    msg += `Impact: ${o.impact} | Effort: ${o.effort}\n\n`;
  });

  return msg;
}

// ── Main Execute Command ───────────────────────────────────
async function executeCommand(command, modelConfig, workspaceId, firebaseConfig) {
  console.log(`\n🎯 "${command}"`);

  // ── Check Business Setup Flow ──────────────────────────
  const setupState = loadSetupState();

  // Mid-setup conversation
  if (setupState.inProgress) {
    const result = await handleBusinessSetup(command, setupState);
    return {
      success: true,
      message: result.message,
      isSetupFlow: true,
      setupComplete: result.setupComplete || false,
      options: result.options || null,
    };
  }

  // User wants to start setup
  if (isBusinessSetupRequest(command)) {
    const result = await handleBusinessSetup(command, { inProgress: false });
    return {
      success: true,
      message: result.message,
      isSetupFlow: true,
      options: result.options || null,
    };
  }

  // ── Briefing Request ────────────────────────────────────
  if (isBriefingRequest(command)) {
    console.log("   → Generating daily briefing...");
    const briefing = await generateMorningBriefing(modelConfig, null);
    return {
      success: true,
      message: formatBriefing(briefing),
      isBriefing: true,
    };
  }

  // ── Team Request ────────────────────────────────────────
  if (isTeamRequest(command)) {
    console.log("   → Assembling multi-agent team...");
    const teamResult = await executeTeam(command, modelConfig, (progress) => {
      console.log(`   Team: ${progress.message}`);
    });
    return {
      success: teamResult.success,
      message: teamResult.message,
      output: teamResult.output,
      isTeamTask: true,
      teamName: teamResult.teamName,
      agents: teamResult.agents,
    };
  }

  // ── Standard Command Execution ──────────────────────────
  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;
  const systemPrompt = buildSystemPrompt(modelConfig);

  const userContent = `User command: "${command}"\n\nRespond ONLY with a valid JSON array of actions. No explanation.`;

  let actions = null;
  let attempts = 0;

  while (!actions && attempts < 3) {
    attempts++;
    try {
      let text = "";
      if (modelConfig.visionEnabled && modelConfig.visionOllamaId && screenshot) {
        text = await runOllamaVision(modelConfig.visionOllamaId, systemPrompt, `Current screen above.\n${userContent}`, screenshot);
      } else {
        text = await runOllamaPrompt(modelConfig.ollamaId, systemPrompt, userContent);
      }
      const match = text.match(/\[[\s\S]*\]/);
      if (match) actions = JSON.parse(match[0]);
    } catch (err) {
      console.error(`Attempt ${attempts} failed: ${err.message}`);
    }
  }

  if (!actions || actions.length === 0) {
    return { success: false, message: "AI could not determine actions. Please rephrase your command." };
  }

  console.log(`   ${actions.length} actions planned`);

  const results   = await executeActions(actions, modelConfig, workspaceId, firebaseConfig, null);
  const done      = results.find(r => r.action?.action === "done");
  const error     = results.find(r => r.action?.action === "error");
  const pcShot    = modelConfig.visionEnabled ? await takeScreenshot() : null;
  const browserShot = results.find(r => r.action?.action === "browser_screenshot" && r.output)?.output;

  // Update memory
  if (done) {
    updateMemory({
      type: "task",
      command,
      result: done.action?.message || "Done",
      success: true,
      timestamp: Date.now(),
    });
  }

  return {
    success:      !error,
    message:      done?.action?.message || error?.action?.message || "Task executed",
    output:       done?.action?.output  || null,
    results,
    screenshot:   browserShot || pcShot,
  };
}

module.exports = { executeCommand, takeScreenshot, writeFile, handleBusinessSetup, formatBriefing };