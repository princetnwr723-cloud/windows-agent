// src/agent/agentNetwork.js
// ═══════════════════════════════════════════════════════════
// INTER-AGENT PROTOCOL  (Feature #5 — HONEST SCOPE)
//
// What "agents talking to other companies' agents" actually
// requires before it can be safe: a shared identity/auth
// standard, a discovery mechanism, consent flows on BOTH sides,
// spam/abuse prevention, and rate limiting across untrusted
// parties. None of that exists as an industry standard yet —
// building a fake version of it wouldn't make Agentic Vnus more
// powerful, it would just be an unguarded network endpoint.
//
// What IS safe and genuinely useful today: YOUR OWN agents,
// across YOUR OWN workspaces/PCs, coordinating with each other.
// You already own the trust boundary — it's the same RTDB
// account, same billing, same user. This is real "multi-PC
// swarm" coordination, and it's the correct foundation to widen
// into a cross-org protocol LATER, once (if) an industry
// standard for agent identity actually emerges.
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const NETWORK_FILE = path.join(os.homedir(), ".vnus-agent", "agent-network.json");

function loadNetwork() {
  try { return JSON.parse(fs.readFileSync(NETWORK_FILE, "utf8")); }
  catch { return { knownWorkspaces: [], pendingRequests: [] }; }
}
function saveNetwork(n) {
  fs.writeFileSync(NETWORK_FILE, JSON.stringify(n, null, 2));
}

// ── Register another of YOUR OWN workspaces as a known peer ──
// (e.g. your laptop's agent and your desktop's agent, both under
// the same Agentic Vnus account) — this is an explicit, manual
// step, never automatic discovery of unknown machines.
function registerPeerWorkspace(workspaceId, label) {
  const net = loadNetwork();
  if (net.knownWorkspaces.find(w => w.id === workspaceId)) {
    return { success: false, error: "Already registered" };
  }
  net.knownWorkspaces.push({ id: workspaceId, label, registeredAt: new Date().toISOString() });
  saveNetwork(net);
  return { success: true };
}

function removePeerWorkspace(workspaceId) {
  const net = loadNetwork();
  net.knownWorkspaces = net.knownWorkspaces.filter(w => w.id !== workspaceId);
  saveNetwork(net);
}

function listPeerWorkspaces() {
  return loadNetwork().knownWorkspaces;
}

// ── Send a task request to another of your own workspaces ────
// Delivered via the SAME RTDB the rest of the app already uses —
// no new network surface, no new auth system, just a message in
// a path scoped to workspaces you already own.
async function requestFromPeer(rtdbSet, apiKey, rtdbUrl, targetWorkspaceId, task, fromWorkspaceId) {
  const net = loadNetwork();
  const known = net.knownWorkspaces.find(w => w.id === targetWorkspaceId);
  if (!known) {
    return { success: false, error: "Target workspace is not a registered peer — register it first from the dashboard" };
  }

  const requestId = `peer_req_${Date.now()}`;
  await rtdbSet(rtdbUrl, `/workspaces/${targetWorkspaceId}/peerRequests/${requestId}`, {
    fromWorkspaceId,
    task,
    status:    "pending",
    createdAt: Date.now(),
  }, apiKey);

  return { success: true, requestId };
}

// ── Handle an incoming peer request — still requires local
// approval unless the user has pre-authorized this specific peer
// for autonomous handling (opt-in, off by default) ───────────
function shouldAutoApprove(fromWorkspaceId) {
  const net = loadNetwork();
  const peer = net.knownWorkspaces.find(w => w.id === fromWorkspaceId);
  return !!peer?.autoApprove; // false unless explicitly set
}

function setAutoApprove(workspaceId, enabled) {
  const net = loadNetwork();
  const peer = net.knownWorkspaces.find(w => w.id === workspaceId);
  if (peer) { peer.autoApprove = enabled; saveNetwork(net); }
}

module.exports = {
  registerPeerWorkspace,
  removePeerWorkspace,
  listPeerWorkspaces,
  requestFromPeer,
  shouldAutoApprove,
  setAutoApprove,
};