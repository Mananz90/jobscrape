// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import * as cheerio from "cheerio";
import { request } from "./http.ts";
import { detectSource } from "./detect.ts";
import { adapters } from "./adapters/index.ts";
import { makeContext } from "./http.ts";
import type { SourceConfig } from "./types.ts";

/**
 * Company discovery: turn "all companies in <region/industry>" into concrete ATS sources.
 *  - Search-engine discovery: query `site:boards.greenhouse.io <keyword>` etc. via Brave Search API (BRAVE_API_KEY)
 *    or DuckDuckGo HTML as a keyless fallback. Each hit maps to an ATS slug.
 *  - Name/domain import: a list of company names, domains or careers URLs -> detection + slug probing.
 *  - Packs: curated lists shipped in config/packs/*.json.
 */
const ATS_PATTERNS: [string, RegExp][] = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/i],
  ["lever", /jobs\.lever\.co\/([a-z0-9_-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i],
  ["workable", /apply\.workable\.com\/([a-z0-9_-]+)/i],
  ["smartrecruiters", /jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/],
  ["recruitee", /https?:\/\/([a-z0-9-]+)\.recruitee\.com/i],
  ["personio", /https?:\/\/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i],
];
const ATS_SITES = ["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "apply.workable.com", "jobs.smartrecruiters.com", "recruitee.com", "jobs.personio.de"];

export async function discoverByKeyword(keyword: string, opts: { limitPerSite?: number; sites?: string[]; log?: (m: string) => void } = {}): Promise<SourceConfig[]> {
  const found = new Map<string, SourceConfig>();
  for (const site of opts.sites ?? ATS_SITES) {
    const q = `site:${site} ${keyword}`;
    let urls: string[] = [];
    try { urls = process.env.BRAVE_API_KEY ? await braveSearch(q, opts.limitPerSite ?? 20) : await ddgSearch(q); }
    catch (e) { opts.log?.(`search "${q}" failed: ${(e as Error).message}`); continue; }
    for (const u of urls) {
      const hit = slugFromUrl(u);
      if (hit && !found.has(`${hit.adapter}:${hit.key}`)) found.set(`${hit.adapter}:${hit.key}`, { ...hit, company: pretty(hit.key) });
    }
    opts.log?.(`${site}: ${urls.length} hits, ${found.size} companies so far`);
  }
  return [...found.values()];
}

export function slugFromUrl(u: string): { adapter: string; key: string } | null {
  for (const [adapter, re] of ATS_PATTERNS) {
    const m = u.match(re);
    if (m && !["jobs", "www", "api", "embed"].includes(m[1].toLowerCase())) return { adapter, key: m[1] };
  }
  return null;
}

/** Resolve a list of company names / domains / careers URLs into sources. */
export async function resolveCompanies(entries: string[], log?: (m: string) => void): Promise<{ resolved: SourceConfig[]; unresolved: string[] }> {
  const resolved: SourceConfig[] = [], unresolved: string[] = [];
  const ctx = { ...makeContext("resolve"), log: () => {} };
  for (const raw of entries.map((e) => e.trim()).filter(Boolean)) {
    try {
      if (/^https?:\/\//.test(raw)) { const cfg = await detectSource(raw); if (cfg.adapter !== "careerpage") { resolved.push(cfg); log?.(`${raw} -> ${cfg.adapter}:${cfg.key}`); continue; } resolved.push(cfg); log?.(`${raw} -> generic career page`); continue; }
      if (/\.[a-z]{2,}$/i.test(raw) && !raw.includes(" ")) { const cfg = await detectSource(`https://${raw}/careers`); resolved.push(cfg); log?.(`${raw} -> ${cfg.adapter}:${cfg.key}`); continue; }
      // Known Workday tenants first (no public slug convention there).
      const { WORKDAY_REGISTRY } = await import("./adapters/workday.ts");
      const wk = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (WORKDAY_REGISTRY[wk]) { try { const jobs = await adapters.workday.fetchJobs({ adapter: "workday", key: wk, company: raw }, ctx); if (jobs.length) { resolved.push({ adapter: "workday", key: wk, company: raw }); log?.(`${raw} -> workday:${wk}`); continue; } } catch { /* fall through */ } }
      // Company name: probe slugs on each ATS.
      const slugs = [...new Set([raw.toLowerCase().replace(/[^a-z0-9]+/g, ""), raw.toLowerCase().replace(/[^a-z0-9]+/g, "-"), raw.split(/\s+/)[0].toLowerCase()])];
      let hit: SourceConfig | null = null;
      outer: for (const slug of slugs) for (const name of ["greenhouse", "lever", "ashby", "workable", "recruitee", "smartrecruiters", "personio"]) {
        try { const jobs = await adapters[name].fetchJobs({ adapter: name, key: slug, company: raw }, ctx); if (jobs.length) { hit = { adapter: name, key: slug, company: raw }; break outer; } } catch { /* next */ }
      }
      if (hit) { resolved.push(hit); log?.(`${raw} -> ${hit.adapter}:${hit.key}`); } else { unresolved.push(raw); log?.(`${raw} -> not found on any known ATS`); }
    } catch (e) { unresolved.push(raw); log?.(`${raw} -> error ${(e as Error).message}`); }
  }
  return { resolved, unresolved };
}

async function ddgSearch(q: string): Promise<string[]> {
  const html = await (await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`)).text();
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $("a.result__a, a.result__url").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const m = href.match(/uddg=([^&]+)/);
    urls.push(m ? decodeURIComponent(m[1]) : href);
  });
  return [...new Set(urls)];
}

async function braveSearch(q: string, count: number): Promise<string[]> {
  const res = await request(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, { headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY!, accept: "application/json" } });
  const data = await res.json();
  return (data.web?.results ?? []).map((r: any) => r.url);
}

const pretty = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
