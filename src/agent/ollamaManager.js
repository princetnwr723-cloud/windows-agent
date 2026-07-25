// src/agent/ollamaManager.js
// Fixed: version check, force reinstall, proper error messages
// Model download aur AI commands properly chalenge

const { execSync, exec, spawn } = require("child_process");
const os    = require("os");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");

const OLLAMA_BASE_URL     = "http://localhost:11434";
const MIN_OLLAMA_VERSION  = "0.1.40"; // minimum required version

// ── Check if Ollama is running ─────────────────────────────
async function isOllamaRunning() {
  try {
    const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 3000);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Get Ollama version ─────────────────────────────────────
function getOllamaVersion() {
  try {
    const out = execSync("ollama --version", { encoding: "utf8", stdio: "pipe", timeout: 5000 });
    // "ollama version 0.1.44" → "0.1.44"
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ── Version compare ────────────────────────────────────────
function versionGte(v1, v2) {
  if (!v1) return false;
  const a = v1.split(".").map(Number);
  const b = v2.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

// ── Fetch with timeout ─────────────────────────────────────
function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Request timeout")), timeoutMs);
    fetch(url, options)
      .then(res => { clearTimeout(timer); resolve(res); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

// ── Kill existing Ollama process ───────────────────────────
function killOllama() {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      execSync("taskkill /F /IM ollama.exe /T", { stdio: "pipe" });
    } else {
      execSync("pkill -f ollama", { stdio: "pipe" });
    }
    return true;
  } catch { return false; }
}

// ── Start Ollama server ────────────────────────────────────
async function startOllama() {
  const platform = os.platform();
  try {
    killOllama();
    await new Promise(r => setTimeout(r, 1000));

    if (platform === "win32") {
      // Windows: Ollama runs as background service
      const ollamaPath = path.join(
        process.env.LOCALAPPDATA || "",
        "Programs", "Ollama", "ollama.exe"
      );
      const exePath = fs.existsSync(ollamaPath) ? ollamaPath : "ollama";
      exec(`"${exePath}" serve`, { detached: true, stdio: "ignore", shell: false });
    } else if (platform === "darwin") {
      exec("ollama serve", { detached: true, stdio: "ignore" });
    } else {
      exec("ollama serve", { detached: true, stdio: "ignore", shell: true });
    }

    // Wait for server to start
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1500));
      if (await isOllamaRunning()) return true;
    }
    return false;
  } catch (err) {
    console.error("Start Ollama error:", err.message);
    return false;
  }
}

// ── Download file with progress ────────────────────────────
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    // Follow redirects
    const doRequest = (reqUrl) => {
      const mod = reqUrl.startsWith("https") ? https : http;
      mod.get(reqUrl, (res) => {
        // Handle redirect
        if (res.statusCode === 301 || res.statusCode === 302) {
          doRequest(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total      = parseInt(res.headers["content-length"] || "0");
        let downloaded   = 0;
        const file       = fs.createWriteStream(dest);
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            onProgress?.(Math.min(pct, 95));
          }
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
      }).on("error", reject);
    };
    doRequest(url);
  });
}

// ── Install Ollama ─────────────────────────────────────────
async function installOllama(onProgress) {
  const platform = os.platform();
  onProgress?.({ step: "download", message: "Downloading Ollama...", percent: 0 });

  try {
    if (platform === "win32") {
      const installerPath = path.join(os.tmpdir(), "OllamaSetup.exe");

      // Remove old installer if exists
      if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath);

      await downloadFile(
        "https://ollama.com/download/OllamaSetup.exe",
        installerPath,
        (p) => onProgress?.({ step: "download", message: `Downloading Ollama... ${p}%`, percent: Math.round(p * 0.6) })
      );

      onProgress?.({ step: "install", message: "Installing Ollama...", percent: 65 });

      // Kill any existing Ollama first
      killOllama();
      await new Promise(r => setTimeout(r, 2000));

      // Silent install
      execSync(`"${installerPath}" /S /NORESTART`, { stdio: "pipe", timeout: 120000 });

      // Wait for install to complete
      await new Promise(r => setTimeout(r, 5000));

    } else if (platform === "darwin") {
      onProgress?.({ step: "install", message: "Installing Ollama on macOS...", percent: 20 });
      execSync("curl -fsSL https://ollama.com/install.sh | sh", {
        stdio: "pipe", shell: true, timeout: 120000
      });
    } else {
      onProgress?.({ step: "install", message: "Installing Ollama on Linux...", percent: 20 });
      execSync("curl -fsSL https://ollama.com/install.sh | sh", {
        stdio: "pipe", shell: true, timeout: 120000
      });
    }

    onProgress?.({ step: "starting", message: "Starting Ollama...", percent: 85 });
    const started = await startOllama();

    if (!started) {
      throw new Error("Ollama installed but could not start. Please restart your PC and try again.");
    }

    onProgress?.({ step: "done", message: "Ollama ready!", percent: 100 });
    return { success: true };

  } catch (err) {
    console.error("Install Ollama error:", err.message);
    return { success: false, error: err.message };
  }
}

// ── Ensure Ollama is ready (install/update if needed) ──────
async function ensureOllama(onProgress) {
  // Check if running
  let running = await isOllamaRunning();

  if (running) {
    // Check version
    const version = getOllamaVersion();
    console.log("Ollama version:", version);

    if (!versionGte(version, MIN_OLLAMA_VERSION)) {
      // Version too old — update
      onProgress?.({ step: "update", message: `Updating Ollama (${version} → latest)...`, percent: 5 });
      killOllama();
      await new Promise(r => setTimeout(r, 2000));
      const result = await installOllama((p) =>
        onProgress?.({ ...p, percent: Math.round(p.percent * 0.4) })
      );
      if (!result.success) return result;
      running = await isOllamaRunning();
    }
  } else {
    // Not running — try to start existing installation
    onProgress?.({ step: "starting", message: "Starting Ollama...", percent: 3 });
    running = await startOllama();

    if (!running) {
      // Not installed — install fresh
      onProgress?.({ step: "installing", message: "Installing Ollama (one-time setup)...", percent: 0 });
      const result = await installOllama((p) =>
        onProgress?.({ ...p, percent: Math.round(p.percent * 0.5) })
      );
      if (!result.success) return result;
      running = await isOllamaRunning();
    }
  }

  if (!running) {
    return { success: false, error: "Could not start Ollama. Please check your internet connection and try again." };
  }

  return { success: true };
}

// ── Check if model is installed ────────────────────────────
async function isModelInstalled(ollamaId) {
  try {
    const res  = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 5000);
    const data = await res.json();
    const models = data.models || [];

    // Exact match ya prefix match
    return models.some(m =>
      m.name === ollamaId ||
      m.name === ollamaId + ":latest" ||
      m.name.startsWith(ollamaId.split(":")[0])
    );
  } catch {
    return false;
  }
}

// ── Pull model with streaming progress ────────────────────
async function pullModel(ollamaId, onProgress) {
  onProgress?.({ status: "starting", message: `Starting download of ${ollamaId}...`, percent: 0 });

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name: ollamaId, stream: true }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Pull failed (${res.status}): ${errText}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let lastPct   = 0;
    let lastMsg   = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text  = decoder.decode(value);
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);

          if (data.error) {
            throw new Error(data.error);
          }

          if (data.total && data.completed) {
            const pct = Math.round((data.completed / data.total) * 100);
            lastPct   = pct;
            const dl  = formatBytes(data.completed);
            const tot = formatBytes(data.total);
            onProgress?.({
              status:  "downloading",
              message: `Downloading ${ollamaId}... ${dl} / ${tot}`,
              percent: pct,
            });
          } else if (data.status && data.status !== lastMsg) {
            lastMsg = data.status;
            onProgress?.({ status: data.status, message: data.status, percent: lastPct });
          }

          if (data.status === "success") {
            onProgress?.({ status: "done", message: "Model downloaded!", percent: 100 });
            return { success: true };
          }
        } catch (parseErr) {
          if (parseErr.message !== "Unexpected end of JSON input") {
            console.error("Parse error:", parseErr.message);
          }
        }
      }
    }

    return { success: true };

  } catch (err) {
    console.error("Pull model error:", err.message);
    return { success: false, error: err.message };
  }
}

// ── Full setup: Ollama + model ─────────────────────────────
async function setupModel(ollamaId, onProgress) {
  console.log(`\n🚀 Setting up model: ${ollamaId}`);

  // Step 1: Ensure Ollama is installed and running
  onProgress?.({ step: "ollama", message: "Checking AI engine...", percent: 2 });

  const ollamaResult = await ensureOllama((p) =>
    onProgress?.({ step: "ollama", ...p, percent: Math.round((p.percent || 0) * 0.3) })
  );

  if (!ollamaResult.success) {
    return { success: false, error: ollamaResult.error };
  }

  // Step 2: Check if model already downloaded
  onProgress?.({ step: "check", message: "Checking model...", percent: 32 });

  const alreadyInstalled = await isModelInstalled(ollamaId);
  if (alreadyInstalled) {
    console.log(`✅ Model already installed: ${ollamaId}`);
    onProgress?.({ step: "done", message: "Model already ready!", percent: 100 });
    return { success: true, alreadyInstalled: true };
  }

  // Step 3: Pull model
  console.log(`📥 Downloading model: ${ollamaId}`);
  onProgress?.({ step: "model", message: `Downloading ${ollamaId}...`, percent: 35 });

  const pullResult = await pullModel(ollamaId, (p) => {
    const pct = 35 + Math.round((p.percent || 0) * 0.65);
    onProgress?.({ step: "model", ...p, percent: Math.min(pct, 99) });
  });

  if (!pullResult.success) {
    return {
      success: false,
      error: pullResult.error || `Failed to download ${ollamaId}. Check your internet connection.`,
    };
  }

  // Verify it's actually there
  const verified = await isModelInstalled(ollamaId);
  if (!verified) {
    return { success: false, error: `Model downloaded but verification failed. Please retry.` };
  }

  console.log(`✅ Model ready: ${ollamaId}`);
  return { success: true };
}

// ── Run prompt through Ollama ──────────────────────────────
async function runOllamaPrompt(ollamaId, systemPrompt, userContent) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userContent  },
  ];

  const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      model:    ollamaId,
      messages,
      stream:   false,
      options: {
        temperature: 0.1,
        num_predict: 2048,
        num_ctx:     4096,
      },
    }),
  }, 120000); // 2 min timeout for inference

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.message?.content || "";
}

// ── Run vision prompt ──────────────────────────────────────
async function runOllamaVision(ollamaId, systemPrompt, userText, imageBase64) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userText, images: [imageBase64] },
  ];

  const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      model:    ollamaId,
      messages,
      stream:   false,
      options: { temperature: 0.1, num_predict: 1024 },
    }),
  }, 60000);

  if (!res.ok) throw new Error(`Ollama vision error: ${res.status}`);
  const data = await res.json();
  return data.message?.content || "";
}

// ── Get installed models list ──────────────────────────────
async function getInstalledModels() {
  try {
    const res  = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 5000);
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

// ── Delete a model ─────────────────────────────────────────
async function deleteModel(ollamaId) {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/delete`, {
      method:  "DELETE",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name: ollamaId }),
    });
    return res.ok;
  } catch { return false; }
}

// ── Helper ────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0B";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

module.exports = {
  isOllamaRunning,
  startOllama,
  installOllama,
  ensureOllama,
  pullModel,
  isModelInstalled,
  setupModel,
  runOllamaPrompt,
  runOllamaVision,
  getInstalledModels,
  deleteModel,
  getOllamaVersion,
};