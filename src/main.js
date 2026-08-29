// src/main.js — Complete with RTDB + Auto-updater + Scheduler
const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  shell, dialog, ipcMain, screen,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path            = require("path");
const os              = require("os");
const fs              = require("fs");

const { firebaseConfig }        = require("./config");
const { startCommandListener }  = require("./agent/listener");
const { startScheduler }        = require("./agent/scheduler");
const { getPCSpecs }            = require("./agent/specs");
const { getModelOptions }       = require("./agent/modelSelector");
const { setupModel, isOllamaRunning, startOllama } = require("./agent/ollamaManager");
const { generatePermanentCode } = require("./agent/machineCode");
const { initMemory }            = require("./agent/memory");

const PLATFORM   = os.platform();
const DATA_DIR   = path.join(app.getPath("userData"), "agentic-vnus");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WEBSITE    = "https://agenticvnus.com";
const RTDB_URL   = firebaseConfig.rtdbUrl;

let tray            = null;
let splashWindow    = null;
let workspaceWindow = null;
let isQuitting      = false;
let listenerCleanup = null;

// ── State helpers ─────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadState() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return {
    isSetup: false, agentCode: null, userId: null,
    plan: null, planVerified: false,
    selectedModel: null, modelReady: false,
    userDisconnected: false,
  };
}
function saveState(updates) {
  ensureDataDir();
  const next = { ...loadState(), ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ── PC Info ───────────────────────────────────────────────
function getPCInfo() {
  return {
    pcName: os.hostname(), os: getOSName() + " " + os.release(),
    platform: PLATFORM, arch: os.arch(),
    username: os.userInfo().username,
    totalMemory: Math.round(os.totalmem() / (1024 ** 3)) + " GB",
  };
}
function getOSName() {
  if (PLATFORM === "win32")  return "Windows";
  if (PLATFORM === "darwin") return "macOS";
  return "Linux";
}

// ── RTDB helpers ──────────────────────────────────────────
const { rtdbSet, rtdbGet, rtdbPatch, rtdbDelete } = require("./agent/listener");

async function rtdbRegisterAgent(code, pcInfo) {
  await rtdbSet(RTDB_URL, `/workspaces/${code}`, {
    code, userId: null, userDisconnected: false,
    status: "waiting", agentOnline: true,
    pcName: pcInfo.pcName, os: pcInfo.os,
    platform: pcInfo.platform, username: pcInfo.username,
    totalMemory: pcInfo.totalMemory,
    registeredAt: Date.now(),
  }, firebaseConfig.apiKey);
}

async function listenForConnection(code, onConnected, onDisconnected) {
  const { listenRTDB } = require("./agent/listener");
  listenRTDB(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey, (event, payload) => {
    const data = payload?.data;
    if (!data) return;
    const status          = data.status;
    const userId          = data.userId;
    const userDisconnected = data.userDisconnected;
    const plan            = data.plan;

    if (userDisconnected && status === "disconnected") {
      onDisconnected?.();
    } else if (status === "connected" && userId && !userDisconnected) {
      onConnected(userId, plan);
    }
  });
}

async function listenForPlanVerification(userId, onVerified) {
  const { listenRTDB } = require("./agent/listener");
  listenRTDB(RTDB_URL, `/users/${userId}`, firebaseConfig.apiKey, (event, payload) => {
    const data = payload?.data;
    if (!data) return;
    const plan         = data.plan;
    const planVerified = data.planVerified;
    if (plan && (planVerified === true || plan === "free")) {
      onVerified(plan);
    }
  });
}

// ── Auto Updater ──────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("🔍 Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`📦 Update available: v${info.version}`);
    tray?.setToolTip(`Agentic Vnus — Downloading update v${info.version}...`);
    sendToSplash("update-status", { status: "downloading", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("✅ App is up to date");
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`📥 Update download: ${pct}%`);
    tray?.setToolTip(`Agentic Vnus — Update ${pct}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`✅ Update downloaded: v${info.version}`);
    tray?.setToolTip("Agentic Vnus — Update ready");

    dialog.showMessageBox({
      type:      "info",
      title:     "Update Ready — Agentic Vnus",
      message:   `v${info.version} is ready to install`,
      detail:    "The update has been downloaded. Restart now to apply it — takes less than 30 seconds.",
      buttons:   ["Restart & Install", "Later"],
      defaultId: 0,
      icon:      path.join(__dirname, "../assets/icon.png"),
    }).then(result => {
      if (result.response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("❌ Auto-update error:", err.message);
  });

  // Check on startup, then every 4 hours
  setTimeout(() => autoUpdater.checkForUpdates(), 10000);
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}

// ── Splash helpers ────────────────────────────────────────
function sendToSplash(event, data) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(event, data);
  }
}

// ── Splash Window ─────────────────────────────────────────
function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.focus(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWindow = new BrowserWindow({
    width: 480, height: 700,
    x: Math.round((width - 480) / 2), y: Math.round((height - 700) / 2),
    frame: false, resizable: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    backgroundColor: "#050505", show: false,
  });
  splashWindow.loadFile(path.join(__dirname, "../renderer/splash.html"));
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  splashWindow.on("closed", () => { splashWindow = null; });
}

// ── Workspace Window ──────────────────────────────────────
function createWorkspaceWindow(code) {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) { workspaceWindow.focus(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  workspaceWindow = new BrowserWindow({
    width: Math.min(1200, width - 40), height: Math.min(800, height - 40),
    x: Math.round((width - Math.min(1200, width - 40)) / 2),
    y: Math.round((height - Math.min(800, height - 40)) / 2),
    frame: true, resizable: true, title: "Agentic Vnus",
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    backgroundColor: "#050505", show: false,
  });
  workspaceWindow.loadURL(`${WEBSITE}/dashboard/workspace/${code}?agent=true`);
  workspaceWindow.once("ready-to-show", () => {
    workspaceWindow?.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });
  workspaceWindow.webContents.on("did-finish-load", () => {
    const st = loadState();
    workspaceWindow?.webContents.executeJavaScript(`
      window.__VNUS_AGENT__   = true;
      window.__WORKSPACE_ID__ = "${code}";
      window.__PLAN__         = "${st.plan || "free"}";
    `);
  });
  workspaceWindow.on("closed", () => { workspaceWindow = null; });
}

// ── Tray ──────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "../assets/tray-icon.png");
  let icon;
  try { icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }); }
  catch { icon = nativeImage.createEmpty(); }
  tray = new Tray(icon);
  tray.setToolTip("Agentic Vnus");

  const updateMenu = (connected = false) => {
    const st = loadState();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Agentic Vnus", enabled: false },
      { type: "separator" },
      { label: connected ? "● Connected" : "○ Waiting...", enabled: false },
      { type: "separator" },
      { label: "Open Workspace", enabled: connected && st.modelReady, click: () => createWorkspaceWindow(st.agentCode) },
      { label: "Open Website",   click: () => shell.openExternal(WEBSITE) },
      { type: "separator" },
      { label: "Check for Updates", click: () => autoUpdater.checkForUpdates() },
      { type: "separator" },
      { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
    ]));
  };

  tray.on("double-click", () => {
    const st = loadState();
    if (st.userId && st.modelReady && !st.userDisconnected) createWorkspaceWindow(st.agentCode);
    else createSplashWindow();
  });

  return updateMenu;
}

// ── IPC ───────────────────────────────────────────────────
ipcMain.on("close-splash",   () => splashWindow?.close());
ipcMain.on("open-dashboard", () => shell.openExternal(`${WEBSITE}/dashboard`));
ipcMain.on("open-workspace", () => { const st = loadState(); if (st.agentCode) createWorkspaceWindow(st.agentCode); });

ipcMain.on("model-selected", async (event, { modelOption, visionEnabled, visionModel }) => {
  saveState({ selectedModel: { ollamaId: modelOption.ollamaId, name: modelOption.name, visionEnabled, visionOllamaId: visionEnabled && visionModel ? visionModel.ollamaId : null } });
  sendToSplash("setup-progress", { step: "starting", message: "Starting AI engine...", percent: 5 });

  const running = await isOllamaRunning();
  if (!running) {
    sendToSplash("setup-progress", { step: "ollama", message: "Starting Ollama...", percent: 10 });
    await startOllama();
    await new Promise(r => setTimeout(r, 3000));
  }

  const models = [modelOption.ollamaId];
  if (visionEnabled && visionModel) models.push(visionModel.ollamaId);
  let allOk = true;

  for (let i = 0; i < models.length; i++) {
    const result = await setupModel(models[i], (p) => {
      const pct = (i === 0 ? 15 : 65) + Math.round((p.percent || 0) * (i === 0 ? 0.5 : 0.35));
      sendToSplash("setup-progress", { ...p, percent: Math.min(pct, 99) });
    });
    if (!result.success) {
      allOk = false;
      sendToSplash("setup-error", { message: result.error || `Failed to download ${models[i]}` });
      saveState({ modelReady: false, selectedModel: null });
      return;
    }
  }

  if (allOk) {
    saveState({ modelReady: true });
    sendToSplash("setup-progress", { step: "done", message: "AI ready!", percent: 100 });
    setTimeout(() => {
      sendToSplash("model-ready");
      const st = loadState();
      if (st.userId) {
        startFullAgent(st.agentCode, st.selectedModel)
          .catch(err => console.error("❌ startFullAgent error:", err.message));
        setTimeout(() => createWorkspaceWindow(st.agentCode), 1500);
      }
    }, 800);
  }
});

ipcMain.on("retry-model-download", () => {
  const st = loadState();
  if (st.plan && st.userId) {
    const specs = getPCSpecs();
    sendToSplash("show-model-picker", { specs, modelOptions: getModelOptions(st.plan, specs), plan: st.plan });
  }
});

// ── Start full agent (listener + scheduler) ───────────────
// NOTE: startCommandListener is now async (it awaits MCP init,
// agent status sync, etc. on startup) — this function must be
// async too, and must AWAIT it, or listenerCleanup ends up holding
// a Promise instead of the actual cleanup function, which crashes
// the next time it's called as listenerCleanup().
async function startFullAgent(code, selectedModel) {
  if (!selectedModel) return;
  const modelConfig = {
    ollamaId:       selectedModel.ollamaId,
    visionEnabled:  selectedModel.visionEnabled || false,
    visionOllamaId: selectedModel.visionOllamaId || null,
  };

  // Start RTDB command listener
  if (listenerCleanup) listenerCleanup();
  listenerCleanup = await startCommandListener(code, firebaseConfig, modelConfig);

  // Start scheduler
  startScheduler(code, firebaseConfig, modelConfig);

  console.log("🚀 Full agent started — Listener + Scheduler running");
}

// ── App Ready ─────────────────────────────────────────────
app.whenReady().then(async () => {
  if (PLATFORM === "darwin") app.dock?.hide();

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  app.on("second-instance", () => {
    const st = loadState();
    if (st.userId && st.modelReady && !st.userDisconnected) createWorkspaceWindow(st.agentCode);
    else if (splashWindow && !splashWindow.isDestroyed()) splashWindow.focus();
    else createSplashWindow();
  });

  initMemory();

  const code     = generatePermanentCode();
  let   state    = loadState();
  const updateMenu = createTray();
  const specs    = getPCSpecs();

  // Setup auto updater
  setupAutoUpdater();

  if (!state.isSetup) {
    const r = await dialog.showMessageBox({
      type: "info", title: "Agentic Vnus",
      message: "Agentic Vnus needs a few permissions to work.",
      detail: "✅ File system access\n✅ Network access\n✅ Run at startup\n✅ Install local AI model",
      buttons: ["Continue", "Cancel"], defaultId: 0, cancelId: 1,
    });
    if (r.response !== 0) { app.quit(); return; }

    const pcInfo = getPCInfo();
    await rtdbRegisterAgent(code, pcInfo);
    state = saveState({ isSetup: true, agentCode: code, userId: null, plan: null, planVerified: false, selectedModel: null, modelReady: false, userDisconnected: false });
  } else {
    state.agentCode = code;
    const wsData = await rtdbGet(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey);
    if (wsData?.userDisconnected) {
      state = saveState({ userId: null, userDisconnected: true, plan: null, planVerified: false, modelReady: false, selectedModel: null });
      await rtdbPatch(RTDB_URL, `/workspaces/${code}`, { status: "waiting", userId: null, userDisconnected: false }, firebaseConfig.apiKey);
    }
    if (!wsData) {
      const pcInfo = getPCInfo();
      await rtdbRegisterAgent(code, pcInfo);
    }
    saveState({ agentCode: code });
    state = loadState();
  }

  createSplashWindow();

  splashWindow?.once("ready-to-show", async () => {
    await new Promise(r => setTimeout(r, 300));
    const st = loadState();

    // Already fully ready
    if (st.userId && st.planVerified && st.modelReady && st.selectedModel && !st.userDisconnected) {
      updateMenu(true);
      sendToSplash("agent-data", { code: st.agentCode, pcName: os.hostname(), os: getOSName(), connected: true, plan: st.plan });
      await startFullAgent(st.agentCode, st.selectedModel);
      setTimeout(() => createWorkspaceWindow(st.agentCode), 800);
      return;
    }

    // Connected but model not ready
    if (st.userId && st.planVerified && !st.modelReady) {
      updateMenu(true);
      sendToSplash("agent-data", { code: st.agentCode, pcName: os.hostname(), os: getOSName(), connected: true, plan: st.plan });
      sendToSplash("show-model-picker", { specs, modelOptions: getModelOptions(st.plan, specs), plan: st.plan });
      return;
    }

    // Show code — waiting for connection
    sendToSplash("agent-data", { code: st.agentCode || code, pcName: os.hostname(), os: getOSName(), connected: false, plan: null });

    listenForConnection(code,
      async (userId, planFromRTDB) => {
        saveState({ userId, userDisconnected: false });
        updateMenu(true);
        sendToSplash("workspace-connected", { userId });
        sendToSplash("waiting-for-plan", { message: "Waiting for plan selection..." });

        listenForPlanVerification(userId, async (plan) => {
          saveState({ plan, planVerified: true });
          sendToSplash("plan-verified", { plan });
          sendToSplash("show-model-picker", { specs, modelOptions: getModelOptions(plan, specs), plan });
        });
      },
      async () => {
        saveState({ userId: null, userDisconnected: true, plan: null, planVerified: false, modelReady: false, selectedModel: null });
        updateMenu(false);
        workspaceWindow?.close();
        createSplashWindow();
        setTimeout(() => sendToSplash("agent-data", { code, pcName: os.hostname(), os: getOSName(), connected: false, plan: null }), 500);
      }
    );
  });
});

app.on("window-all-closed", (e) => { if (!isQuitting) e.preventDefault(); });
app.on("before-quit", () => { isQuitting = true; listenerCleanup?.(); });
app.on("activate", () => {
  const st = loadState();
  if (st.userId && st.modelReady && !st.userDisconnected) createWorkspaceWindow(st.agentCode);
  else createSplashWindow();
});