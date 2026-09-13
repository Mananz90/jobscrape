// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Bridge to the Scrapling Python sidecar (scrapling/fetch.py). Scrapling contributes three things this Node stack lacks:
 *  - `http`: curl_cffi requests with a real browser TLS/HTTP2 fingerprint (passes TLS-level bot checks plain fetch fails);
 *  - `stealth`: Camoufox, a hardened Firefox with fingerprint spoofing, that many Cloudflare-protected sites let through headless;
 *  - adaptive selectors (`adaptive`/`auto_save`) that relocate elements after a site changes its markup.
 * Setup: `python3 -m venv scrapling/.venv && scrapling/.venv/bin/pip install "scrapling[fetchers]" && scrapling/.venv/bin/scrapling install`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = process.env.JOBSCRAPE_SCRAPLING_PYTHON ?? join(ROOT, "scrapling", ".venv", "bin", "python");

export const scraplingAvailable = () => existsSync(PY);

export interface ScraplingRequest {
  mode?: "http" | "stealth" | "dynamic"; urls: string[]; headless?: boolean; network_idle?: boolean; wait_selector?: string | null;
  timeout_ms?: number; impersonate?: string; proxy?: string | null; block_images?: boolean;
  extract?: Record<string, { css: string; fields?: Record<string, string>; attrs?: Record<string, string>; adaptive?: boolean; auto_save?: boolean }>;
}
export interface ScraplingPage { url: string; final_url: string; status: number | null; title: string | null; html?: string; items?: Record<string, any[]> }

export async function scrapling(req: ScraplingRequest): Promise<ScraplingPage[]> {
  if (!scraplingAvailable()) throw new Error("Scrapling sidecar not installed: run `python3 -m venv scrapling/.venv && scrapling/.venv/bin/pip install 'scrapling[fetchers]' && scrapling/.venv/bin/scrapling install`");
  const full: ScraplingRequest = { mode: "http", headless: process.env.JOBSCRAPE_HEADFUL !== "1", proxy: process.env.HTTPS_PROXY ?? null, ...req };
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [join(ROOT, "scrapling", "fetch.py")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error("scrapling sidecar timed out")); }, (full.timeout_ms ?? 60_000) * Math.max(1, full.urls.length) + 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out || "{}");
        if (res.error) return reject(new Error(`scrapling: ${res.error}`));
        if (code !== 0 && !res.pages) return reject(new Error(`scrapling exited ${code}: ${err.slice(-500)}`));
        resolve(res.pages ?? []);
      } catch { reject(new Error(`scrapling: bad output (exit ${code}): ${(err || out).slice(-500)}`)); }
    });
    child.stdin.end(JSON.stringify(full));
  });
}
