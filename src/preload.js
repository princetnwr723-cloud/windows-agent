// src/preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vnusAgent", {
  // ── Agent data & code ──────────────────────────────────
  onAgentData:          (cb) => ipcRenderer.on("agent-data",          (_, d) => cb(d)),
  onWorkspaceConnected: (cb) => ipcRenderer.on("workspace-connected",  (_, d) => cb(d)),
  onCodeRefreshed:      (cb) => ipcRenderer.on("code-refreshed",       (_, d) => cb(d)),

  // ── Actions ────────────────────────────────────────────
  closeSplash:    ()     => ipcRenderer.send("close-splash"),
  openDashboard:  ()     => ipcRenderer.send("open-dashboard"),
  openWorkspace:  ()     => ipcRenderer.send("open-workspace"),

  // ── Model picker ───────────────────────────────────────
  onShowModelPicker: (cb) => ipcRenderer.on("show-model-picker", (_, d) => cb(d)),
  onSetupProgress:   (cb) => ipcRenderer.on("setup-progress",    (_, d) => cb(d)),
  onSetupError:      (cb) => ipcRenderer.on("setup-error",       (_, d) => cb(d)),
  onModelReady:      (cb) => ipcRenderer.on("model-ready",       ()     => cb()),
  selectModel:       (d)  => ipcRenderer.send("model-selected", d),
});