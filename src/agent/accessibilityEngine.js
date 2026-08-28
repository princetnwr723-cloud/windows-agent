// src/agent/accessibilityEngine.js
// ═══════════════════════════════════════════════════════════
// ACCESSIBILITY ENGINE
// Replaces "guess from screenshot" with real DOM/a11y tree parsing
// Perceive → Think → Act → Verify loop for reliable browser control
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const LOG_DIR = path.join(os.homedir(), ".vnus-agent", "automation-logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── 1. PERCEIVE — Get semantic snapshot of the page ────────
// Now also walks same-origin iframes (many tools embed their
// editor/form in an iframe) and waits for the page to actually
// settle instead of a fixed timeout.
async function perceive(page, options = {}) {
  await waitForStable(page, options.maxWaitMs || 4000);

  try {
    const tree = await page.accessibility.snapshot({ interestingOnly: true });
    const url  = page.url();
    const title = await page.title().catch(() => "");

    const elements = [];
    function walk(node, path = []) {
      if (!node) return;
      const isInteractive = ["button", "link", "textbox", "checkbox", "radio",
        "combobox", "menuitem", "tab", "searchbox", "switch", "slider"].includes(node.role);

      if (isInteractive || node.name) {
        elements.push({
          role:     node.role,
          name:     node.name || "",
          value:    node.value || "",
          checked:  node.checked,
          disabled: node.disabled,
          path:     [...path, node.role].join(" > "),
          frame:    "main",
        });
      }
      (node.children || []).forEach(child => walk(child, [...path, node.role]));
    }
    walk(tree);

    // Walk same-origin child frames too — many editors (video tools,
    // form builders) render their actual UI inside an iframe
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameTree = await frame.accessibility.snapshot({ interestingOnly: true }).catch(() => null);
        if (!frameTree) continue;
        function walkFrame(node) {
          if (!node) return;
          const isInteractive = ["button", "link", "textbox", "checkbox", "radio",
            "combobox", "menuitem", "tab", "searchbox"].includes(node.role);
          if (isInteractive || node.name) {
            elements.push({ role: node.role, name: node.name || "", value: node.value || "",
              disabled: node.disabled, path: node.role, frame: frame.url() });
          }
          (node.children || []).forEach(walkFrame);
        }
        walkFrame(frameTree);
      } catch { /* cross-origin frame — skip, can't access */ }
    }

    return { url, title, elementCount: elements.length, elements, raw: tree };
  } catch (err) {
    console.error("⚠️ Accessibility snapshot failed, falling back to DOM query:", err.message);
    return await perceiveFallback(page);
  }
}

// ── Wait for the page to visually settle (network idle-ish) ──
// Fixed timeouts either waste time on fast pages or aren't long
// enough on slow ones. This waits for the DOM to stop mutating
// for a short quiet window, up to a max ceiling.
async function waitForStable(page, maxWaitMs = 4000) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: maxWaitMs }).catch(() => {});
    await page.evaluate((maxMs) => new Promise((resolve) => {
      let lastMutation = Date.now();
      const observer = new MutationObserver(() => { lastMutation = Date.now(); });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      const start = Date.now();
      const check = () => {
        if (Date.now() - lastMutation > 400 || Date.now() - start > maxMs) {
          observer.disconnect();
          resolve(null);
        } else {
          setTimeout(check, 150);
        }
      };
      check();
    }), maxWaitMs).catch(() => {});
  } catch { /* page may have navigated mid-check — ignore */ }
}

// ── Fallback — DOM query when accessibility tree unavailable ──
async function perceiveFallback(page) {
  const elements = await page.evaluate(() => {
    const selectors = "button, a, input, textarea, select, [role=button], [role=link], [role=tab], [contenteditable=true]";
    return Array.from(document.querySelectorAll(selectors)).slice(0, 200).map(el => ({
      role:     el.tagName.toLowerCase(),
      name:     el.innerText?.trim().slice(0, 80) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "",
      value:    el.value || "",
      disabled: el.hasAttribute("disabled"),
      path:     el.tagName.toLowerCase(),
    }));
  }).catch(() => []);

  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    elementCount: elements.length,
    elements,
    raw: null,
  };
}

// ── 2. THINK — Find the right element for a described action ──
// `hint` narrows scope when multiple elements share a name
// (e.g. "in the modal", "in the header", "second one")
function findElement(snapshot, description, hint = null) {
  const desc = description.toLowerCase().trim();
  let candidates = snapshot.elements.filter(e => !e.disabled);

  // Narrow by frame/region hint if given
  if (hint) {
    const hinted = candidates.filter(e => e.frame?.toLowerCase().includes(hint.toLowerCase()) || e.path?.toLowerCase().includes(hint.toLowerCase()));
    if (hinted.length) candidates = hinted;
  }

  // Exact name match
  const exactMatches = candidates.filter(e => e.name.toLowerCase() === desc);
  if (exactMatches.length === 1) return { element: exactMatches[0], confidence: "exact", alternatives: 0 };
  if (exactMatches.length > 1) {
    // Multiple identical labels — prefer the one that looks most "primary"
    // (button role over link, then first in document order)
    const preferred = exactMatches.find(e => e.role === "button") || exactMatches[0];
    return { element: preferred, confidence: "exact-ambiguous", alternatives: exactMatches.length - 1 };
  }

  // Contains match
  const containsMatches = candidates.filter(e => e.name && (e.name.toLowerCase().includes(desc) || desc.includes(e.name.toLowerCase())));
  if (containsMatches.length === 1) return { element: containsMatches[0], confidence: "contains", alternatives: 0 };
  if (containsMatches.length > 1) {
    return { element: containsMatches[0], confidence: "contains-ambiguous", alternatives: containsMatches.length - 1 };
  }

  // Fuzzy word-overlap match
  const descWords = desc.split(/\s+/).filter(w => w.length > 2);
  let best = null, bestScore = 0, secondBestScore = 0;
  for (const el of candidates) {
    const elWords = el.name.toLowerCase().split(/\s+/);
    const overlap = descWords.filter(w => elWords.some(ew => ew.includes(w) || w.includes(ew))).length;
    if (overlap > bestScore) { secondBestScore = bestScore; bestScore = overlap; best = el; }
    else if (overlap > secondBestScore) { secondBestScore = overlap; }
  }
  if (best && bestScore > 0) {
    const confidence = bestScore > secondBestScore ? "fuzzy" : "fuzzy-ambiguous";
    return { element: best, confidence, score: bestScore, alternatives: secondBestScore > 0 ? 1 : 0 };
  }

  return { element: null, confidence: "none", alternatives: 0 };
}

// ── Confidence score — how sure are we this was the right move? ──
// Used to decide whether a step can run autonomously or should
// pause for human approval. See "Smart Approval" in sessionPersistence.
function confidenceScore(matchResult) {
  const scores = {
    "exact":              1.0,
    "contains":           0.85,
    "fuzzy":              0.65,
    "exact-ambiguous":    0.55,
    "contains-ambiguous": 0.45,
    "fuzzy-ambiguous":    0.3,
    "none":               0,
  };
  return scores[matchResult.confidence] ?? 0.5;
}

// ── 3. ACT — Click/type/select using semantic locators (not pixels) ──
async function actOnElement(page, element, action, value = null) {
  // Resolve the correct frame — element may live inside an iframe
  let target = page;
  if (element.frame && element.frame !== "main") {
    const frame = page.frames().find(f => f.url() === element.frame);
    if (frame) target = frame;
  }

  let locator;
  try {
    if (element.role && element.name) {
      locator = target.getByRole(element.role, { name: element.name, exact: false }).first();
    } else if (element.name) {
      locator = target.getByText(element.name, { exact: false }).first();
    } else {
      throw new Error("No usable selector for element");
    }

    await locator.waitFor({ state: "visible", timeout: 5000 });

    if (action === "click") {
      await locator.click({ timeout: 5000 });
    } else if (action === "type") {
      await locator.fill(value || "", { timeout: 5000 });
    } else if (action === "select") {
      await locator.selectOption(value, { timeout: 5000 });
    } else if (action === "check") {
      await locator.check({ timeout: 5000 });
    } else if (action === "hover") {
      await locator.hover({ timeout: 5000 });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── 4. VERIFY — Did the action actually produce the expected effect? ──
// Falls back to a vision model when the accessibility signal is
// inconclusive (e.g. a canvas-heavy tool where the DOM barely
// changes even though something real happened visually).
async function verify(page, beforeSnapshot, expectedChange, options = {}) {
  await waitForStable(page, 2500);
  const after = await perceive(page);

  const urlChanged   = after.url !== beforeSnapshot.url;
  const titleChanged = after.title !== beforeSnapshot.title;
  const countChanged = Math.abs(after.elementCount - beforeSnapshot.elementCount) > 2;

  let matched = false;
  if (expectedChange) {
    const exp = expectedChange.toLowerCase();
    if (exp.includes("navigate") || exp.includes("page") || exp.includes("redirect")) matched = urlChanged;
    else if (exp.includes("appear") || exp.includes("show") || exp.includes("open"))    matched = countChanged;
    else matched = urlChanged || titleChanged || countChanged;
  } else {
    matched = urlChanged || titleChanged || countChanged;
  }

  // Inconclusive — nothing measurable changed in the accessibility
  // tree, but the action DID succeed at the click/type level. Some
  // canvas/WebGL-heavy tools (video editors, design tools) don't
  // expose their real content to the accessibility tree at all.
  // If a vision checker was provided, use it as a second opinion.
  if (!matched && options.visionVerify && expectedChange) {
    try {
      const screenshot = await page.screenshot({ encoding: "base64" });
      const visionResult = await options.visionVerify(screenshot, expectedChange);
      if (visionResult?.confirmed) {
        return {
          verified: true, urlChanged, titleChanged, countChanged,
          before: { url: beforeSnapshot.url, elementCount: beforeSnapshot.elementCount },
          after:  { url: after.url, elementCount: after.elementCount },
          snapshot: after, verifiedBy: "vision",
        };
      }
    } catch { /* vision check unavailable or failed — fall through */ }
  }

  return {
    verified: matched,
    urlChanged, titleChanged, countChanged,
    before: { url: beforeSnapshot.url, elementCount: beforeSnapshot.elementCount },
    after:  { url: after.url, elementCount: after.elementCount },
    snapshot: after,
    verifiedBy: matched ? "accessibility" : "none",
  };
}

// ── Full loop: PERCEIVE → THINK → ACT → VERIFY (with retries) ──
// options.confidenceThreshold: below this, step pauses for human
// approval instead of running blind (default 0.5 — ambiguous
// matches pause, clear matches run autonomously)
async function perceiveThinkActVerify(page, step, options = {}) {
  const { maxRetries = 3, onLog = console.log, confidenceThreshold = 0.5, onNeedsApproval = null, visionVerify = null } = options;
  const { description, action, value, expectedChange, hint } = step;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    onLog(`  🔍 [Attempt ${attempt}/${maxRetries}] Perceiving page...`);
    const before = await perceive(page);

    onLog(`  🧠 Looking for: "${description}"`);
    const matchResult = findElement(before, description, hint);
    const { element, confidence } = matchResult;
    const score = confidenceScore(matchResult);

    if (!element) {
      lastError = `Element not found: "${description}" (${before.elementCount} elements scanned)`;
      onLog(`  ⚠️ ${lastError}`);
      if (attempt < maxRetries) { await page.waitForTimeout(1000); continue; }
      break;
    }

    // Smart approval — only pause on genuinely ambiguous matches,
    // not every risky-sounding step. Reduces needless interruptions
    // while staying safe on real ambiguity.
    if (score < confidenceThreshold && onNeedsApproval) {
      onLog(`  ⏸️ Low confidence (${(score * 100).toFixed(0)}%, ${matchResult.alternatives} alternative(s)) — requesting approval`);
      const approved = await onNeedsApproval({ description, element, confidence, score, alternatives: matchResult.alternatives });
      if (!approved) {
        return { success: false, error: "Paused — low-confidence match needs your confirmation", needsApproval: true, matchResult };
      }
    }

    onLog(`  ⚡ Acting: ${action} on "${element.name}" (${confidence} match, ${(score * 100).toFixed(0)}% confidence)`);
    const actResult = await actOnElement(page, element, action, value);

    if (!actResult.success) {
      lastError = actResult.error;
      onLog(`  ⚠️ Action failed: ${lastError}`);
      if (attempt < maxRetries) { await page.waitForTimeout(1000); continue; }
      break;
    }

    onLog(`  ✅ Verifying result...`);
    const verifyResult = await verify(page, before, expectedChange, { visionVerify });

    if (verifyResult.verified || !expectedChange) {
      onLog(`  ✅ Step confirmed${verifyResult.verifiedBy === "vision" ? " (via vision check)" : ""}`);
      return { success: true, attempt, confidence, score, verifyResult };
    }

    lastError = "Action executed but expected change not detected";
    onLog(`  ⚠️ ${lastError} — retrying with fresh perception`);
  }

  return { success: false, error: lastError, attemptsMade: maxRetries };
}

// ── Run a full multi-step task through the loop ─────────────
async function runAutomationTask(page, steps, options = {}) {
  const results = [];
  const taskLog = [];
  const log = (msg) => { taskLog.push(msg); (options.onLog || console.log)(msg); };

  log(`🤖 Starting automation task — ${steps.length} steps`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    log(`\n[Step ${i + 1}/${steps.length}] ${step.description}`);

    const result = await perceiveThinkActVerify(page, step, { ...options, onLog: log });
    results.push({ step: i + 1, ...step, ...result });

    if (!result.success) {
      log(`❌ Task paused at step ${i + 1} — could not complete: ${result.error}`);
      return { success: false, completedSteps: i, totalSteps: steps.length, results, log: taskLog };
    }
  }

  log(`\n✅ All ${steps.length} steps completed successfully`);
  return { success: true, completedSteps: steps.length, totalSteps: steps.length, results, log: taskLog };
}

module.exports = {
  perceive,
  findElement,
  confidenceScore,
  actOnElement,
  verify,
  perceiveThinkActVerify,
  runAutomationTask,
  waitForStable,
};