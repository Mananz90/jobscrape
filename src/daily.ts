// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "./store.ts";
import { runAll } from "./runner.ts";
import { runSearch } from "./search.ts";
import { loadSources } from "./config.ts";
import { rankJobs, queryFromProfile } from "./match.ts";
import { verifyJobs } from "./verify.ts";
import { htmlReport } from "./report.ts";
import { notify } from "./notify.ts";
import { scraplingAvailable } from "./scrapling.ts";
import type { SearchQuery } from "./types.ts";

/**
 * One unattended run: refresh watched companies, run the profile's saved searches, rank everything new against the profile,
 * write a Markdown digest and send a notification. Designed for launchd/cron; only headless sources are used.
 */
export async function daily(store: Store, profileName: string, opts: { refresh?: boolean; minScore?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const prof = store.getProfile(profileName);
  if (!prof) throw new Error(`profile "${profileName}" not found; run: node src/index.ts match <cv.pdf> --name ${profileName}`);
  const p = prof.profile;
  const minScore = opts.minScore ?? 40;

  // Saved searches for this profile: create from its keywords on first run.
  let searches = store.listSearches().filter((s) => s.query.profile === profileName);
  if (!searches.length) {
    const base = queryFromProfile(p);
    const sources = ["linkedin-browser", scraplingAvailable() ? "glassdoor" : "glassdoor-browser", "themuse", "jobicy"].filter((s) => s !== "glassdoor-browser");
    const kws = [...new Set([base.keywords, ...(p.keywords ?? [])])].filter(Boolean).slice(0, 3);
    for (const kw of kws) {
      const q: SearchQuery & { profile: string } = { keywords: kw, location: base.location, country: base.country, remote: base.remote === "any" ? "any" : base.remote, jobType: "fulltime",
        seniority: "any", postedWithin: "3d", limit: 40, sources, profile: profileName };
      const name = `${profileName}: ${kw}`;
      store.saveSearch(name, q);
      log(`created saved search "${name}" (${sources.join(", ")})`);
    }
    searches = store.listSearches().filter((s) => s.query.profile === profileName);
  }

  const started = new Date();
  const lines: string[] = [];
  let refreshedNew: string[] = [];
  if (opts.refresh !== false) {
    const res = await runAll(store, loadSources());
    const ok = res.filter((r) => !r.error);
    log(`watched companies: ${ok.length}/${res.length} sources ok, ${ok.reduce((a, r) => a + r.inserted, 0)} new`);
    // New jobs at watched companies are only interesting if they match the profile keywords loosely.
    const since = new Date(started.getTime() - 60_000).toISOString();
    const fresh = store.query({ since, limit: 2000 }) as any[];
    refreshedNew = fresh.filter((j) => (p.titles ?? []).some((t: string) => t.toLowerCase().split(" ").filter((w: string) => w.length > 3).some((w: string) => j.title.toLowerCase().includes(w)))).map((j) => j.id);
  }

  const newIds = new Set<string>(refreshedNew);
  let prevHadLinkedIn = false;
  for (const s of searches) {
    // LinkedIn rate-limits bursts of guest searches: pause between consecutive searches that use it.
    const usesLinkedIn = (s.query.sources ?? []).some((x: string) => x.startsWith("linkedin"));
    if (usesLinkedIn && prevHadLinkedIn) await new Promise((r) => setTimeout(r, Number(process.env.JOBSCRAPE_LINKEDIN_PAUSE_MS ?? 10_000)));
    prevHadLinkedIn = usesLinkedIn;
    try {
      const out = await runSearch(store, s.query, (m) => log(`  ${m}`));
      store.touchSearch(s.name, out.newIds.length);
      out.newIds.forEach((id) => newIds.add(id));
      log(`"${s.name}": ${out.jobs.length} jobs, ${out.newIds.length} new`);
    } catch (e) { log(`"${s.name}" failed: ${(e as Error).message}`); }
  }

  // Hard age ceiling: never surface anything older than JOBSCRAPE_MAX_AGE_DAYS (default 40), whatever the source reports.
  const maxAge = Number(process.env.JOBSCRAPE_MAX_AGE_DAYS ?? 40);
  const rows = (store.query({ ids: [...newIds], limit: 1000 }) as any[]).filter((r) => !r.posted_at || Date.now() - Date.parse(r.posted_at) <= maxAge * 864e5);
  let ranked = (await rankJobs(store, rows, profileName, { maxPerCompany: Number(process.env.JOBSCRAPE_MAX_PER_COMPANY ?? 6), log })).map((r) => ({ ...r, m: r.match }));
  // Drop dead links among the candidates before alerting.
  const verified = await verifyJobs(ranked.filter((r) => r.m.score >= minScore).slice(0, 60), { log });
  const dead = new Set(verified.filter((v) => v.verified === false).map((v) => v.id));
  ranked = ranked.filter((r) => !dead.has(r.id));
  const good = ranked.filter((r) => r.m.score >= minScore);

  mkdirSync("data/digests", { recursive: true });
  const day = started.toISOString().slice(0, 10);
  const file = `data/digests/${day}.md`;
  const md = `# jobscrape digest — ${day} — profile "${profileName}"\n\n${newIds.size} new jobs since last run, ${good.length} at or above ${minScore}% fit.\n\n` +
    `| fit | title | company | location | posted | source | matched | missing |\n|---|---|---|---|---|---|---|---|\n` +
    ranked.slice(0, 60).map((j) => `| ${j.m.score}%${j.m.semantic != null ? ` (sem ${j.m.semantic}%)` : ""} | [${j.title.replace(/\|/g, "/")}](${j.url}) | ${j.company} | ${j.location ?? ""} | ${(j.posted_at ?? "").slice(0, 10)} | ${j.source} | ${j.m.matched.slice(0, 5).join(", ")} | ${j.m.missing.slice(0, 3).join(", ")} |`).join("\n") +
    `\n\nOpen the dashboard: \`node src/index.ts serve\` → http://localhost:3210 (filter by status, mark applied).\n`;
  writeFileSync(file, md);
  writeFileSync(file.replace(/\.md$/, ".html"), htmlReport(ranked.slice(0, 60), `daily digest · profile ${profileName} · ${newIds.size} new · ${good.length} ≥ ${minScore}%`));

  if (good.length) {
    lines.push(...good.slice(0, 5).map((j) => `${j.m.score}% ${j.title} @ ${j.company}`));
    await notify(`jobscrape: ${good.length} new match${good.length > 1 ? "es" : ""} for ${profileName}`, lines,
      good.slice(0, 12).map((j) => ({ title: j.title, company: j.company, url: j.url, score: j.m.score, location: j.location })));
  } else if (process.env.JOBSCRAPE_NOTIFY_EMPTY === "1") await notify("jobscrape: no new matches today", [`${newIds.size} new jobs, none above ${minScore}%`]);

  // Source health: warn (and include in the alert) when a scraper looks broken.
  const h = store.health(14, new Set(loadSources().filter((x) => x.enabled !== false).map((x) => `${x.adapter}:${x.key || "*"}`)));
  const warn = [...h.failing.map((r: any) => `✗ ${r.source}:${r.source_key} failed: ${String(r.error).slice(0, 80)}`), ...h.drops.map((r: any) => `⚠ ${r.source}:${r.source_key} fetched ${r.latest}, 7-day avg ${r.avg7}`)];
  if (warn.length) { log(`source health:\n  ${warn.join("\n  ")}`); if (process.env.JOBSCRAPE_HEALTH_ALERTS !== "0") await notify("jobscrape: source problems", warn.slice(0, 8)); }
  log(`digest written to ${file}; ${newIds.size} new, ${good.length} ≥ ${minScore}%`);
  return { newCount: newIds.size, good: good.length, file };
}
