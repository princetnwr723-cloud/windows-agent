// src/agent/browserAgent.js
// ✅ Playwright Stealth — bot detection avoid
// ✅ Persistent browser profile — login once, reuse session
// ✅ Better error messages for CAPTCHA/2FA

const path = require("path");
const os   = require("os");
const fs   = require("fs");

let browser  = null;
let page     = null;
let context  = null;

const PROFILE_DIR = path.join(os.homedir(), ".vnus-agent", "browser-profile");

// ── Init browser with stealth ─────────────────────────────
async function initBrowser(headless = false) {
  if (browser && browser.isConnected()) return { browser, context, page };

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  // Try stealth via playwright-extra, fallback to regular playwright
  let chromium;
  try {
    const { chromium: stealthChromium } = require("playwright-extra");
    const StealthPlugin = require("puppeteer-extra-plugin-stealth");
    stealthChromium.use(StealthPlugin());
    chromium = stealthChromium;
    console.log("✅ Browser: Stealth mode ON");
  } catch {
    // playwright-extra not installed — use regular playwright
    const playwright = require("playwright");
    chromium         = playwright.chromium;
    console.log("ℹ️ Browser: Standard mode (install playwright-extra for stealth)");
  }

  browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-extensions-except",
      "--lang=en-US",
    ],
    viewport:          null,
    userAgent:         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale:            "en-US",
    timezoneId:        "America/New_York",
    ignoreHTTPSErrors: true,
  });

  const pages = browser.pages();
  page        = pages.length > 0 ? pages[0] : await browser.newPage();

  // Stealth: override navigator.webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  // Block ads for speed
  await page.route("**/*", (route) => {
    const blocked = ["doubleclick.net", "googlesyndication.com", "adservice.google.com", "analytics.google.com"];
    if (blocked.some(b => route.request().url().includes(b))) route.abort();
    else route.continue();
  });

  console.log("✅ Browser ready");
  return { browser, context: browser, page };
}

// ── Close browser ─────────────────────────────────────────
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null; page = null; context = null;
  }
}

// ── Get current page ──────────────────────────────────────
async function getPage() {
  if (!browser || !browser.isConnected()) await initBrowser(false);
  return page;
}

// ── Navigate ──────────────────────────────────────────────
async function browserGoto(url, waitUntil = "domcontentloaded") {
  const p = await getPage();
  try {
    await p.goto(url, { waitUntil, timeout: 30000 });
    // Check for CAPTCHA
    const hasCaptcha = await p.evaluate(() =>
      document.querySelector('iframe[src*="recaptcha"], .cf-browser-verification, #challenge-form') !== null
    );
    if (hasCaptcha) {
      console.warn("⚠️ CAPTCHA detected — agent cannot bypass this automatically");
    }
    return p.url();
  } catch (err) {
    if (err.message.includes("net::ERR_")) {
      throw new Error(`Could not reach ${url} — check your internet connection`);
    }
    throw err;
  }
}

// ── Click ─────────────────────────────────────────────────
async function browserClick(selector, options = {}) {
  const p = await getPage();
  try {
    await p.waitForSelector(selector, { timeout: 10000 });
    await p.click(selector, options);
  } catch (err) {
    throw new Error(`Could not click "${selector}" — element not found or not clickable. Try a different selector.`);
  }
}

// ── Type ──────────────────────────────────────────────────
async function browserType(selector, text, clear = true) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  if (clear) await p.fill(selector, "");
  await p.type(selector, text, { delay: 40 });
}

// ── Fill ──────────────────────────────────────────────────
async function browserFill(selector, text) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  await p.fill(selector, text);
}

// ── Wait ──────────────────────────────────────────────────
async function browserWait(selector, state = "visible", timeout = 15000) {
  const p = await getPage();
  await p.waitForSelector(selector, { state, timeout });
}

// ── Wait for URL ──────────────────────────────────────────
async function browserWaitUrl(urlPattern, timeout = 15000) {
  const p = await getPage();
  await p.waitForURL(urlPattern, { timeout });
}

// ── Extract ───────────────────────────────────────────────
async function browserExtract(selector, what = "text") {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  if (what === "text")     return (await p.textContent(selector))?.trim() || "";
  if (what === "html")     return await p.innerHTML(selector);
  if (what === "value")    return await p.inputValue(selector);
  if (what === "href")     return await p.getAttribute(selector, "href");
  if (what === "all_text") {
    const els   = await p.$$(selector);
    const texts = await Promise.all(els.map(el => el.textContent()));
    return texts.map(t => t?.trim()).filter(Boolean);
  }
  return await p.textContent(selector);
}

// ── Extract table ─────────────────────────────────────────
async function browserExtractTable(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  return await p.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return [];
    return Array.from(table.querySelectorAll("tr")).map(row =>
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

// ── Key ───────────────────────────────────────────────────
async function browserKey(key) {
  const p = await getPage();
  await p.keyboard.press(key);
}

// ── Select ────────────────────────────────────────────────
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

// ── Get info ──────────────────────────────────────────────
async function browserGetInfo() {
  const p = await getPage();
  return { url: p.url(), title: await p.title() };
}

// ── Hover ─────────────────────────────────────────────────
async function browserHover(selector) {
  const p = await getPage();
  await p.waitForSelector(selector, { timeout: 10000 });
  await p.hover(selector);
}

// ── Exists ────────────────────────────────────────────────
async function browserExists(selector, timeout = 5000) {
  try {
    const p = await getPage();
    await p.waitForSelector(selector, { timeout });
    return true;
  } catch { return false; }
}

// ── Upload ────────────────────────────────────────────────
async function browserUpload(selector, filePath) {
  const p = await getPage();
  await p.setInputFiles(selector, filePath);
}

// ── New tab ───────────────────────────────────────────────
async function browserNewTab(url) {
  const p = await browser.newPage();
  // Apply stealth to new tab too
  await p.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  if (url) await p.goto(url, { waitUntil: "domcontentloaded" });
  page = p;
  return p;
}

// ── Eval ─────────────────────────────────────────────────
async function browserEval(script) {
  const p = await getPage();
  return await p.evaluate(script);
}

// ── Smart login ───────────────────────────────────────────
async function browserSmartLogin(site, username, password) {
  const p = await getPage();

  const selectors = {
    gmail: {
      url: "https://accounts.google.com",
      email: 'input[type="email"]',
      emailNext: "#identifierNext",
      pass: 'input[type="password"]',
      passNext: "#passwordNext",
    },
    github: {
      url:    "https://github.com/login",
      email:  "#login_field",
      pass:   "#password",
      submit: 'input[type="submit"]',
    },
    default: {
      email:  'input[type="email"], input[name="email"], input[name="username"]',
      pass:   'input[type="password"]',
      submit: 'button[type="submit"], input[type="submit"]',
    },
  };

  const s = selectors[site?.toLowerCase()] || selectors.default;
  if (s.url) await browserGoto(s.url);
  await browserFill(s.email, username);
  if (s.emailNext) await browserClick(s.emailNext);
  await p.waitForTimeout(1500);
  await browserFill(s.pass, password);
  if (s.passNext)  await browserClick(s.passNext);
  else if (s.submit) await browserClick(s.submit);
  await p.waitForTimeout(2000);

  // Check for 2FA
  const has2FA = await p.evaluate(() =>
    document.querySelector('input[name="totp"], input[name="otp"], #captcha') !== null
  );
  if (has2FA) {
    console.warn("⚠️ 2FA detected — please complete it manually in the browser window");
  }

  console.log(`✅ Login attempted for ${site}`);
}

module.exports = {
  initBrowser, closeBrowser, getPage,
  browserGoto, browserClick, browserType, browserFill,
  browserWait, browserWaitUrl, browserExtract, browserExtractTable,
  browserScreenshot, browserKey, browserSelect, browserScroll,
  browserGetInfo, browserHover, browserExists, browserUpload,
  browserNewTab, browserEval, browserSmartLogin,
};