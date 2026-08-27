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
async function perceive(page) {
  try {
    const tree = await page.accessibility.snapshot({ interestingOnly: true });
    const url  = page.url();
    const title = await page.title().catch(() => "");

    // Flatten tree into a searchable list of interactive elements
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
        });
      }
      (node.children || []).forEach(child => walk(child, [...path, node.role]));
    }
    walk(tree);

    return { url, title, elementCount: elements.length, elements, raw: tree };
  } catch (err) {
    console.error("⚠️ Accessibility snapshot failed, falling back to DOM query:", err.message);
    return await perceiveFallback(page);
  }
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
function findElement(snapshot, description) {
  const desc = description.toLowerCase().trim();
  const candidates = snapshot.elements;

  // Exact name match
  let match = candidates.find(e => e.name.toLowerCase() === desc);
  if (match) return { element: match, confidence: "exact" };

  // Contains match
  match = candidates.find(e => e.name.toLowerCase().includes(desc) || desc.includes(e.name.toLowerCase()));
  if (match && match.name) return { element: match, confidence: "contains" };

  // Fuzzy word-overlap match
  const descWords = desc.split(/\s+/).filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const el of candidates) {
    const elWords = el.name.toLowerCase().split(/\s+/);
    const overlap = descWords.filter(w => elWords.some(ew => ew.includes(w) || w.includes(ew))).length;
    if (overlap > bestScore) { bestScore = overlap; best = el; }
  }
  if (best && bestScore > 0) return { element: best, confidence: "fuzzy", score: bestScore };

  return { element: null, confidence: "none" };
}

// ── 3. ACT — Click/type/select using semantic locators (not pixels) ──
async function actOnElement(page, element, action, value = null) {
  // Build a Playwright locator using role + accessible name — resilient to
  // layout changes, unlike x/y coordinates
  let locator;
  try {
    if (element.role && element.name) {
      locator = page.getByRole(element.role, { name: element.name, exact: false }).first();
    } else if (element.name) {
      locator = page.getByText(element.name, { exact: false }).first();
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
async function verify(page, beforeSnapshot, expectedChange) {
  await page.waitForTimeout(600); // let UI settle
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

  return {
    verified: matched,
    urlChanged, titleChanged, countChanged,
    before: { url: beforeSnapshot.url, elementCount: beforeSnapshot.elementCount },
    after:  { url: after.url, elementCount: after.elementCount },
    snapshot: after,
  };
}

// ── Full loop: PERCEIVE → THINK → ACT → VERIFY (with retries) ──
async function perceiveThinkActVerify(page, step, options = {}) {
  const { maxRetries = 3, onLog = console.log } = options;
  const { description, action, value, expectedChange } = step;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    onLog(`  🔍 [Attempt ${attempt}/${maxRetries}] Perceiving page...`);
    const before = await perceive(page);

    onLog(`  🧠 Looking for: "${description}"`);
    const { element, confidence, score } = findElement(before, description);

    if (!element) {
      lastError = `Element not found: "${description}" (${before.elementCount} elements scanned)`;
      onLog(`  ⚠️ ${lastError}`);
      if (attempt < maxRetries) {
        await page.waitForTimeout(1000);
        continue;
      }
      break;
    }

    onLog(`  ⚡ Acting: ${action} on "${element.name}" (${confidence} match)`);
    const actResult = await actOnElement(page, element, action, value);

    if (!actResult.success) {
      lastError = actResult.error;
      onLog(`  ⚠️ Action failed: ${lastError}`);
      if (attempt < maxRetries) { await page.waitForTimeout(1000); continue; }
      break;
    }

    onLog(`  ✅ Verifying result...`);
    const verifyResult = await verify(page, before, expectedChange);

    if (verifyResult.verified || !expectedChange) {
      onLog(`  ✅ Step confirmed`);
      return { success: true, attempt, confidence, verifyResult };
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
  actOnElement,
  verify,
  perceiveThinkActVerify,
  runAutomationTask,
};