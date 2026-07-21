// src/agent/brain.js
// Vnus Agent Brain — Local Ollama + Playwright Browser + GitHub + File System

const { execSync }       = require("child_process");
const path               = require("path");
const fs                 = require("fs");
const os                 = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");
const {
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserWaitUrl, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect, browserScroll,
  browserGetInfo, browserHover, browserExists, browserUpload,
  browserNewTab, browserEval, browserSmartLogin, initBrowser, closeBrowser,
} = require("./browserAgent");
const {
  githubAuth, githubListRepos, githubListFiles, githubReadFile,
  githubWriteFile, githubDeleteFile, githubCreateRepo, githubCreateBranch,
  githubCreatePR, githubListIssues, githubCreateIssue, githubGetRepo,
  githubSearch, githubCloneLocally, githubCommitMultiple, loadGithubState,
} = require("./githubAgent");

// ── System prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are Vnus, an AI agent running on the user's PC.
You control everything through a JSON array of actions.

═══ PC CONTROL ACTIONS ═══
- { "action": "open", "app": "chrome|firefox|vscode|terminal|explorer|notepad" }
- { "action": "click", "x": number, "y": number }
- { "action": "type", "text": "string" }
- { "action": "key", "key": "Enter|Tab|Escape|ctrl+s|ctrl+n|ctrl+v|ctrl+c" }
- { "action": "scroll", "x": number, "y": number, "direction": "up|down", "amount": number }
- { "action": "wait", "ms": number }
- { "action": "screenshot" }
- { "action": "write_file", "path": "/absolute/path/file.ext", "content": "full content" }
- { "action": "read_file", "path": "/absolute/path/file.ext" }
- { "action": "run_command", "command": "shell command" }

═══ BROWSER ACTIONS (Playwright — fast & accurate) ═══
- { "action": "browser_goto", "url": "https://..." }
- { "action": "browser_click", "selector": "button.submit | #id | [aria-label='...']" }
- { "action": "browser_type", "selector": "#input", "text": "hello" }
- { "action": "browser_fill", "selector": "#input", "text": "hello" }
- { "action": "browser_wait", "selector": ".element", "state": "visible|hidden|attached" }
- { "action": "browser_extract", "selector": ".content", "what": "text|html|value|all_text|href" }
- { "action": "browser_extract_table", "selector": "table" }
- { "action": "browser_screenshot" }
- { "action": "browser_key", "key": "Enter|Tab|Escape|ArrowDown" }
- { "action": "browser_select", "selector": "select#id", "value": "option_value" }
- { "action": "browser_scroll", "direction": "down|up", "amount": 500 }
- { "action": "browser_hover", "selector": ".menu-item" }
- { "action": "browser_exists", "selector": ".element" }
- { "action": "browser_eval", "script": "return document.title" }
- { "action": "browser_new_tab", "url": "https://..." }
- { "action": "browser_login", "site": "gmail|github", "username": "...", "password": "..." }

═══ GITHUB ACTIONS ═══
- { "action": "github_auth", "token": "ghp_..." }
- { "action": "github_list_repos" }
- { "action": "github_list_files", "owner": "user", "repo": "repo", "path": "" }
- { "action": "github_read_file", "owner": "user", "repo": "repo", "path": "src/index.js" }
- { "action": "github_write_file", "owner": "user", "repo": "repo", "path": "src/index.js", "content": "...", "message": "commit msg" }
- { "action": "github_delete_file", "owner": "user", "repo": "repo", "path": "file.js", "message": "..." }
- { "action": "github_create_repo", "name": "my-repo", "description": "...", "private": false }
- { "action": "github_create_branch", "owner": "user", "repo": "repo", "branch": "feature/x" }
- { "action": "github_create_pr", "owner": "user", "repo": "repo", "title": "...", "body": "...", "head": "feature/x" }
- { "action": "github_list_issues", "owner": "user", "repo": "repo", "state": "open" }
- { "action": "github_create_issue", "owner": "user", "repo": "repo", "title": "Bug: ...", "body": "..." }
- { "action": "github_commit_multiple", "owner": "user", "repo": "repo", "files": [{"path":"a.js","content":"..."}], "message": "..." }
- { "action": "github_clone", "owner": "user", "repo": "repo", "target": "/path/on/pc" }
- { "action": "github_search", "query": "function login", "owner": "user", "repo": "repo" }

═══ FLOW CONTROL ═══
- { "action": "done", "message": "Task complete — what was done", "output": "optional result data" }
- { "action": "error", "message": "Cannot complete because..." }

═══ RULES ═══
1. CODING TASKS → Always use write_file (never type long code). Then open in VS Code.
2. WEB TASKS → Always use browser_* actions (faster + more accurate than click/screenshot).
3. GITHUB TASKS → Use github_* actions directly via API (no git commands needed).
4. Use absolute paths for write_file on Windows: C:/Users/username/Desktop/...
5. Chain actions logically — wait for elements before clicking.
6. End with "done" (success) or "error" (failure) always.
7. Respond ONLY with a valid JSON array. No explanation. No markdown.

═══ EXAMPLES ═══

Task: "Open Gmail and check emails"
[
  { "action": "browser_goto", "url": "https://gmail.com" },
  { "action": "browser_wait", "selector": ".AO", "state": "visible" },
  { "action": "browser_extract", "selector": ".zA", "what": "all_text" },
  { "action": "done", "message": "Gmail opened and emails extracted" }
]

Task: "Create a React app and push to GitHub"
[
  { "action": "run_command", "command": "npx create-react-app my-app" },
  { "action": "github_create_repo", "name": "my-app", "description": "New React app" },
  { "action": "run_command", "command": "cd my-app && git remote add origin https://github.com/user/my-app.git && git push -u origin main" },
  { "action": "done", "message": "React app created and pushed to GitHub" }
]

Task: "Fix the bug in src/auth.js in my repo"
[
  { "action": "github_read_file", "owner": "user", "repo": "my-project", "path": "src/auth.js" },
  { "action": "github_write_file", "owner": "user", "repo": "my-project", "path": "src/auth.js", "content": "// fixed code here", "message": "fix: resolve auth bug" },
  { "action": "done", "message": "Bug fixed in src/auth.js and committed to GitHub" }
]`;

// ── Screenshot (PC) ────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        $s=$([System.Windows.Forms.Screen]::PrimaryScreen.Bounds);
        $b=New-Object System.Drawing.Bitmap($s.Width,$s.Height);
        $g=[System.Drawing.Graphics]::FromImage($b);
        $g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size);
        $b.Save('${tmpPath.replace(/\\/g, "\\\\")}');
        $g.Dispose();$b.Dispose();
      `.replace(/\n/g, " ");
      execSync(`powershell -Command "${ps}"`);
    } else if (os.platform() === "darwin") {
      execSync(`screencapture -x "${tmpPath}"`);
    } else {
      execSync(`scrot "${tmpPath}"`);
    }
    const base64 = fs.readFileSync(tmpPath).toString("base64");
    fs.unlinkSync(tmpPath);
    return base64;
  } catch (err) {
    console.error("Screenshot error:", err.message);
    return null;
  }
}

// ── Write file ─────────────────────────────────────────────
async function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`✅ File written: ${filePath} (${content.length} chars)`);
  return filePath;
}

// ── Read file ──────────────────────────────────────────────
function readFile(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); }
  catch (err) { console.error(`Read file error: ${err.message}`); return null; }
}

// ── Run shell command ──────────────────────────────────────
async function runCommand(command) {
  const out = execSync(command, { encoding: "utf8", shell: true, timeout: 60000 });
  console.log(`✅ Command: ${command.slice(0, 60)}`);
  return out;
}

// ── Open app ──────────────────────────────────────────────
async function openApp(appName) {
  const p   = os.platform();
  const map = {
    chrome:   { win32: "start chrome",   darwin: "open -a 'Google Chrome'",      linux: "google-chrome &" },
    firefox:  { win32: "start firefox",  darwin: "open -a Firefox",              linux: "firefox &" },
    vscode:   { win32: "start code",     darwin: "open -a 'Visual Studio Code'", linux: "code &" },
    terminal: { win32: "start cmd",      darwin: "open -a Terminal",             linux: "x-terminal-emulator &" },
    explorer: { win32: "start explorer", darwin: "open ~",                       linux: "nautilus ~ &" },
    notepad:  { win32: "start notepad",  darwin: "open -a TextEdit",             linux: "gedit &" },
  };
  const cmd = map[appName?.toLowerCase()]?.[p];
  execSync(cmd || (p === "win32" ? `start ${appName}` : p === "darwin" ? `open -a "${appName}"` : `${appName} &`), { shell: true });
}

// ── Mouse click ───────────────────────────────────────────
async function mouseClick(x, y) {
  const p = os.platform();
  if (p === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});$sig='[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int b,int e);';$t=Add-Type -MemberDefinition $sig -Name U32 -Namespace W32 -PassThru;$t::mouse_event(2,0,0,0,0);$t::mouse_event(4,0,0,0,0);`;
    execSync(`powershell -Command "${ps}"`);
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to click at {${x},${y}}'`);
  } else {
    execSync(`xdotool mousemove ${x} ${y} click 1`);
  }
}

// ── Type text ─────────────────────────────────────────────
async function typeText(text) {
  const p    = os.platform();
  const safe = text.replace(/'/g, "\\'");
  if (p === "win32") {
    execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${safe}');"`);
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`);
  } else {
    execSync(`xdotool type '${safe}'`);
  }
}

// ── Press key ─────────────────────────────────────────────
async function pressKey(key) {
  const p    = os.platform();
  const wMap = { Enter:"{ENTER}", Tab:"{TAB}", Escape:"{ESC}", Backspace:"{BACKSPACE}", "ctrl+s":"^s", "ctrl+n":"^n", "ctrl+v":"^v", "ctrl+c":"^c", "ctrl+z":"^z", "ctrl+a":"^a" };
  const mMap = { Enter:"return", Tab:"tab", Escape:"escape", Backspace:"delete" };
  if (p === "win32") {
    execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${wMap[key] || key}');"`);
  } else if (p === "darwin") {
    if (key.includes("ctrl+")) execSync(`osascript -e 'tell application "System Events" to keystroke "${key.replace("ctrl+","")}" using command down'`);
    else execSync(`osascript -e 'tell application "System Events" to key code "${mMap[key] || key}"'`);
  } else {
    execSync(`xdotool key ${key}`);
  }
}

// ── Scroll ────────────────────────────────────────────────
async function scrollPage(x, y, direction, amount = 3) {
  const p = os.platform();
  if (p === "win32") {
    const delta = direction === "up" ? amount * 120 : -amount * 120;
    execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});$sig='[DllImport(\"user32.dll\")]public static extern void mouse_event(int f,int dx,int dy,int d,int e);';$t=Add-Type -MemberDefinition $sig -Name U32S -Namespace W32S -PassThru;$t::mouse_event(0x0800,0,0,${delta},0);"`);
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to scroll ${direction === "up" ? "up" : "down"} ${amount}'`);
  } else {
    execSync(`xdotool mousemove ${x} ${y} click ${direction === "up" ? 4 : 5}`);
  }
}

// ── Get desktop path ───────────────────────────────────────
function getDesktopPath() {
  return path.join(os.homedir(), "Desktop");
}

// ── Resolve path shortcuts ─────────────────────────────────
function resolvePath(p) {
  if (!p) return p;
  if (p.startsWith("~/"))      return path.join(os.homedir(), p.slice(2));
  if (p.startsWith("Desktop/"))return path.join(getDesktopPath(), p.slice(8));
  return p;
}

// ── Call local Ollama ─────────────────────────────────────
async function callLocalAI(command, screenshotBase64, modelConfig) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const userText = `User command: "${command}"\n\nRespond ONLY with a valid JSON array of actions. No explanation.`;

  let text = "";
  try {
    if (visionEnabled && visionOllamaId && screenshotBase64) {
      text = await runOllamaVision(visionOllamaId, SYSTEM_PROMPT, `Current screen above.\n${userText}`, screenshotBase64);
    } else {
      text = await runOllamaPrompt(ollamaId, SYSTEM_PROMPT, userText);
    }
    const match   = text.match(/\[[\s\S]*\]/);
    const actions = match ? JSON.parse(match[0]) : null;
    return actions;
  } catch (err) {
    console.error("Local AI error:", err.message);
    return null;
  }
}

// ── Execute all actions ───────────────────────────────────
async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    console.log(`▶ ${action.action}${action.url ? " → " + action.url : action.selector ? " → " + action.selector : action.path ? " → " + action.path : ""}`);

    try {
      let output = null;

      // ── PC Actions ──────────────────────────────────────
      if      (action.action === "open")        await openApp(action.app);
      else if (action.action === "click")        await mouseClick(action.x, action.y);
      else if (action.action === "type")         await typeText(action.text);
      else if (action.action === "key")          await pressKey(action.key);
      else if (action.action === "wait")         await new Promise(r => setTimeout(r, action.ms || 500));
      else if (action.action === "scroll")       await scrollPage(action.x, action.y, action.direction, action.amount);
      else if (action.action === "write_file")   output = await writeFile(resolvePath(action.path), action.content);
      else if (action.action === "read_file")    output = readFile(resolvePath(action.path));
      else if (action.action === "run_command")  output = await runCommand(action.command);

      // ── Browser Actions (Playwright) ────────────────────
      else if (action.action === "browser_goto")           output = await browserGoto(action.url, action.waitUntil);
      else if (action.action === "browser_click")          await browserClick(action.selector, action.options);
      else if (action.action === "browser_type")           await browserType(action.selector, action.text, action.clear);
      else if (action.action === "browser_fill")           await browserFill(action.selector, action.text);
      else if (action.action === "browser_wait")           await browserWait(action.selector, action.state, action.timeout);
      else if (action.action === "browser_wait_url")       await browserWaitUrl(action.url, action.timeout);
      else if (action.action === "browser_extract")        output = await browserExtract(action.selector, action.what);
      else if (action.action === "browser_extract_table")  output = await browserExtractTable(action.selector);
      else if (action.action === "browser_screenshot")     output = await browserScreenshot(action.selector);
      else if (action.action === "browser_key")            await browserKey(action.key);
      else if (action.action === "browser_select")         await browserSelect(action.selector, action.value);
      else if (action.action === "browser_scroll")         await browserScroll(action.direction, action.amount);
      else if (action.action === "browser_hover")          await browserHover(action.selector);
      else if (action.action === "browser_exists")         output = await browserExists(action.selector, action.timeout);
      else if (action.action === "browser_eval")           output = await browserEval(action.script);
      else if (action.action === "browser_new_tab")        await browserNewTab(action.url);
      else if (action.action === "browser_login")          await browserSmartLogin(action.site, action.username, action.password);

      // ── GitHub Actions ──────────────────────────────────
      else if (action.action === "github_auth")            output = await githubAuth(action.token);
      else if (action.action === "github_list_repos")      output = await githubListRepos();
      else if (action.action === "github_list_files")      output = await githubListFiles(action.owner, action.repo, action.path || "");
      else if (action.action === "github_read_file")       output = await githubReadFile(action.owner, action.repo, action.path, action.branch);
      else if (action.action === "github_write_file")      output = await githubWriteFile(action.owner, action.repo, action.path, action.content, action.message, action.branch);
      else if (action.action === "github_delete_file")     output = await githubDeleteFile(action.owner, action.repo, action.path, action.message, action.branch);
      else if (action.action === "github_create_repo")     output = await githubCreateRepo(action.name, action.description, action.private);
      else if (action.action === "github_create_branch")   output = await githubCreateBranch(action.owner, action.repo, action.branch, action.from);
      else if (action.action === "github_create_pr")       output = await githubCreatePR(action.owner, action.repo, action.title, action.body, action.head, action.base);
      else if (action.action === "github_list_issues")     output = await githubListIssues(action.owner, action.repo, action.state);
      else if (action.action === "github_create_issue")    output = await githubCreateIssue(action.owner, action.repo, action.title, action.body, action.labels);
      else if (action.action === "github_get_repo")        output = await githubGetRepo(action.owner, action.repo);
      else if (action.action === "github_search")          output = await githubSearch(action.query, action.owner, action.repo);
      else if (action.action === "github_clone")           output = await githubCloneLocally(action.owner, action.repo, action.target);
      else if (action.action === "github_commit_multiple") output = await githubCommitMultiple(action.owner, action.repo, action.files, action.message, action.branch);

      results.push({ success: true, action, output });
      if (action.action === "done" || action.action === "error") break;

      // Delay between actions (not for file ops)
      const noDelay = ["write_file","read_file","github_read_file","github_write_file","github_list_repos","github_list_files","github_commit_multiple"];
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

// ── Main execute ──────────────────────────────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\n🎯 "${command}"`);
  console.log(`   Model: ${modelConfig.ollamaId} | Vision: ${modelConfig.visionEnabled}`);

  // Screenshot only if vision enabled
  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;

  // Call AI
  const actions = await callLocalAI(command, screenshot, modelConfig);
  if (!actions || actions.length === 0) {
    return { success: false, message: "AI could not determine actions." };
  }

  console.log(`   ${actions.length} actions planned`);

  // Execute
  const results      = await executeActions(actions);
  const done         = results.find(r => r.action?.action === "done");
  const error        = results.find(r => r.action?.action === "error");
  const writtenFiles = results.filter(r => r.action?.action === "write_file" && r.success).map(r => r.output);
  const browserShot  = results.find(r => r.action?.action === "browser_screenshot" && r.output)?.output;
  const pcShot       = modelConfig.visionEnabled ? await takeScreenshot() : null;

  return {
    success:      !error,
    message:      done?.action?.message || error?.action?.message || "Task executed",
    output:       done?.action?.output  || null,
    results,
    screenshot:   browserShot || pcShot,
    writtenFiles,
  };
}

module.exports = { executeCommand, takeScreenshot, writeFile };