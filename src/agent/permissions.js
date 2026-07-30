// src/agent/permissions.js
// Permission System — Agent har dangerous kaam se pehle user se poochta hai
// User website/workspace se approve ya deny karta hai
// Agent tab tak wait karta hai

const path = require("path");
const os   = require("os");

// ── Permission types ───────────────────────────────────────
const PERMISSION_TYPES = {
  FILE_DELETE:  { label: "Delete File",    risk: "high",   icon: "🗑️" },
  FILE_EDIT:    { label: "Edit File",      risk: "medium", icon: "✏️" },
  FILE_CREATE:  { label: "Create File",    risk: "low",    icon: "📄" },
  RUN_COMMAND:  { label: "Run Command",    risk: "high",   icon: "⚡" },
  GITHUB_PUSH:  { label: "Push to GitHub", risk: "medium", icon: "🐙" },
  GITHUB_DELETE:{ label: "Delete from GitHub", risk: "high", icon: "🗑️" },
  BROWSER_FILL: { label: "Fill Form",      risk: "low",    icon: "📝" },
};

// ── High risk commands that always need confirmation ───────
const HIGH_RISK_COMMANDS = [
  // File deletion
  /\bdel\b.*\/[sqf]/i,
  /\brm\b.*-[rf]/i,
  /\brmdir\b/i,
  /\brd\b.*\/s/i,
  // Disk formatting
  /format\s+[a-z]:/i,
  /diskpart/i,
  /mkfs/i,
  // Registry
  /reg\s+delete/i,
  /regedit/i,
  // System shutdown/restart
  /shutdown/i,
  /\breboot\b/i,
  // Network
  /netsh.*delete/i,
  /iptables.*-D/i,
  // Package removal
  /npm\s+uninstall/i,
  /pip\s+uninstall/i,
  /apt.*remove/i,
  /brew\s+uninstall/i,
];

// ── Medium risk — need confirmation on first use ───────────
const MEDIUM_RISK_COMMANDS = [
  /curl.*\|\s*(?:bash|sh)/i,
  /wget.*\|\s*(?:bash|sh)/i,
  /powershell.*-enc/i,
  /python.*-c/i,
  /node.*-e/i,
];

// ── Blocklist — NEVER execute these ───────────────────────
const BLOCKED_COMMANDS = [
  /rm\s+-rf\s+\//i,
  /rm\s+-rf\s+~\//i,
  /format\s+c:/i,
  /del\s+\/f\s+\/s\s+\/q\s+c:\\/i,
  /rd\s+\/s\s+\/q\s+c:\\/i,
  /:\(\)\{:\|:&\};:/,  // fork bomb
  /dd\s+if=.*of=\/dev\/[sh]d/i,
];

// ── Check command risk level ───────────────────────────────
function assessCommandRisk(command) {
  const cmd = command.trim();

  // Check blocklist first — always block
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(cmd)) {
      return { level: "blocked", reason: `This command is permanently blocked for safety: ${cmd.slice(0, 50)}` };
    }
  }

  // Check high risk
  for (const pattern of HIGH_RISK_COMMANDS) {
    if (pattern.test(cmd)) {
      return { level: "high", reason: `High-risk command detected: ${cmd.slice(0, 60)}` };
    }
  }

  // Check medium risk
  for (const pattern of MEDIUM_RISK_COMMANDS) {
    if (pattern.test(cmd)) {
      return { level: "medium", reason: `Command requires confirmation: ${cmd.slice(0, 60)}` };
    }
  }

  return { level: "safe" };
}

// ── Assess file operation risk ─────────────────────────────
function assessFileRisk(action, filePath) {
  const p = (filePath || "").toLowerCase();

  // System files — always block
  const systemPaths = [
    "c:\\windows", "c:\\system32", "/etc/", "/usr/bin",
    "/bin/", "/sbin/", "c:\\program files\\",
  ];
  if (systemPaths.some(sp => p.includes(sp))) {
    return { level: "blocked", reason: `Cannot modify system files: ${filePath}` };
  }

  // Delete is always high risk
  if (action === "delete" || action === "FILE_DELETE") {
    return { level: "high", reason: `Delete file: ${filePath}` };
  }

  // Edit existing files — medium risk
  if (action === "write_file" || action === "FILE_EDIT") {
    const fs = require("fs");
    if (fs.existsSync(filePath)) {
      return { level: "medium", reason: `Overwrite existing file: ${filePath}` };
    }
    return { level: "low", reason: `Create new file: ${filePath}` };
  }

  return { level: "safe" };
}

// ── Send permission request to Firestore ──────────────────
async function requestPermission(workspaceId, firebaseConfig, permissionData) {
  const {
    type,
    description,
    command,
    filePath,
    riskLevel,
    chatId,
    messageId,
  } = permissionData;

  const permId  = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const BASE    = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const API_KEY = firebaseConfig.apiKey;

  // Save permission request to Firestore
  const url = `${BASE}/agent_connections/${workspaceId}/permissions/${permId}?key=${API_KEY}`;
  try {
    await fetch(url, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        fields: {
          id:          { stringValue: permId },
          type:        { stringValue: type },
          description: { stringValue: description },
          command:     { stringValue: command || "" },
          filePath:    { stringValue: filePath || "" },
          riskLevel:   { stringValue: riskLevel },
          status:      { stringValue: "pending" },
          chatId:      { stringValue: chatId || "" },
          messageId:   { stringValue: messageId || "" },
          createdAt:   { stringValue: new Date().toISOString() },
          icon:        { stringValue: PERMISSION_TYPES[type]?.icon || "⚡" },
        },
      }),
    });
  } catch (err) {
    console.error("Permission request save error:", err.message);
    throw new Error("Could not save permission request");
  }

  return permId;
}

// ── Wait for user decision (poll Firestore) ───────────────
async function waitForPermission(workspaceId, permId, firebaseConfig, timeoutMs = 60000) {
  const BASE    = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const API_KEY = firebaseConfig.apiKey;
  const url     = `${BASE}/agent_connections/${workspaceId}/permissions/${permId}?key=${API_KEY}`;

  const startTime = Date.now();

  return new Promise((resolve) => {
    const poll = setInterval(async () => {
      // Timeout — deny by default
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(poll);
        console.log(`⏰ Permission timeout: ${permId}`);
        resolve({ granted: false, reason: "timeout" });
        return;
      }

      try {
        const res    = await fetch(url, { signal: AbortSignal.timeout(4000) });
        const data   = await res.json();
        const status = data?.fields?.status?.stringValue;

        if (status === "approved") {
          clearInterval(poll);
          console.log(`✅ Permission granted: ${permId}`);
          resolve({ granted: true });
        } else if (status === "denied") {
          clearInterval(poll);
          console.log(`❌ Permission denied: ${permId}`);
          resolve({ granted: false, reason: "user_denied" });
        }
      } catch {}
    }, 2000);
  });
}

// ── Main permission check (used in brain.js) ──────────────
async function checkAndRequestPermission(action, details, workspaceId, firebaseConfig, context = {}) {
  let riskAssessment = { level: "safe" };

  // Assess risk based on action type
  if (action === "run_command") {
    riskAssessment = assessCommandRisk(details.command || "");
  } else if (action === "write_file") {
    riskAssessment = assessFileRisk("write_file", details.path || "");
  } else if (action === "delete_file" || details.delete) {
    riskAssessment = assessFileRisk("delete", details.path || "");
  } else if (action === "github_delete_file") {
    riskAssessment = { level: "high", reason: `Delete from GitHub: ${details.path}` };
  } else if (action === "github_write_file") {
    riskAssessment = { level: "medium", reason: `Push to GitHub: ${details.path}` };
  }

  // Blocked — never execute
  if (riskAssessment.level === "blocked") {
    return {
      allowed:  false,
      blocked:  true,
      reason:   riskAssessment.reason,
    };
  }

  // Safe — no permission needed
  if (riskAssessment.level === "safe" || riskAssessment.level === "low") {
    return { allowed: true };
  }

  // Medium/High — need user permission
  console.log(`🔐 Permission required [${riskAssessment.level}]: ${riskAssessment.reason}`);

  const permId = await requestPermission(workspaceId, firebaseConfig, {
    type:        action === "run_command" ? "RUN_COMMAND" : action === "github_delete_file" ? "GITHUB_DELETE" : "FILE_EDIT",
    description: riskAssessment.reason,
    command:     details.command || "",
    filePath:    details.path || "",
    riskLevel:   riskAssessment.level,
    chatId:      context.chatId || "",
    messageId:   context.messageId || "",
  });

  const result = await waitForPermission(workspaceId, permId, firebaseConfig);

  return {
    allowed: result.granted,
    reason:  result.reason,
    permId,
  };
}

module.exports = {
  assessCommandRisk,
  assessFileRisk,
  checkAndRequestPermission,
  requestPermission,
  waitForPermission,
  HIGH_RISK_COMMANDS,
  BLOCKED_COMMANDS,
  PERMISSION_TYPES,
};
