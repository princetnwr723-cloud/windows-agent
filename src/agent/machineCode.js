// src/agent/machineCode.js
// Generates a PERMANENT 10-char code based on machine hardware ID
// Same machine = same code always
// Only changes if user deletes + reinstalls the app

const os   = require("os");
const crypto = require("crypto");

// ── Get unique machine fingerprint ────────────────────────
function getMachineFingerprint() {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || "",
    String(os.totalmem()),
  ];

  // Try node-machine-id if available
  try {
    const { machineIdSync } = require("node-machine-id");
    parts.push(machineIdSync());
  } catch {
    // fallback to network interfaces MAC
    try {
      const nets    = os.networkInterfaces();
      const macs    = [];
      for (const iface of Object.values(nets)) {
        for (const addr of (iface || [])) {
          if (addr.mac && addr.mac !== "00:00:00:00:00:00") {
            macs.push(addr.mac);
          }
        }
      }
      if (macs.length > 0) parts.push(macs.sort().join("|"));
    } catch {}
  }

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

  return code; // e.g. "ABCD-EFGHIJ" → shown as "ABCDE-FGHIJ"
}

module.exports = { generatePermanentCode, getMachineFingerprint };
