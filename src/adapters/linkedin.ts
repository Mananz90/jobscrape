// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import * as cheerio from "cheerio";
import type { SourceAdapter, SearchQuery, RawJob, FetchContext } from "../types.ts";

/**
 * LinkedIn public ("guest") job search. No login, no key. Returns up to 25 cards per page.
 * LinkedIn rate-limits aggressively (HTTP 429 after a few dozen requests): keep limits small,
 * and use the `apify` adapter with the linkedin preset for volume.
 */
const TPR: Record<string, string> = { "24h": "r86400", "3d": "r259200", "7d": "r604800", "14d": "r1209600", "30d": "r2592000" };
const JT: Record<string, string> = { fulltime: "F", parttime: "P", contract: "C", internship: "I" };
const WT: Record<string, string> = { onsite: "1", remote: "2", hybrid: "3" };
const EXP: Record<string, string> = { entry: "2", mid: "3", senior: "4", lead: "5" };

export const linkedin: SourceAdapter = {
  name: "linkedin",
  description: "LinkedIn public job search (guest API, no login). Query-driven; ~25 jobs/page, rate-limited.",
  kind: "board",
  keyKind: "none",
  async search(q, ctx) {
    // Whole-region search: run once per country in the region and merge.
    if (!q.location && q.regionLocations?.length) {
      const out: RawJob[] = [];
      for (const loc of q.regionLocations.slice(0, 8)) { try { out.push(...await linkedin.search!({ ...q, location: loc, regionLocations: undefined, limit: Math.max(25, Math.floor((q.limit ?? 50) / q.regionLocations.length)) }, ctx)); } catch (e) { ctx.log(`${loc}: ${(e as Error).message}`); break; } }
      return out;
    }
    const limit = Math.min(q.limit ?? 50, 200);
    const out: RawJob[] = [];
    for (let start = 0; start < limit; start += 25) {
      const p = new URLSearchParams({ keywords: q.keywords.replace(/[&|/]+/g, " ").replace(/\s+/g, " ").trim(), start: String(start) });
      if (q.location) p.set("location", q.location);
      if (q.postedWithin && TPR[q.postedWithin]) p.set("f_TPR", TPR[q.postedWithin]);
      if (q.jobType && JT[q.jobType]) p.set("f_JT", JT[q.jobType]);
      if (q.remote && WT[q.remote]) p.set("f_WT", WT[q.remote]);
      if (q.seniority && EXP[q.seniority]) p.set("f_E", EXP[q.seniority]);
      const html = await ctx.fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`);
      const $ = cheerio.load(html);
      const cards = $("div.base-card, li > div.base-search-card");
      if (!cards.length) break;
      cards.each((_, el) => {
        const c = $(el);
        const id = c.attr("data-entity-urn")?.split(":").pop() ?? c.find("a.base-card__full-link").attr("href")?.match(/-(\d+)\??/)?.[1];
        const title = c.find(".base-search-card__title").text().trim();
        if (!id || !title) return;
        out.push({
          externalId: id, title,
          company: c.find(".base-search-card__subtitle").text().trim() || "Unknown",
          url: `https://www.linkedin.com/jobs/view/${id}`,
          location: c.find(".job-search-card__location").text().trim() || null,
          postedAt: c.find("time").attr("datetime") ?? null,
          remote: q.remote === "remote" ? true : null,
          raw: { source: "linkedin-guest" },
        });
      });
      if (cards.length < 25) break;
    }
    // Optionally enrich with descriptions (one request per job; capped).
    const details = Math.min(out.length, Number(process.env.JOBSCRAPE_LINKEDIN_DETAILS ?? 10));
    for (const j of out.slice(0, details)) {
      try {
        const html = await ctx.fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${j.externalId}`);
        const $ = cheerio.load(html);
        j.descriptionHtml = $(".show-more-less-html__markup").html() ?? null;
        $(".description__job-criteria-item").each((_, li) => {
          const k = $(li).find("h3").text().trim().toLowerCase();
          const v = $(li).find("span").text().trim();
          if (k.includes("employment")) j.employmentType = v;
          if (k.includes("seniority")) j.department = v; // stored in department for lack of a seniority column
        });
      } catch (e) { ctx.log(`detail ${j.externalId}: ${(e as Error).message}`); break; }
    }
    return out.slice(0, limit);
  },
  async fetchJobs(cfg, ctx) {
    const q = cfg.options?.query as SearchQuery | undefined;
    if (!q) throw new Error("linkedin needs options.query ({keywords, location, ...})");
    return linkedin.search!(q, ctx);
  },
};

/** Fetch the description of one LinkedIn job on demand (used by the details view when the search skipped it). */
export async function linkedinDescription(externalId: string, ctx: FetchContext): Promise<string | null> {
  const html = await ctx.fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${externalId}`);
  return cheerio.load(html)(".show-more-less-html__markup").html() ?? null;
}

export function linkedinSearchUrl(q: SearchQuery) {
  const p = new URLSearchParams({ keywords: q.keywords.replace(/[&|/]+/g, " ").replace(/\s+/g, " ").trim() });
  if (q.location) p.set("location", q.location);
  if (q.postedWithin && TPR[q.postedWithin]) p.set("f_TPR", TPR[q.postedWithin]);
  if (q.jobType && JT[q.jobType]) p.set("f_JT", JT[q.jobType]);
  if (q.remote && WT[q.remote]) p.set("f_WT", WT[q.remote]);
  return `https://www.linkedin.com/jobs/search/?${p}`;
}
