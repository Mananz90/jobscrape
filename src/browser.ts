// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { mkdirSync, existsSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";

/**
 * One real Chromium with a persistent profile (cookies, local storage) under data/browser-profile.
 * - Headless by default; JOBSCRAPE_HEADFUL=1 shows the window (needed the first time a site throws a challenge or login).
 * - `node src/index.ts login <site>` opens the site headful so you can sign in once; the session is reused afterwards.
 * - Light stealth: no automation flag, real UA/locale/timezone, navigator.webdriver hidden. Not a CAPTCHA bypass: when a
 *   site shows a challenge we wait for it to clear (it usually does in headful mode) or report the block.
 */
const PROFILE_DIR = process.env.JOBSCRAPE_BROWSER_PROFILE ?? "data/browser-profile";
let ctxPromise: Promise<BrowserContext> | null = null;
let users = 0;

/** Prefer patchright (Playwright fork that hides the CDP automation fingerprint Cloudflare Turnstile keys on); fall back to playwright. */
async function loadPlaywright(): Promise<{ chromium: any; patched: boolean }> {
  try { const m: any = await import("patchright"); return { chromium: m.chromium, patched: true }; }
  catch { const m: any = await import("playwright"); return { chromium: m.chromium, patched: false }; }
}

export async function browserContext(): Promise<BrowserContext> {
  if (!ctxPromise) ctxPromise = (async () => {
    const { chromium, patched } = await loadPlaywright();
    mkdirSync(PROFILE_DIR, { recursive: true });
    const headless = process.env.JOBSCRAPE_HEADFUL !== "1";
    const channel = defaultChannel();
    // patchright guidance: real Chrome channel, persistent context, no custom UA/flags/init scripts (those are fingerprintable).
    const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless, channel,
      viewport: patched ? null : { width: 1366, height: 900 },
      // No locale/timezone emulation: CDP overrides are detectable; the real Chrome's own settings are used.
      ...(process.env.JOBSCRAPE_LOCALE ? { locale: process.env.JOBSCRAPE_LOCALE } : {}), ...(process.env.JOBSCRAPE_TZ ? { timezoneId: process.env.JOBSCRAPE_TZ } : {}),
      ...(patched ? {} : {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
        args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
        ignoreDefaultArgs: ["--enable-automation"],
      }),
      proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    });
    if (!patched) await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // @ts-ignore
      window.chrome = window.chrome ?? { runtime: {} };
    });
    // Block heavy assets in headless runs to keep them fast.
    if (headless) await ctx.route(/\.(png|jpg|jpeg|gif|webp|mp4)(\?|$)/, (r) => r.abort());
    if (process.env.JOBSCRAPE_DEBUG) console.log(`[browser] ${patched ? "patchright" : "playwright"} · ${channel ?? "bundled chromium"} · ${headless ? "headless" : "visible"}`);
    return ctx;
  })();
  return ctxPromise;
}

function defaultChannel(): string | undefined {
  if (process.env.JOBSCRAPE_BROWSER_CHANNEL) return process.env.JOBSCRAPE_BROWSER_CHANNEL === "bundled" ? undefined : process.env.JOBSCRAPE_BROWSER_CHANNEL;
  if (process.platform === "darwin" && existsSync("/Applications/Google Chrome.app")) return "chrome";
  return undefined;
}

export async function withPage<T>(fn: (page: Page) => Promise<T>, opts: { keepOpen?: boolean } = {}): Promise<T> {
  users++;
  const ctx = await browserContext();
  const page = await ctx.newPage();
  try { return await fn(page); }
  finally {
    await page.close().catch(() => {});
    if (--users === 0 && !opts.keepOpen) { const c = ctxPromise; ctxPromise = null; await (await c!)?.close().catch(() => {}); }
  }
}

export async function closeBrowser() { if (ctxPromise) { const c = ctxPromise; ctxPromise = null; await (await c).close().catch(() => {}); } }

export async function isBlocked(page: Page): Promise<boolean> {
  try {
    const t = (await page.title()).toLowerCase();
    if (/just a moment|attention required|access denied|verify you are human|security check|are you a human|einen moment|nur für menschen|^blocked|request blocked/.test(t)) return true;
    if (await page.locator("#challenge-running, #challenge-stage, #challenge-form, iframe[src*='challenges.cloudflare.com'], iframe[src*='captcha'], #px-captcha, [data-cf-challenge], #cf-chl-widget").count() > 0) return true;
    const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 1500).toLowerCase();
    return /ray id:|verify you are human|nur für menschen|just a moment|additional verification required|please verify you are a human|human verification|you have been blocked|request blocked/.test(body) && body.length < 1500;
  } catch { return false; }
}

/**
 * Wait for a Cloudflare / DataDome / "verify you are human" interstitial to clear. Returns false if still blocked.
 * In headless mode these rarely clear. When stdin is a terminal (wizard/CLI) and JOBSCRAPE_NO_ESCALATE is not set, the caller
 * can use `openWithEscalation` instead, which re-opens the page in a visible window so the user can click through once.
 */
export async function waitForChallenge(page: Page, timeoutMs = 25_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await isBlocked(page))) return true;
    await page.waitForTimeout(1500);
  }
  return !(await isBlocked(page));
}

/** Call before the browser is launched: forces a visible window for sites that hard-block headless Chrome. */
export function requireHeadful() { if (!ctxPromise) process.env.JOBSCRAPE_HEADFUL = "1"; }

export const canEscalate = () => !!process.stdin.isTTY && process.env.JOBSCRAPE_NO_ESCALATE !== "1";

/**
 * Navigate; if a challenge blocks the headless page and we can escalate, switch to a visible browser window, load the URL again
 * and wait up to `manualMs` for the user to pass the check. The cleared cookies persist in the profile, so later runs stay headless.
 * Returns the (possibly new) page.
 */
export async function openWithEscalation(page: Page, url: string, log: (m: string) => void, manualMs = 120_000): Promise<Page> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (await waitForChallenge(page, 20_000)) return page;
  const host = new URL(url).host;
  if (process.env.JOBSCRAPE_HEADFUL === "1") {
    log(`${host} is asking for human verification. Please complete it in the browser window (waiting up to ${manualMs / 1000}s)...`);
    if (await waitForChallenge(page, manualMs)) return page;
    throw new Error(`${host} verification was not completed`);
  }
  if (!canEscalate()) throw new Error(`${host} shows a verification challenge in headless mode. Run 'node src/index.ts login ${host.includes("indeed") ? "indeed" : host.includes("glassdoor") ? "glassdoor" : "linkedin"}' once from a terminal, or set JOBSCRAPE_HEADFUL=1.`);
  log(`${host} shows a verification challenge; opening a visible browser window so you can pass it once...`);
  await page.close().catch(() => {});
  await closeBrowser();
  process.env.JOBSCRAPE_HEADFUL = "1";
  const ctx = await browserContext();
  const p2 = await ctx.newPage();
  await p2.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await p2.bringToFront().catch(() => {});
  log(`If a checkbox or puzzle is shown, complete it in the window (waiting up to ${manualMs / 1000}s)...`);
  if (await waitForChallenge(p2, manualMs)) { log("verification passed; session saved for next time"); return p2; }
  throw new Error(`${host} verification was not completed`);
}

export const humanPause = (page: Page, min = 600, max = 1800) => page.waitForTimeout(min + Math.random() * (max - min));

export const LOGIN_URLS: Record<string, string> = {
  linkedin: "https://www.linkedin.com/login",
  indeed: "https://secure.indeed.com/auth",
  glassdoor: "https://www.glassdoor.com/profile/login_input.htm",
};

/** Regional page whose Cloudflare clearance the search adapters need. */
export function verifyUrl(site: string, country: string): string {
  const cc = country.toUpperCase();
  if (site === "indeed") { const h = { US: "www.indeed.com", GB: "uk.indeed.com", DE: "de.indeed.com", FR: "fr.indeed.com", IN: "in.indeed.com", CA: "ca.indeed.com", AU: "au.indeed.com", NL: "nl.indeed.com", CH: "ch.indeed.com", AT: "at.indeed.com" }[cc] ?? "www.indeed.com"; return `https://${h}/jobs?q=consultant`; }
  if (site === "glassdoor") { const h = { US: "www.glassdoor.com", GB: "www.glassdoor.co.uk", DE: "www.glassdoor.de", FR: "www.glassdoor.fr", IN: "www.glassdoor.co.in", CA: "www.glassdoor.ca", AU: "www.glassdoor.com.au", NL: "www.glassdoor.nl", CH: "www.glassdoor.ch", AT: "www.glassdoor.at" }[cc] ?? "www.glassdoor.com"; return `https://${h}/Job/jobs.htm?sc.keyword=consultant`; }
  return "https://www.linkedin.com/jobs/search/?keywords=consultant";
}

/**
 * Interactive session setup for one site: open the login page in a visible window, wait until any bot check is passed and the
 * user has either signed in or moved on, then load the regional search page and wait for its clearance too.
 * Completion is detected from the page (no keyboard needed), with `maxMs` as the ceiling.
 */
export async function loginFlow(site: string, country: string, log: (m: string) => void, maxMs = 8 * 60_000): Promise<{ cleared: boolean; loggedIn: boolean }> {
  process.env.JOBSCRAPE_HEADFUL = "1";
  const ctx = await browserContext();
  const page = await ctx.newPage();
  const started = Date.now();
  const left = () => Math.max(0, maxMs - (Date.now() - started));
  await page.goto(LOGIN_URLS[site], { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  log(`${site}: window open at ${LOGIN_URLS[site]}. Pass any "verify you are human" check, then sign in (optional).`);
  let cleared = await waitForChallenge(page, Math.min(left(), 5 * 60_000));
  log(cleared ? `${site}: bot check passed on login page` : `${site}: bot check still showing after the wait`);
  // Give the user time to sign in: done when the URL leaves the login/auth page, or after 2 minutes of no change.
  const isLoginUrl = () => /login|auth|signin|sign-in/i.test(page.url());
  let loggedIn = false;
  if (cleared) {
    const end = Date.now() + Math.min(left(), 2 * 60_000);
    while (Date.now() < end) { if (!isLoginUrl()) { loggedIn = true; break; } await page.waitForTimeout(2000); }
    log(loggedIn ? `${site}: signed in (now at ${page.url().slice(0, 60)})` : `${site}: no sign-in detected; continuing without it`);
  }
  // Regional search page clearance (separate Cloudflare zone for country editions).
  const vu = verifyUrl(site, country);
  await page.goto(vu, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  log(`${site}: checking ${new URL(vu).host} ...`);
  cleared = await waitForChallenge(page, Math.min(left(), 4 * 60_000));
  log(cleared ? `${site}: ${new URL(vu).host} cleared; session saved` : `${site}: ${new URL(vu).host} still blocked`);
  await page.close().catch(() => {});
  return { cleared, loggedIn };
}
