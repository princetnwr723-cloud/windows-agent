// src/agent/machineCode.js
// Generates a PERMANENT 10-char code.
// FIX: previously, when node-machine-id was unavailable, this fell
// back to hashing network interface MAC addresses — which change
// when switching WiFi networks, plugging in Ethernet, using a VPN,
// or when a network adapter is disabled. That silently broke the
// "same machine = same code always" promise, causing a brand new
// code to be generated on some launches while the OLD code stayed
// stuck in RTDB as a orphaned "waiting" workspace forever.
//
// New fallback: a random UUID stored ONCE in a local file. This
// never changes regardless of network state — it only changes if
// the user deletes the app's data folder (same as before).

const os     = require("os");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");

const ID_DIR  = path.join(os.homedir(), ".vnus-agent");
const ID_FILE = path.join(ID_DIR, "machine-id.txt");

// ── Get a stable local fallback ID — created once, reused forever ──
function getStableLocalId() {
  try {
    if (!fs.existsSync(ID_DIR)) fs.mkdirSync(ID_DIR, { recursive: true });
    if (fs.existsSync(ID_FILE)) {
      const existing = fs.readFileSync(ID_FILE, "utf8").trim();
      if (existing) return existing;
    }
    const fresh = crypto.randomUUID();
    fs.writeFileSync(ID_FILE, fresh, "utf8");
    console.log("🆕 Created new stable local machine ID (first run)");
    return fresh;
  } catch (err) {
    console.error("⚠️ Could not read/write stable local ID file:", err.message);
    // last-resort — still better than MAC addresses, at least stable per-process
    return "fallback-" + os.hostname();
  }
}

// ── Get unique machine fingerprint ────────────────────────
function getMachineFingerprint() {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || "",
    String(os.totalmem()),
  ];

  // Try node-machine-id if available — this IS stable across reboots
  // and network changes, so prefer it when it works.
  try {
    const { machineIdSync } = require("node-machine-id");
    const id = machineIdSync();
    if (id) {
      parts.push(id);
      return parts.join(":::");
    }
  } catch (err) {
    console.warn("⚠️ node-machine-id unavailable, using stable local fallback:", err.message);
  }

  // FIXED FALLBACK: use a locally-stored stable ID instead of MAC
  // addresses (which change with network conditions and broke the
  // "permanent" code promise).
  parts.push(getStableLocalId());
  return parts.join(":::");
}

// ── Generate permanent 10-char code from fingerprint ──────
function generatePermanentCode() {
  const fingerprint = getMachineFingerprint();
  const hash        = crypto
    .createHash("sha256")
    .update(fingerprint)
    .digest("hex");

  // Use chars that are easy to read — no 0/O, 1/I confusion
  const chars  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code     = "";

  for (let i = 0; i < 10; i++) {
    const byte  = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    code       += chars[byte % chars.length];
  }

  return code;
}

module.exports = { generatePermanentCode, getMachineFingerprint };