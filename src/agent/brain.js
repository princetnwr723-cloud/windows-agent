// src/agent/brain.js
// Vnus Agent Brain — Local Ollama AI + Screenshot + Actions

const { execSync }       = require("child_process");
const path               = require("path");
const fs                 = require("fs");
const os                 = require("os");
const { runOllamaPrompt, runOllamaVision } = require("./ollamaManager");

// ── System prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are Vnus, an AI agent running on the user's PC.
You can control the PC by responding with a JSON array of actions.

Available actions:
- { "action": "click", "x": number, "y": number }
- { "action": "type", "text": "string" }
- { "action": "key", "key": "Enter|Tab|Escape|Backspace|..." }
- { "action": "open", "app": "chrome|firefox|notepad|explorer|terminal|vscode" }
- { "action": "scroll", "x": number, "y": number, "direction": "up|down", "amount": number }
- { "action": "wait", "ms": number }
- { "action": "screenshot" }
- { "action": "done", "message": "Task complete description" }
- { "action": "error", "message": "Cannot complete because..." }

Rules:
1. Always look at the screenshot carefully before deciding actions
2. Be precise with x,y coordinates when clicking
3. Chain multiple actions to complete complex tasks
4. Always end with "done" or "error"
5. Respond ONLY with a valid JSON array — no explanation text

Example:
[
  { "action": "open", "app": "chrome" },
  { "action": "wait", "ms": 1500 },
  { "action": "done", "message": "Chrome opened successfully" }
]`;

// ── Screenshot ────────────────────────────────────────────
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

// ── Call local Ollama ─────────────────────────────────────
async function callLocalAI(command, screenshotBase64, modelConfig) {
  const { ollamaId, visionOllamaId, visionEnabled } = modelConfig;
  const userText = `User command: "${command}"\n\nRespond with JSON actions array only.`;

  let text = "";

  try {
    if (visionEnabled && visionOllamaId && screenshotBase64) {
      // Vision model — send screenshot + command
      const visionText = `Current screen shown above.\n${userText}`;
      text = await runOllamaVision(visionOllamaId, SYSTEM_PROMPT, visionText, screenshotBase64);
    } else {
      // Text only
      text = await runOllamaPrompt(ollamaId, SYSTEM_PROMPT, userText);
    }

    // Parse JSON actions
    const match   = text.match(/\[[\s\S]*\]/);
    const actions = match ? JSON.parse(match[0]) : null;
    return actions;
  } catch (err) {
    console.error("Local AI error:", err.message);
    return null;
  }
}

// ── Execute actions ───────────────────────────────────────
async function executeActions(actions) {
  const results = [];
  for (const action of actions) {
    console.log("Action:", JSON.stringify(action));
    try {
      if      (action.action === "open")   await openApp(action.app);
      else if (action.action === "click")  await mouseClick(action.x, action.y);
      else if (action.action === "type")   await typeText(action.text);
      else if (action.action === "key")    await pressKey(action.key);
      else if (action.action === "wait")   await new Promise(r => setTimeout(r, action.ms || 500));
      else if (action.action === "scroll") await scrollPage(action.x, action.y, action.direction, action.amount);

      results.push({ success: true, action });
      if (action.action === "done" || action.action === "error") break;
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error("Action error:", err.message);
      results.push({ success: false, action, error: err.message });
    }
  }
  return results;
}

// ── Open App ──────────────────────────────────────────────
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
  execSync(cmd || (p === "win32" ? `start ${appName}` : p === "darwin" ? `open -a "${appName}"` : `${appName} &`), { shell: true });
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
    const map = { Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}", Backspace: "{BACKSPACE}", Space: " " };
    const ps  = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('${map[key] || key}');`;
    execSync(`powershell -Command "${ps}"`);
  } else if (p === "darwin") {
    const map = { Enter: "return", Tab: "tab", Escape: "escape", Backspace: "delete" };
    execSync(`osascript -e 'tell application "System Events" to key code "${map[key] || key}"'`);
  } else {
    execSync(`xdotool key ${key}`);
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

// ── Main execute ──────────────────────────────────────────
async function executeCommand(command, modelConfig) {
  console.log(`\nCommand: "${command}"`);
  console.log(`Model: ${modelConfig.ollamaId} | Vision: ${modelConfig.visionEnabled}`);

  // Screenshot
  const screenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;

  // Call AI
  const actions = await callLocalAI(command, screenshot, modelConfig);
  if (!actions || actions.length === 0) {
    return { success: false, message: "AI could not determine actions." };
  }

  // Execute
  const results       = await executeActions(actions);
  const done          = results.find(r => r.action?.action === "done");
  const error         = results.find(r => r.action?.action === "error");
  const finalScreenshot = modelConfig.visionEnabled ? await takeScreenshot() : null;

  return {
    success:    !error,
    message:    done?.action?.message || error?.action?.message || "Task executed",
    results,
    screenshot: finalScreenshot,
  };
}

module.exports = { executeCommand, takeScreenshot };