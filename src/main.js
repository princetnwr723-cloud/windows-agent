// src/main.js
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, screen, systemPreferences } = require("electron");
const path = require("path");
const os   = require("os");
const fs   = require("fs");
const { execSync, exec } = require("child_process");

const { firebaseConfig }       = require("./config");
const { startCommandListener } = require("./agent/listener");
const { getPCSpecs }           = require("./agent/specs");
const { getModelOptions }      = require("./agent/modelSelector");
const { setupModel, isOllamaRunning, startOllama } = require("./agent/ollamaManager");

// ── App Config ────────────────────────────────────────────
const IS_DEV   = process.argv.includes("--dev");
const PLATFORM = os.platform();
const DATA_DIR = path.join(app.getPath("userData"), "vnus-agent");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let tray         = null;
let splashWindow = null;
let isQuitting   = false;

// ── State ─────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return {
    isSetup:        false,
    agentCode:      null,
    userId:         null,
    codeCreatedAt:  null,
    plan:           "free",
    selectedModel:  null,   // { ollamaId, name, visionEnabled, visionOllamaId }
    modelReady:     false,
  };
}
function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Generate code ─────────────────────────────────────────
function generateAgentCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── PC Info ───────────────────────────────────────────────
function getPCInfo() {
  return {
    pcName:      os.hostname(),
    os:          `${getOSName()} ${os.release()}`,
    platform:    PLATFORM,
    arch:        os.arch(),
    username:    os.userInfo().username,
    totalMemory: Math.round(os.totalmem() / (1024 ** 3)) + " GB",
  };
}
function getOSName() {
  if (PLATFORM === "win32")  return "Windows";
  if (PLATFORM === "darwin") return "macOS";
  return "Linux";
}

// ── Firestore ─────────────────────────────────────────────
async function saveCodeToFirestore(code, pcInfo) {
  const url  = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}`;
  const body = {
    fields: {
      code:      { stringValue: code },
      status:    { stringValue: "waiting" },
      userId:    { nullValue: null },
      pcName:    { stringValue: pcInfo.pcName },
      os:        { stringValue: pcInfo.os },
      platform:  { stringValue: pcInfo.platform },
      arch:      { stringValue: pcInfo.arch },
      username:  { stringValue: pcInfo.username },
      createdAt: { stringValue: new Date().toISOString() },
      expiresAt: { stringValue: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    },
  };
  try {
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch (err) {
    console.error("Firestore error:", err);
    return false;
  }
}

// ── Fetch user plan from Firestore ────────────────────────
async function fetchUserPlan(userId) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/users/${userId}?key=${firebaseConfig.apiKey}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    return data?.fields?.plan?.stringValue || "free";
  } catch {
    return "free";
  }
}

// ── Listen for connection ─────────────────────────────────
function listenForConnection(code, onConnected) {
  const url  = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}`;
  const poll = setInterval(async () => {
    try {
      const res    = await fetch(url);
      const data   = await res.json();
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

// ── Platform permissions ──────────────────────────────────
async function requestPermissions() {
  if (PLATFORM === "win32") {
    const r = await dialog.showMessageBox({
      type: "info", title: "Vnus Agent — Permissions",
      message: "Vnus Agent needs permissions to run.",
      detail: "✅ File system access\n✅ Network access\n✅ Run at startup\n✅ Install local AI model",
      buttons: ["Grant & Continue", "Cancel"], defaultId: 0, cancelId: 1,
    });
    return r.response === 0;
  }
  if (PLATFORM === "darwin") {
    await dialog.showMessageBox({
      type: "info", title: "Vnus Agent — Permissions",
      message: "Vnus Agent needs a few permissions.",
      detail: "✅ Accessibility access\n✅ Full Disk Access\n✅ Network access\n✅ Install local AI model",
      buttons: ["Continue"], defaultId: 0,
    });
    systemPreferences.isTrustedAccessibilityClient(true);
    addToMacStartup();
    return true;
  }
  addToLinuxStartup();
  return true;
}

// ── Startup helpers ───────────────────────────────────────
function addToMacStartup() {
  try {
    const appPath       = app.getPath("exe");
    const launchDir     = path.join(os.homedir(), "Library", "LaunchAgents");
    const plistPath     = path.join(launchDir, "ai.vnus.agent.plist");
    if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.vnus.agent</string>
  <key>ProgramArguments</key><array><string>${appPath}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
</dict></plist>`;
    fs.writeFileSync(plistPath, plist);
    execSync(`launchctl load "${plistPath}"`);
  } catch {}
}
function addToLinuxStartup() {
  try {
    const appPath     = app.getPath("exe");
    const autostartDir = path.join(os.homedir(), ".config", "autostart");
    if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(path.join(autostartDir, "vnus-agent.desktop"),
      `[Desktop Entry]\nType=Application\nName=Vnus Agent\nExec=${appPath}\nHidden=false\nNoDisplay=false\nX-GNOME-Autostart-enabled=true`);
  } catch {}
}
function addToWindowsStartup() {
  try {
    const appPath = app.getPath("exe");
    execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "VnusAgent" /t REG_SZ /d "${appPath}" /f`);
  } catch {}
}
function addToStartup() {
  if (PLATFORM === "win32")  addToWindowsStartup();
  if (PLATFORM === "darwin") addToMacStartup();
  if (PLATFORM === "linux")  addToLinuxStartup();
}

// ── Splash Window ─────────────────────────────────────────
function createSplashWindow(code, isFirstTime) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWindow = new BrowserWindow({
    width: 480, height: 680,
    x: Math.round((width - 480) / 2),
    y: Math.round((height - 680) / 2),
    frame: false, resizable: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    backgroundColor: "#050505", show: false,
    ...(PLATFORM === "darwin" ? { vibrancy: "dark", visualEffectState: "active" } : {}),
  });
  splashWindow.loadFile(path.join(__dirname, "../renderer/splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    splashWindow.webContents.send("agent-data", {
      code, isFirstTime,
      pcName: os.hostname(),
      os:     getOSName(),
      platform: PLATFORM,
    });
  });
  splashWindow.on("closed", () => { splashWindow = null; });
}

// ── System Tray ───────────────────────────────────────────
function createTray(state) {
  const iconPath = path.join(__dirname, "../assets/tray-icon.png");
  let icon;
  try { icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }); }
  catch { icon = nativeImage.createEmpty(); }

  tray = new Tray(icon);
  tray.setToolTip("Vnus Agent — Running");

  const updateMenu = (connected) => {
    const menu = Menu.buildFromTemplate([
      { label: "Vnus Agent", enabled: false },
      { type: "separator" },
      { label: connected ? "● Connected" : "○ Waiting...", enabled: false },
      { type: "separator" },
      { label: "Show Agent Code", click: () => { const st = loadState(); createSplashWindow(st.agentCode, false); } },
      { label: "Open Dashboard", click: () => shell.openExternal("https://vnus.ai/dashboard") },
      { type: "separator" },
      { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };

  updateMenu(!!state.userId);
  tray.on("double-click", () => { const st = loadState(); createSplashWindow(st.agentCode, false); });
  return updateMenu;
}

// ── IPC Handlers ──────────────────────────────────────────
ipcMain.on("close-splash", () => { if (splashWindow) splashWindow.close(); });
ipcMain.on("open-dashboard", () => shell.openExternal("https://vnus.ai/dashboard"));

ipcMain.on("refresh-code", async (event) => {
  const state  = loadState();
  const pcInfo = getPCInfo();
  const code   = generateAgentCode();
  await saveCodeToFirestore(code, pcInfo);
  state.agentCode      = code;
  state.codeCreatedAt  = new Date().toISOString();
  saveState(state);
  event.reply("code-refreshed", code);
});

// Model selected by user in splash
ipcMain.on("model-selected", async (event, { modelOption, visionEnabled, visionModel }) => {
  const state = loadState();

  // Save selection
  state.selectedModel = {
    ollamaId:       modelOption.ollamaId,
    name:           modelOption.name,
    visionEnabled,
    visionOllamaId: visionEnabled && visionModel ? visionModel.ollamaId : null,
  };
  saveState(state);

  // Start setup
  splashWindow?.webContents.send("setup-progress", { step: "ollama", message: "Setting up AI engine...", percent: 0 });

  const modelsToSetup = [modelOption.ollamaId];
  if (visionEnabled && visionModel) modelsToSetup.push(visionModel.ollamaId);

  for (const modelId of modelsToSetup) {
    const result = await setupModel(modelId, (progress) => {
      splashWindow?.webContents.send("setup-progress", progress);
    });
    if (!result.success) {
      splashWindow?.webContents.send("setup-error", { message: result.error });
      return;
    }
  }

  state.modelReady = true;
  saveState(state);
  splashWindow?.webContents.send("model-ready");
});

// ── App Ready ─────────────────────────────────────────────
app.whenReady().then(async () => {
  if (PLATFORM === "darwin") app.dock.hide();

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  app.on("second-instance", () => {
    if (splashWindow) splashWindow.focus();
    else { const st = loadState(); createSplashWindow(st.agentCode, false); }
  });

  let state       = loadState();
  const isFirst   = !state.isSetup;
  const pcInfo    = getPCInfo();
  const specs     = getPCSpecs();

  if (isFirst) {
    const granted = await requestPermissions();
    if (!granted) { app.quit(); return; }
    addToStartup();

    const code = generateAgentCode();
    await saveCodeToFirestore(code, pcInfo);

    state = {
      isSetup:       true,
      agentCode:     code,
      userId:        null,
      codeCreatedAt: new Date().toISOString(),
      plan:          "free",
      selectedModel: null,
      modelReady:    false,
    };
    saveState(state);
    createSplashWindow(code, true);

    // Send specs to splash for model picker
    splashWindow?.once("ready-to-show", () => {
      const modelOptions = getModelOptions("free", specs);
      splashWindow?.webContents.send("show-model-picker", { specs, modelOptions });
    });

    listenForConnection(code, async (userId) => {
      state.userId = userId;
      // Fetch plan from Firestore
      const plan   = await fetchUserPlan(userId);
      state.plan   = plan;

      // Re-compute model options with actual plan
      if (!state.modelReady) {
        const modelOptions = getModelOptions(plan, specs);
        splashWindow?.webContents.send("show-model-picker", { specs, modelOptions, plan });
      }

      saveState(state);
      splashWindow?.webContents.send("workspace-connected", { userId, plan });
    });

  } else {
    // Returning user
    const codeAge = state.codeCreatedAt ? Date.now() - new Date(state.codeCreatedAt).getTime() : Infinity;
    if (!state.agentCode || codeAge > 10 * 60 * 1000) {
      const code = generateAgentCode();
      await saveCodeToFirestore(code, pcInfo);
      state.agentCode     = code;
      state.codeCreatedAt = new Date().toISOString();
      saveState(state);
    }

    // If model not ready, show picker again
    if (!state.modelReady || !state.selectedModel) {
      createSplashWindow(state.agentCode, false);
      const plan         = state.userId ? await fetchUserPlan(state.userId) : "free";
      const modelOptions = getModelOptions(plan, specs);
      splashWindow?.once("ready-to-show", () => {
        splashWindow?.webContents.send("show-model-picker", { specs, modelOptions, plan });
      });
    }
  }

  const updateMenu = createTray(state);

  // If already connected + model ready → start listener
  if (state.userId && state.modelReady && state.selectedModel) {
    updateMenu(true);
    startCommandListener(state.agentCode, firebaseConfig, state.selectedModel);
  } else if (!state.userId && state.agentCode) {
    listenForConnection(state.agentCode, async (userId) => {
      state.userId = userId;
      const plan   = await fetchUserPlan(userId);
      state.plan   = plan;
      saveState(state);
      updateMenu(true);
      splashWindow?.webContents.send("workspace-connected", { userId, plan });
      if (state.modelReady && state.selectedModel) {
        startCommandListener(state.agentCode, firebaseConfig, state.selectedModel);
      }
    });
  }
});

app.on("window-all-closed", (e) => { if (!isQuitting) e.preventDefault(); });
app.on("before-quit", () => { isQuitting = true; });
app.on("activate", () => {
  const st = loadState();
  if (!splashWindow) createSplashWindow(st.agentCode, false);
});