import { request, HttpError } from "./http.ts";

/**
 * Check that job URLs are still live. Drops postings whose page is gone or says "no longer accepting".
 * Sources that block plain HTTP (Indeed, Glassdoor) or rate-limit (LinkedIn) are treated as verified at fetch time.
 */
const SKIP = new Set(["indeed", "indeed-browser", "glassdoor", "glassdoor-browser", "linkedin", "linkedin-browser", "apify-indeed", "apify-glassdoor", "apify-linkedin"]);
const DEAD = /no longer accepting|position has been filled|job is no longer|posting is closed|not accepting applications|stelle ist nicht mehr|nicht mehr verfügbar|404 not found|job not found/i;

export async function verifyJobs<T extends { url: string; source: string }>(jobs: T[], opts: { concurrency?: number; log?: (m: string) => void } = {}): Promise<(T & { verified: boolean | null })[]> {
  const out = jobs.map((j) => ({ ...j, verified: null as boolean | null }));
  const queue = out.filter((j) => !SKIP.has(j.source));
  let i = 0;
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, async () => {
    while (i < queue.length) {
      const j = queue[i++];
      try {
        const res = await request(j.url, { redirect: "follow" }, 2);
        const body = (await res.text()).slice(0, 6000);
        j.verified = !DEAD.test(body);
      } catch (e) { j.verified = e instanceof HttpError && (e.status === 404 || e.status === 410) ? false : null; }
    }
  }));
  for (const j of out) if (SKIP.has(j.source)) j.verified = true;
  opts.log?.(`verified ${queue.length} links: ${queue.filter((j) => j.verified === false).length} dead`);
  return out;
}
