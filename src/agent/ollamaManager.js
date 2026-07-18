// src/agent/ollamaManager.js
// Handles Ollama installation + model download with progress callbacks

const { execSync, exec, spawn } = require("child_process");
const os   = require("os");
const path = require("path");
const fs   = require("fs");
const https = require("https");

const OLLAMA_BASE_URL = "http://localhost:11434";

// ── Check if Ollama is running ─────────────────────────────
async function isOllamaRunning() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Start Ollama server ────────────────────────────────────
async function startOllama() {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      // Ollama runs as a service on Windows after install
      exec("ollama serve", { detached: true, stdio: "ignore" });
    } else if (platform === "darwin") {
      exec("ollama serve", { detached: true, stdio: "ignore" });
    } else {
      exec("ollama serve &", { shell: true, detached: true, stdio: "ignore" });
    }
    // Wait for it to start
    await new Promise(r => setTimeout(r, 3000));
    return await isOllamaRunning();
  } catch {
    return false;
  }
}

// ── Install Ollama silently ────────────────────────────────
async function installOllama(onProgress) {
  const platform = os.platform();
  onProgress?.({ step: "download", message: "Downloading Ollama installer...", percent: 0 });

  try {
    if (platform === "win32") {
      // Windows — download and run installer silently
      const installerPath = path.join(os.tmpdir(), "OllamaSetup.exe");
      await downloadFile(
        "https://ollama.com/download/OllamaSetup.exe",
        installerPath,
        (p) => onProgress?.({ step: "download", message: `Downloading Ollama... ${p}%`, percent: p })
      );
      onProgress?.({ step: "install", message: "Installing Ollama...", percent: 80 });
      execSync(`"${installerPath}" /S`, { stdio: "pipe" });

    } else if (platform === "darwin") {
      // Mac — use curl install script
      onProgress?.({ step: "install", message: "Installing Ollama on macOS...", percent: 20 });
      execSync("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "pipe", shell: true });

    } else {
      // Linux — curl install script
      onProgress?.({ step: "install", message: "Installing Ollama on Linux...", percent: 20 });
      execSync("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "pipe", shell: true });
    }

    onProgress?.({ step: "starting", message: "Starting Ollama...", percent: 90 });

    // Start ollama server
    await startOllama();
    await new Promise(r => setTimeout(r, 2000));

    const running = await isOllamaRunning();
    onProgress?.({ step: "done", message: running ? "Ollama ready!" : "Ollama installed, may need restart", percent: 100 });
    return running;

  } catch (err) {
    onProgress?.({ step: "error", message: `Install failed: ${err.message}`, percent: 0 });
    return false;
  }
}

// ── Download file with progress ────────────────────────────
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      const total   = parseInt(res.headers["content-length"] || "0");
      let downloaded = 0;
      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const percent = Math.round((downloaded / total) * 100);
          onProgress?.(Math.min(percent, 75));
        }
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ── Pull a model with streaming progress ──────────────────
async function pullModel(ollamaId, onProgress) {
  onProgress?.({ status: "starting", message: `Starting download of ${ollamaId}...`, percent: 0 });

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ollamaId, stream: true }),
    });

    if (!res.ok) {
      throw new Error(`Pull failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lastPercent = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text  = decoder.decode(value);
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);

          if (data.total && data.completed) {
            const percent = Math.round((data.completed / data.total) * 100);
            lastPercent   = percent;
            const downloaded = formatBytes(data.completed);
            const total      = formatBytes(data.total);
            onProgress?.({
              status:  "downloading",
              message: `Downloading ${ollamaId}... ${downloaded} / ${total}`,
              percent,
            });
          } else if (data.status) {
            onProgress?.({
              status:  data.status,
              message: data.status,
              percent: lastPercent,
            });
          }

          if (data.status === "success") {
            onProgress?.({ status: "done", message: "Model ready!", percent: 100 });
            return true;
          }
        } catch {}
      }
    }

    return true;
  } catch (err) {
    onProgress?.({ status: "error", message: `Download failed: ${err.message}`, percent: 0 });
    return false;
  }
}

// ── Check if model is already installed ───────────────────
async function isModelInstalled(ollamaId) {
  try {
    const res  = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    const data = await res.json();
    const modelName = ollamaId.split(":")[0];
    return (data.models || []).some(m =>
      m.name === ollamaId || m.name.startsWith(modelName)
    );
  } catch {
    return false;
  }
}

// ── Full setup: ensure Ollama + pull model ─────────────────
async function setupModel(ollamaId, onProgress) {
  // Step 1: Check Ollama installed
  let running = await isOllamaRunning();

  if (!running) {
    // Try to start existing installation
    onProgress?.({ step: "ollama", message: "Starting Ollama...", percent: 5 });
    running = await startOllama();

    if (!running) {
      // Need to install
      onProgress?.({ step: "ollama", message: "Installing Ollama (one time setup)...", percent: 0 });
      const installed = await installOllama((p) =>
        onProgress?.({ step: "ollama", ...p, percent: Math.round(p.percent * 0.3) })
      );
      if (!installed) {
        return { success: false, error: "Failed to install Ollama" };
      }
    }
  }

  onProgress?.({ step: "check", message: "Checking model...", percent: 32 });

  // Step 2: Check if model already downloaded
  const alreadyInstalled = await isModelInstalled(ollamaId);
  if (alreadyInstalled) {
    onProgress?.({ step: "done", message: "Model already installed!", percent: 100 });
    return { success: true, alreadyInstalled: true };
  }

  // Step 3: Pull model
  onProgress?.({ step: "model", message: `Downloading ${ollamaId}...`, percent: 35 });
  const pulled = await pullModel(ollamaId, (p) =>
    onProgress?.({ step: "model", ...p, percent: 35 + Math.round(p.percent * 0.65) })
  );

  if (!pulled) {
    return { success: false, error: "Failed to download model" };
  }

  return { success: true };
}

// ── Run a prompt through local Ollama ─────────────────────
async function runOllamaPrompt(ollamaId, systemPrompt, userContent) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userContent  },
  ];

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:    ollamaId,
      messages,
      stream:   false,
      options: {
        temperature: 0.1,
        num_predict: 1024,
      },
    }),
  });

  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
  const data = await res.json();
  return data.message?.content || "";
}

// ── Run with vision (image + text) ────────────────────────
async function runOllamaVision(ollamaId, systemPrompt, userText, imageBase64) {
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role:    "user",
      content: userText,
      images:  [imageBase64],
    },
  ];

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:    ollamaId,
      messages,
      stream:   false,
      options: { temperature: 0.1, num_predict: 1024 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama vision error: ${res.status}`);
  const data = await res.json();
  return data.message?.content || "";
}

// ── Helper ─────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

module.exports = {
  isOllamaRunning,
  startOllama,
  installOllama,
  pullModel,
  isModelInstalled,
  setupModel,
  runOllamaPrompt,
  runOllamaVision,
};