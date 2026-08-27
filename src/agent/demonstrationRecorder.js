// src/agent/demonstrationRecorder.js
// ═══════════════════════════════════════════════════════════
// DEMONSTRATION RECORDER
// "Show it once, it repeats it" — for tools with no API/MCP
// Records a human's browser actions, generalizes them into a
// replayable macro (semantic selectors, not fixed pixels),
// then replays with new data on future runs.
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { perceive, actOnElement, verify } = require("./accessibilityEngine");

const MACRO_DIR = path.join(os.homedir(), ".vnus-agent", "macros");
if (!fs.existsSync(MACRO_DIR)) fs.mkdirSync(MACRO_DIR, { recursive: true });

let activeRecording = null; // { name, startedAt, rawEvents: [] }

// ── Injected page-side recorder script ─────────────────────
const RECORDER_SCRIPT = `
(() => {
  if (window.__vnusRecording) return;
  window.__vnusRecording = true;
  window.__vnusEvents = [];

  function describe(el) {
    if (!el) return null;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || el.innerText?.trim().slice(0, 60) || el.getAttribute('name') || el.getAttribute('title') || '';
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return { role, label, tag: el.tagName.toLowerCase(), id: el.id || null };
  }

  document.addEventListener('click', (e) => {
    window.__vnusEvents.push({
      type: 'click',
      target: describe(e.target),
      timestamp: Date.now(),
      url: location.href,
    });
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || !['INPUT','TEXTAREA'].includes(el.tagName)) return;
    window.__vnusEvents.push({
      type: 'type',
      target: describe(el),
      value: el.value,
      timestamp: Date.now(),
      url: location.href,
    });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'SELECT') return;
    window.__vnusEvents.push({
      type: 'select',
      target: describe(el),
      value: el.value,
      timestamp: Date.now(),
      url: location.href,
    });
  }, true);
})();
`;

// ── Start recording — inject listener into the page ─────────
async function startRecording(page, taskName) {
  if (activeRecording) {
    return { success: false, error: `Already recording "${activeRecording.name}"` };
  }

  await page.addInitScript(RECORDER_SCRIPT);
  await page.evaluate(RECORDER_SCRIPT).catch(() => {});

  activeRecording = {
    name: taskName,
    startedAt: new Date().toISOString(),
    startUrl: page.url(),
    page,
  };

  console.log(`🔴 Recording started: "${taskName}"`);
  console.log(`   Do the task manually now. Say "stop recording" when done.`);

  return { success: true, message: `Recording "${taskName}". Perform the task now.` };
}

// ── Stop recording — pull events, generalize, save ──────────
async function stopRecording() {
  if (!activeRecording) {
    return { success: false, error: "No active recording" };
  }

  const { name, page, startUrl, startedAt } = activeRecording;

  const rawEvents = await page.evaluate(() => window.__vnusEvents || []).catch(() => []);

  if (!rawEvents.length) {
    activeRecording = null;
    return { success: false, error: "No actions were captured during recording" };
  }

  const macro = generalizeMacro(rawEvents, { name, startUrl, startedAt });
  saveMacro(name, macro);

  console.log(`⏹️ Recording stopped: "${name}" — ${macro.steps.length} steps captured`);
  activeRecording = null;

  return { success: true, macro, message: `Saved "${name}" with ${macro.steps.length} steps.` };
}

// ── Generalize raw events into a replayable macro ──────────
// Key idea: drop timestamps and pixel coords, keep semantic
// descriptors (role + label) so it survives layout changes.
// Also detects which typed values look like "data" that
// should become parameters on replay (vs fixed boilerplate).
function generalizeMacro(rawEvents, meta) {
  const steps = [];
  let lastUrl = meta.startUrl;

  for (const ev of rawEvents) {
    if (ev.url !== lastUrl) {
      steps.push({ description: `page is now at ${ev.url}`, action: "navigate", value: ev.url });
      lastUrl = ev.url;
    }

    const label = ev.target?.label || ev.target?.tag || "element";

    if (ev.type === "click") {
      // Collapse consecutive duplicate clicks on same element
      const prev = steps[steps.length - 1];
      if (prev && prev.action === "click" && prev.description === label) continue;
      steps.push({ description: label, action: "click", role: ev.target?.role });
    }
    else if (ev.type === "type") {
      // Keep only the LAST value typed into a given field
      // (users often correct themselves while typing)
      const existingIdx = steps.findIndex(s => s.action === "type" && s.description === label);
      const stepData = {
        description: label,
        action: "type",
        role: ev.target?.role,
        value: ev.value,
        isParameter: guessIsParameter(ev.value),
      };
      if (existingIdx >= 0) steps[existingIdx] = stepData;
      else steps.push(stepData);
    }
    else if (ev.type === "select") {
      steps.push({ description: label, action: "select", role: ev.target?.role, value: ev.value });
    }
  }

  return {
    name: meta.name,
    createdAt: meta.startedAt,
    startUrl: meta.startUrl,
    steps,
    runCount: 0,
    lastRun: null,
  };
}

// ── Heuristic: is this typed value likely "data" (should be
// swappable on replay) vs fixed boilerplate text? ──────────
function guessIsParameter(value) {
  if (!value || value.length < 2) return false;
  // Looks like a proper noun, title, or short phrase → likely a parameter
  const looksLikeTitle = /^[A-Z]/.test(value) && value.split(" ").length <= 8;
  const looksLikeUrl    = /^https?:\/\//.test(value);
  const looksLikeNumber = /^\d+$/.test(value);
  return looksLikeTitle || looksLikeUrl || looksLikeNumber;
}

// ── Save / load macros to disk ──────────────────────────────
function saveMacro(name, macro) {
  const file = path.join(MACRO_DIR, `${slugify(name)}.json`);
  fs.writeFileSync(file, JSON.stringify(macro, null, 2));
}

function loadMacro(name) {
  const file = path.join(MACRO_DIR, `${slugify(name)}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function listMacros() {
  try {
    return fs.readdirSync(MACRO_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(MACRO_DIR, f), "utf8"));
        return {
          name:      data.name,
          steps:     data.steps.length,
          runCount:  data.runCount || 0,
          lastRun:   data.lastRun,
          createdAt: data.createdAt,
        };
      });
  } catch { return []; }
}

function deleteMacro(name) {
  const file = path.join(MACRO_DIR, `${slugify(name)}.json`);
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ── Replay a saved macro, optionally substituting new data ──
// newData: { "video title": "Winter Sale", "description": "..." }
// matched loosely against the step's `description` label.
async function replayMacro(page, name, newData = {}, options = {}) {
  const macro = loadMacro(name);
  if (!macro) return { success: false, error: `No macro found named "${name}"` };

  const { onLog = console.log } = options;
  onLog(`▶️ Replaying "${name}" — ${macro.steps.length} steps`);

  if (macro.startUrl) {
    await page.goto(macro.startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  const results = [];
  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i];
    onLog(`  [${i + 1}/${macro.steps.length}] ${step.action} → "${step.description}"`);

    if (step.action === "navigate") {
      await page.goto(step.value, { waitUntil: "domcontentloaded" }).catch(() => {});
      results.push({ step: i + 1, success: true });
      continue;
    }

    // Substitute parameter value if a matching override was provided
    let value = step.value;
    if (step.isParameter) {
      const override = findDataOverride(step.description, newData);
      if (override !== null) value = override;
    }

    const element = { role: step.role, name: step.description };
    const actResult = await actOnElement(page, element, step.action, value);

    results.push({ step: i + 1, success: actResult.success, error: actResult.error });

    if (!actResult.success) {
      onLog(`  ⚠️ Step ${i + 1} failed: ${actResult.error} — attempting to continue`);
    }
    await page.waitForTimeout(400);
  }

  macro.runCount = (macro.runCount || 0) + 1;
  macro.lastRun  = new Date().toISOString();
  saveMacro(name, macro);

  const failedSteps = results.filter(r => !r.success).length;
  onLog(`${failedSteps === 0 ? "✅" : "⚠️"} Replay complete — ${results.length - failedSteps}/${results.length} steps succeeded`);

  return { success: failedSteps === 0, results, macro: { name: macro.name, runCount: macro.runCount } };
}

function findDataOverride(fieldLabel, newData) {
  const label = fieldLabel.toLowerCase();
  for (const [key, value] of Object.entries(newData)) {
    if (label.includes(key.toLowerCase()) || key.toLowerCase().includes(label)) return value;
  }
  return null;
}

module.exports = {
  startRecording,
  stopRecording,
  generalizeMacro,
  saveMacro,
  loadMacro,
  listMacros,
  deleteMacro,
  replayMacro,
  isRecording: () => !!activeRecording,
  getActiveRecordingName: () => activeRecording?.name || null,
};