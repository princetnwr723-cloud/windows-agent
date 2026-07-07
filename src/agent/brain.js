// src/agent/brain.js
// Vnus Agent Brain — Aerolink API (Anthropic-compatible proxy)
// Base URL: https://capi.aerolink.lat
// Key format: aero_live_...

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Config ────────────────────────────────────────────────
const AEROLINK_BASE_URL = "https://capi.aerolink.lat";
const AEROLINK_API_KEY = aerolinkConfig.apiKey;
const MODEL = "claude-sonnet-4-6"; // Fast + cheap for testing

// ── Screenshot ────────────────────────────────────────────
async function takeScreenshot() {
  const tmpPath = path.join(os.tmpdir(), `vnus-screenshot-${Date.now()}.png`);

  try {
    if (os.platform() === "win32") {
      // Windows — PowerShell screenshot
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height);
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
        $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
        $bitmap.Save('${tmpPath.replace(/\\/g, "\\\\")}');
        $graphics.Dispose(); $bitmap.Dispose();
      `;
      execSync(`powershell -Command "${ps.replace(/\n/g, " ")}"`);
    } else if (os.platform() === "darwin") {
      // Mac
      execSync(`screencapture -x "${tmpPath}"`);
    } else {
      // Linux
      execSync(`scrot "${tmpPath}"`);
    }

    const imageData = fs.readFileSync(tmpPath);
    const base64 = imageData.toString("base64");
    fs.unlinkSync(tmpPath); // cleanup
    return base64;
  } catch (err) {
    console.error("Screenshot error:", err);
    return null;
  }
}

// ── Call Aerolink API ─────────────────────────────────────
async function callAerolink(command, screenshotBase64) {
  const messages = [];

  // System prompt — tells AI what it can do
  const systemPrompt = `You are Vnus, an AI agent running on the user's PC.
You can control the PC by responding with JSON actions.

Available actions:
- { "action": "click", "x": number, "y": number }
- { "action": "type", "text": "string" }
- { "action": "key", "key": "Enter|Tab|Escape|..." }
- { "action": "open", "app": "chrome|notepad|explorer|..." }
- { "action": "screenshot" }
- { "action": "done", "message": "Task complete message" }
- { "action": "error", "message": "Error message" }

Always respond with a JSON array of actions. Example:
[
  { "action": "open", "app": "chrome" },
  { "action": "done", "message": "Chrome opened successfully" }
]

Look at the screenshot carefully before deciding what to do.
Be precise with coordinates when clicking.`;

  // Build message with screenshot if available
  const userContent = screenshotBase64
    ? [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: screenshotBase64,
          },
        },
        {
          type: "text",
          text: `Current screen shown above. User command: "${command}"\n\nRespond with JSON actions array only.`,
        },
      ]
    : [
        {
          type: "text",
          text: `User command: "${command}"\n\nRespond with JSON actions array only.`,
        },
      ];

  messages.push({ role: "user", content: userContent });

  try {
    const response = await fetch(`${AEROLINK_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AEROLINK_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Aerolink error:", err);
      return null;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // Parse JSON actions from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error("API call error:", err);
    return null;
  }
}

// ── Execute Actions ───────────────────────────────────────
async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    console.log("Executing:", action);

    try {
      if (action.action === "open") {
        await openApp(action.app);
        results.push({ success: true, action });
      } else if (action.action === "click") {
        await mouseClick(action.x, action.y);
        results.push({ success: true, action });
      } else if (action.action === "type") {
        await typeText(action.text);
        results.push({ success: true, action });
      } else if (action.action === "key") {
        await pressKey(action.key);
        results.push({ success: true, action });
      } else if (action.action === "screenshot") {
        const ss = await takeScreenshot();
        results.push({ success: true, action, screenshot: ss });
      } else if (action.action === "done") {
        results.push({ success: true, action, done: true, message: action.message });
        break;
      } else if (action.action === "error") {
        results.push({ success: false, action, message: action.message });
        break;
      }

      // Small delay between actions
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      results.push({ success: false, action, error: err.message });
    }
  }

  return results;
}

// ── Open App ─────────────────────────────────────────────
async function openApp(appName) {
  const platform = os.platform();
  const apps = {
    chrome:   { win32: "start chrome", darwin: "open -a 'Google Chrome'", linux: "google-chrome" },
    firefox:  { win32: "start firefox", darwin: "open -a Firefox", linux: "firefox" },
    notepad:  { win32: "start notepad", darwin: "open -a TextEdit", linux: "gedit" },
    explorer: { win32: "start explorer", darwin: "open ~", linux: "nautilus ~" },
    terminal: { win32: "start cmd", darwin: "open -a Terminal", linux: "x-terminal-emulator" },
    vscode:   { win32: "start code", darwin: "open -a 'Visual Studio Code'", linux: "code" },
  };

  const cmd = apps[appName.toLowerCase()]?.[platform];
  if (cmd) {
    execSync(cmd, { shell: true });
  } else {
    // Try to open directly
    if (platform === "win32") execSync(`start ${appName}`, { shell: true });
    else if (platform === "darwin") execSync(`open -a "${appName}"`, { shell: true });
    else execSync(appName, { shell: true });
  }
}

// ── Mouse Click ──────────────────────────────────────────
async function mouseClick(x, y) {
  const platform = os.platform();

  if (platform === "win32") {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
      $signature = '[DllImport("user32.dll")]public static extern void mouse_event(int flags, int dx, int dy, int buttons, int extraInfo);';
      $t = Add-Type -MemberDefinition $signature -Name User32 -Namespace Win32 -PassThru;
      $t::mouse_event(0x0002, 0, 0, 0, 0);
      $t::mouse_event(0x0004, 0, 0, 0, 0);
    `;
    execSync(`powershell -Command "${ps.replace(/\n/g, " ")}"`);
  } else if (platform === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`);
  } else {
    execSync(`xdotool mousemove ${x} ${y} click 1`);
  }
}

// ── Type Text ────────────────────────────────────────────
async function typeText(text) {
  const platform = os.platform();
  const escaped = text.replace(/'/g, "\\'");

  if (platform === "win32") {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait('${escaped}');
    `;
    execSync(`powershell -Command "${ps.replace(/\n/g, " ")}"`);
  } else if (platform === "darwin") {
    execSync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
  } else {
    execSync(`xdotool type '${escaped}'`);
  }
}

// ── Press Key ────────────────────────────────────────────
async function pressKey(key) {
  const platform = os.platform();

  if (platform === "win32") {
    const keyMap = { Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}", Backspace: "{BACKSPACE}" };
    const mappedKey = keyMap[key] || key;
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait('${mappedKey}');
    `;
    execSync(`powershell -Command "${ps.replace(/\n/g, " ")}"`);
  } else if (platform === "darwin") {
    const keyMap = { Enter: "return", Tab: "tab", Escape: "escape" };
    const k = keyMap[key] || key;
    execSync(`osascript -e 'tell application "System Events" to key code "${k}"'`);
  } else {
    execSync(`xdotool key ${key}`);
  }
}

// ── Main Execute Function ─────────────────────────────────
async function executeCommand(command) {
  console.log(`\nExecuting command: "${command}"`);

  // Step 1: Take screenshot
  console.log("Taking screenshot...");
  const screenshot = await takeScreenshot();

  // Step 2: Ask Aerolink what to do
  console.log("Asking Aerolink AI...");
  const actions = await callAerolink(command, screenshot);

  if (!actions || actions.length === 0) {
    return { success: false, message: "AI could not determine actions" };
  }

  console.log("Actions to execute:", JSON.stringify(actions, null, 2));

  // Step 3: Execute actions
  const results = await executeActions(actions);

  // Step 4: Get final result
  const doneAction = results.find((r) => r.action?.action === "done");
  const errorAction = results.find((r) => r.action?.action === "error");

  return {
    success: !errorAction,
    message: doneAction?.message || errorAction?.message || "Task executed",
    actions: results,
    screenshot: await takeScreenshot(), // Final state screenshot
  };
}

module.exports = { executeCommand, takeScreenshot };