const { contextBridge, ipcRenderer } = require("electron");

// Expose safe APIs to renderer (splash.html)
contextBridge.exposeInMainWorld("vnusAgent", {
  // Receive agent data (code, pcName etc)
  onAgentData: (callback) => ipcRenderer.on("agent-data", (_, data) => callback(data)),

  // Receive workspace connected event
  onWorkspaceConnected: (callback) => ipcRenderer.on("workspace-connected", (_, data) => callback(data)),

  // Receive code refresh
  onCodeRefreshed: (callback) => ipcRenderer.on("code-refreshed", (_, code) => callback(code)),

  // Actions
  closeSplash: () => ipcRenderer.send("close-splash"),
  openDashboard: () => ipcRenderer.send("open-dashboard"),
  refreshCode: () => ipcRenderer.send("refresh-code"),
});