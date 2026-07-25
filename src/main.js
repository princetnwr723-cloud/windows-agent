// src/main.js — Agentic Vnus Desktop Agent
// Flow: Install → Splash+Code → Website Connect → Plan → Model Download → Workspace

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  shell, dialog, ipcMain, screen, systemPreferences,
} = require("electron");
const path         = require("path");
const os           = require("os");
const fs           = require("fs");
const { execSync } = require("child_process");

const { firebaseConfig }        = require("./config");
const { startCommandListener }  = require("./agent/listener");
const { getPCSpecs }            = require("./agent/specs");
const { getModelOptions }       = require("./agent/modelSelector");
const { setupModel, isOllamaRunning, startOllama } = require("./agent/ollamaManager");
const { generatePermanentCode } = require("./agent/machineCode");

// ── Config ────────────────────────────────────────────────
const PLATFORM   = os.platform();
const DATA_DIR   = path.join(app.getPath("userData"), "agentic-vnus");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WEBSITE    = "https://agentic-vnus.vercel.app"; // production URL

let tray            = null;
let splashWindow    = null;
let workspaceWindow = null;
let isQuitting      = false;
let commandListener = null;

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
    isSetup:          false,
    agentCode:        null,
    userId:           null,
    plan:             null,      // null = plan not chosen yet
    planVerified:     false,     // true = Gumroad payment confirmed
    selectedModel:    null,
    modelReady:       false,
    userDisconnected: false,
  };
}

function saveState(updates) {
  ensureDataDir();
  const current = loadState();
  const next    = { ...current, ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
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

// ── Firestore REST helpers ────────────────────────────────
const FS_BASE = () =>
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

async function firestoreGet(path) {
  try {
    const res  = await fetch(`${FS_BASE()}/${path}?key=${firebaseConfig.apiKey}`);
    const data = await res.json();
    return data?.fields || null;
  } catch { return null; }
}

async function firestorePatch(path, fields, maskFields = null) {
  try {
    let url = `${FS_BASE()}/${path}?key=${firebaseConfig.apiKey}`;
    if (maskFields) {
      url += maskFields.map(f => `&updateMask.fieldPaths=${f}`).join("");
    }
    const firestoreFields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string")  firestoreFields[k] = { stringValue: v };
      if (typeof v === "boolean") firestoreFields[k] = { booleanValue: v };
      if (v === null)             firestoreFields[k] = { nullValue: null };
    }
    const res = await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ fields: firestoreFields }),
    });
    return res.ok;
  } catch { return false; }
}

// ── Save agent code to Firestore ──────────────────────────
async function registerAgent(code, pcInfo) {
  return firestorePatch(`agent_connections/${code}`, {
    code,
    status:           "waiting",
    userId:           null,
    userDisconnected: false,
    pcName:           pcInfo.pcName,
    os:               pcInfo.os,
    platform:         pcInfo.platform,
    arch:             pcInfo.arch,
    username:         pcInfo.username,
    createdAt:        new Date().toISOString(),
    permanent:        "true",
  });
}

// ── Poll for connection ───────────────────────────────────
function listenForConnection(code, onConnected, onDisconnected) {
  const poll = setInterval(async () => {
    try {
      const fields          = await firestoreGet(`agent_connections/${code}`);
      if (!fields) return;
      const status          = fields?.status?.stringValue;
      const userId          = fields?.userId?.stringValue;
      const userDisconnected = fields?.userDisconnected?.booleanValue;
      const plan            = fields?.plan?.stringValue;

      if (userDisconnected && status === "disconnected") {
        clearInterval(poll);
        onDisconnected?.();
        return;
      }
      if (status === "connected" && userId && !userDisconnected) {
        clearInterval(poll);
        onConnected(userId, plan);
      }
    } catch {}
  }, 3000);
  return poll;
}

// ── Poll for plan verification (after Gumroad payment) ────
function listenForPlanVerification(userId, onVerified) {
  const poll = setInterval(async () => {
    try {
      const fields = await firestoreGet(`users/${userId}`);
      if (!fields) return;
      const plan         = fields?.plan?.stringValue;
      const planVerified = fields?.planVerified?.booleanValue;

      // Plan set hua matlab webhook aa gaya ya free plan choose kiya
      if (plan && (planVerified === true || plan === "free")) {
        clearInterval(poll);
        onVerified(plan);
      }
    } catch {}
  }, 3000);
  return poll;
}

// ── Fetch user plan from Firebase ─────────────────────────
async function fetchUserPlan(userId) {
  const fields = await firestoreGet(`users/${userId}`);
  return fields?.plan?.stringValue || null;
}

// ── Startup setup ─────────────────────────────────────────
function addToStartup() {
  try {
    const exePath = app.getPath("exe");
    if (PLATFORM === "win32") {
      execSync(
        `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "AgenticVnus" /t REG_SZ /d "${exePath}" /f`,
        { stdio: "pipe" }
      );
    } else if (PLATFORM === "darwin") {
      const launchDir  = path.join(os.homedir(), "Library", "LaunchAgents");
      const plistPath  = path.join(launchDir, "ai.agentic.vnus.plist");
      if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });
      fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.agentic.vnus</string>
  <key>ProgramArguments</key><array><string>${exePath}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
</dict></plist>`);
      execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
    } else {
      const autostartDir = path.join(os.homedir(), ".config", "autostart");
      if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(
        path.join(autostartDir, "agentic-vnus.desktop"),
        `[Desktop Entry]\nType=Application\nName=Agentic Vnus\nExec=${exePath}\nHidden=false\nNoDisplay=false\nX-GNOME-Autostart-enabled=true`
      );
    }
  } catch (err) {
    console.error("Startup setup error:", err.message);
  }
}

// ── Splash Window ─────────────────────────────────────────
function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWindow = new BrowserWindow({
    width: 480, height: 700,
    x: Math.round((width - 480) / 2),
    y: Math.round((height - 700) / 2),
    frame:     false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#050505",
    show: false,
    ...(PLATFORM === "darwin" ? { vibrancy: "dark", visualEffectState: "active" } : {}),
  });
  splashWindow.loadFile(path.join(__dirname, "../renderer/splash.html"));
  splashWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on("closed", () => { splashWindow = null; });
}

function sendToSplash(event, data) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(event, data);
  }
}

// ── Workspace Window ──────────────────────────────────────
function createWorkspaceWindow(code) {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  workspaceWindow = new BrowserWindow({
    width:  Math.min(1200, width  - 40),
    height: Math.min(800,  height - 40),
    x: Math.round((width  - Math.min(1200, width  - 40)) / 2),
    y: Math.round((height - Math.min(800,  height - 40)) / 2),
    frame:     true,
    resizable: true,
    title:     "Agentic Vnus — Workspace",
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#050505",
    show: false,
    ...(PLATFORM === "darwin" ? { titleBarStyle: "hiddenInset", vibrancy: "dark" } : {}),
  });

  const workspaceUrl = `${WEBSITE}/dashboard/workspace/${code}?agent=true`;
  workspaceWindow.loadURL(workspaceUrl);

  workspaceWindow.once("ready-to-show", () => {
    if (workspaceWindow && !workspaceWindow.isDestroyed()) {
      workspaceWindow.show();
      // Splash band karo jab workspace khule
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    }
  });

  workspaceWindow.on("closed", () => { workspaceWindow = null; });

  workspaceWindow.webContents.on("did-finish-load", () => {
    if (workspaceWindow && !workspaceWindow.isDestroyed()) {
      const st = loadState();
      workspaceWindow.webContents.executeJavaScript(`
        window.__VNUS_AGENT__    = true;
        window.__WORKSPACE_ID__  = "${code}";
        window.__PLAN__          = "${st.plan || "free"}";
      `);
    }
  });
}

// ── Tray ──────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "../assets/tray-icon.png");
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Agentic Vnus — Running");

  const updateMenu = (connected = false) => {
    const st = loadState();
    const menu = Menu.buildFromTemplate([
      { label: "Agentic Vnus", enabled: false },
      { type: "separator" },
      { label: connected ? "● Connected" : "○ Not connected", enabled: false },
      { type: "separator" },
      {
        label:   "Open Workspace",
        enabled: connected && st.modelReady,
        click:   () => createWorkspaceWindow(st.agentCode),
      },
      {
        label: "Open Website",
        click: () => shell.openExternal(WEBSITE),
      },
      {
        label: "Show Agent Code",
        click: () => {
          createSplashWindow();
          setTimeout(() => sendToSplash("agent-data", {
            code:      st.agentCode,
            pcName:    os.hostname(),
            os:        getOSName(),
            connected,
            plan:      st.plan,
          }), 500);
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };

  tray.on("double-click", () => {
    const st = loadState();
    if (st.userId && st.modelReady && !st.userDisconnected) {
      createWorkspaceWindow(st.agentCode);
    } else {
      createSplashWindow();
    }
  });

  return updateMenu;
}

// ── IPC Handlers ──────────────────────────────────────────
ipcMain.on("close-splash", () => {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
});

ipcMain.on("open-dashboard", () => {
  shell.openExternal(`${WEBSITE}/dashboard`);
});

ipcMain.on("open-workspace", () => {
  const st = loadState();
  if (st.agentCode) createWorkspaceWindow(st.agentCode);
});

// Model selected → download karo
ipcMain.on("model-selected", async (event, { modelOption, visionEnabled, visionModel }) => {
  const st = loadState();

  saveState({
    selectedModel: {
      ollamaId:       modelOption.ollamaId,
      name:           modelOption.name,
      visionEnabled,
      visionOllamaId: visionEnabled && visionModel ? visionModel.ollamaId : null,
    },
  });

  sendToSplash("setup-progress", { step: "starting", message: "Starting AI engine...", percent: 5 });

  // Ollama start karo pehle
  const running = await isOllamaRunning();
  if (!running) {
    sendToSplash("setup-progress", { step: "ollama", message: "Starting Ollama...", percent: 10 });
    await startOllama();
    await new Promise(r => setTimeout(r, 3000));
  }

  const modelsToSetup = [modelOption.ollamaId];
  if (visionEnabled && visionModel) modelsToSetup.push(visionModel.ollamaId);

  let allSuccess = true;

  for (let i = 0; i < modelsToSetup.length; i++) {
    const modelId     = modelsToSetup[i];
    const basePercent = i === 0 ? 15 : 65;
    const result      = await setupModel(modelId, (progress) => {
      const pct = basePercent + Math.round((progress.percent || 0) * (i === 0 ? 0.5 : 0.35));
      sendToSplash("setup-progress", { ...progress, percent: Math.min(pct, 99) });
    });

    if (!result.success) {
      allSuccess = false;
      sendToSplash("setup-error", {
        message: result.error || `Failed to download ${modelId}. Check your internet connection and try again.`,
        modelId,
      });
      // State reset karo taaki retry possible ho
      saveState({ modelReady: false, selectedModel: null });
      return;
    }
  }

  if (allSuccess) {
    saveState({ modelReady: true });
    sendToSplash("setup-progress", { step: "done", message: "AI ready!", percent: 100 });
    setTimeout(() => {
      sendToSplash("model-ready");
      // Workspace kholo
      const finalState = loadState();
      if (finalState.userId) {
        setTimeout(() => createWorkspaceWindow(finalState.agentCode), 1500);
      }
    }, 800);
  }
});

// Retry download
ipcMain.on("retry-model-download", () => {
  const st = loadState();
  if (st.plan && st.userId) {
    const specs        = getPCSpecs();
    const modelOptions = getModelOptions(st.plan, specs);
    sendToSplash("show-model-picker", { specs, modelOptions, plan: st.plan });
  }
});

// ── App Ready ─────────────────────────────────────────────
app.whenReady().then(async () => {
  // Mac dock hide karo
  if (PLATFORM === "darwin") app.dock?.hide();

  // Single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  app.on("second-instance", () => {
    const st = loadState();
    if (st.userId && st.modelReady && !st.userDisconnected) {
      createWorkspaceWindow(st.agentCode);
    } else {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.focus();
      } else {
        createSplashWindow();
      }
    }
  });

  let state = loadState();

  // ── Permanent machine code generate karo ──────────────
  const code = generatePermanentCode();

  // ── First time setup ───────────────────────────────────
  if (!state.isSetup) {
    // Permissions maango
    const r = await dialog.showMessageBox({
      type:      "info",
      title:     "Agentic Vnus — Permissions",
      message:   "Agentic Vnus needs some permissions to work.",
      detail:    PLATFORM === "darwin"
        ? "✅ Accessibility access\n✅ Full Disk Access\n✅ Network access\n✅ Install local AI model"
        : "✅ File system access\n✅ Network access\n✅ Run at startup\n✅ Install local AI model",
      buttons:   ["Grant & Continue", "Cancel"],
      defaultId: 0,
      cancelId:  1,
    });

    if (r.response !== 0) { app.quit(); return; }

    if (PLATFORM === "darwin") {
      systemPreferences.isTrustedAccessibilityClient(true);
    }

    addToStartup();

    const pcInfo = getPCInfo();
    await registerAgent(code, pcInfo);

    state = saveState({
      isSetup:          true,
      agentCode:        code,
      userId:           null,
      plan:             null,
      planVerified:     false,
      selectedModel:    null,
      modelReady:       false,
      userDisconnected: false,
    });
  } else {
    // Returning user
    state.agentCode = code;

    // Firestore se check karo disconnect hua tha kya
    const fsDoc            = await firestoreGet(`agent_connections/${code}`);
    const userDisconnected = fsDoc?.userDisconnected?.booleanValue || false;

    if (userDisconnected) {
      state = saveState({
        userId:           null,
        userDisconnected: true,
        plan:             null,
        planVerified:     false,
        modelReady:       false,
        selectedModel:    null,
      });
      // Firestore reset
      await firestorePatch(`agent_connections/${code}`, {
        status:           "waiting",
        userId:           null,
        userDisconnected: false,
      }, ["status", "userId", "userDisconnected"]);
    } else {
      // Ensure Firestore me code registered hai
      const pcInfo = getPCInfo();
      if (!fsDoc) await registerAgent(code, pcInfo);
      saveState({ agentCode: code });
    }
    state = loadState();
  }

  // Tray banao
  const updateMenu = createTray();

  // Splash banao
  createSplashWindow();

  const specs = getPCSpecs();

  // Splash ready hone pe initial data bhejo
  splashWindow?.once("ready-to-show", async () => {
    await new Promise(r => setTimeout(r, 300));

    const st = loadState();

    // ── CASE 1: Pehle se connected + plan verified + model ready ──
    if (st.userId && st.planVerified && st.modelReady && st.selectedModel && !st.userDisconnected) {
      updateMenu(true);
      sendToSplash("agent-data", {
        code:      st.agentCode,
        pcName:    os.hostname(),
        os:        getOSName(),
        connected: true,
        plan:      st.plan,
      });

      // Command listener start karo
      if (!commandListener) {
        commandListener = startCommandListener(st.agentCode, firebaseConfig, st.selectedModel);
      }

      // Workspace directly kholo
      setTimeout(() => createWorkspaceWindow(st.agentCode), 800);
      return;
    }

    // ── CASE 2: Connected + plan verified + model NOT ready ──
    if (st.userId && st.planVerified && !st.modelReady) {
      updateMenu(true);
      sendToSplash("agent-data", {
        code:      st.agentCode,
        pcName:    os.hostname(),
        os:        getOSName(),
        connected: true,
        plan:      st.plan,
      });
      const modelOptions = getModelOptions(st.plan, specs);
      sendToSplash("show-model-picker", { specs, modelOptions, plan: st.plan });
      return;
    }

    // ── CASE 3: Not connected / plan not chosen ──
    // Sirf code dikho — baki sab website pe hoga
    sendToSplash("agent-data", {
      code:      st.agentCode || code,
      pcName:    os.hostname(),
      os:        getOSName(),
      connected: false,
      plan:      null,
    });

    // Connection ke liye wait karo
    listenForConnection(
      code,

      // onConnected — user ne website pe code daala
      async (userId, planFromFirestore) => {
        saveState({ userId, userDisconnected: false });
        updateMenu(true);

        sendToSplash("workspace-connected", { userId });

        // Plan check karo — website pe plan choose kiya hoga
        sendToSplash("waiting-for-plan", {
          message: "Waiting for plan selection on website...",
        });

        // Plan verification ke liye poll karo
        listenForPlanVerification(userId, async (plan) => {
          saveState({ plan, planVerified: true });
          updateMenu(true);

          sendToSplash("plan-verified", { plan });

          // Model picker dikho
          const modelOptions = getModelOptions(plan, specs);
          sendToSplash("show-model-picker", { specs, modelOptions, plan });
        });
      },

      // onDisconnected
      async () => {
        saveState({
          userId:           null,
          userDisconnected: true,
          plan:             null,
          planVerified:     false,
          modelReady:       false,
          selectedModel:    null,
        });
        updateMenu(false);

        if (workspaceWindow && !workspaceWindow.isDestroyed()) {
          workspaceWindow.close();
        }

        // Splash reopen karo
        createSplashWindow();
        setTimeout(() => sendToSplash("agent-data", {
          code,
          pcName:    os.hostname(),
          os:        getOSName(),
          connected: false,
          plan:      null,
        }), 500);
      }
    );
  });
});

// Window close pe app band nahi ho — tray mein rahe
app.on("window-all-closed", (e) => {
  if (!isQuitting) e.preventDefault();
});

app.on("before-quit", () => { isQuitting = true; });

app.on("activate", () => {
  const st = loadState();
  if (st.userId && st.modelReady && !st.userDisconnected) {
    createWorkspaceWindow(st.agentCode);
  } else {
    createSplashWindow();
  }
});