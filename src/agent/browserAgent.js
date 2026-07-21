// src/agent/browserAgent.js
// Playwright browser control — 10x better than screenshot-click approach
// Handles login, forms, data extraction, navigation

const { chromium } = require("playwright");
const path         = require("path");
const os           = require("os");
const fs           = require("fs");

// ── Browser instance (singleton) ──────────────────────────
let browser  = null;
let page     = null;
let context  = null;

// Profile dir — saves cookies/sessions between runs
const PROFILE_DIR = path.join(os.homedir(), ".vnus-agent", "browser-profile");

// ── Init browser ──────────────────────────────────────────
async function initBrowser(headless = false) {
  if (browser && browser.isConnected()) return { browser, context, page };

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    // Show browser so user can see what agent is doing
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled", // avoid bot detection
      "--no-sandbox",
    ],
    viewport: null, // use full window size
  });

  const pages = browser.pages();
  page = pages.length > 0 ? pages[0] : await browser.newPage();

  // Block ads/trackers for speed
  await page.route("**/*", (route) => {
    const blocked = ["doubleclick.net", "googlesyndication.com", "adservice.google.com"];
    if (blocked.some(b => route.request().url().includes(b))) {
      route.abort();
    } else {
      route.continue();
    }
  });

  console.log("✅ Browser ready");
  return { browser, context: browser, page };
}

// ── Close browser ─────────────────────────────────────────
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser  = null;
    page     = null;
    context  = null;
  }
}

// ── Get current page ──────────────────────────────────────
async function getPage() {
  if (!browser || !browser.isConnected()) {
    await initBrowser(false);
  }
  return page;
}

// ── Navigate to URL ───────────────────────────────────────
async function browserGoto(url, waitUntil = "domcontentloaded") {
  const p = await getPage();
  await p.goto(url, { waitUntil, timeout: 30000 });
  console.log(`✅ Navigated to ${url}`);
  return p.url();
}

// ── Click element ─────────────────────────────────────────
async function browserClick(selector, options = {}) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  await p.click(selector, options);
  console.log(`✅ Clicked: ${selector}`);
}

// ── Type text ─────────────────────────────────────────────
async function browserType(selector, text, clear = true) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  if (clear) await p.fill(selector, ""); // clear first
  await p.type(selector, text, { delay: 30 }); // human-like typing
  console.log(`✅ Typed in: ${selector}`);
}

// ── Fill (instant, no delay) ──────────────────────────────
async function browserFill(selector, text) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  await p.fill(selector, text);
  console.log(`✅ Filled: ${selector}`);
}

// ── Wait for element ──────────────────────────────────────
async function browserWait(selector, state = "visible", timeout = 15000) {
  const p = await getPage();
  await p.waitForSelector(selector, { state, timeout });
  console.log(`✅ Element ready: ${selector}`);
}

// ── Wait for URL ──────────────────────────────────────────
async function browserWaitUrl(urlPattern, timeout = 15000) {
  const p = await getPage();
  await p.waitForURL(urlPattern, { timeout });
}

// ── Extract text ──────────────────────────────────────────
async function browserExtract(selector, what = "text") {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });

  if (what === "text") {
    const text = await p.textContent(selector);
    return text?.trim() || "";
  }
  if (what === "html") {
    return await p.innerHTML(selector);
  }
  if (what === "value") {
    return await p.inputValue(selector);
  }
  if (what === "all_text") {
    const elements = await p.$$(selector);
    const texts    = await Promise.all(elements.map(el => el.textContent()));
    return texts.map(t => t?.trim()).filter(Boolean);
  }
  if (what === "href") {
    return await p.getAttribute(selector, "href");
  }
  return await p.textContent(selector);
}

// ── Extract table data ────────────────────────────────────
async function browserExtractTable(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  return await p.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll("tr"));
    return rows.map(row =>
      Array.from(row.querySelectorAll("th, td")).map(cell => cell.textContent?.trim() || "")
    );
  }, selector);
}

// ── Screenshot ────────────────────────────────────────────
async function browserScreenshot(selector = null) {
  const p    = await getPage();
  const opts = { encoding: "base64" };
  if (selector) {
    const el = await p.$(selector);
    if (el) return await el.screenshot(opts);
  }
  return await p.screenshot({ ...opts, fullPage: false });
}

// ── Press key ─────────────────────────────────────────────
async function browserKey(key) {
  const p = await getPage();
  await p.keyboard.press(key);
}

// ── Select dropdown ───────────────────────────────────────
async function browserSelect(selector, value) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  await p.selectOption(selector, value);
}

// ── Scroll ────────────────────────────────────────────────
async function browserScroll(direction = "down", amount = 500) {
  const p = await getPage();
  await p.evaluate((dir, amt) => {
    window.scrollBy(0, dir === "down" ? amt : -amt);
  }, direction, amount);
}

// ── Get page info ─────────────────────────────────────────
async function browserGetInfo() {
  const p = await getPage();
  return {
    url:   p.url(),
    title: await p.title(),
  };
}

// ── Hover ─────────────────────────────────────────────────
async function browserHover(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  await p.hover(selector);
}

// ── Check if element exists ───────────────────────────────
async function browserExists(selector, timeout = 5000) {
  try {
    const p = await getPage();
    await p.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

// ── Upload file ───────────────────────────────────────────
async function browserUpload(selector, filePath) {
  const p = await getPage();
  await p.setInputFiles(selector, filePath);
}

// ── Download file ─────────────────────────────────────────
async function browserDownload(url, savePath) {
  const p = await getPage();
  const [download] = await Promise.all([
    p.waitForEvent("download"),
    p.goto(url),
  ]);
  await download.saveAs(savePath);
  return savePath;
}

// ── New tab ───────────────────────────────────────────────
async function browserNewTab(url) {
  const p = await browser.newPage();
  if (url) await p.goto(url, { waitUntil: "domcontentloaded" });
  page = p; // switch to new tab
  return p;
}

// ── Evaluate JS in browser ────────────────────────────────
async function browserEval(script) {
  const p = await getPage();
  return await p.evaluate(script);
}

// ── Smart login helper ────────────────────────────────────
async function browserSmartLogin(site, username, password) {
  const p = await getPage();

  // Common login selectors for popular sites
  const loginSelectors = {
    gmail: {
      url:      "https://accounts.google.com",
      email:    'input[type="email"]',
      emailNext:"#identifierNext",
      pass:     'input[type="password"]',
      passNext: "#passwordNext",
    },
    github: {
      url:  "https://github.com/login",
      email:"#login_field",
      pass: "#password",
      submit:"input[type='submit']",
    },
    default: {
      email:  'input[type="email"], input[name="email"], input[id*="email"], input[name="username"]',
      pass:   'input[type="password"]',
      submit: 'button[type="submit"], input[type="submit"]',
    },
  };

  const s = loginSelectors[site.toLowerCase()] || loginSelectors.default;

  if (s.url) await browserGoto(s.url);
  await browserFill(s.email, username);
  if (s.emailNext) await browserClick(s.emailNext);
  await p.waitForTimeout(1500);
  await browserFill(s.pass, password);
  if (s.passNext) await browserClick(s.passNext);
  else if (s.submit) await browserClick(s.submit);
  await p.waitForTimeout(2000);
  console.log(`✅ Login attempted for ${site}`);
}

module.exports = {
  initBrowser,
  closeBrowser,
  getPage,
  browserGoto,
  browserClick,
  browserType,
  browserFill,
  browserWait,
  browserWaitUrl,
  browserExtract,
  browserExtractTable,
  browserScreenshot,
  browserKey,
  browserSelect,
  browserScroll,
  browserGetInfo,
  browserHover,
  browserExists,
  browserUpload,
  browserDownload,
  browserNewTab,
  browserEval,
  browserSmartLogin,
};
