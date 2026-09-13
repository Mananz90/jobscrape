#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { runAll } from "./runner.ts";
import { adapters, searchAdapters } from "./adapters/index.ts";
import { detectSource } from "./detect.ts";
import { loadSources, addSource } from "./config.ts";
import { serve } from "./server.ts";
import { runSearch, searchLocal } from "./search.ts";
import { readDocument, extractProfile } from "./profile.ts";
import { rankJobs, queryFromProfile } from "./match.ts";
import { discoverByKeyword, resolveCompanies } from "./discover.ts";
import { notify } from "./notify.ts";
import type { SearchQuery } from "./types.ts";

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string", short: "s" }, add: { type: "boolean" }, interval: { type: "string", default: "60" }, format: { type: "string", default: "json" },
    keywords: { type: "string", short: "k" }, location: { type: "string", short: "l" }, country: { type: "string", short: "c" }, remote: { type: "string" },
    type: { type: "string" }, posted: { type: "string" }, seniority: { type: "string" }, limit: { type: "string" }, sources: { type: "string" },
    profile: { type: "string" }, name: { type: "string" }, save: { type: "string" }, local: { type: "boolean" }, json: { type: "boolean" },
  },
});
const [cmd, arg] = positionals;

const help = `jobscrape — interactive, self-hosted job search across job boards, ATS platforms and company career pages

  node src/index.ts                          interactive wizard (region, country, job type, dates, sources, CV matching...)
  node src/index.ts search -k "data engineer" -l "Berlin, Germany" -c DE [--remote remote|hybrid|onsite] [--type fulltime]
                           [--posted 24h|3d|7d|14d|30d] [--seniority senior] [--limit 50] [--sources linkedin,themuse] [--profile NAME]
                           [--local] [--save NAME] [--json]
  node src/index.ts match <cv.pdf|jd.docx|file.txt> [--name NAME] [--local]   read a CV/JD, build a profile, search + rank by fit
  node src/index.ts discover "<keyword>"     find companies' ATS boards via search engines (e.g. "Berlin fintech") and add them
  node src/index.ts import <file|"A, B, C">  resolve company names/domains/careers URLs into sources
  node src/index.ts detect <careers-url> [--add]
  node src/index.ts run [--source NAME]      re-scrape configured company/board sources
  node src/index.ts serve                    REST API + dashboard on http://localhost:3210
  node src/index.ts daily --profile NAME     one unattended run: refresh companies, run the profile's saved searches, rank new jobs, notify, write data/digests/<date>.md
  node src/index.ts schedule [--interval M]  re-scrape + re-run saved searches every M minutes, alert on new jobs, serve API
  node src/index.ts login linkedin|indeed|glassdoor   open a real browser window to sign in once; the session is reused by *-browser sources
  node src/index.ts health                   sources whose fetch count dropped, are failing, or have had no new jobs for 14 days
  node src/index.ts sources                  list adapters, readiness (API keys), coverage, configured sources
  node src/index.ts export [--format json|csv]
`;

const store = new Store();
const flagsToQuery = (): SearchQuery => ({
  keywords: v.keywords ?? "", location: v.location, country: v.country?.toUpperCase(), remote: (v.remote as any) ?? "any", jobType: (v.type as any) ?? "any",
  postedWithin: (v.posted as any) ?? "7d", seniority: (v.seniority as any) ?? "any", limit: Number(v.limit ?? 50), sources: v.sources?.split(",").map((s) => s.trim()).filter(Boolean),
});
const rank = async (rows: any[], profileName?: string) => profileName ? rankJobs(store, rows, profileName, { log: (m) => console.error(m) }) : rows;
const print = (rows: any[]) => {
  if (v.json) return console.log(JSON.stringify(rows, null, 2));
  const cut = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").slice(0, n).padEnd(n);
  console.log(`\n${cut("#", 4)}${cut("fit", 5)}${cut("sem", 5)}${cut("title", 46)} ${cut("company", 22)} ${cut("location", 24)} ${cut("posted", 11)}${cut("source", 12)}`);
  rows.forEach((j, i) => console.log(`${cut(i + 1, 4)}${cut(j.match ? j.match.score + "%" : "", 5)}${cut(j.match?.semantic != null ? j.match.semantic + "%" : "", 5)}${cut(j.title, 46)} ${cut(j.company, 22)} ${cut((j.location ?? "") + ((j.remote === true || j.remote === 1) ? " 🏠" : ""), 24)} ${cut((j.posted_at ?? j.postedAt ?? j.first_seen ?? "").slice(0, 10), 11)}${cut(j.source, 12)}`));
  console.log(`\n${rows.length} jobs`);
};

switch (cmd) {
  case undefined: case "interactive": case "i": { const { interactive } = await import("./interactive.ts"); await interactive(store); break; }
  case "search": {
    const q = flagsToQuery();
    if (!q.keywords) { console.error("search needs -k/--keywords"); process.exit(1); }
    const out = await runSearch(store, q, (m) => v.json || console.error(m));
    let rows: any[] = out.jobs;
    if (v.local) rows = [...rows, ...searchLocal(store, q).filter((l) => !rows.some((j) => j.id === l.id))];
    if (v.save) store.saveSearch(v.save, q);
    print(await rank(rows, v.profile));
    break;
  }
  case "match": {
    if (!arg) { console.error("usage: match <cv-or-jd file>"); process.exit(1); }
    const text = await readDocument(arg);
    const kind = /job description|responsibilities|we are looking|what you.ll do/i.test(text) && !/curriculum|résumé|resume|work experience|education/i.test(text.slice(0, 600)) ? "jd" : "cv";
    const { profile, method } = await extractProfile(text, kind, (m) => console.error(m));
    const name = v.name ?? arg.split("/").pop()!.replace(/\.[^.]+$/, "");
    store.saveProfile(name, kind, profile, arg, text);
    console.error(`profile "${name}" (${kind}, ${method}): ${profile.summary}\n  keywords: ${profile.keywords.join(" | ")} · ${profile.locations.join(", ") || "no location"} · ${profile.remotePreference} · ${profile.seniority}`);
    const base = queryFromProfile(profile);
    const q: SearchQuery = { ...flagsToQuery(), keywords: v.keywords ?? base.keywords, location: v.location ?? base.location, country: v.country?.toUpperCase() ?? base.country, remote: (v.remote as any) ?? base.remote, seniority: (v.seniority as any) ?? base.seniority };
    const out = await runSearch(store, q, (m) => v.json || console.error(m));
    let rows: any[] = out.jobs;
    if (v.local) rows = [...rows, ...searchLocal(store, { ...q, keywords: profile.keywords[0] ?? q.keywords }).filter((l) => !rows.some((j) => j.id === l.id))];
    print(await rank(rows, name));
    break;
  }
  case "discover": {
    if (!arg) { console.error('usage: discover "<keyword>"'); process.exit(1); }
    const found = await discoverByKeyword(arg, { log: (m) => console.error(m) });
    let added = 0; if (v.add) for (const f of found) if (addSource(f)) added++;
    console.log(found.map((f) => `${f.adapter}:${f.key} (${f.company})`).join("\n") || "nothing found");
    console.error(v.add ? `added ${added} new sources` : `use --add to write ${found.length} sources to config/sources.json`);
    break;
  }
  case "import": {
    if (!arg) { console.error('usage: import <file | "A, B, C">'); process.exit(1); }
    const entries = /\.(txt|csv|md)$/i.test(arg) ? readFileSync(arg, "utf8").split(/\r?\n/) : arg.split(",");
    const { resolved, unresolved } = await resolveCompanies(entries, (m) => console.error(m));
    let added = 0; for (const r of resolved) if (addSource(r)) added++;
    console.log(`resolved ${resolved.length}, added ${added}${unresolved.length ? `, unresolved: ${unresolved.join(", ")}` : ""}`);
    break;
  }
  case "run": {
    const results = await runAll(store, loadSources(), v.source);
    const ok = results.filter((r) => !r.error);
    console.log(`\n${ok.length}/${results.length} sources ok · fetched ${ok.reduce((a, r) => a + r.fetched, 0)} · new ${ok.reduce((a, r) => a + r.inserted, 0)} · closed ${ok.reduce((a, r) => a + r.closed, 0)}`);
    for (const r of results.filter((r) => r.error)) console.log(`  ✗ ${r.source}:${r.key} — ${r.error}`);
    break;
  }
  case "login": {
    const { LOGIN_URLS, loginFlow, closeBrowser } = await import("./browser.ts");
    const sites = (arg ?? "linkedin").split(",").map((x) => x.trim());
    for (const site of sites) if (!LOGIN_URLS[site]) { console.error(`unknown site "${site}"; choose from ${Object.keys(LOGIN_URLS).join(", ")}`); process.exit(1); }
    const country = (v.country ?? "DE").toUpperCase();
    console.log(`Opening a visible browser for: ${sites.join(", ")} (country edition: ${country}). jobscrape never sees your password; only the sites' cookies stay in data/browser-profile.`);
    const results: Record<string, { cleared: boolean; loggedIn: boolean }> = {};
    for (const site of sites) results[site] = await loginFlow(site, country, (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`));
    await closeBrowser();
    for (const [site, r] of Object.entries(results)) console.log(`${r.cleared ? "✓" : "✗"} ${site}: ${r.cleared ? "bot check cleared" : "still blocked"}${r.loggedIn ? ", signed in" : ""}`);
    process.exit(0);
  }
  case "daily": {
    const { daily } = await import("./daily.ts");
    const name = v.profile ?? store.listProfiles()[0]?.name;
    if (!name) { console.error("daily needs --profile NAME (create one with: match <cv.pdf> --name NAME)"); process.exit(1); }
    const r = await daily(store, name, { refresh: !v.local, minScore: v.limit ? undefined : undefined });
    console.log(`done: ${r.newCount} new, ${r.good} matches → ${r.file}`);
    const { closeBrowser } = await import("./browser.ts"); await closeBrowser();
    process.exit(0);
  }
  case "health": {
    const h = store.health(14, new Set(loadSources().filter((x) => x.enabled !== false).map((x) => `${x.adapter}:${x.key || "*"}`)));
    const line = (r: any) => `${r.source}:${r.source_key}`;
    console.log(`Failing (last run errored): ${h.failing.length}`); for (const r of h.failing) console.log(`  ✗ ${line(r)} — ${r.error}`);
    console.log(`Dropped >50% vs 7-day average: ${h.drops.length}`); for (const r of h.drops) console.log(`  ⚠ ${line(r)}: ${r.latest} vs avg ${r.avg7}`);
    console.log(`No new jobs for 14+ days: ${h.stale.length}`); for (const r of h.stale) console.log(`  · ${line(r)} (last new ${r.last_new?.slice(0, 10) ?? "never"}, ${r.runs} runs)`);
    break;
  }
  case "serve": serve(store); break;
  case "schedule": {
    const mins = Number(v.interval);
    serve(store);
    const tick = async () => {
      console.log(`\n[${new Date().toISOString()}] scheduled run`);
      const res = await runAll(store, loadSources());
      const lines: string[] = [];
      const fresh = res.reduce((a, r) => a + r.inserted, 0);
      if (fresh) lines.push(`${fresh} new jobs at watched companies`);
      for (const s of store.listSearches()) {
        try { const out = await runSearch(store, s.query); store.touchSearch(s.name, out.newIds.length); if (out.newIds.length) lines.push(`"${s.name}": ${out.newIds.length} new — ${out.jobs.filter((j) => out.newIds.includes(j.id)).slice(0, 3).map((j) => `${j.title} @ ${j.company}`).join("; ")}`); }
        catch (e) { console.error(`saved search ${s.name} failed: ${(e as Error).message}`); }
      }
      if (lines.length) await notify("jobscrape: new jobs", lines);
    };
    await tick();
    setInterval(tick, mins * 60_000);
    break;
  }
  case "detect": {
    if (!arg) { console.error("usage: detect <careers-url> [--add]"); process.exit(1); }
    const cfg = await detectSource(arg);
    console.log(JSON.stringify(cfg, null, 2));
    if (v.add) console.log(addSource(cfg) ? "added to config/sources.json" : "already configured");
    break;
  }
  case "sources": {
    console.log("Adapters:");
    const { coverageLabel } = await import("./regions.ts");
    for (const a of Object.values(adapters)) { const ready = (a.requires ?? []).every((k) => process.env[k]); console.log(`  ${ready ? "✓" : "○"} ${a.name.padEnd(18)} ${(a.kind ?? "").padEnd(10)} ${a.search ? "search " : "        "} ${coverageLabel(a.name).padEnd(14)} ${a.description}${ready ? "" : `  [needs ${a.requires!.join(", ")}]`}`); }
    console.log("\nConfigured sources:");
    for (const s of loadSources()) console.log(`  ${s.enabled === false ? "(off) " : ""}${s.adapter}:${s.key}${s.company ? ` (${s.company})` : ""}`);
    console.log(`\nProfiles: ${store.listProfiles().map((p) => p.name).join(", ") || "none"}\nSaved searches: ${store.listSearches().map((s) => s.name).join(", ") || "none"}`);
    break;
  }
  case "export": {
    const rows: any[] = store.query({ limit: 1_000_000 });
    mkdirSync("data/exports", { recursive: true });
    const file = `data/exports/jobs-${new Date().toISOString().slice(0, 10)}.${v.format}`;
    if (v.format === "csv") { const cols = Object.keys(rows[0] ?? {}); const esc = (x: unknown) => `"${String(x ?? "").replace(/"/g, '""')}"`; writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")); }
    else writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`wrote ${rows.length} jobs to ${file}`);
    break;
  }
  default: console.log(help);
}
