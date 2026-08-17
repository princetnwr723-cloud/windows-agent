// src/agent/brain.js
// ✅ All original features preserved
// ✅ Multi-Agent Team System added
// ✅ Business DNA added
// ✅ Proactive Agent added
// ✅ Chain of Thought + JSON retry + Permission system all intact

const { execSync }        = require("child_process");
const path                = require("path");
const fs                  = require("fs");
const os                  = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");
const { buildMemoryPrompt, extractLearnings, saveSession, initMemory } = require("./memory");
const { shouldCreateSkill, generateSkill, getSkillForCommand, getSkillsSummary } = require("./skills");
const { checkAndRequestPermission, assessCommandRisk } = require("./permissions");
const { buildBusinessPrompt, loadDNA, isDNASetup, SETUP_QUESTIONS, processSetupAnswer, completeSetup, detectDNADrift, buildDriftMessage, applyDriftUpdates, isUpdateConfirmation, isUpdateRejection, generateDNAHealthReport } = require("./businessDNA");
const { executeTeam, needsTeam } = require("./multiAgent");
const { generateMorningBriefing, scanForOpportunities } = require("./proactiveAgent");
const { getBestConnector, callConnector } = require("./connectors");
const { executeTeamTask, chatWithAgent, addToLog } = require("./teamAgent");
const {
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect, browserScroll,
  browserHover, browserExists, browserNewTab, browserEval, browserSmartLogin,
} = require("./browserAgent");
const {
  githubAuth, githubListRepos, githubListFiles, githubReadFile,
  githubWriteFile, githubDeleteFile, githubCreateRepo, githubCreateBranch,
  githubCreatePR, githubListIssues, githubCreateIssue,
  githubSearch, githubCloneLocally, githubCommitMultiple,
} = require("./githubAgent");

initMemory();

// ── Global context ────────────────────────────────────────
let _workspaceId    = null;
let _firebaseConfig = null;
let _chatContext    = {};

function setAgentContext(workspaceId, firebaseConfig, chatContext = {}) {
  _workspaceId    = workspaceId;
  _firebaseConfig = firebaseConfig;
  _chatContext    = chatContext;
}

// ── Drift state — pending updates ─────────────────────────
const DRIFT_STATE_FILE = path.join(os.homedir(), ".vnus-agent", "drift-state.json");

function loadDriftState() {
  try { return JSON.parse(fs.readFileSync(DRIFT_STATE_FILE, "utf8")); }
  catch { return { pending: null }; }
}
function saveDriftState(state) {
  fs.writeFileSync(DRIFT_STATE_FILE, JSON.stringify(state, null, 2));
}
function clearDriftState() {
  try { fs.unlinkSync(DRIFT_STATE_FILE); } catch {} 
}

// ── Setup state file ──────────────────────────────────────
const SETUP_STATE_FILE = path.join(os.homedir(), ".vnus-agent", "setup-state.json");

function loadSetupState() {
  try { return JSON.parse(fs.readFileSync(SETUP_STATE_FILE, "utf8")); }
  catch { return { inProgress: false, currentQuestion: 0, answers: {} }; }
}

function saveSetupState(state) {
  const dir = path.dirname(SETUP_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify(state, null, 2));
}

function clearSetupState() {
  try { fs.unlinkSync(SETUP_STATE_FILE); } catch {}
}

// ── Detect special command types ──────────────────────────
function isBusinessSetupRequest(cmd) {
  return /introduce.*business|setup.*business|business.*dna|meet.*business|tell.*about.*business|my.*business.*is|configure.*agent.*role/i.test(cmd);
}

function isBriefingRequest(cmd) {
  return /morning.*brief|daily.*brief|brief.*me|what.*today|daily.*update|status.*update|how.*business.*doing/i.test(cmd);
}

function isOpportunityRequest(cmd) {
  return /find.*opportunit|scan.*opportunit|opportunit.*for.*me|what.*opportunit/i.test(cmd);
}

// ── Task type detection (original) ───────────────────────
function detectTaskType(command) {
  if (/(write|create|build|make|generate|fix|debug|refactor|optimize|review)\s.*(code|script|function|class|component|app|api|website|html|css|js|python|react|node)/i.test(command) ||
      /(code|script|function|class|bug|error|exception|compile|syntax|algorithm|implement)/i.test(command)) return "coding";
  if (/(why|explain|analyze|reason|think|understand|compare|difference|how does|what is the best|should i|pros and cons)/i.test(command)) return "reasoning";
  if (/(open|go to|navigate|search|click|fill|extract|scrape|browse|website|http)/i.test(command)) return "browser";
  if (/(file|folder|directory|read|write|delete|create|copy|move|rename|save)/i.test(command)) return "files";
  if (/(github|git|repo|commit|push|pull|branch|pr|issue|merge)/i.test(command)) return "github";
  return "general";
}

function selectModelForTask(taskType, modelConfig) {
  if (taskType === "coding" && modelConfig.coderOllamaId) {
    console.log(`🎯 Task: coding — switching to coder model: ${modelConfig.coderOllamaId}`);
    return { ...modelConfig, ollamaId: modelConfig.coderOllamaId };
  }
  return modelConfig;
}

// ── Chain of Thought (original) ───────────────────────────
function getCoTInstruction(taskType) {
  if (taskType === "coding") return `
CODING REASONING STEPS:
1. What language/framework is needed?
2. What is the exact file path and name?
3. What are the edge cases to avoid?
4. Write complete, working code — no placeholders.
5. Output JSON actions.`;
  if (taskType === "reasoning") return `
REASONING STEPS:
1. What exactly is being asked?
2. What is the most logical step-by-step approach?
3. Output JSON actions.`;
  if (taskType === "browser") return `
BROWSER TASK STEPS:
1. What is the exact URL or site?
2. What elements need interaction?
3. Use browser_* actions — more reliable.
4. Use browser_wait before any interaction.`;
  return `
TASK STEPS:
1. What exactly does the user want?
2. Simplest correct approach?
3. Output JSON actions.`;
}

// ── System prompt (original + business DNA) ───────────────
function buildSystemPrompt(taskType = "general") {
  const memoryContext   = buildMemoryPrompt();
  const skillsContext   = getSkillsSummary();
  const cotSteps        = getCoTInstruction(taskType);
  const businessContext = buildBusinessPrompt(); // empty string if DNA not set

  return `You are Agentic Vnus, a self-improving AI agent running on the user's PC.
CRITICAL: Respond ONLY with a valid JSON array. No markdown, no explanation, no text outside the array.

${businessContext}
${memoryContext}
${skillsContext}

${cotSteps}

═══ AVAILABLE ACTIONS ═══

PC CONTROL:
{"action":"open","app":"chrome|firefox|vscode|terminal|explorer|notepad|calculator"}
{"action":"click","x":500,"y":300}
{"action":"type","text":"hello world"}
{"action":"key","key":"Enter|Tab|Escape|ctrl+s|ctrl+c|ctrl+v|ctrl+z|ctrl+a"}
{"action":"scroll","x":500,"y":300,"direction":"up|down","amount":3}
{"action":"wait","ms":1000}
{"action":"screenshot"}
{"action":"write_file","path":"C:/Users/USERNAME/Desktop/file.txt","content":"full content here"}
{"action":"read_file","path":"C:/Users/USERNAME/Desktop/file.txt"}
{"action":"run_command","command":"dir C:\\Users\\USERNAME\\Desktop"}

BROWSER (preferred for web tasks):
{"action":"browser_goto","url":"https://example.com"}
{"action":"browser_click","selector":"button.submit"}
{"action":"browser_type","selector":"#input","text":"hello"}
{"action":"browser_fill","selector":"#input","text":"hello"}
{"action":"browser_wait","selector":".element","state":"visible"}
{"action":"browser_extract","selector":".content","what":"text|html|value|all_text"}
{"action":"browser_screenshot"}
{"action":"browser_key","key":"Enter|Tab|Escape"}
{"action":"browser_scroll","direction":"down","amount":500}
{"action":"browser_eval","script":"return document.title"}

GITHUB:
{"action":"github_auth","token":"ghp_..."}
{"action":"github_list_repos"}
{"action":"github_read_file","owner":"user","repo":"repo","path":"src/index.js"}
{"action":"github_write_file","owner":"user","repo":"repo","path":"file.js","content":"...","message":"commit"}
{"action":"github_create_repo","name":"my-repo","description":"...","private":false}
{"action":"github_create_pr","owner":"user","repo":"repo","title":"PR title","body":"description","head":"feature","base":"main"}

FLOW:
{"action":"done","message":"What was accomplished"}
{"action":"error","message":"Why it failed and what user should do"}

═══ STRICT RULES ═══
1. USERNAME is auto-replaced with actual system username
2. Always use browser_* for web tasks
3. For code files — write COMPLETE code, never truncate
4. Always end with done or error action
5. ONLY output the JSON array — no text before or after`;
}

// ── Screenshot (original) ─────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size);$b.Save('${tmpPath.replace(/\\/g,"\\\\")}}');$g.Dispose();$b.Dispose()`;
      execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { timeout: 10000, stdio: "pipe" });
    } else if (os.platform() === "darwin") {
      execSync(`screencapture -x "${tmpPath}"`, { timeout: 5000, stdio: "pipe" });
    } else {
      execSync(`scrot "${tmpPath}"`, { timeout: 5000, stdio: "pipe" });
    }
    if (fs.existsSync(tmpPath)) {
      const base64 = fs.readFileSync(tmpPath).toString("base64");
      fs.unlinkSync(tmpPath);
      return base64;
    }
    return null;
  } catch { return null; }
}

// ── File operations (original) ────────────────────────────
async function writeFile(filePath, content) {
  const resolved = resolvePath(filePath);
  const dir      = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
  console.log(`✅ File written: ${resolved}`);
  return resolved;
}

function readFile(filePath) {
  try {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
    const content  = fs.readFileSync(resolved, "utf8");
    return content.length > 4000 ? content.slice(0, 4000) + "\n...(truncated)" : content;
  } catch (err) { return `Error: ${err.message}`; }
}

// ── Run command with permission check (original) ──────────
async function runCommand(command) {
  const risk = assessCommandRisk(command);
  if (risk.level === "blocked") throw new Error(`🚫 Blocked: ${risk.reason}`);
  if ((risk.level === "high" || risk.level === "medium") && _workspaceId && _firebaseConfig) {
    const perm = await checkAndRequestPermission("run_command", { command }, _workspaceId, _firebaseConfig, _chatContext);
    if (perm.blocked)  throw new Error(`🚫 Blocked: ${perm.reason}`);
    if (!perm.allowed) throw new Error(perm.reason === "timeout" ? "⏰ Permission timeout" : "❌ User denied");
  }
  const out = execSync(command, { encoding: "utf8", shell: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  return out || "Done";
}

// ── Open app (original) ───────────────────────────────────
async function openApp(appName) {
  const p   = os.platform();
  const app = (appName || "").toLowerCase();
  const map = {
    chrome:     { win32:"start chrome",   darwin:"open -a 'Google Chrome'", linux:"google-chrome &" },
    firefox:    { win32:"start firefox",  darwin:"open -a Firefox",         linux:"firefox &" },
    vscode:     { win32:"code .",         darwin:"open -a 'Visual Studio Code'", linux:"code &" },
    terminal:   { win32:"start cmd",      darwin:"open -a Terminal",         linux:"x-terminal-emulator &" },
    explorer:   { win32:"explorer .",     darwin:"open .",                   linux:"nautilus . &" },
    notepad:    { win32:"notepad",        darwin:"open -a TextEdit",         linux:"gedit &" },
    calculator: { win32:"calc",           darwin:"open -a Calculator",       linux:"gnome-calculator &" },
  };
  const cmd = map[app]?.[p];
  if (cmd) execSync(cmd, { shell: true, stdio: "pipe" });
  else {
    if (p === "win32")       execSync(`start ${appName}`,      { shell: true, stdio: "pipe" });
    else if (p === "darwin") execSync(`open -a "${appName}"`,  { shell: true, stdio: "pipe" });
    else                     execSync(`${appName} &`,          { shell: true, stdio: "pipe" });
  }
}

// ── PC controls (original) ────────────────────────────────
async function mouseClick(x, y) {
  const p = os.platform();
  if (p === "win32") {
    const ps = `Add-Type @'\nusing System;using System.Runtime.InteropServices;\npublic class M{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int b,int e);}\n'@;[M]::SetCursorPos(${x},${y});Start-Sleep -Milliseconds 80;[M]::mouse_event(2,0,0,0,0);[M]::mouse_event(4,0,0,0,0)`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g," ")}"`, { stdio:"pipe", timeout:5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to click at {${x},${y}}'`, { stdio:"pipe" });
  } else {
    execSync(`xdotool mousemove ${x} ${y} click 1`, { stdio:"pipe" });
  }
}

async function typeText(text) {
  const p    = os.platform();
  const safe = text.replace(/'/g, "\\'");
  if (p === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::SetText('${safe.replace(/'/g,"''")}');[System.Windows.Forms.SendKeys]::SendWait('^v')`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio:"pipe", timeout:5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`, { stdio:"pipe" });
  } else {
    execSync(`xdotool type --clearmodifiers '${safe}'`, { stdio:"pipe" });
  }
}

async function pressKey(key) {
  const p    = os.platform();
  const wMap = { "Enter":"{ENTER}","Tab":"{TAB}","Escape":"{ESC}","Backspace":"{BACKSPACE}","ctrl+s":"^s","ctrl+c":"^c","ctrl+v":"^v","ctrl+z":"^z","ctrl+a":"^a","ctrl+n":"^n" };
  if (p === "win32") {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${wMap[key]||key}')"`, { stdio:"pipe", timeout:5000 });
  } else if (p === "darwin") {
    if (key.includes("ctrl+")) execSync(`osascript -e 'tell application "System Events" to keystroke "${key.replace("ctrl+","")}" using command down'`, { stdio:"pipe" });
  } else {
    const xMap = { "Enter":"Return","Tab":"Tab","Escape":"Escape","ctrl+s":"ctrl+s","ctrl+c":"ctrl+c","ctrl+v":"ctrl+v" };
    execSync(`xdotool key ${xMap[key]||key}`, { stdio:"pipe" });
  }
}

async function scrollPage(x, y, direction, amount = 3) {
  const p = os.platform();
  if (p === "win32") {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})"`, { stdio:"pipe" });
    await new Promise(r => setTimeout(r, 100));
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to scroll (get mouse location) by {0, ${direction==="up"?-amount*3:amount*3}00}'`, { stdio:"pipe" });
  } else {
    const btn = direction === "up" ? 4 : 5;
    for (let i = 0; i < amount; i++) execSync(`xdotool click ${btn}`, { stdio:"pipe" });
  }
}

function resolvePath(p) {
  if (!p) return p;
  const username = os.userInfo().username;
  p = p.replace(/\bUSERNAME\b/g, username).replace(/\bUSER\b/g, username);
  if (p.startsWith("~/"))         return path.join(os.homedir(), p.slice(2));
  if (p.startsWith("Desktop/"))   return path.join(os.homedir(), "Desktop",   p.slice(8));
  if (p.startsWith("Documents/")) return path.join(os.homedir(), "Documents", p.slice(10));
  if (p.startsWith("Downloads/")) return path.join(os.homedir(), "Downloads", p.slice(10));
  return p;
}

// ── JSON parsing with auto-fix (original) ─────────────────
function parseActions(text) {
  if (!text) return null;
  let clean = text.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(clean.slice(start, end+1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    try {
      const fixed = clean.slice(start, end+1)
        .replace(/,\s*]/g,"]").replace(/,\s*}/g,"}")
        .replace(/(['"'])?([a-zA-Z_]\w*)(['"'])?:/g,'"$2":');
      const parsed = JSON.parse(fixed);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
}

// ── AI call with CoT + retry (original) ───────────────────
async function callLocalAI(command, screenshotBase64, modelConfig, taskType, retryCount = 0) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const username  = os.userInfo().username;
  const MAX_RETRY = 3;
  const retryNote = retryCount > 0
    ? `\n⚠️ RETRY ${retryCount}/${MAX_RETRY}: Previous response was not valid JSON. Output ONLY a JSON array.`
    : "";

  const userContent = `Task: "${command}"

System: ${os.platform()==="win32"?"Windows":os.platform()==="darwin"?"macOS":"Linux"}
Username: ${username}
Desktop: ${path.join(os.homedir(),"Desktop")}
Home: ${os.homedir()}
Task type: ${taskType}
${retryNote}

Output ONLY a valid JSON array.`;

  try {
    const systemPrompt = buildSystemPrompt(taskType);
    let text = "";
    if (visionEnabled && visionOllamaId && screenshotBase64) {
      text = await runOllamaVision(visionOllamaId, systemPrompt, `Screen shown.\n${userContent}`, screenshotBase64);
    } else {
      text = await runOllamaPrompt(ollamaId, systemPrompt, userContent);
    }
    console.log(`AI response (attempt ${retryCount+1}):`, text.slice(0,150));
    const actions = parseActions(text);
    if (!actions) {
      if (retryCount < MAX_RETRY) {
        console.warn(`⚠️ Invalid JSON attempt ${retryCount+1} — retrying...`);
        await new Promise(r => setTimeout(r, 1000));
        return callLocalAI(command, screenshotBase64, modelConfig, taskType, retryCount+1);
      }
      return null;
    }
    return actions;
  } catch (err) {
    console.error("AI call error:", err.message);
    if (retryCount < MAX_RETRY) {
      await new Promise(r => setTimeout(r, 2000));
      return callLocalAI(command, screenshotBase64, modelConfig, taskType, retryCount+1);
    }
    return null;
  }
}

// ── Execute actions (original + new special actions) ──────
async function executeActions(actions) {
  const results = [];
  for (const action of actions) {
    const name = action.action;
    console.log(`▶ ${name}${action.url?" → "+action.url:action.app?" → "+action.app:action.path?" → "+action.path:""}`);
    try {
      let output = null;
      if (name==="done"||name==="error") { results.push({success:true,action,output:action.message}); break; }
      else if (name==="open")           await openApp(action.app);
      else if (name==="click")          await mouseClick(action.x,action.y);
      else if (name==="type")           await typeText(action.text);
      else if (name==="key")            await pressKey(action.key);
      else if (name==="wait")           await new Promise(r=>setTimeout(r,Math.min(action.ms||500,10000)));
      else if (name==="scroll")         await scrollPage(action.x||500,action.y||300,action.direction,action.amount);
      else if (name==="screenshot")     output = await takeScreenshot();
      else if (name==="write_file") {
        if (_workspaceId && _firebaseConfig) {
          const perm = await checkAndRequestPermission("write_file",{path:action.path},_workspaceId,_firebaseConfig,_chatContext);
          if (!perm.allowed && perm.reason) { results.push({success:false,action,error:perm.reason}); continue; }
        }
        output = await writeFile(action.path,action.content);
      }
      else if (name==="read_file")      output = readFile(action.path);
      else if (name==="run_command")    output = await runCommand(action.command);
      else if (name==="browser_goto")          output = await browserGoto(action.url,action.waitUntil);
      else if (name==="browser_click")         await browserClick(action.selector,action.options);
      else if (name==="browser_type")          await browserType(action.selector,action.text,action.clear);
      else if (name==="browser_fill")          await browserFill(action.selector,action.text);
      else if (name==="browser_wait")          await browserWait(action.selector,action.state,action.timeout);
      else if (name==="browser_extract")       output = await browserExtract(action.selector,action.what);
      else if (name==="browser_extract_table") output = await browserExtractTable(action.selector);
      else if (name==="browser_screenshot")    output = await browserScreenshot(action.selector);
      else if (name==="browser_key")           await browserKey(action.key);
      else if (name==="browser_select")        await browserSelect(action.selector,action.value);
      else if (name==="browser_scroll")        await browserScroll(action.direction,action.amount);
      else if (name==="browser_hover")         await browserHover(action.selector);
      else if (name==="browser_exists")        output = await browserExists(action.selector,action.timeout);
      else if (name==="browser_eval")          output = await browserEval(action.script);
      else if (name==="browser_new_tab")       await browserNewTab(action.url);
      else if (name==="browser_login")         await browserSmartLogin(action.site,action.username,action.password);
      else if (name==="github_auth")           output = await githubAuth(action.token);
      else if (name==="github_list_repos")     output = await githubListRepos();
      else if (name==="github_list_files")     output = await githubListFiles(action.owner,action.repo,action.path||"");
      else if (name==="github_read_file")      output = await githubReadFile(action.owner,action.repo,action.path,action.branch);
      else if (name==="github_write_file")     output = await githubWriteFile(action.owner,action.repo,action.path,action.content,action.message,action.branch);
      else if (name==="github_delete_file")    output = await githubDeleteFile(action.owner,action.repo,action.path,action.message);
      else if (name==="github_create_repo")    output = await githubCreateRepo(action.name,action.description,action.private);
      else if (name==="github_create_branch")  output = await githubCreateBranch(action.owner,action.repo,action.branch,action.from);
      else if (name==="github_create_pr")      output = await githubCreatePR(action.owner,action.repo,action.title,action.body,action.head,action.base);
      else if (name==="github_list_issues")    output = await githubListIssues(action.owner,action.repo,action.state);
      else if (name==="github_create_issue")   output = await githubCreateIssue(action.owner,action.repo,action.title,action.body,action.labels);
      else if (name==="github_search")         output = await githubSearch(action.query,action.owner,action.repo);
      else if (name==="github_clone")          output = await githubCloneLocally(action.owner,action.repo,action.target);
      else if (name==="github_commit_multiple") output = await githubCommitMultiple(action.owner,action.repo,action.files,action.message,action.branch);
      else console.warn(`⚠️ Unknown action: ${name}`);
      results.push({success:true,action,output});
      const noDelay = ["write_file","read_file","github_read_file","github_write_file","wait"];
      if (!noDelay.includes(name)) await new Promise(r=>setTimeout(r,200));
    } catch (err) {
      console.error(`❌ ${name}: ${err.message}`);
      results.push({success:false,action,error:err.message});
    }
  }
  return results;
}

// ── Business DNA Setup Handler ────────────────────────────
async function handleBusinessSetup(command, setupState) {
  const questions = SETUP_QUESTIONS;
  if (!setupState.inProgress) {
    saveSetupState({ inProgress:true, currentQuestion:0, answers:{} });
    const q = questions[0];
    return { setupInProgress:true, message:`🧬 Let's set up your Business DNA!\n\nThis takes about 5 minutes. I'll remember everything forever.\n\n**Question 1/${questions.length}:**\n${q.question}\n\n💡 ${q.example}`, options:q.options||null };
  }
  const q          = questions[setupState.currentQuestion];
  let dna          = loadDNA();
  dna              = processSetupAnswer(q.id, command, dna);
  const nextQ      = setupState.currentQuestion + 1;
  if (nextQ >= questions.length) {
    dna = completeSetup(dna);
    clearSetupState();
    return { setupInProgress:false, setupComplete:true, message:`🎉 Business DNA stored!\n\n**${dna.business?.name}** is all set.\n\nAs your AI ${dna.agentRole || "CEO"}, I'll:\n→ Brief you every morning\n→ Monitor your competitors\n→ Assemble teams for complex tasks\n→ Work proactively 24/7\n\nTry: *"Brief me on today"* or *"Create a marketing campaign"*`, dna };
  }
  saveSetupState({ inProgress:true, currentQuestion:nextQ, answers:{ ...setupState.answers, [q.id]:command } });
  const nq = questions[nextQ];
  return { setupInProgress:true, message:`✅ Got it!\n\n**Question ${nextQ+1}/${questions.length}:**\n${nq.question}\n\n💡 ${nq.example}`, options:nq.options||null };
}

// ── Main execute command ──────────────────────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\n🎯 Command: "${command}"`);

  // ── 1. Business DNA setup flow ─────────────────────────
  const setupState = loadSetupState();
  if (setupState.inProgress) {
    const result = await handleBusinessSetup(command, setupState);
    return { success:true, isSetupFlow:true, ...result };
  }
  if (isBusinessSetupRequest(command)) {
    const result = await handleBusinessSetup(command, { inProgress:false });
    return { success:true, isSetupFlow:true, ...result };
  }

  // ── 1.5 DNA Drift — Check pending update confirmation ───
  const driftState = loadDriftState();
  if (driftState.pending) {
    if (isUpdateConfirmation(command)) {
      applyDriftUpdates(driftState.pending);
      clearDriftState();
      return {
        success: true,
        message: "✅ Business DNA updated!\n\n" + driftState.pending.map(d => "→ " + d.label + ": " + d.newVal).join("\n") + "\n\nYour agent now has the latest context. 🧬",
        isDriftUpdate: true,
      };
    }
    if (isUpdateRejection(command)) {
      clearDriftState();
      return {
        success: true,
        message: "Got it — keeping your existing DNA unchanged. 🧬",
        isDriftUpdate: true,
      };
    }
  }

  // ── 1.6 DNA Drift — Detect in current command ───────────
  if (isDNASetup()) {
    const drifts = detectDNADrift(command);
    if (drifts.length > 0) {
      saveDriftState({ pending: drifts });
      console.log(`🧬 DNA drift detected: ${drifts.map(d => d.label).join(", ")}`);
    }
  }

  // ── 2. Morning briefing ────────────────────────────────
  if (isBriefingRequest(command)) {
    const briefing = await generateMorningBriefing(modelConfig);
    return {
      success: true,
      isBriefing: true,
      message: briefing ? formatBriefing(briefing) : "Could not generate briefing right now.",
    };
  }

  // ── 3. Opportunity scan ────────────────────────────────
  if (isOpportunityRequest(command)) {
    const opps = await scanForOpportunities(modelConfig);
    return {
      success: true,
      message: opps ? formatOpportunities(opps) : "No opportunities found right now.",
    };
  }

  // ── 4. Smart team routing via Boss Agent ───────────────
  const teamResult = await executeTeamTask(command, modelConfig, (progress) => {
    console.log(`   Team: ${progress.message}`);
  });

  if (teamResult.solo) {
    // Boss handled alone — continue to standard execution
    return {
      success: teamResult.success,
      message: teamResult.output || "Task completed.",
      isTeamTask: false,
    };
  }

  return {
    success:    teamResult.success,
    message:    `👥 Team completed!\n\n${teamResult.output || "Done."}`,
    isTeamTask: true,
    agents:     teamResult.agents,
    output:     teamResult.output,
    routing:    teamResult.routing,
  };

  // ── 5. Standard single-agent execution (original flow) ─
  const taskType   = detectTaskType(command);
  const bestConfig = selectModelForTask(taskType, modelConfig);
  console.log(`   Task type: ${taskType} | Model: ${bestConfig.ollamaId}`);

  const existingSkill = getSkillForCommand(command);
  if (existingSkill && !existingSkill.stale) console.log(`⚡ Skill match: ${existingSkill.name}`);

  // ── Try API connector for complex tasks ─────────────────
  const connector = await getBestConnector(taskType);
  let actions = null;

  if (connector && ["coding","reasoning","strategy","content","research"].includes(taskType)) {
    console.log(`   🔀 Using connector: ${connector.name} (${connector.model})`);
    try {
      const systemPrompt = buildSystemPrompt(taskType);
      const userContent  = `User command: "${command}"

Respond ONLY with a valid JSON array of actions. No explanation.`;
      const text         = await callConnector(connector, systemPrompt, userContent);
      actions            = parseActions(text);
      if (actions) console.log(`   ✅ Connector response parsed: ${actions.length} actions`);
      else         console.log(`   ⚠️ Connector response invalid — falling back to local`);
    } catch (err) {
      console.error(`   ❌ Connector error: ${err.message} — falling back to local`);
      actions = null;
    }
  }

  // ── Fallback to local Ollama ──────────────────────────
  if (!actions) {
    const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;
    actions = await callLocalAI(command, screenshot, bestConfig, taskType);
  }

  if (!actions || actions.length === 0) {
    return { success:false, message:"Could not understand this command after 3 attempts. Please rephrase and try again." };
  }

  console.log(`   ${actions.length} actions planned`);
  const results = await executeActions(actions);

  const doneAction  = results.find(r => r.action?.action === "done");
  const errorAction = results.find(r => r.action?.action === "error");
  const success     = !errorAction && results.some(r => r.success);
  const message     = doneAction?.output || errorAction?.action?.message || "Task completed";

  extractLearnings(command, actions, success);
  const shouldCreate = shouldCreateSkill(command, actions, success);
  if (shouldCreate) {
    generateSkill(command, actions, { message, success });
    console.log(`⚡ Skill generated for: "${command}"`);
  }
  saveSession([{ command, success, message }], results);

  const browserShot = results.find(r => r.action?.action==="browser_screenshot" && r.output)?.output;
  const finalShot   = modelConfig.visionEnabled ? await takeScreenshot() : null;

  // Append drift notice if detected
  const pendingDrift = loadDriftState();
  let finalMessage = message;
  if (pendingDrift.pending?.length) {
    finalMessage = message + "\n\n---\n" + buildDriftMessage(pendingDrift.pending);
  }

  return { success, message: finalMessage, results, screenshot: browserShot || finalShot, taskType };
}

// ── Format briefing ───────────────────────────────────────
function formatBriefing(briefing) {
  if (!briefing) return "Could not generate briefing.";
  let msg = `☀️ **Good morning from ${briefing.agentName || "Vnus"}**\n\n${briefing.greeting}\n\n`;
  if (briefing.alerts?.length) {
    msg += `**🔔 Alerts:**\n`;
    briefing.alerts.forEach(a => {
      const icon = a.type==="warning"?"⚠️":a.type==="opportunity"?"🎯":"ℹ️";
      msg += `${icon} **${a.title}**\n${a.description}\n→ ${a.action}\n\n`;
    });
  }
  if (briefing.tasksForToday?.length) {
    msg += `**📋 Today's priorities:**\n`;
    briefing.tasksForToday.forEach((t,i) => { msg += `${i+1}. ${t.task}\n   ↳ ${t.reason}\n`; });
    msg += "\n";
  }
  if (briefing.strategicInsight) msg += `**💡 Strategic insight:**\n${briefing.strategicInsight}\n\n`;
  if (briefing.motivationalNote) msg += `*${briefing.motivationalNote}* 👹`;
  return msg;
}

function formatOpportunities(opps) {
  if (!opps?.length) return "No immediate opportunities found.";
  let msg = `🎯 **Opportunities found:**\n\n`;
  opps.forEach((o,i) => {
    msg += `**${i+1}. ${o.title}**\n${o.description}\n→ First step: *${o.firstStep}*\nImpact: ${o.impact} | Effort: ${o.effort}\n\n`;
  });
  return msg;
}

module.exports = { executeCommand, takeScreenshot, writeFile, setAgentContext };