import { adapters, availableSearchAdapters } from "./adapters/index.ts";
import { makeContext } from "./http.ts";
import { normalize } from "./normalize.ts";
import { Store } from "./store.ts";
import type { SearchQuery, Job } from "./types.ts";
import { covers, inRegion } from "./regions.ts";

export interface SearchOutcome { jobs: Job[]; newIds: string[]; perSource: { source: string; count: number; error?: string; ms: number }[] }

/** Run a query against every chosen (or every available) search adapter, store results, return them ranked newest-first. */
export async function runSearch(store: Store, q: SearchQuery, onProgress?: (msg: string) => void): Promise<SearchOutcome> {
  const wanted = q.sources?.length ? q.sources.map((n) => adapters[n]).filter((a) => a?.search) : availableSearchAdapters();
  const chosen = wanted.filter((a) => covers(a.name, q.country));
  if (chosen.some((a) => a.needsHeadful)) { const { requireHeadful } = await import("./browser.ts"); requireHeadful(); onProgress?.("opening a visible browser window (Indeed/Glassdoor block headless Chrome)"); }
  const perSource: SearchOutcome["perSource"] = [];
  for (const a of wanted) if (!chosen.includes(a)) { perSource.push({ source: a.name, count: 0, error: `no coverage for ${q.country}`, ms: 0 }); onProgress?.(`[${a.name}] skipped: does not cover ${q.country}`); }
  const all: Job[] = [];
  const newIds: string[] = [];
  await Promise.all(chosen.map(async (a) => {
    const started = Date.now();
    const ctx = makeContext(a.name);
    ctx.log = (m) => onProgress?.(`[${a.name}] ${m}`);
    try {
      const raws = await a.search!(q, ctx);
      const seen = new Set<string>();
      const jobs = raws.filter((r) => r.title && r.url).map((r) => normalize(r, a.name, "search")).filter((j) => !seen.has(j.id) && seen.add(j.id));
      const r = store.upsertRun(a.name, "search", jobs, { close: false });
      newIds.push(...r.newIds);
      all.push(...jobs);
      perSource.push({ source: a.name, count: jobs.length, ms: Date.now() - started });
      onProgress?.(`[${a.name}] ${jobs.length} jobs (${r.inserted} new)`);
    } catch (e) {
      perSource.push({ source: a.name, count: 0, error: (e as Error).message, ms: Date.now() - started });
      onProgress?.(`[${a.name}] failed: ${(e as Error).message}`);
    }
  }));
  // Post-filter for adapters that ignore some parameters, plus user exclusions.
  const filtered = all.filter((j) => {
    if (q.excludeCompanies?.some((c) => j.company.toLowerCase().includes(c.toLowerCase()))) return false;
    if (q.excludeKeywords?.some((k) => j.title.toLowerCase().includes(k.toLowerCase()))) return false;
    if (q.remote === "remote" && j.remote === false) return false;
    if (q.country && j.country && j.country !== q.country.toUpperCase()) return false;
    if (!q.country && q.region && !inRegion(q.region, j.location, j.remote)) return false;
    if (q.postedWithin && q.postedWithin !== "any" && j.postedAt) {
      const days = { "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 }[q.postedWithin];
      if (Date.now() - Date.parse(j.postedAt) > days * 864e5 * 1.05) return false;
    }
    return true;
  });
  // Cross-source dedup by fingerprint (keep first occurrence, remember how many sources carried it).
  const byFp = new Map<string, Job>();
  for (const j of filtered) {
    const fp = `${j.company}|${j.title}|${j.location ?? ""}`.toLowerCase().replace(/[^a-z0-9|]+/g, " ");
    if (!byFp.has(fp)) byFp.set(fp, j);
  }
  const jobs = [...byFp.values()].sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
  return { jobs, newIds, perSource };
}

/** Search the local database (already-scraped ATS/company jobs) with the same query shape. */
export function searchLocal(store: Store, q: SearchQuery, limit = 200) {
  const days = { "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30, any: undefined }[q.postedWithin ?? "any"];
  return store.query({ q: q.keywords, country: q.country, remote: q.remote === "remote" ? true : undefined, postedDays: days,
    excludeCompanies: q.excludeCompanies, excludeKeywords: q.excludeKeywords, limit }) as any[];
}
