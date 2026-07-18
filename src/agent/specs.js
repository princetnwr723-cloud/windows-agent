// src/agent/specs.js
// PC Specs checker — RAM, GPU, Storage, Platform
// Used to determine which AI models can run on this machine

const os   = require("os");
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Get total RAM in GB ────────────────────────────────────
function getRAMInGB() {
  const bytes = os.totalmem();
  return Math.round(bytes / (1024 ** 3));
}

// ── Get free disk space in GB ──────────────────────────────
function getFreeStorageGB() {
  try {
    const platform = os.platform();
    if (platform === "win32") {
      // Windows: check C drive
      const out = execSync("wmic logicaldisk where DeviceID='C:' get FreeSpace /value", { encoding: "utf8" });
      const match = out.match(/FreeSpace=(\d+)/);
      if (match) return Math.round(parseInt(match[1]) / (1024 ** 3));
    } else {
      // Mac/Linux
      const out = execSync("df -k / | tail -1", { encoding: "utf8" });
      const parts = out.trim().split(/\s+/);
      const freeKB = parseInt(parts[3]);
      return Math.round(freeKB / (1024 ** 2));
    }
  } catch {}
  return 50; // fallback
}

// ── Get GPU info ───────────────────────────────────────────
function getGPUInfo() {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      const out = execSync(
        'wmic path win32_VideoController get Name,AdapterRAM /format:csv',
        { encoding: "utf8" }
      );
      const lines = out.trim().split("\n").filter(l => l.includes(",") && !l.includes("Node"));
      const gpus  = [];
      for (const line of lines) {
        const parts = line.split(",");
        const name  = parts[2]?.trim() || "";
        const vramBytes = parseInt(parts[1]) || 0;
        const vramGB    = Math.round(vramBytes / (1024 ** 3));
        if (name && !name.toLowerCase().includes("microsoft")) {
          gpus.push({ name, vramGB });
        }
      }
      return gpus;
    } else if (platform === "darwin") {
      const out = execSync("system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Chipset|VRAM'", { encoding: "utf8" });
      const lines = out.trim().split("\n");
      const gpus  = [];
      let name    = "Apple GPU";
      let vramGB  = 0;
      for (const line of lines) {
        if (line.includes("Chipset")) name = line.split(":")[1]?.trim() || name;
        if (line.includes("VRAM")) {
          const match = line.match(/(\d+)\s*(MB|GB)/i);
          if (match) {
            vramGB = parseInt(match[1]);
            if (match[2].toLowerCase() === "mb") vramGB = Math.round(vramGB / 1024);
          }
        }
      }
      if (name) gpus.push({ name, vramGB });
      return gpus;
    } else {
      // Linux — check nvidia-smi first
      try {
        const out = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null", { encoding: "utf8" });
        return out.trim().split("\n").map(line => {
          const [name, mem] = line.split(",");
          const match = mem?.match(/(\d+)/);
          const vramGB = match ? Math.round(parseInt(match[1]) / 1024) : 0;
          return { name: name?.trim(), vramGB };
        });
      } catch {
        // No nvidia, check lspci
        try {
          const out = execSync("lspci 2>/dev/null | grep -i vga", { encoding: "utf8" });
          return [{ name: out.trim().split(":").pop()?.trim() || "Unknown GPU", vramGB: 0 }];
        } catch {}
      }
    }
  } catch {}
  return [];
}

// ── Check if Ollama is installed ───────────────────────────
function isOllamaInstalled() {
  try {
    execSync("ollama --version", { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Check which models are already downloaded ──────────────
function getInstalledModels() {
  try {
    const out = execSync("ollama list 2>/dev/null", { encoding: "utf8" });
    const lines = out.trim().split("\n").slice(1); // skip header
    return lines
      .filter(l => l.trim())
      .map(l => l.split(/\s+/)[0]?.split(":")[0] || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Main specs collector ───────────────────────────────────
function getPCSpecs() {
  const ramGB        = getRAMInGB();
  const freeStorageGB= getFreeStorageGB();
  const gpus         = getGPUInfo();
  const platform     = os.platform();
  const arch         = os.arch();
  const cpuModel     = os.cpus()[0]?.model || "Unknown CPU";
  const cpuCores     = os.cpus().length;
  const ollamaReady  = isOllamaInstalled();
  const installedModels = ollamaReady ? getInstalledModels() : [];

  // Best GPU VRAM
  const bestGPU    = gpus.sort((a, b) => b.vramGB - a.vramGB)[0] || null;
  const gpuVRAMGB  = bestGPU?.vramGB || 0;
  const hasNvidiaGPU = gpus.some(g => g.name?.toLowerCase().includes("nvidia") || g.name?.toLowerCase().includes("geforce") || g.name?.toLowerCase().includes("rtx") || g.name?.toLowerCase().includes("gtx"));
  const hasAppleSilicon = platform === "darwin" && (arch === "arm64");

  return {
    ramGB,
    freeStorageGB,
    gpus,
    bestGPU,
    gpuVRAMGB,
    hasNvidiaGPU,
    hasAppleSilicon,
    platform,
    arch,
    cpuModel,
    cpuCores,
    ollamaReady,
    installedModels,
    // Human readable
    summary: `${ramGB}GB RAM · ${freeStorageGB}GB free · ${bestGPU ? bestGPU.name + " " + gpuVRAMGB + "GB VRAM" : "No dedicated GPU"}`,
  };
}

module.exports = { getPCSpecs, getRAMInGB, getFreeStorageGB, getGPUInfo, isOllamaInstalled, getInstalledModels };