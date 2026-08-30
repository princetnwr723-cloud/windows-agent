// src/agent/worldModel.js
// ═══════════════════════════════════════════════════════════
// CONTINUOUS WORLD MODEL  (Feature #3)
// Business DNA stores FACTS. Drift Detection catches CHANGES.
// This layer builds PATTERNS and PROJECTIONS from the history
// of both — turning "here's what happened" into "here's where
// this is heading" in the weekly report and on demand.
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const MODEL_FILE = path.join(os.homedir(), ".vnus-agent", "world-model.json");

function loadModel() {
  try { return JSON.parse(fs.readFileSync(MODEL_FILE, "utf8")); }
  catch { return { snapshots: [] }; }
}
function saveModel(m) {
  fs.writeFileSync(MODEL_FILE, JSON.stringify(m, null, 2));
}

// ── Record a snapshot of key metrics — called weekly, and any
// time DNA drift is applied (so we capture the moment things changed) ──
function recordSnapshot(source = "weekly") {
  const { loadDNA } = require("./businessDNA");
  const dna = loadDNA();
  if (!dna.setupComplete) return null;

  const model = loadModel();

  const mrrRaw = dna.metrics?.mrr;
  const mrr    = mrrRaw ? parseFloat(String(mrrRaw).replace(/[^0-9.]/g, "")) : null;
  const usersRaw = dna.metrics?.users;
  const users    = usersRaw ? parseInt(String(usersRaw).replace(/[^0-9]/g, ""), 10) : null;

  const snapshot = {
    date:  new Date().toISOString(),
    source,
    mrr,
    users,
    focus: dna.currentFocus || null,
  };

  model.snapshots.push(snapshot);
  // Keep a rolling window — enough for meaningful trend lines
  // without the file growing forever
  model.snapshots = model.snapshots.slice(-104); // ~2 years of weekly points
  saveModel(model);

  return snapshot;
}

// ── Compute trend + a simple linear projection ───────────────
// Deliberately simple (linear regression over recent points) —
// this is presented as a directional signal, not a forecast
// promise, and is labeled as such wherever it's shown.
function computeTrend(field = "mrr", windowPoints = 8) {
  const model = loadModel();
  const points = model.snapshots
    .filter(s => s[field] !== null && s[field] !== undefined)
    .slice(-windowPoints);

  if (points.length < 3) {
    return { available: false, reason: `Need at least 3 data points, have ${points.length}. Keep using the agent — this fills in automatically.` };
  }

  // Simple linear regression: x = index, y = value
  const n  = points.length;
  const xs = points.map((_, i) => i);
  const ys = points.map(p => p[field]);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  const num = xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i] - yMean), 0);
  const den = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  const current  = ys[ys.length - 1];
  const previous = ys[0];
  const changePercent = previous ? ((current - previous) / previous) * 100 : 0;

  // Project forward — same weekly cadence as the recorded points
  const weeksAhead = 12;
  const projected  = intercept + slope * (n - 1 + weeksAhead);

  return {
    available:      true,
    field,
    current,
    changePercent:  Math.round(changePercent * 10) / 10,
    direction:      slope > 0 ? "up" : slope < 0 ? "down" : "flat",
    weeklyRate:     Math.round(slope * 100) / 100,
    projectedIn12Weeks: Math.round(projected),
    pointsUsed:     n,
    confidence:     n >= 8 ? "moderate" : "low", // honest — small samples = low confidence
  };
}

// ── Build the "here's where this is heading" section for the
// weekly report / on-demand queries ──────────────────────────
function buildTrajectoryReport() {
  const mrrTrend   = computeTrend("mrr");
  const userTrend  = computeTrend("users");

  let report = `📈 **Business Trajectory** (directional signal, not a guarantee)\n\n`;

  [["Revenue", mrrTrend, "$"], ["Users", userTrend, ""]].forEach(([label, trend, prefix]) => {
    if (!trend.available) {
      report += `${label}: not enough history yet — ${trend.reason}\n\n`;
      return;
    }
    const arrow = trend.direction === "up" ? "↗" : trend.direction === "down" ? "↘" : "→";
    report += `${label}: ${arrow} ${trend.changePercent > 0 ? "+" : ""}${trend.changePercent}% over the last ${trend.pointsUsed} check-ins\n`;
    report += `  Current: ${prefix}${trend.current}\n`;
    report += `  If this pace holds, ~12 weeks out: ${prefix}${trend.projectedIn12Weeks} (${trend.confidence} confidence — more history sharpens this)\n\n`;
  });

  return report;
}

// ── Query interface for on-demand questions ──────────────────
function answerTrajectoryQuestion(question) {
  const q = question.toLowerCase();
  if (/revenue|mrr|arr/i.test(q)) return computeTrend("mrr");
  if (/user|customer/i.test(q))   return computeTrend("users");
  return { available: false, reason: "Ask about revenue or users specifically — those are the tracked metrics right now." };
}

module.exports = {
  recordSnapshot,
  computeTrend,
  buildTrajectoryReport,
  answerTrajectoryQuestion,
  loadModel,
};