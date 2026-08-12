// src/agent/connectors.js
// API Connectors — store, encrypt, route to best provider
// Keys stored locally at ~/.vnus-agent/connectors.json
// Keys NEVER go to RTDB or any server

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const crypto = require("crypto");
const { getMachineId } = require("node-machine-id");

const CONNECTORS_FILE = path.join(os.homedir(), ".vnus-agent", "connectors.json");

// ── Encryption using machine ID as key ────────────────────
async function getEncryptionKey() {
  const machineId = await getMachineId();
  return crypto.createHash("sha256").update(machineId).digest("hex").slice(0, 32);
}

function encrypt(text, key) {
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text, key) {
  try {
    const [ivHex, encrypted] = text.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch { return null; }
}

// ── Connector Definitions ─────────────────────────────────
const CONNECTOR_DEFS = {
  openrouter: {
    name:        "OpenRouter",
    icon:        "🔀",
    description: "100+ models — Claude, GPT-4o, Gemini, Llama in one key",
    baseUrl:     "https://openrouter.ai/api/v1",
    keyPrefix:   "sk-or-",
    keyHint:     "sk-or-v1-...",
    defaultModel:"anthropic/claude-sonnet-4-5",
    models:      ["anthropic/claude-sonnet-4-5","openai/gpt-4o","google/gemini-pro-1.5","deepseek/deepseek-r1","meta-llama/llama-3.3-70b-instruct"],
    bestFor:     ["coding","content","strategy","general"],
    priority:    1,
  },
  anthropic: {
    name:        "Anthropic",
    icon:        "🤖",
    description: "Claude Sonnet — best reasoning and coding",
    baseUrl:     "https://api.anthropic.com/v1",
    keyPrefix:   "sk-ant-",
    keyHint:     "sk-ant-api03-...",
    defaultModel:"claude-sonnet-4-5",
    models:      ["claude-opus-4-5","claude-sonnet-4-5","claude-haiku-4-5-20251001"],
    bestFor:     ["coding","reasoning","content","strategy"],
    priority:    2,
  },
  openai: {
    name:        "OpenAI",
    icon:        "⚡",
    description: "GPT-4o, o1, o3 — most capable models",
    baseUrl:     "https://api.openai.com/v1",
    keyPrefix:   "sk-",
    keyHint:     "sk-proj-...",
    defaultModel:"gpt-4o",
    models:      ["gpt-4o","gpt-4o-mini","o1-mini","o3-mini"],
    bestFor:     ["coding","general","reasoning"],
    priority:    3,
  },
  gemini: {
    name:        "Google Gemini",
    icon:        "💎",
    description: "Gemini 2.0 Flash — fast, free tier, 2M context",
    baseUrl:     "https://generativelanguage.googleapis.com/v1beta",
    keyPrefix:   "AIza",
    keyHint:     "AIzaSy...",
    defaultModel:"gemini-2.0-flash",
    models:      ["gemini-2.0-flash","gemini-1.5-pro","gemini-1.5-flash"],
    bestFor:     ["general","content","multimodal"],
    priority:    4,
  },
  groq: {
    name:        "Groq",
    icon:        "🚀",
    description: "Ultra-fast inference — Llama, Mixtral — free tier",
    baseUrl:     "https://api.groq.com/openai/v1",
    keyPrefix:   "gsk_",
    keyHint:     "gsk_...",
    defaultModel:"llama-3.3-70b-versatile",
    models:      ["llama-3.3-70b-versatile","mixtral-8x7b-32768","llama-3.1-8b-instant"],
    bestFor:     ["fast","general"],
    priority:    5,
  },
  mistral: {
    name:        "Mistral AI",
    icon:        "🌊",
    description: "Mistral Large — European privacy, strong reasoning",
    baseUrl:     "https://api.mistral.ai/v1",
    keyPrefix:   "",
    keyHint:     "your-mistral-api-key",
    defaultModel:"mistral-large-latest",
    models:      ["mistral-large-latest","mistral-medium-latest","codestral-latest"],
    bestFor:     ["coding","general","europe"],
    priority:    6,
  },
  together: {
    name:        "Together AI",
    icon:        "🤝",
    description: "Open source models — cheap, fast, Llama hosted",
    baseUrl:     "https://api.together.xyz/v1",
    keyPrefix:   "",
    keyHint:     "your-together-api-key",
    defaultModel:"meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models:      ["meta-llama/Llama-3.3-70B-Instruct-Turbo","Qwen/Qwen2.5-72B-Instruct-Turbo"],
    bestFor:     ["general","cheap"],
    priority:    7,
  },
  deepseek: {
    name:        "DeepSeek",
    icon:        "🔬",
    description: "DeepSeek R1 — world-class reasoning, very cheap",
    baseUrl:     "https://api.deepseek.com/v1",
    keyPrefix:   "sk-",
    keyHint:     "sk-...",
    defaultModel:"deepseek-reasoner",
    models:      ["deepseek-reasoner","deepseek-chat"],
    bestFor:     ["reasoning","coding","cheap"],
    priority:    8,
  },
  perplexity: {
    name:        "Perplexity",
    icon:        "🔍",
    description: "Web search + AI — real-time information access",
    baseUrl:     "https://api.perplexity.ai",
    keyPrefix:   "pplx-",
    keyHint:     "pplx-...",
    defaultModel:"sonar-pro",
    models:      ["sonar-pro","sonar","sonar-reasoning"],
    bestFor:     ["research","web-search","real-time"],
    priority:    9,
  },
  cohere: {
    name:        "Cohere",
    icon:        "🎯",
    description: "Command R+ — excellent for RAG and enterprise",
    baseUrl:     "https://api.cohere.ai/v1",
    keyPrefix:   "",
    keyHint:     "your-cohere-api-key",
    defaultModel:"command-r-plus",
    models:      ["command-r-plus","command-r","command-light"],
    bestFor:     ["rag","enterprise","search"],
    priority:    10,
  },
};

// ── Load connectors ────────────────────────────────────────
async function loadConnectors() {
  try {
    if (!fs.existsSync(CONNECTORS_FILE)) return {};
    const raw  = JSON.parse(fs.readFileSync(CONNECTORS_FILE, "utf8"));
    const key  = await getEncryptionKey();
    const result = {};
    for (const [provider, data] of Object.entries(raw)) {
      if (data.encryptedKey) {
        const decrypted = decrypt(data.encryptedKey, key);
        if (decrypted) result[provider] = { ...data, apiKey: decrypted, encryptedKey: undefined };
      }
    }
    return result;
  } catch (err) {
    console.error("Load connectors error:", err.message);
    return {};
  }
}

// ── Save connector ─────────────────────────────────────────
async function saveConnector(provider, apiKey, selectedModel) {
  try {
    const dir = path.dirname(CONNECTORS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const key          = await getEncryptionKey();
    const encryptedKey = encrypt(apiKey, key);
    const existing     = fs.existsSync(CONNECTORS_FILE)
      ? JSON.parse(fs.readFileSync(CONNECTORS_FILE, "utf8"))
      : {};

    existing[provider] = {
      provider,
      encryptedKey,
      model:    selectedModel || CONNECTOR_DEFS[provider]?.defaultModel,
      enabled:  true,
      savedAt:  new Date().toISOString(),
    };

    fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(existing, null, 2));
    console.log(`✅ Connector saved: ${provider}`);
    return true;
  } catch (err) {
    console.error("Save connector error:", err.message);
    return false;
  }
}

// ── Remove connector ───────────────────────────────────────
async function removeConnector(provider) {
  try {
    if (!fs.existsSync(CONNECTORS_FILE)) return;
    const existing = JSON.parse(fs.readFileSync(CONNECTORS_FILE, "utf8"));
    delete existing[provider];
    fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(existing, null, 2));
    console.log(`🗑️ Connector removed: ${provider}`);
  } catch (err) {
    console.error("Remove connector error:", err.message);
  }
}

// ── Test connector ─────────────────────────────────────────
async function testConnector(provider, apiKey) {
  const def = CONNECTOR_DEFS[provider];
  if (!def) return { success: false, error: "Unknown provider" };

  try {
    // Different test for each provider
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }),
      });
      const data = await res.json();
      if (data.error) return { success: false, error: data.error.message };
      return { success: true, model: "claude-haiku-4-5-20251001" };
    }

    if (provider === "gemini") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }] }] }),
      });
      const data = await res.json();
      if (data.error) return { success: false, error: data.error.message };
      return { success: true, model: "gemini-2.0-flash" };
    }

    // OpenAI-compatible (openai, openrouter, groq, mistral, together, deepseek, perplexity, cohere)
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
    if (provider === "openrouter") headers["HTTP-Referer"] = "https://agenticvnus.com";

    const res = await fetch(`${def.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: def.defaultModel, max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }),
    });
    const data = await res.json();
    if (data.error) return { success: false, error: data.error.message || JSON.stringify(data.error) };
    return { success: true, model: def.defaultModel };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Get active connector — ONE key handles everything ────
async function getBestConnector(taskType = "general") {
  const connectors = await loadConnectors();
  if (!Object.keys(connectors).length) return null;

  // Find first enabled connector — user sets ONE key, it handles all tasks
  // Priority: anthropic > openrouter > openai > gemini > groq > others
  const priority = ["anthropic","openrouter","openai","gemini","groq","deepseek","mistral","together","perplexity","cohere"];

  for (const provider of priority) {
    if (connectors[provider]?.enabled && connectors[provider]?.apiKey) {
      const def = CONNECTOR_DEFS[provider];
      console.log(`🔀 Using: ${def.name} for ${taskType} task`);
      return {
        provider,
        apiKey:  connectors[provider].apiKey,
        model:   connectors[provider].model || def.defaultModel,
        baseUrl: def.baseUrl,
        name:    def.name,
        def,
      };
    }
  }
  return null;
}

// ── Call API through connector ─────────────────────────────
async function callConnector(connector, systemPrompt, userPrompt) {
  const { provider, apiKey, model, baseUrl, def } = connector;

  const headers = {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://agenticvnus.com";
    headers["X-Title"]      = "Agentic Vnus";
  }

  if (provider === "anthropic") {
    // Anthropic has different API format
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system:   systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.[0]?.text || "";
  }

  if (provider === "gemini") {
    // Gemini different format
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: { maxOutputTokens: 4096 },
        }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  // OpenAI-compatible format (openai, groq, mistral, together, deepseek, perplexity, cohere, openrouter)
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.choices?.[0]?.message?.content || "";
}

// ── Get masked key for display ─────────────────────────────
function maskKey(apiKey) {
  if (!apiKey || apiKey.length < 8) return "••••••••";
  return apiKey.slice(0, 8) + "••••••••" + apiKey.slice(-4);
}

// ── Get connector status for RTDB sync ────────────────────
async function getConnectorStatus() {
  const connectors = await loadConnectors();
  const result = {};
  for (const [provider, data] of Object.entries(connectors)) {
    result[provider] = {
      provider,
      enabled:    data.enabled,
      model:      data.model,
      savedAt:    data.savedAt,
      maskedKey:  maskKey(data.apiKey),
    };
  }
  return result;
}

module.exports = {
  CONNECTOR_DEFS,
  loadConnectors,
  saveConnector,
  removeConnector,
  testConnector,
  getBestConnector,
  callConnector,
  getConnectorStatus,
  maskKey,
};