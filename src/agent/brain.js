// src/agent/brain.js
// Agentic Vnus Brain — Fixed JSON parsing, safe execution, proper error handling

const { execSync }        = require("child_process");
const path                = require("path");
const fs                  = require("fs");
const os                  = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");
const {
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect, browserScroll,
  browserGetInfo, browserHover, browserExists, browserNewTab,
  browserEval, browserSmartLogin, initBrowser,
} = require("./browserAgent");
const {
  githubAuth, githubListRepos, githubListFiles, githubReadFile,
  githubWriteFile, githubDeleteFile, githubCreateRepo, githubCreateBranch,
  githubCreatePR, githubListIssues, githubCreateIssue, githubGetRepo,
  githubSearch, githubCloneLocally, githubCommitMultiple,
} = require("./githubAgent");

// ── System Prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are Agentic Vnus, an AI agent running on the user's PC.
You control everything through a JSON array of actions.
CRITICAL: Respond ONLY with a valid JSON array. No markdown, no explanation, no \`\`\` blocks.

═══ AVAILABLE ACTIONS ═══

PC CONTROL:
{"action":"open","app":"chrome|firefox|vscode|terminal|explorer|notepad|calculator"}
{"action":"click","x":500,"y":300}
{"action":"type","text":"hello world"}
{"action":"key","key":"Enter|Tab|Escape|ctrl+s|ctrl+c|ctrl+v|ctrl+z|ctrl+a|ctrl+n|win+d"}
{"action":"scroll","x":500,"y":300,"direction":"up|down","amount":3}
{"action":"wait","ms":1000}
{"action":"screenshot"}
{"action":"write_file","path":"C:/Users/USERNAME/Desktop/file.txt","content":"file content here"}
{"action":"read_file","path":"C:/Users/USERNAME/Desktop/file.txt"}
{"action":"run_command","command":"dir C:\\Users\\USERNAME\\Desktop"}

BROWSER (use these for web tasks — more reliable):
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
{"action":"github_write_file","owner":"user","repo":"repo","path":"file.js","content":"...","message":"commit msg"}
{"action":"github_create_repo","name":"my-repo","description":"...","private":false}

FLOW:
{"action":"done","message":"What was accomplished"}
{"action":"error","message":"Why it failed"}

═══ RULES ═══
1. Windows paths use forward slashes: C:/Users/username/Desktop/file.txt
2. For file operations, use USERNAME from the system (will be provided)
3. Web tasks → use browser_* actions (faster and more reliable)
4. Code writing → use write_file (never type long code character by character)
5. Always end with "done" or "error"
6. Keep actions minimal — don't add unnecessary waits
7. RESPOND ONLY WITH JSON ARRAY — no other text whatsoever

═══ EXAMPLES ═══

"Open Notepad and write hello world"
[
  {"action":"open","app":"notepad"},
  {"action":"wait","ms":1500},
  {"action":"type","text":"hello world"},
  {"action":"done","message":"Opened Notepad and typed hello world"}
]

"Search Google for AI news"
[
  {"action":"browser_goto","url":"https://www.google.com/search?q=AI+news"},
  {"action":"browser_wait","selector":"#search","state":"visible"},
  {"action":"browser_extract","selector":"#search","what":"text"},
  {"action":"done","message":"Searched Google for AI news"}
]

"Create a Python script on Desktop"
[
  {"action":"write_file","path":"C:/Users/USER/Desktop/script.py","content":"print('Hello World')"},
  {"action":"done","message":"Created Python script on Desktop"}
]`;

// ── Screenshot ─────────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size);$b.Save('${tmpPath.replace(/\\/g, "\\\\")}');$g.Dispose();$b.Dispose()`.replace(/\n/g, " ");
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
  } catch (err) {
    console.error("Screenshot error:", err.message);
    return null;
  }
}

// ── Write file ─────────────────────────────────────────────
async function writeFile(filePath, content) {
  const resolved = resolvePath(filePath);
  const dir      = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
  console.log(`✅ File written: ${resolved}`);
  return resolved;
}

// ── Read file ──────────────────────────────────────────────
function readFile(filePath) {
  try {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${resolved}`;
    const content  = fs.readFileSync(resolved, "utf8");
    // Limit to 4000 chars to avoid context overflow
    return content.length > 4000 ? content.slice(0, 4000) + "\n... (truncated)" : content;
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

// ── Run command (with safety checks) ──────────────────────
async function runCommand(command) {
  // Block dangerous commands
  const dangerous = ["rm -rf /", "format c:", "del /f /s /q c:\\", "rd /s /q c:\\"];
  const cmdLower  = command.toLowerCase();
  if (dangerous.some(d => cmdLower.includes(d))) {
    throw new Error("Command blocked for safety");
  }

  try {
    const out = execSync(command, {
      encoding: "utf8",
      shell:    true,
      timeout:  60000,
      maxBuffer: 1024 * 1024, // 1MB
    });
    console.log(`✅ Command ran: ${command.slice(0, 60)}`);
    return out || "Command completed successfully";
  } catch (err) {
    throw new Error(`Command failed: ${err.message}`);
  }
}

// ── Open app ──────────────────────────────────────────────
async function openApp(appName) {
  const p   = os.platform();
  const app = (appName || "").toLowerCase();
  const map = {
    chrome:      { win32: "start chrome",        darwin: "open -a 'Google Chrome'",      linux: "google-chrome &" },
    firefox:     { win32: "start firefox",       darwin: "open -a Firefox",              linux: "firefox &" },
    vscode:      { win32: "code .",              darwin: "open -a 'Visual Studio Code'", linux: "code &" },
    terminal:    { win32: "start cmd",           darwin: "open -a Terminal",             linux: "x-terminal-emulator &" },
    explorer:    { win32: "explorer .",          darwin: "open .",                       linux: "nautilus . &" },
    notepad:     { win32: "notepad",             darwin: "open -a TextEdit",             linux: "gedit &" },
    calculator:  { win32: "calc",               darwin: "open -a Calculator",           linux: "gnome-calculator &" },
    settings:    { win32: "start ms-settings:",  darwin: "open -a 'System Preferences'", linux: "gnome-control-center &" },
  };

  const cmd = map[app]?.[p];
  if (cmd) {
    execSync(cmd, { shell: true, stdio: "pipe" });
  } else {
    if (p === "win32")       execSync(`start ${appName}`,             { shell: true, stdio: "pipe" });
    else if (p === "darwin") execSync(`open -a "${appName}"`,         { shell: true, stdio: "pipe" });
    else                     execSync(`${appName} &`,                 { shell: true, stdio: "pipe" });
  }
  console.log(`✅ Opened: ${appName}`);
}

// ── Mouse click ───────────────────────────────────────────
async function mouseClick(x, y) {
  const p = os.platform();
  if (p === "win32") {
    const ps = `Add-Type @'
using System;using System.Runtime.InteropServices;
public class Mouse{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int b,int e);}
'@;[Mouse]::SetCursorPos(${x},${y});Start-Sleep -Milliseconds 100;[Mouse]::mouse_event(2,0,0,0,0);[Mouse]::mouse_event(4,0,0,0,0)`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/\n/g, " ")}"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to click at {${x},${y}}'`, { stdio: "pipe" });
  } else {
    execSync(`xdotool mousemove ${x} ${y} click 1`, { stdio: "pipe" });
  }
}

// ── Type text ─────────────────────────────────────────────
async function typeText(text) {
  const p    = os.platform();
  // Escape special chars
  const safe = text.replace(/[\\"]/g, "\\$&");
  if (p === "win32") {
    // Use clipboard for reliability
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::SetText('${safe.replace(/'/g, "''")}');[System.Windows.Forms.SendKeys]::SendWait('^v')`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`, { stdio: "pipe" });
  } else {
    execSync(`xdotool type --clearmodifiers '${safe}'`, { stdio: "pipe" });
  }
}

// ── Press key ─────────────────────────────────────────────
async function pressKey(key) {
  const p    = os.platform();
  const wMap: Record<string, string> = {
    "Enter": "{ENTER}", "Tab": "{TAB}", "Escape": "{ESC}",
    "Backspace": "{BACKSPACE}", "Delete": "{DEL}", "Space": " ",
    "ctrl+s": "^s", "ctrl+c": "^c", "ctrl+v": "^v", "ctrl+z": "^z",
    "ctrl+a": "^a", "ctrl+n": "^n", "ctrl+w": "^w", "ctrl+t": "^t",
    "win+d":  "^{ESC}", // approximate
  };
  if (p === "win32") {
    const mapped = wMap[key] || key;
    execSync(`powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${mapped}')"`, { stdio: "pipe", timeout: 5000 });
  } else if (p === "darwin") {
    if (key.includes("ctrl+") || key.includes("cmd+")) {
      const k = key.replace(/ctrl\+|cmd\+/, "");
      execSync(`osascript -e 'tell application "System Events" to keystroke "${k}" using command down'`, { stdio: "pipe" });
    } else {
      execSync(`osascript -e 'tell application "System Events" to key code 36'`, { stdio: "pipe" }); // Enter fallback
    }
  } else {
    const xMap: Record<string, string> = {
      "ctrl+s": "ctrl+s", "ctrl+c": "ctrl+c", "ctrl+v": "ctrl+v",
      "Enter": "Return", "Tab": "Tab", "Escape": "Escape",
    };
    execSync(`xdotool key ${xMap[key] || key}`, { stdio: "pipe" });
  }
}

// ── Scroll ────────────────────────────────────────────────
async function scrollPage(x, y, direction, amount = 3) {
  const p = os.platform();
  if (p === "win32") {
    const delta = direction === "up" ? amount * 120 : -amount * 120;
    const ps    = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe" });
    await new Promise(r => setTimeout(r, 100));
    execSync(`powershell -NoProfile -Command "Add-Type @'using System.Runtime.InteropServices;public class W{[DllImport(\"user32.dll\")]public static extern void mouse_event(int f,int dx,int dy,int d,int e);}'@;[W]::mouse_event(0x0800,0,0,${delta},0)"`, { stdio: "pipe" });
  } else if (p === "darwin") {
    const d = direction === "up" ? -amount : amount;
    execSync(`osascript -e 'tell application "System Events" to scroll (get mouse location) by {0, ${d * 100}}'`, { stdio: "pipe" });
  } else {
    const btn = direction === "up" ? 4 : 5;
    for (let i = 0; i < amount; i++) {
      execSync(`xdotool mousemove ${x} ${y} click ${btn}`, { stdio: "pipe" });
    }
  }
}

// ── Resolve paths ──────────────────────────────────────────
function resolvePath(p) {
  if (!p) return p;
  const username = os.userInfo().username;

  // Replace USER/USERNAME placeholders
  p = p.replace(/\bUSERNAME\b/g, username).replace(/\bUSER\b/g, username);

  if (p.startsWith("~/"))        return path.join(os.homedir(), p.slice(2));
  if (p.startsWith("Desktop/"))  return path.join(os.homedir(), "Desktop",   p.slice(8));
  if (p.startsWith("Documents/"))return path.join(os.homedir(), "Documents", p.slice(10));
  if (p.startsWith("Downloads/")) return path.join(os.homedir(), "Downloads", p.slice(10));

  return p;
}

// ── Parse LLM response → actions ──────────────────────────
function parseActions(text) {
  if (!text) return null;

  // Remove markdown code blocks if LLM added them
  let clean = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Find JSON array
  const startIdx = clean.indexOf("[");
  const endIdx   = clean.lastIndexOf("]");

  if (startIdx === -1 || endIdx === -1) {
    console.error("No JSON array found in response:", text.slice(0, 200));
    return null;
  }

  const jsonStr = clean.slice(startIdx, endIdx + 1);

  try {
    const actions = JSON.parse(jsonStr);
    if (!Array.isArray(actions)) {
      console.error("Parsed result is not an array");
      return null;
    }
    return actions;
  } catch (err) {
    console.error("JSON parse error:", err.message);
    console.error("Raw JSON:", jsonStr.slice(0, 300));
    return null;
  }
}

// ── Call local AI ──────────────────────────────────────────
async function callLocalAI(command, screenshotBase64, modelConfig) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const username = os.userInfo().username;
  const desktop  = path.join(os.homedir(), "Desktop");

  const userContent = `Task: "${command}"

System Info:
- OS: ${os.platform() === "win32" ? "Windows" : os.platform() === "darwin" ? "macOS" : "Linux"}
- Username: ${username}
- Desktop path: ${desktop}
- Home: ${os.homedir()}

Respond with ONLY a JSON array of actions. No explanation, no markdown.`;

  try {
    let text = "";

    if (visionEnabled && visionOllamaId && screenshotBase64) {
      text = await runOllamaVision(
        visionOllamaId,
        SYSTEM_PROMPT,
        `Current screen is shown above.\n${userContent}`,
        screenshotBase64
      );
    } else {
      text = await runOllamaPrompt(ollamaId, SYSTEM_PROMPT, userContent);
    }

    console.log("AI response:", text.slice(0, 200));
    return parseActions(text);

  } catch (err) {
    console.error("AI call error:", err.message);
    return null;
  }
}

// ── Execute all actions ───────────────────────────────────
async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    const actionName = action.action;
    console.log(`▶ ${actionName}${action.url ? " → " + action.url : action.selector ? " → " + action.selector : action.path ? " → " + action.path : action.app ? " → " + action.app : ""}`);

    try {
      let output = null;

      // ── Flow control ────────────────────────────────────
      if (actionName === "done" || actionName === "error") {
        results.push({ success: true, action, output: action.message });
        break;
      }

      // ── PC Actions ──────────────────────────────────────
      else if (actionName === "open")         await openApp(action.app);
      else if (actionName === "click")        await mouseClick(action.x, action.y);
      else if (actionName === "type")         await typeText(action.text);
      else if (actionName === "key")          await pressKey(action.key);
      else if (actionName === "wait")         await new Promise(r => setTimeout(r, Math.min(action.ms || 500, 10000)));
      else if (actionName === "scroll")       await scrollPage(action.x || 500, action.y || 300, action.direction, action.amount);
      else if (actionName === "screenshot")   output = await takeScreenshot();
      else if (actionName === "write_file")   output = await writeFile(action.path, action.content);
      else if (actionName === "read_file")    output = readFile(action.path);
      else if (actionName === "run_command")  output = await runCommand(action.command);

      // ── Browser Actions ──────────────────────────────────
      else if (actionName === "browser_goto")          output = await browserGoto(action.url, action.waitUntil);
      else if (actionName === "browser_click")         await browserClick(action.selector, action.options);
      else if (actionName === "browser_type")          await browserType(action.selector, action.text, action.clear);
      else if (actionName === "browser_fill")          await browserFill(action.selector, action.text);
      else if (actionName === "browser_wait")          await browserWait(action.selector, action.state, action.timeout);
      else if (actionName === "browser_extract")       output = await browserExtract(action.selector, action.what);
      else if (actionName === "browser_extract_table") output = await browserExtractTable(action.selector);
      else if (actionName === "browser_screenshot")    output = await browserScreenshot(action.selector);
      else if (actionName === "browser_key")           await browserKey(action.key);
      else if (actionName === "browser_select")        await browserSelect(action.selector, action.value);
      else if (actionName === "browser_scroll")        await browserScroll(action.direction, action.amount);
      else if (actionName === "browser_hover")         await browserHover(action.selector);
      else if (actionName === "browser_exists")        output = await browserExists(action.selector, action.timeout);
      else if (actionName === "browser_eval")          output = await browserEval(action.script);
      else if (actionName === "browser_new_tab")       await browserNewTab(action.url);
      else if (actionName === "browser_login")         await browserSmartLogin(action.site, action.username, action.password);

      // ── GitHub Actions ───────────────────────────────────
      else if (actionName === "github_auth")            output = await githubAuth(action.token);
      else if (actionName === "github_list_repos")      output = await githubListRepos();
      else if (actionName === "github_list_files")      output = await githubListFiles(action.owner, action.repo, action.path || "");
      else if (actionName === "github_read_file")       output = await githubReadFile(action.owner, action.repo, action.path, action.branch);
      else if (actionName === "github_write_file")      output = await githubWriteFile(action.owner, action.repo, action.path, action.content, action.message, action.branch);
      else if (actionName === "github_delete_file")     output = await githubDeleteFile(action.owner, action.repo, action.path, action.message);
      else if (actionName === "github_create_repo")     output = await githubCreateRepo(action.name, action.description, action.private);
      else if (actionName === "github_create_branch")   output = await githubCreateBranch(action.owner, action.repo, action.branch, action.from);
      else if (actionName === "github_create_pr")       output = await githubCreatePR(action.owner, action.repo, action.title, action.body, action.head, action.base);
      else if (actionName === "github_list_issues")     output = await githubListIssues(action.owner, action.repo, action.state);
      else if (actionName === "github_create_issue")    output = await githubCreateIssue(action.owner, action.repo, action.title, action.body, action.labels);
      else if (actionName === "github_search")          output = await githubSearch(action.query, action.owner, action.repo);
      else if (actionName === "github_clone")           output = await githubCloneLocally(action.owner, action.repo, action.target);
      else if (actionName === "github_commit_multiple") output = await githubCommitMultiple(action.owner, action.repo, action.files, action.message, action.branch);

      else {
        console.warn(`⚠️ Unknown action: ${actionName}`);
      }

      results.push({ success: true, action, output });

      // Small delay between actions (not for file ops)
      const noDelay = ["write_file", "read_file", "github_read_file", "github_write_file", "github_commit_multiple", "wait"];
      if (!noDelay.includes(actionName)) {
        await new Promise(r => setTimeout(r, 200));
      }

    } catch (err) {
      console.error(`❌ ${actionName}: ${err.message}`);
      results.push({ success: false, action, error: err.message });
      // Continue executing remaining actions unless critical
    }
  }

  return results;
}

// ── Main execute function ──────────────────────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\n🎯 Command: "${command}"`);
  console.log(`   Model: ${modelConfig.ollamaId} | Vision: ${modelConfig.visionEnabled}`);

  // Take screenshot if vision enabled
  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;

  // Call AI
  const actions = await callLocalAI(command, screenshot, modelConfig);

  if (!actions || actions.length === 0) {
    return {
      success: false,
      message: "AI could not understand the command. Please try rephrasing.",
    };
  }

  console.log(`   ${actions.length} actions planned`);

  // Execute actions
  const results = await executeActions(actions);

  // Find done/error action
  const doneAction  = results.find(r => r.action?.action === "done");
  const errorAction = results.find(r => r.action?.action === "error");
  const failedStep  = results.find(r => !r.success && r.action?.action !== "done" && r.action?.action !== "error");

  // Get screenshot after execution
  const browserShot = results.find(r => r.action?.action === "browser_screenshot" && r.output)?.output;
  const finalShot   = modelConfig.visionEnabled ? await takeScreenshot() : null;

  const message = doneAction?.output
    || errorAction?.action?.message
    || (failedStep ? `Step failed: ${failedStep.error}` : "Task completed");

  return {
    success:    !errorAction && !failedStep,
    message,
    results,
    screenshot: browserShot || finalShot,
  };
}

module.exports = { executeCommand, takeScreenshot, writeFile };