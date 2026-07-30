// src/agent/brain.js — Upgraded
// ✅ JSON retry loop (3 attempts)
// ✅ Permission system for dangerous actions
// ✅ Skill self-healing on failure
// ✅ Better error messages

const { execSync }        = require("child_process");
const path                = require("path");
const fs                  = require("fs");
const os                  = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");
const { buildMemoryPrompt, extractLearnings, saveSession, initMemory } = require("./memory");
const { shouldCreateSkill, generateSkill, getSkillForCommand, getSkillsSummary, deleteSkill } = require("./skills");
const { checkAndRequestPermission, assessCommandRisk, assessFileRisk } = require("./permissions");
const {
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect, browserScroll,
  browserHover, browserExists, browserNewTab, browserEval,
  browserSmartLogin,
} = require("./browserAgent");
const {
  githubAuth, githubListRepos, githubListFiles, githubReadFile,
  githubWriteFile, githubDeleteFile, githubCreateRepo, githubCreateBranch,
  githubCreatePR, githubListIssues, githubCreateIssue, githubGetRepo,
  githubSearch, githubCloneLocally, githubCommitMultiple,
} = require("./githubAgent");

initMemory();

// ── Global context (set per command) ─────────────────────
let _workspaceId    = null;
let _firebaseConfig = null;
let _chatContext    = {};

function setAgentContext(workspaceId, firebaseConfig, chatContext = {}) {
  _workspaceId    = workspaceId;
  _firebaseConfig = firebaseConfig;
  _chatContext    = chatContext;
}

// ── System Prompt ─────────────────────────────────────────
function buildSystemPrompt() {
  const memoryContext = buildMemoryPrompt();
  const skillsContext = getSkillsSummary();

  return `You are Agentic Vnus, a self-improving AI agent running on the user's PC.
CRITICAL: Respond ONLY with a valid JSON array. No markdown, no explanation, no \`\`\` blocks. Pure JSON only.

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
{"action":"write_file","path":"C:/Users/USERNAME/Desktop/file.txt","content":"content here"}
{"action":"read_file","path":"C:/Users/USERNAME/Desktop/file.txt"}
{"action":"run_command","command":"dir C:\\Users\\USERNAME\\Desktop"}

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
1. USERNAME placeholder auto-replaced with actual username
2. Web tasks → use browser_* (more reliable than click/type)
3. Writing code → write_file (never type character by character)
4. Always end with done or error
5. ONLY JSON ARRAY — no other text at all`;
}

// ── Screenshot ────────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size);$b.Save('${tmpPath.replace(/\\/g,"\\\\")});$g.Dispose();$b.Dispose()`;
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

// ── Run command with permission check ────────────────────
async function runCommand(command) {
  // Check risk
  const risk = assessCommandRisk(command);

  if (risk.level === "blocked") {
    throw new Error(`🚫 Blocked: ${risk.reason}`);
  }

  // High/medium risk → ask permission
  if ((risk.level === "high" || risk.level === "medium") && _workspaceId && _firebaseConfig) {
    const perm = await checkAndRequestPermission(
      "run_command",
      { command },
      _workspaceId,
      _firebaseConfig,
      _chatContext
    );

    if (!perm.allowed) {
      throw new Error(
        perm.reason === "timeout"
          ? "⏰ Command timed out waiting for permission. Please approve in workspace."
          : "❌ User denied permission for this command."
      );
    }
  }

  const out = execSync(command, {
    encoding:  "utf8",
    shell:     true,
    timeout:   60000,
    maxBuffer: 1024 * 1024,
  });
  return out || "Command completed successfully";
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
    if (p === "win32")       execSync(`start ${appName}`,        { shell: true, stdio: "pipe" });
    else if (p === "darwin") execSync(`open -a "${appName}"`,    { shell: true, stdio: "pipe" });
    else                     execSync(`${appName} &`,            { shell: true, stdio: "pipe" });
  }
}

// ── Mouse click ───────────────────────────────────────────
async function mouseClick(x, y) {
  const p = os.platform();
  if (p === "win32") {
    const ps = `Add-Type @'
using System;using System.Runtime.InteropServices;
public class M{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int b,int e);}
'@;[M]::SetCursorPos(${x},${y});Start-Sleep -Milliseconds 80;[M]::mouse_event(2,0,0,0,0);[M]::mouse_event(4,0,0,0,0)`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g," ")}"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to click at {${x},${y}}'`, { stdio: "pipe" });
  } else {
    execSync(`xdotool mousemove ${x} ${y} click 1`, { stdio: "pipe" });
  }
}

// ── Type text ─────────────────────────────────────────────
async function typeText(text) {
  const p    = os.platform();
  const safe = text.replace(/'/g, "\\'");
  if (p === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::SetText('${safe.replace(/'/g,"''")}');[System.Windows.Forms.SendKeys]::SendWait('^v')`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`, { stdio: "pipe" });
  } else {
    execSync(`xdotool type --clearmodifiers '${safe}'`, { stdio: "pipe" });
  }
}

// ── Press key ─────────────────────────────────────────────
async function pressKey(key) {
  const p    = os.platform();
  const wMap = { "Enter":"{ENTER}","Tab":"{TAB}","Escape":"{ESC}","Backspace":"{BACKSPACE}","ctrl+s":"^s","ctrl+c":"^c","ctrl+v":"^v","ctrl+z":"^z","ctrl+a":"^a","ctrl+n":"^n" };
  if (p === "win32") {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${wMap[key]||key}')"`, { stdio:"pipe", timeout:5000 });
  } else if (p === "darwin") {
    if (key.includes("ctrl+")) {
      execSync(`osascript -e 'tell application "System Events" to keystroke "${key.replace("ctrl+","")}" using command down'`, { stdio:"pipe" });
    }
  } else {
    const xMap = { "Enter":"Return","Tab":"Tab","Escape":"Escape","ctrl+s":"ctrl+s","ctrl+c":"ctrl+c","ctrl+v":"ctrl+v" };
    execSync(`xdotool key ${xMap[key]||key}`, { stdio:"pipe" });
  }
}

// ── Scroll ────────────────────────────────────────────────
async function scrollPage(x, y, direction, amount = 3) {
  const p = os.platform();
  if (p === "win32") {
    const delta = direction === "up" ? amount*120 : -amount*120;
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})"`, { stdio:"pipe" });
    await new Promise(r => setTimeout(r, 100));
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to scroll (get mouse location) by {0, ${direction==="up"?-amount*3:amount*3}00}'`, { stdio:"pipe" });
  } else {
    const btn = direction === "up" ? 4 : 5;
    for (let i = 0; i < amount; i++) execSync(`xdotool click ${btn}`, { stdio:"pipe" });
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

// ── JSON Schema Validation ────────────────────────────────
function validateActions(actions) {
  if (!Array.isArray(actions)) return { valid: false, error: "Response is not a JSON array" };
  if (actions.length === 0)    return { valid: false, error: "Empty actions array" };

  for (const action of actions) {
    if (typeof action !== "object" || !action.action) {
      return { valid: false, error: `Invalid action object: ${JSON.stringify(action)}` };
    }
    const name = action.action;

    // Validate required fields
    if (name === "write_file" && (!action.path || action.content === undefined)) {
      return { valid: false, error: "write_file missing path or content" };
    }
    if (name === "run_command" && !action.command) {
      return { valid: false, error: "run_command missing command field" };
    }
    if (name === "browser_goto" && !action.url) {
      return { valid: false, error: "browser_goto missing url" };
    }
    if (name === "click" && (action.x === undefined || action.y === undefined)) {
      return { valid: false, error: "click missing x or y" };
    }
  }
  return { valid: true };
}

// ── Parse AI response with retry ─────────────────────────
function parseActions(text) {
  if (!text) return null;
  let clean = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Find JSON array boundaries
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start === -1 || end === -1) return null;

  try {
    const actions = JSON.parse(clean.slice(start, end + 1));
    return Array.isArray(actions) ? actions : null;
  } catch {
    // Try to fix common JSON errors
    try {
      const fixed = clean.slice(start, end + 1)
        .replace(/,\s*]/g, "]")      // trailing comma in array
        .replace(/,\s*}/g, "}")      // trailing comma in object
        .replace(/(['"])?([a-zA-Z_][a-zA-Z0-9_]*)(['"])?:/g, '"$2":'); // unquoted keys
      const actions = JSON.parse(fixed);
      return Array.isArray(actions) ? actions : null;
    } catch { return null; }
  }
}

// ── Call AI with retry loop ───────────────────────────────
async function callLocalAI(command, screenshotBase64, modelConfig, retryCount = 0) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const username = os.userInfo().username;
  const MAX_RETRIES = 3;

  // Build retry context
  let retryNote = "";
  if (retryCount > 0) {
    retryNote = `\n⚠️ RETRY ATTEMPT ${retryCount}/${MAX_RETRIES}: Previous response was not valid JSON. You MUST respond with ONLY a JSON array. No explanation, no markdown, no text before or after the array.`;
  }

  const userContent = `Task: "${command}"

System: ${os.platform() === "win32" ? "Windows" : os.platform() === "darwin" ? "macOS" : "Linux"}
Username: ${username}
Desktop: ${path.join(os.homedir(), "Desktop")}
Home: ${os.homedir()}
${retryNote}

Respond with ONLY a valid JSON array of actions. Start with [ and end with ].`;

  try {
    const systemPrompt = buildSystemPrompt();
    let text = "";

    if (visionEnabled && visionOllamaId && screenshotBase64) {
      text = await runOllamaVision(visionOllamaId, systemPrompt, `Screen shown above.\n${userContent}`, screenshotBase64);
    } else {
      text = await runOllamaPrompt(ollamaId, systemPrompt, userContent);
    }

    console.log(`AI response (attempt ${retryCount + 1}):`, text.slice(0, 150));

    const actions = parseActions(text);

    // Validate
    if (!actions) {
      if (retryCount < MAX_RETRIES) {
        console.warn(`⚠️ Invalid JSON on attempt ${retryCount + 1}, retrying...`);
        await new Promise(r => setTimeout(r, 1000));
        return callLocalAI(command, screenshotBase64, modelConfig, retryCount + 1);
      }
      console.error("❌ All retries failed — could not get valid JSON");
      return null;
    }

    const validation = validateActions(actions);
    if (!validation.valid) {
      if (retryCount < MAX_RETRIES) {
        console.warn(`⚠️ Schema validation failed: ${validation.error}, retrying...`);
        await new Promise(r => setTimeout(r, 1000));
        return callLocalAI(command, screenshotBase64, modelConfig, retryCount + 1);
      }
      return null;
    }

    if (retryCount > 0) {
      console.log(`✅ Got valid JSON on retry ${retryCount}`);
    }

    return actions;

  } catch (err) {
    console.error("AI call error:", err.message);
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000));
      return callLocalAI(command, screenshotBase64, modelConfig, retryCount + 1);
    }
    return null;
  }
}

// ── Execute actions with permission checks ────────────────
async function executeActions(actions, skillId = null) {
  const results = [];

  for (const action of actions) {
    const name = action.action;
    console.log(`▶ ${name}${action.url?" → "+action.url:action.app?" → "+action.app:action.path?" → "+action.path:""}`);

    try {
      let output = null;

      // Flow control
      if (name === "done" || name === "error") {
        results.push({ success: true, action, output: action.message });
        break;
      }

      // ── Permission check for dangerous actions ────────────
      if ((name === "run_command" || name === "write_file" || name === "github_delete_file" || name === "github_write_file") && _workspaceId && _firebaseConfig) {
        const perm = await checkAndRequestPermission(
          name,
          { command: action.command, path: action.path },
          _workspaceId,
          _firebaseConfig,
          _chatContext
        );

        if (perm.blocked) {
          results.push({ success: false, action, error: `🚫 Blocked: ${perm.reason}` });
          continue;
        }

        if (!perm.allowed && name !== "write_file") {
          // For write_file low risk — allow without permission
          results.push({ success: false, action, error: perm.reason === "timeout" ? "⏰ Permission timeout" : "❌ Permission denied by user" });
          continue;
        }
      }

      // ── Execute ───────────────────────────────────────────
      if      (name === "open")         await openApp(action.app);
      else if (name === "click")        await mouseClick(action.x, action.y);
      else if (name === "type")         await typeText(action.text);
      else if (name === "key")          await pressKey(action.key);
      else if (name === "wait")         await new Promise(r => setTimeout(r, Math.min(action.ms||500, 10000)));
      else if (name === "scroll")       await scrollPage(action.x||500, action.y||300, action.direction, action.amount);
      else if (name === "screenshot")   output = await takeScreenshot();
      else if (name === "write_file")   output = await writeFile(action.path, action.content);
      else if (name === "read_file")    output = readFile(action.path);
      else if (name === "run_command")  output = await runCommand(action.command);
      else if (name === "browser_goto")          output = await browserGoto(action.url, action.waitUntil);
      else if (name === "browser_click")         await browserClick(action.selector, action.options);
      else if (name === "browser_type")          await browserType(action.selector, action.text, action.clear);
      else if (name === "browser_fill")          await browserFill(action.selector, action.text);
      else if (name === "browser_wait")          await browserWait(action.selector, action.state, action.timeout);
      else if (name === "browser_extract")       output = await browserExtract(action.selector, action.what);
      else if (name === "browser_extract_table") output = await browserExtractTable(action.selector);
      else if (name === "browser_screenshot")    output = await browserScreenshot(action.selector);
      else if (name === "browser_key")           await browserKey(action.key);
      else if (name === "browser_select")        await browserSelect(action.selector, action.value);
      else if (name === "browser_scroll")        await browserScroll(action.direction, action.amount);
      else if (name === "browser_hover")         await browserHover(action.selector);
      else if (name === "browser_exists")        output = await browserExists(action.selector, action.timeout);
      else if (name === "browser_eval")          output = await browserEval(action.script);
      else if (name === "browser_new_tab")       await browserNewTab(action.url);
      else if (name === "browser_login")         await browserSmartLogin(action.site, action.username, action.password);
      else if (name === "github_auth")           output = await githubAuth(action.token);
      else if (name === "github_list_repos")     output = await githubListRepos();
      else if (name === "github_list_files")     output = await githubListFiles(action.owner, action.repo, action.path||"");
      else if (name === "github_read_file")      output = await githubReadFile(action.owner, action.repo, action.path, action.branch);
      else if (name === "github_write_file")     output = await githubWriteFile(action.owner, action.repo, action.path, action.content, action.message, action.branch);
      else if (name === "github_delete_file")    output = await githubDeleteFile(action.owner, action.repo, action.path, action.message);
      else if (name === "github_create_repo")    output = await githubCreateRepo(action.name, action.description, action.private);
      else if (name === "github_create_branch")  output = await githubCreateBranch(action.owner, action.repo, action.branch, action.from);
      else if (name === "github_create_pr")      output = await githubCreatePR(action.owner, action.repo, action.title, action.body, action.head, action.base);
      else if (name === "github_list_issues")    output = await githubListIssues(action.owner, action.repo, action.state);
      else if (name === "github_create_issue")   output = await githubCreateIssue(action.owner, action.repo, action.title, action.body, action.labels);
      else if (name === "github_search")         output = await githubSearch(action.query, action.owner, action.repo);
      else if (name === "github_clone")          output = await githubCloneLocally(action.owner, action.repo, action.target);
      else if (name === "github_commit_multiple") output = await githubCommitMultiple(action.owner, action.repo, action.files, action.message, action.branch);
      else console.warn(`⚠️ Unknown action: ${name}`);

      results.push({ success: true, action, output });

      const noDelay = ["write_file","read_file","github_read_file","github_write_file","wait"];
      if (!noDelay.includes(name)) await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`❌ ${name}: ${err.message}`);
      results.push({ success: false, action, error: err.message });

      // ── Skill self-healing ────────────────────────────────
      // If a skill action failed, mark skill as stale so it gets regenerated
      if (skillId && (name.startsWith("browser_") || name === "run_command")) {
        console.warn(`⚠️ Skill action failed — marking skill ${skillId} as stale`);
        try {
          const { SKILLS_DIR } = require("./memory");
          const skillFile = path.join(SKILLS_DIR, `${skillId}.json`);
          if (fs.existsSync(skillFile)) {
            const skill = JSON.parse(fs.readFileSync(skillFile, "utf8"));
            skill.failCount = (skill.failCount || 0) + 1;
            skill.stale     = skill.failCount >= 2; // stale after 2 failures
            fs.writeFileSync(skillFile, JSON.stringify(skill, null, 2));
            console.warn(`⚠️ Skill fail count: ${skill.failCount}${skill.stale ? " — marked stale" : ""}`);
          }
        } catch {}
      }
    }
  }
  return results;
}

// ── Main execute ──────────────────────────────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\n🎯 Command: "${command}"`);

  // Check for existing skill
  const existingSkill = getSkillForCommand(command);
  let   usedSkillId   = null;

  if (existingSkill && !existingSkill.stale) {
    console.log(`⚡ Skill match: ${existingSkill.name} (used ${existingSkill.successCount}x)`);
    usedSkillId = existingSkill.id;
  }

  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;
  const actions    = await callLocalAI(command, screenshot, modelConfig);

  if (!actions || actions.length === 0) {
    return {
      success: false,
      message: "Could not understand the command after 3 attempts. Please rephrase and try again.",
    };
  }

  console.log(`   ${actions.length} actions planned`);
  const results = await executeActions(actions, usedSkillId);

  const doneAction  = results.find(r => r.action?.action === "done");
  const errorAction = results.find(r => r.action?.action === "error");
  const success     = !errorAction && results.some(r => r.success);
  const message     = doneAction?.output || errorAction?.action?.message || "Task completed";

  // ── Self-healing: if skill was stale, re-run with LLM and update ──
  if (usedSkillId && existingSkill?.stale) {
    console.log(`🔄 Skill stale — updating with fresh execution pattern`);
    if (success) {
      generateSkill(command, actions, { message, success });
    }
  }

  // ── Learn from this task ──────────────────────────────────
  extractLearnings(command, actions, success);

  // ── Auto-generate skill if pattern detected ───────────────
  const shouldCreate = shouldCreateSkill(command, actions, success);
  if (shouldCreate && !existingSkill) {
    generateSkill(command, actions, { message, success });
    console.log(`⚡ New skill generated for: "${command}"`);
  }

  // ── Save session ──────────────────────────────────────────
  saveSession([{ command, success, message }], results);

  const browserShot = results.find(r => r.action?.action === "browser_screenshot" && r.output)?.output;
  const finalShot   = modelConfig.visionEnabled ? await takeScreenshot() : null;

  return {
    success,
    message,
    results,
    screenshot:    browserShot || finalShot,
    skillUsed:     usedSkillId,
    skillGenerated: !!shouldCreate,
  };
}

module.exports = { executeCommand, takeScreenshot, writeFile, setAgentContext };