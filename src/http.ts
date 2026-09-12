import type { FetchContext } from "./types.ts";

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
];

const MIN_DELAY = Number(process.env.JOBSCRAPE_MIN_DELAY_MS ?? 500);
const TIMEOUT_MS = Number(process.env.JOBSCRAPE_TIMEOUT_MS ?? 45_000);
const lastHit = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-host politeness: never hit the same host faster than MIN_DELAY. */
async function throttle(url: string) {
  const host = new URL(url).host;
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + MIN_DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

/** fetch with retries, exponential backoff, Retry-After support, rotating UA. */
export async function request(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    await throttle(url);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "user-agent": UAS[i % UAS.length],
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** i);
        lastErr = new HttpError(res.status, url);
        continue;
      }
      throw new HttpError(res.status, url);
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      // A hung upstream (timeout) gets one retry, not four: otherwise a slow API blocks a whole run for minutes.
      if ((e as Error).name === "TimeoutError" && i >= 1) throw new Error(`${url.split("?")[0]} timed out twice (${TIMEOUT_MS / 1000}s each); upstream is slow or down`);
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

export function makeContext(label: string): FetchContext {
  return {
    fetchJson: async (url, init) => (await request(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } })).json(),
    fetchText: async (url, init) => (await request(url, init)).text(),
    log: (msg) => console.log(`[${label}] ${msg}`),
  };
}

/** Optional headless-browser fetch for JS-only career pages. Requires `npm i playwright && npx playwright install chromium`. */
export async function renderWithBrowser(url: string): Promise<string> {
  let pw: any;
  try {
    pw = await import("playwright");
  } catch {
    throw new Error("playwright not installed; run: npm i playwright && npx playwright install chromium");
  }
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UAS[0] });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}
