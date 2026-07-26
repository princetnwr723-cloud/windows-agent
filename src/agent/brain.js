// src/agent/brain.js
// Agentic Vnus Brain — Memory + Skills + Self-Improving
// Har task ke baad agent seekhta hai — next time better karta hai

const { execSync }        = require("child_process");
const path                = require("path");
const fs                  = require("fs");
const os                  = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");
const {
  buildMemoryPrompt, extractLearnings,
  saveSession, initMemory,
} = require("./memory");
const {
  shouldCreateSkill, generateSkill,
  getSkillForCommand, getSkillsSummary,
} = require("./skills");
const {
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect, browserScroll,
  browserHover, browserExists, browserNewTab,
  browserEval, browserSmartLogin, initBrowser,
} = require("./browserAgent");
const {
  githubAuth, githubListRepos, githubListFiles, githubReadFile,
  githubWriteFile, githubDeleteFile, githubCreateRepo, githubCreateBranch,
  githubCreatePR, githubListIssues, githubCreateIssue, githubGetRepo,
  githubSearch, githubCloneLocally, githubCommitMultiple,
} = require("./githubAgent");

// Init memory on startup
initMemory();

// ── System Prompt (memory inject hogi) ───────────────────
function buildSystemPrompt() {
  const memoryContext = buildMemoryPrompt();
  const skillsContext = getSkillsSummary();

  return `You are Agentic Vnus, a self-improving AI agent running on the user's PC.
You learn from every task and get better over time.
CRITICAL: Respond ONLY with a valid JSON array. No markdown, no explanation, no \`\`\` blocks.

${memoryContext}
${skillsContext}

═══ AVAILABLE ACTIONS ═══

PC CONTROL:
{"action":"open","app":"chrome|firefox|vscode|terminal|explorer|notepad|calculator"}
{"action":"click","x":500,"y":300}
{"action":"type","text":"hello world"}
{"action":"key","key":"Enter|Tab|Escape|ctrl+s|ctrl+c|ctrl+v|ctrl+z|ctrl+a"}
{"action":"scroll","x":500,"y":300,"direction":"up|down","amount":3}
{"action":"wait","ms":1000}
{"action":"screenshot"}
{"action":"write_file","path":"C:/Users/USERNAME/Desktop/file.txt","content":"content"}
{"action":"read_file","path":"C:/Users/USERNAME/Desktop/file.txt"}
{"action":"run_command","command":"dir"}

BROWSER:
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

FLOW:
{"action":"done","message":"What was accomplished"}
{"action":"error","message":"Why it failed"}

═══ RULES ═══
1. Use USERNAME placeholder — it gets replaced with actual username automatically
2. Web tasks → use browser_* (more reliable)
3. Code writing → use write_file (never type character by character)
4. If a SKILL matches the task, follow its pattern
5. Use learned preferences from memory (preferred browser, save location etc)
6. Always end with done or error
7. RESPOND ONLY WITH JSON ARRAY — nothing else

═══ EXAMPLES ═══

"Open Chrome and search for AI news"
[
  {"action":"browser_goto","url":"https://www.google.com/search?q=AI+news"},
  {"action":"browser_wait","selector":"#search","state":"visible"},
  {"action":"done","message":"Searched Google for AI news"}
]

"Create a Python hello world on Desktop"
[
  {"action":"write_file","path":"C:/Users/USERNAME/Desktop/hello.py","content":"print('Hello World')\\nprint('Made by Agentic Vnus')"},
  {"action":"done","message":"Created hello.py on Desktop"}
]`;
}

// ── Screenshot ────────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size);$b.Save('${tmpPath.replace(/\\/g, "\\\\")}');$g.Dispose();$b.Dispose()`;
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

// ── Write file ────────────────────────────────────────────
async function writeFile(filePath, content) {
  const resolved = resolvePath(filePath);
  const dir      = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
  console.log(`✅ File written: ${resolved}`);
  return resolved;
}

// ── Read file ─────────────────────────────────────────────
function readFile(filePath) {
  try {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
    const content  = fs.readFileSync(resolved, "utf8");
    return content.length > 4000 ? content.slice(0, 4000) + "\n...(truncated)" : content;
  } catch (err) { return `Error: ${err.message}`; }
}

// ── Run command ───────────────────────────────────────────
async function runCommand(command) {
  const dangerous = ["rm -rf /", "format c:", "del /f /s /q c:\\"];
  if (dangerous.some(d => command.toLowerCase().includes(d))) {
    throw new Error("Command blocked for safety");
  }
  const out = execSync(command, { encoding: "utf8", shell: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  return out || "Done";
}

// ── Open app ──────────────────────────────────────────────
async function openApp(appName) {
  const p   = os.platform();
  const app = (appName || "").toLowerCase();
  const map = {
    chrome:     { win32: "start chrome",   darwin: "open -a 'Google Chrome'", linux: "google-chrome &" },
    firefox:    { win32: "start firefox",  darwin: "open -a Firefox",         linux: "firefox &" },
    vscode:     { win32: "code .",         darwin: "open -a 'Visual Studio Code'", linux: "code &" },
    terminal:   { win32: "start cmd",      darwin: "open -a Terminal",         linux: "x-terminal-emulator &" },
    explorer:   { win32: "explorer .",     darwin: "open .",                   linux: "nautilus . &" },
    notepad:    { win32: "notepad",        darwin: "open -a TextEdit",         linux: "gedit &" },
    calculator: { win32: "calc",           darwin: "open -a Calculator",       linux: "gnome-calculator &" },
  };
  const cmd = map[app]?.[p];
  if (cmd) execSync(cmd, { shell: true, stdio: "pipe" });
  else {
    if (p === "win32")       execSync(`start ${appName}`,          { shell: true, stdio: "pipe" });
    else if (p === "darwin") execSync(`open -a "${appName}"`,      { shell: true, stdio: "pipe" });
    else                     execSync(`${appName} &`,              { shell: true, stdio: "pipe" });
  }
}

// ── Mouse ─────────────────────────────────────────────────
async function mouseClick(x, y) {
  const p = os.platform();
  if (p === "win32") {
    const ps = `Add-Type @'
using System;using System.Runtime.InteropServices;
public class M{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int b,int e);}
'@;[M]::SetCursorPos(${x},${y});Start-Sleep -Milliseconds 80;[M]::mouse_event(2,0,0,0,0);[M]::mouse_event(4,0,0,0,0)`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ")}"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to click at {${x},${y}}'`, { stdio: "pipe" });
  } else {
    execSync(`xdotool mousemove ${x} ${y} click 1`, { stdio: "pipe" });
  }
}

// ── Type ──────────────────────────────────────────────────
async function typeText(text) {
  const p    = os.platform();
  const safe = text.replace(/'/g, "\\'");
  if (p === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::SetText('${safe.replace(/'/g, "''")}');[System.Windows.Forms.SendKeys]::SendWait('^v')`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`, { stdio: "pipe" });
  } else {
    execSync(`xdotool type --clearmodifiers '${safe}'`, { stdio: "pipe" });
  }
}

// ── Key ───────────────────────────────────────────────────
async function pressKey(key) {
  const p    = os.platform();
  const wMap = { "Enter":"{ENTER}","Tab":"{TAB}","Escape":"{ESC}","Backspace":"{BACKSPACE}","ctrl+s":"^s","ctrl+c":"^c","ctrl+v":"^v","ctrl+z":"^z","ctrl+a":"^a","ctrl+n":"^n" };
  if (p === "win32") {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${wMap[key] || key}')"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    if (key.includes("ctrl+")) {
      const k = key.replace("ctrl+","");
      execSync(`osascript -e 'tell application "System Events" to keystroke "${k}" using command down'`, { stdio: "pipe" });
    }
  } else {
    const xMap = { "Enter":"Return","Tab":"Tab","Escape":"Escape","ctrl+s":"ctrl+s","ctrl+c":"ctrl+c","ctrl+v":"ctrl+v" };
    execSync(`xdotool key ${xMap[key] || key}`, { stdio: "pipe" });
  }
}

// ── Scroll ────────────────────────────────────────────────
async function scrollPage(x, y, direction, amount = 3) {
  const p = os.platform();
  if (p === "win32") {
    const delta = direction === "up" ? amount * 120 : -amount * 120;
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})"`, { stdio: "pipe" });
    await new Promise(r => setTimeout(r, 100));
    execSync(`powershell -NoProfile -Command "Add-Type @'\\nusing System.Runtime.InteropServices;\\npublic class S{[DllImport(\\"user32.dll\\")]public static extern void mouse_event(int f,int dx,int dy,int d,int e);}\\n'@;[S]::mouse_event(0x0800,0,0,${delta},0)"`, { stdio: "pipe" });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to scroll (get mouse location) by {0, ${direction === "up" ? -amount*3 : amount*3}00}'`, { stdio: "pipe" });
  } else {
    const btn = direction === "up" ? 4 : 5;
    for (let i = 0; i < amount; i++) execSync(`xdotool click ${btn}`, { stdio: "pipe" });
  }
}

// ── Resolve paths ─────────────────────────────────────────
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

// ── Parse AI response ─────────────────────────────────────
function parseActions(text) {
  if (!text) return null;
  let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const actions = JSON.parse(clean.slice(start, end + 1));
    return Array.isArray(actions) ? actions : null;
  } catch { return null; }
}

// ── Call AI with memory-enriched prompt ───────────────────
async function callLocalAI(command, screenshotBase64, modelConfig) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const username = os.userInfo().username;

  const userContent = `Task: "${command}"

System: ${os.platform() === "win32" ? "Windows" : os.platform() === "darwin" ? "macOS" : "Linux"}
Username: ${username}
Desktop: ${path.join(os.homedir(), "Desktop")}
Home: ${os.homedir()}

Respond with ONLY a JSON array of actions.`;

  try {
    const systemPrompt = buildSystemPrompt();
    let text = "";

    if (visionEnabled && visionOllamaId && screenshotBase64) {
      text = await runOllamaVision(visionOllamaId, systemPrompt, `Screen shown above.\n${userContent}`, screenshotBase64);
    } else {
      text = await runOllamaPrompt(ollamaId, systemPrompt, userContent);
    }

    console.log("AI response preview:", text.slice(0, 150));
    return parseActions(text);
  } catch (err) {
    console.error("AI error:", err.message);
    return null;
  }
}

// ── Execute all actions ───────────────────────────────────
async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    const name = action.action;
    console.log(`▶ ${name}${action.url ? " → " + action.url : action.app ? " → " + action.app : action.path ? " → " + action.path : ""}`);

    try {
      let output = null;

      if      (name === "done" || name === "error") { results.push({ success: true, action, output: action.message }); break; }
      else if (name === "open")                      await openApp(action.app);
      else if (name === "click")                     await mouseClick(action.x, action.y);
      else if (name === "type")                      await typeText(action.text);
      else if (name === "key")                       await pressKey(action.key);
      else if (name === "wait")                      await new Promise(r => setTimeout(r, Math.min(action.ms || 500, 10000)));
      else if (name === "scroll")                    await scrollPage(action.x || 500, action.y || 300, action.direction, action.amount);
      else if (name === "screenshot")                output = await takeScreenshot();
      else if (name === "write_file")                output = await writeFile(action.path, action.content);
      else if (name === "read_file")                 output = readFile(action.path);
      else if (name === "run_command")               output = await runCommand(action.command);
      else if (name === "browser_goto")              output = await browserGoto(action.url, action.waitUntil);
      else if (name === "browser_click")             await browserClick(action.selector, action.options);
      else if (name === "browser_type")              await browserType(action.selector, action.text, action.clear);
      else if (name === "browser_fill")              await browserFill(action.selector, action.text);
      else if (name === "browser_wait")              await browserWait(action.selector, action.state, action.timeout);
      else if (name === "browser_extract")           output = await browserExtract(action.selector, action.what);
      else if (name === "browser_extract_table")     output = await browserExtractTable(action.selector);
      else if (name === "browser_screenshot")        output = await browserScreenshot(action.selector);
      else if (name === "browser_key")               await browserKey(action.key);
      else if (name === "browser_select")            await browserSelect(action.selector, action.value);
      else if (name === "browser_scroll")            await browserScroll(action.direction, action.amount);
      else if (name === "browser_hover")             await browserHover(action.selector);
      else if (name === "browser_exists")            output = await browserExists(action.selector, action.timeout);
      else if (name === "browser_eval")              output = await browserEval(action.script);
      else if (name === "browser_new_tab")           await browserNewTab(action.url);
      else if (name === "browser_login")             await browserSmartLogin(action.site, action.username, action.password);
      else if (name === "github_auth")               output = await githubAuth(action.token);
      else if (name === "github_list_repos")         output = await githubListRepos();
      else if (name === "github_list_files")         output = await githubListFiles(action.owner, action.repo, action.path || "");
      else if (name === "github_read_file")          output = await githubReadFile(action.owner, action.repo, action.path, action.branch);
      else if (name === "github_write_file")         output = await githubWriteFile(action.owner, action.repo, action.path, action.content, action.message, action.branch);
      else if (name === "github_create_repo")        output = await githubCreateRepo(action.name, action.description, action.private);
      else if (name === "github_create_branch")      output = await githubCreateBranch(action.owner, action.repo, action.branch, action.from);
      else if (name === "github_create_pr")          output = await githubCreatePR(action.owner, action.repo, action.title, action.body, action.head, action.base);
      else if (name === "github_list_issues")        output = await githubListIssues(action.owner, action.repo, action.state);
      else if (name === "github_create_issue")       output = await githubCreateIssue(action.owner, action.repo, action.title, action.body, action.labels);
      else if (name === "github_search")             output = await githubSearch(action.query, action.owner, action.repo);
      else if (name === "github_clone")              output = await githubCloneLocally(action.owner, action.repo, action.target);
      else if (name === "github_commit_multiple")    output = await githubCommitMultiple(action.owner, action.repo, action.files, action.message, action.branch);
      else console.warn(`⚠️ Unknown action: ${name}`);

      results.push({ success: true, action, output });

      const noDelay = ["write_file","read_file","github_read_file","github_write_file","wait"];
      if (!noDelay.includes(name)) await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`❌ ${name}: ${err.message}`);
      results.push({ success: false, action, error: err.message });
    }
  }
  return results;
}

// ── Main execute — with memory + skills ───────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\n🎯 Command: "${command}"`);

  // Check if a skill exists for this command
  const existingSkill = getSkillForCommand(command);
  if (existingSkill) {
    console.log(`⚡ Skill match found: ${existingSkill.name}`);
  }

  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;
  const actions    = await callLocalAI(command, screenshot, modelConfig);

  if (!actions || actions.length === 0) {
    return { success: false, message: "Could not understand the command. Please rephrase." };
  }

  console.log(`   ${actions.length} actions planned`);
  const results = await executeActions(actions);

  const doneAction  = results.find(r => r.action?.action === "done");
  const errorAction = results.find(r => r.action?.action === "error");
  const success     = !errorAction;
  const message     = doneAction?.output || errorAction?.action?.message || "Task completed";

  // ── Memory: learn from this task ─────────────────────────
  extractLearnings(command, actions, success);

  // ── Skills: auto-generate if pattern detected ─────────────
  const shouldCreate = shouldCreateSkill(command, actions, success);
  if (shouldCreate) {
    generateSkill(command, actions, { message, success });
    console.log(`⚡ Skill auto-generated for: "${command}"`);
  }

  // ── Session history save ───────────────────────────────────
  saveSession(
    [{ command, success, message }],
    results
  );

  const browserShot = results.find(r => r.action?.action === "browser_screenshot" && r.output)?.output;
  const finalShot   = modelConfig.visionEnabled ? await takeScreenshot() : null;

  return {
    success,
    message,
    results,
    screenshot: browserShot || finalShot,
    skillGenerated: !!shouldCreate,
  };
}

module.exports = { executeCommand, takeScreenshot, writeFile };