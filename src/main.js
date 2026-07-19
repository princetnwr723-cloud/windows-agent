// src/main.js
const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  shell, dialog, ipcMain, screen, systemPreferences,
} = require("electron");
const path   = require("path");
const os     = require("os");
const fs     = require("fs");
const { execSync } = require("child_process");

const { firebaseConfig }          = require("./config");
const { startCommandListener }    = require("./agent/listener");
const { getPCSpecs }              = require("./agent/specs");
const { getModelOptions }         = require("./agent/modelSelector");
const { setupModel, isOllamaRunning, startOllama } = require("./agent/ollamaManager");
const { generatePermanentCode }   = require("./agent/machineCode");

// ── App Config ────────────────────────────────────────────
const PLATFORM  = os.platform();
const DATA_DIR  = path.join(app.getPath("userData"), "vnus-agent");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let tray            = null;
let splashWindow    = null;
let workspaceWindow = null;
let isQuitting      = false;

// ── State ─────────────────────────────────────────────────
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
    isSetup:       false,
    agentCode:     null,   // permanent machine-based code
    userId:        null,
    plan:          "free",
    selectedModel: null,
    modelReady:    false,
    userDisconnected: false,
  };
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── PC Info ───────────────────────────────────────────────
function getPCInfo() {
  return {
    pcName:   os.hostname(),
    os:       `${getOSName()} ${os.release()}`,
    platform: PLATFORM,
    arch:     os.arch(),
    username: os.userInfo().username,
    totalMemory: Math.round(os.totalmem() / (1024 ** 3)) + " GB",
  };
}

function getOSName() {
  if (PLATFORM === "win32")  return "Windows";
  if (PLATFORM === "darwin") return "macOS";
  return "Linux";
}

// ── Firestore helpers ─────────────────────────────────────
async function saveCodeToFirestore(code, pcInfo) {
  const url  = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}`;
  const body = {
    fields: {
      code:            { stringValue: code },
      status:          { stringValue: "waiting" },
      userId:          { nullValue: null },
      userDisconnected:{ booleanValue: false },
      pcName:          { stringValue: pcInfo.pcName },
      os:              { stringValue: pcInfo.os },
      platform:        { stringValue: pcInfo.platform },
      arch:            { stringValue: pcInfo.arch },
      username:        { stringValue: pcInfo.username },
      createdAt:       { stringValue: new Date().toISOString() },
      permanent:       { booleanValue: true },
    },
  };
  try {
    const res = await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.error("Firestore error:", err);
    return false;
  }
}

async function getFirestoreDoc(code) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    return data?.fields || null;
  } catch {
    return null;
  }
}

async function updateFirestoreField(code, fields) {
  const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}?key=${firebaseConfig.apiKey}&${fieldPaths}`;
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string")  firestoreFields[k] = { stringValue: v };
    if (typeof v === "boolean") firestoreFields[k] = { booleanValue: v };
    if (v === null)             firestoreFields[k] = { nullValue: null };
  }
  try {
    await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ fields: firestoreFields }),
    });
  } catch {}
}

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
function listenForConnection(code, onConnected, onDisconnected) {
  const poll = setInterval(async () => {
    try {
      const fields = await getFirestoreDoc(code);
      if (!fields) return;

      const status          = fields?.status?.stringValue;
      const userId          = fields?.userId?.stringValue;
      const userDisconnected = fields?.userDisconnected?.booleanValue;

      // User disconnected from dashboard
      if (userDisconnected && status === "disconnected") {
        onDisconnected?.();
        return;
      }

      // Connected!
      if (status === "connected" && userId && !userDisconnected) {
        clearInterval(poll);
        onConnected(userId);
      }
    } catch {}
  }, 3000);

  return poll;
}

// ── Platform permissions ──────────────────────────────────
async function requestPermissions() {
  const detail = PLATFORM === "darwin"
    ? "✅ Accessibility access (to control apps)\n✅ Full Disk Access\n✅ Network access\n✅ Install local AI model"
    : "✅ File system access\n✅ Network access\n✅ Run at startup\n✅ Install local AI model";

  const r = await dialog.showMessageBox({
    type: "info", title: "Vnus Agent — Permissions",
    message: "Vnus Agent needs a few permissions to work.",
    detail,
    buttons: ["Grant & Continue", "Cancel"],
    defaultId: 0, cancelId: 1,
  });
  if (r.response !== 0) return false;

  if (PLATFORM === "darwin") {
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  return true;
}

// ── Startup ───────────────────────────────────────────────
function addToStartup() {
  try {
    const appPath = app.getPath("exe");
    if (PLATFORM === "win32") {
      execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "VnusAgent" /t REG_SZ /d "${appPath}" /f`);
    } else if (PLATFORM === "darwin") {
      const launchDir = path.join(os.homedir(), "Library", "LaunchAgents");
      const plistPath = path.join(launchDir, "ai.vnus.agent.plist");
      if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });
      fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.vnus.agent</string>
  <key>ProgramArguments</key><array><string>${appPath}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
</dict></plist>`);
      execSync(`launchctl load "${plistPath}"`);
    } else {
      const autostartDir = path.join(os.homedir(), ".config", "autostart");
      if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(
        path.join(autostartDir, "vnus-agent.desktop"),
        `[Desktop Entry]\nType=Application\nName=Vnus Agent\nExec=${appPath}\nHidden=false\nNoDisplay=false\nX-GNOME-Autostart-enabled=true`
      );
    }
  } catch (err) {
    console.error("Startup setup error:", err.message);
  }
}

// ── Splash Window ─────────────────────────────────────────
function createSplashWindow() {
  if (splashWindow) { splashWindow.focus(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWindow = new BrowserWindow({
    width: 480, height: 680,
    x: Math.round((width - 480) / 2),
    y: Math.round((height - 680) / 2),
    frame: false, resizable: false, alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#050505",
    show: false,
    ...(PLATFORM === "darwin" ? { vibrancy: "dark", visualEffectState: "active" } : {}),
  });
  splashWindow.loadFile(path.join(__dirname, "../renderer/splash.html"));
  splashWindow.once("ready-to-show", () => splashWindow.show());
  splashWindow.on("closed", () => { splashWindow = null; });
}

// ── Workspace Window (Electron-embedded dashboard) ────────
function createWorkspaceWindow(state) {
  if (workspaceWindow) { workspaceWindow.focus(); return; }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  workspaceWindow = new BrowserWindow({
    width:  Math.min(1200, width  - 40),
    height: Math.min(800,  height - 40),
    x: Math.round((width  - Math.min(1200, width  - 40)) / 2),
    y: Math.round((height - Math.min(800,  height - 40)) / 2),
    frame:     true,
    resizable: true,
    title:     "Vnus Agent — Workspace",
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#050505",
    show: false,
    ...(PLATFORM === "darwin" ? {
      titleBarStyle: "hiddenInset",
      vibrancy:      "dark",
    } : {}),
  });

  // Load the dashboard workspace page from deployed website
  const workspaceUrl = `https://vnus.ai/dashboard/workspace/${state.agentCode}?agent=true`;
  workspaceWindow.loadURL(workspaceUrl);

  workspaceWindow.once("ready-to-show", () => {
    workspaceWindow.show();
    // Close splash when workspace opens
    if (splashWindow) splashWindow.close();
  });

  workspaceWindow.on("closed", () => { workspaceWindow = null; });

  // Inject agent=true flag so website knows it's embedded
  workspaceWindow.webContents.on("did-finish-load", () => {
    workspaceWindow?.webContents.executeJavaScript(`
      window.__VNUS_AGENT__ = true;
      window.__WORKSPACE_ID__ = "${state.agentCode}";
      window.__PLAN__ = "${state.plan}";
    `);
  });
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
    const st = loadState();
    const menu = Menu.buildFromTemplate([
      { label: "Vnus Agent", enabled: false },
      { type: "separator" },
      {
        label:   connected ? "● Connected" : "○ Not connected",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Workspace",
        enabled: connected,
        click: () => createWorkspaceWindow(st),
      },
      {
        label: "Open Dashboard",
        click: () => shell.openExternal("https://vnus.ai/dashboard"),
      },
      {
        label: "Show Agent Code",
        click: () => {
          createSplashWindow();
          splashWindow?.webContents.send("agent-data", {
            code:      st.agentCode,
            pcName:    os.hostname(),
            os:        getOSName(),
            platform:  PLATFORM,
            connected,
            plan:      st.plan,
          });
        },
      },
      { type: "separator" },
      {
        label: "Quit Vnus Agent",
        click: () => { isQuitting = true; app.quit(); },
      },
    ]);
    tray.setContextMenu(menu);
  };

  updateMenu(!!state.userId && !state.userDisconnected);

  // Double-click tray → open workspace or splash
  tray.on("double-click", () => {
    const st = loadState();
    if (st.userId && st.modelReady && !st.userDisconnected) {
      createWorkspaceWindow(st);
    } else {
      createSplashWindow();
    }
  });

  return updateMenu;
}

// ── IPC Handlers ──────────────────────────────────────────
ipcMain.on("close-splash", () => {
  if (splashWindow) splashWindow.close();
});

ipcMain.on("open-dashboard", () => {
  shell.openExternal("https://vnus.ai/dashboard");
});

ipcMain.on("open-workspace", () => {
  const st = loadState();
  createWorkspaceWindow(st);
});

// Model selected by user → start download
ipcMain.on("model-selected", async (event, { modelOption, visionEnabled, visionModel }) => {
  const state = loadState();
  state.selectedModel = {
    ollamaId:       modelOption.ollamaId,
    name:           modelOption.name,
    visionEnabled,
    visionOllamaId: visionEnabled && visionModel ? visionModel.ollamaId : null,
  };
  saveState(state);

  splashWindow?.webContents.send("setup-progress", {
    step: "ollama", message: "Setting up AI engine...", percent: 0,
  });

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

  // Auto open workspace window after model is ready!
  if (state.userId) {
    setTimeout(() => createWorkspaceWindow(loadState()), 1500);
  }
});

// ── App Ready ─────────────────────────────────────────────
app.whenReady().then(async () => {
  if (PLATFORM === "darwin") app.dock.hide();

  // Single instance
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }

  app.on("second-instance", () => {
    const st = loadState();
    if (st.userId && st.modelReady && !st.userDisconnected) {
      createWorkspaceWindow(st);
    } else {
      createSplashWindow();
    }
  });

  let state = loadState();

  // ── Generate PERMANENT machine-based code ──────────────
  const permanentCode = generatePermanentCode();

  // First time setup
  if (!state.isSetup) {
    const granted = await requestPermissions();
    if (!granted) { app.quit(); return; }

    addToStartup();

    const pcInfo = getPCInfo();
    await saveCodeToFirestore(permanentCode, pcInfo);

    state = {
      isSetup:          true,
      agentCode:        permanentCode,
      userId:           null,
      plan:             "free",
      selectedModel:    null,
      modelReady:       false,
      userDisconnected: false,
    };
    saveState(state);
  } else {
    // Returning user — ensure code is in Firestore (in case it was wiped)
    state.agentCode = permanentCode;

    // Check if userDisconnected flag is set in Firestore
    const firestoreDoc = await getFirestoreDoc(permanentCode);
    const userDisconnected = firestoreDoc?.userDisconnected?.booleanValue || false;

    if (userDisconnected) {
      // User manually disconnected — reset connection
      state.userId          = null;
      state.userDisconnected = true;
      await updateFirestoreField(permanentCode, {
        status: "waiting",
        userId: null,
        userDisconnected: false,
      });
    } else if (!state.userId) {
      // Make sure Firestore has correct status
      const pcInfo = getPCInfo();
      await saveCodeToFirestore(permanentCode, pcInfo);
    }

    saveState(state);
  }

  // Get PC specs for model selection
  const specs = getPCSpecs();

  // Create splash
  createSplashWindow();

  // Send initial data to splash
  splashWindow?.once("ready-to-show", () => {
    const st = loadState();
    splashWindow?.webContents.send("agent-data", {
      code:      st.agentCode,
      pcName:    os.hostname(),
      os:        getOSName(),
      platform:  PLATFORM,
      connected: !!st.userId && !st.userDisconnected,
      plan:      st.plan,
    });

    // If model not ready → show model picker
    if (!st.modelReady || !st.selectedModel) {
      const plan         = st.plan || "free";
      const modelOptions = getModelOptions(plan, specs);
      splashWindow?.webContents.send("show-model-picker", {
        specs, modelOptions, plan,
      });
    } else if (st.userId && !st.userDisconnected) {
      // Already connected + model ready → open workspace directly
      setTimeout(() => createWorkspaceWindow(loadState()), 500);
    }
  });

  // Create tray
  const updateMenu = createTray(state);

  // Start connection listener if not connected
  if (!state.userId || state.userDisconnected) {
    const poll = listenForConnection(
      permanentCode,
      // onConnected
      async (userId) => {
        const plan = await fetchUserPlan(userId);
        const st   = loadState();
        st.userId           = userId;
        st.plan             = plan;
        st.userDisconnected = false;
        saveState(st);
        updateMenu(true);

        // Update model options with actual plan
        if (!st.modelReady) {
          const modelOptions = getModelOptions(plan, specs);
          splashWindow?.webContents.send("show-model-picker", {
            specs, modelOptions, plan,
          });
        }

        splashWindow?.webContents.send("workspace-connected", { userId, plan });

        // Start command listener
        if (st.modelReady && st.selectedModel) {
          startCommandListener(permanentCode, firebaseConfig, st.selectedModel);
          // Auto open workspace
          setTimeout(() => createWorkspaceWindow(loadState()), 1000);
        }
      },
      // onDisconnected
      () => {
        const st = loadState();
        st.userDisconnected = true;
        st.userId           = null;
        saveState(st);
        updateMenu(false);
        // Close workspace window
        if (workspaceWindow) workspaceWindow.close();
        // Show splash
        createSplashWindow();
        splashWindow?.webContents.send("agent-data", {
          code:      permanentCode,
          pcName:    os.hostname(),
          os:        getOSName(),
          platform:  PLATFORM,
          connected: false,
          plan:      "free",
        });
      }
    );
  } else {
    // Already connected
    updateMenu(true);
    if (state.modelReady && state.selectedModel) {
      startCommandListener(permanentCode, firebaseConfig, state.selectedModel);
      // Open workspace window directly
      setTimeout(() => createWorkspaceWindow(state), 800);
    } else {
      // Model not ready — show picker
      const modelOptions = getModelOptions(state.plan, specs);
      splashWindow?.webContents.send("show-model-picker", {
        specs, modelOptions, plan: state.plan,
      });
    }
  }
});

app.on("window-all-closed", (e) => {
  // Keep running in tray
  if (!isQuitting) e.preventDefault();
});

app.on("before-quit", () => { isQuitting = true; });

app.on("activate", () => {
  const st = loadState();
  if (st.userId && st.modelReady && !st.userDisconnected) {
    createWorkspaceWindow(st);
  } else {
    createSplashWindow();
  }
});