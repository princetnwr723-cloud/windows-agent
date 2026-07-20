// src/agent/brain.js
// Vnus Agent Brain — Local Ollama + write_file + run_command support

const { execSync }       = require("child_process");
const path               = require("path");
const fs                 = require("fs");
const os                 = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");

// ── System prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = `You are Vnus, an AI agent running on the user's PC.
You control the PC by responding with a JSON array of actions.

Available actions:
- { "action": "open", "app": "chrome|firefox|notepad|explorer|terminal|vscode" }
- { "action": "click", "x": number, "y": number }
- { "action": "type", "text": "string" }
- { "action": "key", "key": "Enter|Tab|Escape|Backspace|ctrl+s|ctrl+n|ctrl+v..." }
- { "action": "scroll", "x": number, "y": number, "direction": "up|down", "amount": number }
- { "action": "wait", "ms": number }
- { "action": "screenshot" }
- { "action": "write_file", "path": "absolute/path/to/file.ext", "content": "full file content here" }
- { "action": "read_file", "path": "absolute/path/to/file.ext" }
- { "action": "run_command", "command": "shell command here" }
- { "action": "done", "message": "Task complete description" }
- { "action": "error", "message": "Cannot complete because..." }

IMPORTANT RULES:
1. For coding tasks — ALWAYS use write_file to create files. Never type long code manually.
2. write_file creates directories automatically if needed.
3. After write_file, open the file in the right app to show the user.
4. For websites — write complete HTML/CSS/JS in one file first, then open in browser.
5. Always end with "done" or "error".
6. Respond ONLY with a valid JSON array — no explanation text.
7. Use absolute paths for write_file (e.g. C:/Users/username/Desktop/project/index.html on Windows).

Example for coding task:
[
  { "action": "write_file", "path": "C:/Users/user/Desktop/app/index.html", "content": "<!DOCTYPE html>..." },
  { "action": "open", "app": "vscode" },
  { "action": "wait", "ms": 2000 },
  { "action": "done", "message": "Created index.html and opened in VS Code" }
]`;

// ── Screenshot ─────────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-ss-${Date.now()}.png`);
  try {
    if (os.platform() === "win32") {
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
        $g = [System.Drawing.Graphics]::FromImage($bitmap);
        $g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
        $bitmap.Save('${tmpPath.replace(/\\/g, "\\\\")}');
        $g.Dispose(); $bitmap.Dispose();
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
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`✅ File written: ${filePath} (${content.length} chars)`);
    return { success: true, path: filePath };
  } catch (err) {
    console.error(`❌ Write file error: ${err.message}`);
    throw err;
  }
}

// ── Read file ──────────────────────────────────────────────
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`❌ Read file error: ${err.message}`);
    return null;
  }
}

// ── Run shell command ──────────────────────────────────────
async function runCommand(command) {
  try {
    const out = execSync(command, {
      encoding: "utf8",
      shell:    true,
      timeout:  30000, // 30s timeout
    });
    console.log(`✅ Command output: ${out.slice(0, 200)}`);
    return out;
  } catch (err) {
    console.error(`❌ Command error: ${err.message}`);
    throw err;
  }
}

// ── Open app ──────────────────────────────────────────────
async function openApp(appName) {
  const p   = os.platform();
  const map = {
    chrome:   { win32: "start chrome",   darwin: "open -a 'Google Chrome'",      linux: "google-chrome &" },
    firefox:  { win32: "start firefox",  darwin: "open -a Firefox",              linux: "firefox &" },
    notepad:  { win32: "start notepad",  darwin: "open -a TextEdit",             linux: "gedit &" },
    explorer: { win32: "start explorer", darwin: "open ~",                       linux: "nautilus ~ &" },
    terminal: { win32: "start cmd",      darwin: "open -a Terminal",             linux: "x-terminal-emulator &" },
    vscode:   { win32: "start code",     darwin: "open -a 'Visual Studio Code'", linux: "code &" },
  };
  const cmd = map[appName?.toLowerCase()]?.[p];
  execSync(
    cmd || (p === "win32" ? `start ${appName}` : p === "darwin" ? `open -a "${appName}"` : `${appName} &`),
    { shell: true }
  );
}

// ── Open file in app ───────────────────────────────────────
async function openFileInApp(filePath, app) {
  const p = os.platform();
  try {
    if (app === "vscode" || app === "code") {
      execSync(`code "${filePath}"`, { shell: true });
    } else if (app === "chrome" || app === "browser") {
      if (p === "win32")       execSync(`start chrome "${filePath}"`, { shell: true });
      else if (p === "darwin") execSync(`open -a "Google Chrome" "${filePath}"`, { shell: true });
      else                     execSync(`google-chrome "${filePath}" &`, { shell: true });
    } else {
      if (p === "win32")       execSync(`start "" "${filePath}"`, { shell: true });
      else if (p === "darwin") execSync(`open "${filePath}"`, { shell: true });
      else                     execSync(`xdg-open "${filePath}" &`, { shell: true });
    }
  } catch (err) {
    console.error(`Open file error: ${err.message}`);
  }
}

// ── Mouse click ───────────────────────────────────────────
async function mouseClick(x, y) {
  const p = os.platform();
  if (p === "win32") {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y});
      $sig='[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int b,int e);';
      $t=Add-Type -MemberDefinition $sig -Name U32 -Namespace W32 -PassThru;
      $t::mouse_event(2,0,0,0,0);$t::mouse_event(4,0,0,0,0);
    `.replace(/\n/g, " ");
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
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${safe}');`;
    execSync(`powershell -Command "${ps}"`);
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`);
  } else {
    execSync(`xdotool type '${safe}'`);
  }
}

// ── Press key ─────────────────────────────────────────────
async function pressKey(key) {
  const p = os.platform();
  if (p === "win32") {
    const map = {
      Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}",
      Backspace: "{BACKSPACE}", Space: " ",
      "ctrl+s": "^s", "ctrl+n": "^n", "ctrl+v": "^v",
      "ctrl+c": "^c", "ctrl+z": "^z", "ctrl+a": "^a",
    };
    const ps = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${map[key] || key}');`;
    execSync(`powershell -Command "${ps}"`);
  } else if (p === "darwin") {
    const map = { Enter: "return", Tab: "tab", Escape: "escape", Backspace: "delete" };
    if (key.includes("ctrl+")) {
      const k = key.replace("ctrl+","");
      execSync(`osascript -e 'tell application "System Events" to keystroke "${k}" using command down'`);
    } else {
      execSync(`osascript -e 'tell application "System Events" to key code "${map[key] || key}"'`);
    }
  } else {
    const linuxMap = { "ctrl+s": "ctrl+s", "ctrl+n": "ctrl+n" };
    execSync(`xdotool key ${linuxMap[key] || key}`);
  }
}

// ── Scroll ────────────────────────────────────────────────
async function scrollPage(x, y, direction, amount = 3) {
  const p = os.platform();
  if (p === "win32") {
    const delta = direction === "up" ? amount * 120 : -amount * 120;
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y});
      $sig='[DllImport("user32.dll")]public static extern void mouse_event(int f,int dx,int dy,int d,int e);';
      $t=Add-Type -MemberDefinition $sig -Name U32S -Namespace W32S -PassThru;
      $t::mouse_event(0x0800,0,0,${delta},0);
    `.replace(/\n/g, " ");
    execSync(`powershell -Command "${ps}"`);
  } else if (p === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to scroll ${direction === "up" ? "up" : "down"} ${amount}'`);
  } else {
    execSync(`xdotool mousemove ${x} ${y} click ${direction === "up" ? 4 : 5}`);
  }
}

// ── Call local Ollama ─────────────────────────────────────
async function callLocalAI(command, screenshotBase64, modelConfig) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const userText = `User command: "${command}"\n\nRespond ONLY with a valid JSON array of actions. No explanation.`;

  let text = "";
  try {
    if (visionEnabled && visionOllamaId && screenshotBase64) {
      const visionText = `Current screen shown above.\n${userText}`;
      text = await runOllamaVision(visionOllamaId, SYSTEM_PROMPT, visionText, screenshotBase64);
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

// ── Get default desktop path ──────────────────────────────
function getDesktopPath() {
  return path.join(os.homedir(), "Desktop");
}

// ── Execute actions ───────────────────────────────────────
async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    console.log("▶ Action:", JSON.stringify(action).slice(0, 100));
    try {
      let output = null;

      if      (action.action === "open")         await openApp(action.app);
      else if (action.action === "click")         await mouseClick(action.x, action.y);
      else if (action.action === "type")          await typeText(action.text);
      else if (action.action === "key")           await pressKey(action.key);
      else if (action.action === "wait")          await new Promise(r => setTimeout(r, action.ms || 500));
      else if (action.action === "scroll")        await scrollPage(action.x, action.y, action.direction, action.amount);
      else if (action.action === "write_file") {
        // Replace ~/ or Desktop shortcut with actual path
        let filePath = action.path;
        if (filePath.startsWith("~/"))      filePath = path.join(os.homedir(), filePath.slice(2));
        if (filePath.startsWith("Desktop")) filePath = path.join(getDesktopPath(), filePath.slice(7));
        await writeFile(filePath, action.content);
        output = filePath;
      }
      else if (action.action === "read_file") {
        let filePath = action.path;
        if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2));
        output = readFile(filePath);
      }
      else if (action.action === "run_command")   output = await runCommand(action.command);
      else if (action.action === "open_file")     await openFileInApp(action.path, action.with);

      results.push({ success: true, action, output });

      if (action.action === "done" || action.action === "error") break;

      // Small delay between actions
      if (!["write_file", "read_file"].includes(action.action)) {
        await new Promise(r => setTimeout(r, 350));
      }
    } catch (err) {
      console.error("❌ Action error:", err.message);
      results.push({ success: false, action, error: err.message });
    }
  }
  return results;
}

// ── Main execute ──────────────────────────────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\n🎯 Command: "${command}"`);
  console.log(`   Model: ${modelConfig.ollamaId} | Vision: ${modelConfig.visionEnabled}`);

  // Screenshot (only if vision enabled)
  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;

  // Call AI
  const actions = await callLocalAI(command, screenshot, modelConfig);
  if (!actions || actions.length === 0) {
    return { success: false, message: "AI could not determine actions." };
  }

  console.log(`   Got ${actions.length} actions`);

  // Execute
  const results        = await executeActions(actions);
  const done           = results.find(r => r.action?.action === "done");
  const error          = results.find(r => r.action?.action === "error");
  const writtenFiles   = results.filter(r => r.action?.action === "write_file" && r.success).map(r => r.output);
  const finalScreenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;

  return {
    success:      !error,
    message:      done?.action?.message || error?.action?.message || "Task executed",
    results,
    screenshot:   finalScreenshot,
    writtenFiles,
  };
}

module.exports = { executeCommand, takeScreenshot, writeFile };