const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, screen } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Firebase (using REST API to avoid ESM issues in Electron)
const { firebaseConfig } = require("./config");

// ─── App Config ───────────────────────────────────────────
const IS_DEV = process.argv.includes("--dev");
const DATA_DIR = path.join(app.getPath("userData"), "vnus-agent");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let tray = null;
let splashWindow = null;
let trayWindow = null;
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
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let code = "";
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Get PC Info ──────────────────────────────────────────
function getPCInfo() {
  return {
    pcName: os.hostname(),
    os: `${getOSName()} ${os.release()}`,
    platform: os.platform(),
    arch: os.arch(),
    username: os.userInfo().username,
    totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + " GB",
  };
}

function getOSName() {
  const p = os.platform();
  if (p === "win32") return "Windows";
  if (p === "darwin") return "macOS";
  return "Linux";
}

// ─── Save code to Firestore via REST ──────────────────────
async function saveCodeToFirestore(code, pcInfo) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${code}`;

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
    const response = await fetch(`${url}?key=${firebaseConfig.apiKey}`, {
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
async function listenForConnection(code, onConnected) {
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
  }, 3000); // check every 3 seconds

  // Stop polling after 15 minutes
  setTimeout(() => clearInterval(poll), 15 * 60 * 1000);
  return poll;
}

// ─── Request Windows Permissions ──────────────────────────
async function requestWindowsPermissions() {
  const result = await dialog.showMessageBox({
    type: "info",
    title: "Vnus Agent — Permissions Required",
    message: "Vnus Agent needs the following permissions to work:",
    detail:
      "✅  Full file system access (read, write, delete files)\n" +
      "✅  Network access (connect to Vnus servers)\n" +
      "✅  Run at startup (start automatically when you log in)\n" +
      "✅  System notifications (alert you when tasks complete)\n\n" +
      "Your data stays on your PC and is never uploaded without your command.",
    buttons: ["Grant Permissions & Continue", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    icon: path.join(__dirname, "../assets/icon.png"),
  });
  return result.response === 0;
}

// ─── Splash Window (setup screen) ─────────────────────────
function createSplashWindow(code, isFirstTime) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  splashWindow = new BrowserWindow({
    width: 480,
    height: 600,
    x: Math.round((width - 480) / 2),
    y: Math.round((height - 600) / 2),
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#050505",
    show: false,
  });

  splashWindow.loadFile(path.join(__dirname, "../renderer/splash.html"));

  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    // Send code and setup state to renderer
    splashWindow.webContents.send("agent-data", {
      code,
      isFirstTime,
      pcName: os.hostname(),
      os: getOSName(),
    });
  });

  splashWindow.on("closed", () => { splashWindow = null; });
}

// ─── System Tray ──────────────────────────────────────────
function createTray(state) {
  const iconPath = path.join(__dirname, "../assets/tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Vnus Agent — Running");

  const updateMenu = (connected) => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Vnus Agent",
        enabled: false,
        icon: nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }),
      },
      { type: "separator" },
      {
        label: connected ? "● Connected to Dashboard" : "○ Waiting for connection...",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Show Agent Code",
        click: () => {
          const st = loadState();
          createSplashWindow(st.agentCode, false);
        },
      },
      {
        label: "Open Dashboard",
        click: () => shell.openExternal("https://vnus.ai/dashboard"),
      },
      { type: "separator" },
      {
        label: "Quit Vnus Agent",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
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
ipcMain.on("close-splash", () => {
  if (splashWindow) splashWindow.close();
});

ipcMain.on("open-dashboard", () => {
  shell.openExternal("https://vnus.ai/dashboard");
});

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
  // Single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (splashWindow) {
      splashWindow.focus();
    } else {
      const state = loadState();
      createSplashWindow(state.agentCode, false);
    }
  });

  let state = loadState();
  const isFirstTime = !state.isSetup;

  if (isFirstTime) {
    // First launch — request permissions
    const granted = await requestWindowsPermissions();
    if (!granted) {
      app.quit();
      return;
    }

    // Generate code and save to Firestore
    const pcInfo = getPCInfo();
    const code = generateAgentCode();
    const saved = await saveCodeToFirestore(code, pcInfo);

    state = {
      isSetup: true,
      agentCode: code,
      userId: null,
      codeCreatedAt: new Date().toISOString(),
    };
    saveState(state);

    // Show setup complete splash
    createSplashWindow(code, true);

    // Start listening for dashboard connection
    if (saved) {
      listenForConnection(code, (userId) => {
        state.userId = userId;
        saveState(state);
        // Notify splash if open
        if (splashWindow) splashWindow.webContents.send("workspace-connected", { userId });
      });
    }
  } else {
    // Returning launch — just show tray
    if (!state.agentCode) {
      const code = generateAgentCode();
      const pcInfo = getPCInfo();
      await saveCodeToFirestore(code, pcInfo);
      state.agentCode = code;
      state.codeCreatedAt = new Date().toISOString();
      saveState(state);
    }
  }

  // Create system tray
  const updateMenu = createTray(state);

  // If already connected, start listening for commands (future feature)
  if (state.userId) {
    updateMenu(true);
  } else if (state.agentCode) {
    listenForConnection(state.agentCode, (userId) => {
      state.userId = userId;
      saveState(state);
      updateMenu(true);
      if (splashWindow) splashWindow.webContents.send("workspace-connected", { userId });
    });
  }
});

// ─── Prevent app from quitting when windows close ─────────
app.on("window-all-closed", (e) => {
  if (!isQuitting) e.preventDefault(); // Keep running in tray
});

app.on("before-quit", () => { isQuitting = true; });