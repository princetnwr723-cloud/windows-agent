const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, screen, systemPreferences } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync, exec } = require("child_process");

const { firebaseConfig } = require("./config");

// ─── App Config ───────────────────────────────────────────
const IS_DEV = process.argv.includes("--dev");
const PLATFORM = os.platform(); // 'win32', 'darwin', 'linux'
const DATA_DIR = path.join(app.getPath("userData"), "vnus-agent");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let tray = null;
let splashWindow = null;
let isQuitting = false;

// ─── State Management ─────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { isSetup: false, agentCode: null, userId: null, codeCreatedAt: null };
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Generate unique 10-digit code ────────────────────────
function generateAgentCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Get PC Info ──────────────────────────────────────────
function getPCInfo() {
  return {
    pcName: os.hostname(),
    os: `${getOSName()} ${os.release()}`,
    platform: PLATFORM,
    arch: os.arch(),
    username: os.userInfo().username,
    totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + " GB",
  };
}

function getOSName() {
  if (PLATFORM === "win32") return "Windows";
  if (PLATFORM === "darwin") return "macOS";
  return "Linux";
}

// ─── Save code to Firestore via REST ──────────────────────
async function saveCodeToFirestore(code, pcInfo) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}`;
  const body = {
    fields: {
      code: { stringValue: code },
      status: { stringValue: "waiting" },
      userId: { nullValue: null },
      pcName: { stringValue: pcInfo.pcName },
      os: { stringValue: pcInfo.os },
      platform: { stringValue: pcInfo.platform },
      arch: { stringValue: pcInfo.arch },
      username: { stringValue: pcInfo.username },
      createdAt: { stringValue: new Date().toISOString() },
      expiresAt: { stringValue: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    },
  };
  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch (err) {
    console.error("Firestore error:", err);
    return false;
  }
}

// ─── Listen for workspace connection ──────────────────────
function listenForConnection(code, onConnected) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}`;
  const poll = setInterval(async () => {
    try {
      const res = await fetch(url);
      const data = await res.json();
      const status = data?.fields?.status?.stringValue;
      const userId = data?.fields?.userId?.stringValue;
      if (status === "connected" && userId) {
        clearInterval(poll);
        onConnected(userId);
      }
    } catch {}
  }, 3000);
  setTimeout(() => clearInterval(poll), 15 * 60 * 1000);
  return poll;
}

// ─── WINDOWS: Request Permissions ─────────────────────────
async function requestWindowsPermissions() {
  const result = await dialog.showMessageBox({
    type: "info",
    title: "Vnus Agent — Permissions Required",
    message: "Vnus Agent needs the following permissions:",
    detail:
      "✅  Full file system access\n" +
      "✅  Network access\n" +
      "✅  Run at startup\n" +
      "✅  System notifications\n\n" +
      "Your data stays on your PC and is never uploaded without your command.",
    buttons: ["Grant Permissions & Continue", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  return result.response === 0;
}

// ─── MAC: Request Permissions ─────────────────────────────
async function requestMacPermissions() {
  // Show info dialog first
  await dialog.showMessageBox({
    type: "info",
    title: "Vnus Agent — Permissions Required",
    message: "Vnus Agent needs a few permissions to work.",
    detail:
      "We'll ask for:\n\n" +
      "✅  Accessibility access (to control apps)\n" +
      "✅  Full Disk Access (to manage files)\n" +
      "✅  Network access (to connect to dashboard)\n\n" +
      "Click Continue — your Mac will ask for each permission.",
    buttons: ["Continue"],
    defaultId: 0,
  });

  // Request Accessibility permission (needed for app control)
  const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(true);

  if (!accessibilityGranted) {
    // Open System Settings to Accessibility
    await dialog.showMessageBox({
      type: "warning",
      title: "Accessibility Permission Needed",
      message: "Please grant Accessibility access to Vnus Agent.",
      detail:
        "System Settings will open.\n\n" +
        "1. Find 'Vnus Agent' in the list\n" +
        "2. Toggle it ON\n" +
        "3. Come back to Vnus Agent\n\n" +
        "This allows Vnus to control apps on your behalf.",
      buttons: ["Open System Settings", "Skip for Now"],
      defaultId: 0,
    }).then((r) => {
      if (r.response === 0) {
        shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
      }
    });
  }

  // Add to startup (launchd on Mac)
  addToMacStartup();

  return true;
}

// ─── LINUX: Request Permissions ───────────────────────────
async function requestLinuxPermissions() {
  await dialog.showMessageBox({
    type: "info",
    title: "Vnus Agent — Setup",
    message: "Setting up Vnus Agent on Linux",
    detail:
      "Vnus Agent will:\n\n" +
      "✅  Run in system tray\n" +
      "✅  Access your file system\n" +
      "✅  Connect to Vnus dashboard\n" +
      "✅  Start on login\n\n" +
      "Click Continue to complete setup.",
    buttons: ["Continue"],
    defaultId: 0,
  });

  // Add to autostart on Linux
  addToLinuxStartup();
  return true;
}

// ─── MAC Startup (LaunchAgent) ────────────────────────────
function addToMacStartup() {
  try {
    const appPath = app.getPath("exe");
    const launchAgentDir = path.join(os.homedir(), "Library", "LaunchAgents");
    const plistPath = path.join(launchAgentDir, "ai.vnus.agent.plist");

    if (!fs.existsSync(launchAgentDir)) fs.mkdirSync(launchAgentDir, { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.vnus.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>`;

    fs.writeFileSync(plistPath, plist);
    execSync(`launchctl load "${plistPath}"`);
  } catch (err) {
    console.error("Mac startup error:", err);
  }
}

// ─── LINUX Startup (autostart) ────────────────────────────
function addToLinuxStartup() {
  try {
    const appPath = app.getPath("exe");
    const autostartDir = path.join(os.homedir(), ".config", "autostart");
    if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });

    const desktop = `[Desktop Entry]
Type=Application
Name=Vnus Agent
Exec=${appPath}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=Vnus AI Agent`;

    fs.writeFileSync(path.join(autostartDir, "vnus-agent.desktop"), desktop);
  } catch (err) {
    console.error("Linux startup error:", err);
  }
}

// ─── WINDOWS Startup (Registry) ───────────────────────────
function addToWindowsStartup() {
  try {
    const appPath = app.getPath("exe");
    const { execSync } = require("child_process");
    execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "VnusAgent" /t REG_SZ /d "${appPath}" /f`);
  } catch (err) {
    console.error("Windows startup error:", err);
  }
}

// ─── Platform-specific permission request ─────────────────
async function requestPermissions() {
  if (PLATFORM === "win32") return await requestWindowsPermissions();
  if (PLATFORM === "darwin") return await requestMacPermissions();
  if (PLATFORM === "linux") return await requestLinuxPermissions();
  return true;
}

// ─── Add to startup based on platform ─────────────────────
function addToStartup() {
  if (PLATFORM === "win32") addToWindowsStartup();
  else if (PLATFORM === "darwin") addToMacStartup();
  else if (PLATFORM === "linux") addToLinuxStartup();
}

// ─── Splash Window ────────────────────────────────────────
function createSplashWindow(code, isFirstTime) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWindow = new BrowserWindow({
    width: 480,
    height: 620,
    x: Math.round((width - 480) / 2),
    y: Math.round((height - 620) / 2),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#050505",
    show: false,
    // Mac specific
    ...(PLATFORM === "darwin" ? { vibrancy: "dark", visualEffectState: "active" } : {}),
  });

  splashWindow.loadFile(path.join(__dirname, "../renderer/splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    splashWindow.webContents.send("agent-data", {
      code,
      isFirstTime,
      pcName: os.hostname(),
      os: getOSName(),
      platform: PLATFORM,
    });
  });
  splashWindow.on("closed", () => { splashWindow = null; });
}

// ─── System Tray ──────────────────────────────────────────
function createTray(state) {
  const iconName = PLATFORM === "win32" ? "tray-icon.png" : "tray-icon.png";
  const iconPath = path.join(__dirname, "../assets", iconName);

  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Vnus Agent — Running");

  const updateMenu = (connected) => {
    const menu = Menu.buildFromTemplate([
      { label: "Vnus Agent", enabled: false },
      { type: "separator" },
      { label: connected ? "● Connected" : "○ Waiting for connection...", enabled: false },
      { type: "separator" },
      {
        label: "Show Agent Code",
        click: () => {
          const st = loadState();
          createSplashWindow(st.agentCode, false);
        },
      },
      { label: "Open Dashboard", click: () => shell.openExternal("https://vnus.ai/dashboard") },
      { type: "separator" },
      { label: "Quit Vnus Agent", click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };

  updateMenu(!!state.userId);
  tray.on("double-click", () => {
    const st = loadState();
    createSplashWindow(st.agentCode, false);
  });

  return updateMenu;
}

// ─── IPC Handlers ─────────────────────────────────────────
ipcMain.on("close-splash", () => { if (splashWindow) splashWindow.close(); });
ipcMain.on("open-dashboard", () => shell.openExternal("https://vnus.ai/dashboard"));
ipcMain.on("refresh-code", async (event) => {
  const state = loadState();
  const pcInfo = getPCInfo();
  const newCode = generateAgentCode();
  await saveCodeToFirestore(newCode, pcInfo);
  state.agentCode = newCode;
  state.codeCreatedAt = new Date().toISOString();
  saveState(state);
  event.reply("code-refreshed", newCode);
});

// ─── App Ready ────────────────────────────────────────────
app.whenReady().then(async () => {
  // Mac dock hide karo (tray app hai)
  if (PLATFORM === "darwin") app.dock.hide();

  // Single instance
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  app.on("second-instance", () => {
    if (splashWindow) splashWindow.focus();
    else { const st = loadState(); createSplashWindow(st.agentCode, false); }
  });

  let state = loadState();
  const isFirstTime = !state.isSetup;

  if (isFirstTime) {
    // Request platform-specific permissions
    const granted = await requestPermissions();
    if (!granted) { app.quit(); return; }

    // Add to startup
    addToStartup();

    // Generate code
    const pcInfo = getPCInfo();
    const code = generateAgentCode();
    await saveCodeToFirestore(code, pcInfo);

    state = {
      isSetup: true,
      agentCode: code,
      userId: null,
      codeCreatedAt: new Date().toISOString(),
    };
    saveState(state);

    // Show splash
    createSplashWindow(code, true);

    // Listen for connection
    listenForConnection(code, (userId) => {
      state.userId = userId;
      saveState(state);
      if (splashWindow) splashWindow.webContents.send("workspace-connected", { userId });
    });

  } else {
    // Returning user — regenerate code if expired
    const codeAge = state.codeCreatedAt ? Date.now() - new Date(state.codeCreatedAt).getTime() : Infinity;
    if (!state.agentCode || codeAge > 10 * 60 * 1000) {
      const code = generateAgentCode();
      const pcInfo = getPCInfo();
      await saveCodeToFirestore(code, pcInfo);
      state.agentCode = code;
      state.codeCreatedAt = new Date().toISOString();
      saveState(state);
    }
  }

  // Create tray
  const updateMenu = createTray(state);

  // Listen for connection if not connected
  if (!state.userId && state.agentCode) {
    listenForConnection(state.agentCode, (userId) => {
      state.userId = userId;
      saveState(state);
      updateMenu(true);
      if (splashWindow) splashWindow.webContents.send("workspace-connected", { userId });
    });
  } else if (state.userId) {
    updateMenu(true);
  }
});

// Keep running in tray
app.on("window-all-closed", (e) => { if (!isQuitting) e.preventDefault(); });
app.on("before-quit", () => { isQuitting = true; });

// Mac: reopen on dock click
app.on("activate", () => {
  const st = loadState();
  if (!splashWindow) createSplashWindow(st.agentCode, false);
});