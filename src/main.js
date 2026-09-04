// src/main.js — Complete with RTDB + Scheduler
const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  shell, dialog, ipcMain, screen,
} = require("electron");
// Auto-updater disabled — electron-updater wasn't bundled into the
// packaged app (missing from the build), which crashed the app on
// launch with "Cannot find module 'electron-updater'". Re-enable
// once it's confirmed present in package.json dependencies AND
// electron-builder's output — see setupAutoUpdater() below.
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
  console.log(`📡 Registering agent at /workspaces/${code} on ${RTDB_URL}`);
  try {
    const result = await rtdbSet(RTDB_URL, `/workspaces/${code}`, {
      code, userId: null, userDisconnected: false,
      status: "waiting", agentOnline: true,
      pcName: pcInfo.pcName, os: pcInfo.os,
      platform: pcInfo.platform, username: pcInfo.username,
      totalMemory: pcInfo.totalMemory,
      registeredAt: Date.now(),
    }, firebaseConfig.apiKey);
    console.log(`✅ Agent registered:`, result ? "success" : "NULL RESPONSE — check RTDB rules / RTDB_URL");
    return result;
  } catch (err) {
    console.error(`❌ Agent registration FAILED — check that RTDB rules are published and RTDB_URL is correct:`, err.message);
    throw err;
  }
}

// ── FIX: previously this ONLY subscribed to future SSE changes.
// If the workspace was ALREADY connected in RTDB from a previous
// session (e.g. local state.json got reset/lost but RTDB still has
// status:"connected" + userId — exactly what happens if the agent
// connects successfully once, then is relaunched with a fresh/empty
// state.json), no NEW event would ever fire, since nothing new is
// changing in RTDB. The splash screen would sit on "Waiting for
// connection..." forever even though the website already shows it
// as connected.
//
// Fix #1 (existing): do an immediate one-time rtdbGet() check FIRST,
// synchronously before subscribing. If the workspace is already
// connected, trigger onConnected() right away instead of waiting for
// a change that already happened in the past.
//
// Fix #2 (NEW): the raw SSE connection (`eventsource` package) can
// die silently — no error, no close event — behind some firewalls,
// antivirus products, or corporate proxies that don't like
// long-lived streaming HTTP connections. When that happens, register
// and connect both still work fine (they're just one-shot REST
// calls), but the agent NEVER finds out the workspace flipped to
// "connected" because the live stream that would tell it is dead.
// This is exactly the "workspace shows connected on the website but
// agent is stuck on Waiting for connection..." bug.
//
// Fix: add a lightweight polling fallback (every 4s) alongside the
// SSE listener. Whichever one notices the change first wins — SSE
// is still the fast path when it's healthy, but the poll guarantees
// the agent can never get permanently stuck even if SSE is silently
// dead the whole time.
async function listenForConnection(code, onConnected, onDisconnected) {
  const { listenRTDB, rtdbGet } = require("./agent/listener");

  let resolved  = false;
  let pollTimer = null;

  const checkAndTrigger = (data) => {
    if (!data || resolved) return;
    const status           = data.status;
    const userId           = data.userId;
    const userDisconnected = data.userDisconnected;
    const plan             = data.plan;

    if (userDisconnected && status === "disconnected") {
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      onDisconnected?.();
    } else if (status === "connected" && userId && !userDisconnected) {
      console.log(`✅ Connection detected — userId: ${userId}`);
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      onConnected(userId, plan);
    }
  };

  // ── Immediate check — catches the case where connection already
  // happened before this listener started ──
  try {
    console.log(`🔍 Checking current state of /workspaces/${code}...`);
    const current = await rtdbGet(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey);
    if (current) {
      console.log(`🔍 Current state:`, JSON.stringify({
        status: current.status,
        userId: current.userId,
        plan: current.plan,
        userDisconnected: current.userDisconnected,
      }));
      checkAndTrigger(current);
    } else {
      console.log(`🔍 No existing data at /workspaces/${code}`);
    }
  } catch (err) {
    console.error("❌ Initial connection check failed:", err.message);
  }

  if (resolved) return;

  // ── Then keep listening for any FUTURE changes too (fast path) ──
  console.log(`👂 Listening for live changes at /workspaces/${code}`);
  listenRTDB(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey, (event, payload) => {
    const data = payload?.data;
    if (!data) return;
    checkAndTrigger(data);
  });

  // ── NEW: polling safety net — guarantees detection even if the
  // SSE stream above is silently dead (firewall/AV interference) ──
  console.log(`⏱️ Starting connection poll fallback for /workspaces/${code} (every 4s)`);
  pollTimer = setInterval(async () => {
    if (resolved) { clearInterval(pollTimer); return; }
    try {
      const current = await rtdbGet(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey);
      checkAndTrigger(current);
    } catch (err) {
      console.error("⚠️ Connection poll check failed:", err.message);
    }
  }, 4000);
}

// ── FIX: same issue as above, plus this now reads /workspaces/{code}
// instead of the auth-protected /users/{userId} node (the Electron
// agent has no Firebase Auth session, so that read always failed
// silently before). PlanWall.tsx and the Gumroad webhook mirror the
// plan into /workspaces/{code}, which is open in RTDB rules.
//
// Same SSE-can-die-silently risk applies here too, so this also gets
// the polling fallback.
async function listenForPlanVerification(code, onVerified) {
  const { listenRTDB, rtdbGet } = require("./agent/listener");

  let resolved  = false;
  let pollTimer = null;

  const checkAndTrigger = (data) => {
    if (!data || resolved) return;
    const plan         = data.plan;
    const planVerified = data.planVerified;
    if (plan && (planVerified === true || plan === "free")) {
      console.log(`✅ Plan detected: ${plan}`);
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      onVerified(plan);
    }
  };

  // ── Immediate check first — catches plan already set before this
  // listener started (e.g. free plan chosen very fast, or relaunch
  // after state.json was lost) ──
  try {
    console.log(`🔍 Checking current plan at /workspaces/${code}...`);
    const current = await rtdbGet(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey);
    checkAndTrigger(current);
    if (resolved) return; // already have it — no need to also subscribe
  } catch (err) {
    console.error("❌ Initial plan check failed:", err.message);
  }

  // ── Then listen for future changes (fast path) ──
  console.log(`👂 Listening for plan at /workspaces/${code}`);
  listenRTDB(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey, (event, payload) => {
    checkAndTrigger(payload?.data);
  });

  // ── NEW: polling safety net ──
  console.log(`⏱️ Starting plan poll fallback for /workspaces/${code} (every 4s)`);
  pollTimer = setInterval(async () => {
    if (resolved) { clearInterval(pollTimer); return; }
    try {
      const current = await rtdbGet(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey);
      checkAndTrigger(current);
    } catch (err) {
      console.error("⚠️ Plan poll check failed:", err.message);
    }
  }, 4000);
}

// ── Auto Updater — DISABLED ─────────────────────────────────
// Was crashing the packaged app because electron-updater wasn't
// actually bundled in. Kept as a no-op stub (not deleted outright)
// so any existing call to setupAutoUpdater() elsewhere in this
// file still runs safely instead of throwing.
//
// To re-enable later:
//   1. Confirm "electron-updater" is in package.json "dependencies"
//      (not devDependencies)
//   2. Rebuild and verify resources/app.asar actually contains
//      node_modules/electron-updater after packaging
//   3. Restore the code below (kept commented, unchanged)
function setupAutoUpdater() {
  console.log("ℹ️ Auto-updater disabled for this build — checking manually via GitHub Releases instead");
  return;

  /* ORIGINAL IMPLEMENTATION — restore once electron-updater is
     confirmed bundled correctly in the packaged app:

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
  */
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
      { label: "Check for Updates", click: () => {
        shell.openExternal("https://github.com/princetnwr723-cloud/windows-agent/releases/latest");
      }},
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

  // ── Sanity check: fail loud instead of silent if RTDB_URL is missing ──
  if (!RTDB_URL) {
    console.error("❌ FATAL: firebaseConfig.rtdbUrl is empty — agent cannot register or listen for anything. Check src/config.js / FIREBASE_RTDB_URL env var.");
    dialog.showErrorBox("Configuration Error", "Realtime Database URL is not configured. The agent cannot connect. Please reinstall or contact support.");
  } else {
    console.log(`🔗 RTDB URL: ${RTDB_URL}`);
  }

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
    try {
      await rtdbRegisterAgent(code, pcInfo);
    } catch (err) {
      dialog.showErrorBox(
        "Could not register agent",
        `Failed to write to the database. Check your internet connection and that Realtime Database rules are published.\n\n${err.message}`
      );
    }
    state = saveState({ isSetup: true, agentCode: code, userId: null, plan: null, planVerified: false, selectedModel: null, modelReady: false, userDisconnected: false });
  } else {
    state.agentCode = code;

    // ── FIX: previously, if this fetch FAILED for any reason
    // (network hiccup on cold boot, transient RTDB permission issue,
    // etc.), the code treated that failure identically to "the
    // workspace node genuinely doesn't exist" and RE-REGISTERED the
    // agent — which overwrites RTDB back to status:"waiting",
    // userId:null, silently DESTROYING an already-working connection.
    // This is what caused the observed toggle: connect → works once
    // after restart → next restart wipes it back to "waiting".
    //
    // Now: only re-register when the fetch SUCCEEDS and confirms the
    // path is truly empty (wsData === null). If the fetch throws
    // (fetchFailed), we do NOTHING here — no re-register, no state
    // reset — and just let listenForConnection()'s own immediate
    // check + live SSE subscription (called later) keep trying. That
    // way a flaky network moment can never destroy a real connection.
    let wsData;
    let fetchFailed = false;
    try {
      wsData = await rtdbGet(RTDB_URL, `/workspaces/${code}`, firebaseConfig.apiKey);
    } catch (err) {
      console.error("⚠️ Could not read existing workspace state — will NOT touch RTDB, retrying via listener instead:", err.message);
      fetchFailed = true;
    }

    if (!fetchFailed) {
      if (wsData?.userDisconnected) {
        state = saveState({ userId: null, userDisconnected: true, plan: null, planVerified: false, modelReady: false, selectedModel: null });
        try {
          await rtdbPatch(RTDB_URL, `/workspaces/${code}`, { status: "waiting", userId: null, userDisconnected: false }, firebaseConfig.apiKey);
        } catch (err) {
          console.error("⚠️ Could not reset disconnected workspace:", err.message);
        }
      } else if (wsData === null) {
        // Confirmed empty — safe to register fresh
        console.log(`ℹ️ /workspaces/${code} confirmed empty — registering fresh`);
        const pcInfo = getPCInfo();
        try {
          await rtdbRegisterAgent(code, pcInfo);
        } catch (err) {
          dialog.showErrorBox("Could not re-register agent", err.message);
        }
      }
      // else: wsData has real data (already connected/waiting/etc.) —
      // leave it completely untouched.
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

        // ── If the plan was already written by the time we get the
        // connection event (e.g. free plan chosen very fast, or the
        // Gumroad webhook already fired, or this is the "already
        // connected from a previous session" case this whole fix is
        // for), skip straight to the model picker instead of showing
        // "waiting for plan" forever.
        if (planFromRTDB) {
          saveState({ plan: planFromRTDB, planVerified: true });
          sendToSplash("plan-verified", { plan: planFromRTDB });
          sendToSplash("show-model-picker", { specs, modelOptions: getModelOptions(planFromRTDB, specs), plan: planFromRTDB });
          return;
        }

        sendToSplash("waiting-for-plan", { message: "Waiting for plan selection..." });

        listenForPlanVerification(code, async (plan) => {
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