// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import type { SourceAdapter, SearchQuery, RawJob, FetchContext } from "../types.ts";

/**
 * Runs Apify Store actors for the boards that block plain scraping (Indeed, Glassdoor, ZipRecruiter,
 * Naukri, StepStone, LinkedIn at volume). Needs APIFY_TOKEN. Pay-per-result pricing: a few USD per 1k jobs.
 * Each preset maps our SearchQuery to the actor's input; output fields are mapped heuristically because
 * every actor names them differently.
 */
export interface ActorPreset {
  actor: string;
  homepage: string;
  input: (q: SearchQuery) => Record<string, unknown>;
}

const days = (q: SearchQuery) => ({ "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 } as Record<string, number>)[q.postedWithin ?? ""];

export const presets: Record<string, ActorPreset> = {
  indeed: {
    actor: "borderline/indeed-scraper", homepage: "https://apify.com/borderline/indeed-scraper",
    input: (q) => ({ country: (q.country ?? "us").toLowerCase(), query: q.keywords, location: q.location ?? "", maxRows: q.limit ?? 50,
      ...(days(q) ? { fromDays: String(days(q)) } : {}), ...(q.remote === "remote" ? { remote: "remote" } : {}),
      ...(q.jobType && q.jobType !== "any" ? { jobType: q.jobType } : {}) }),
  },
  linkedin: {
    actor: "curious_coder/linkedin-jobs-scraper", homepage: "https://apify.com/curious_coder/linkedin-jobs-scraper",
    input: (q) => ({ keywords: q.keywords, location: q.location ?? "", limitPerSource: q.limit ?? 50,
      ...(days(q) ? { datePosted: days(q)! <= 1 ? "24h" : days(q)! <= 7 ? "week" : "month" } : {}) }),
  },
  glassdoor: {
    actor: "memo23/glassdoor-scraper-ppr", homepage: "https://apify.com/memo23/glassdoor-scraper-ppr",
    input: (q) => ({ command: "jobs", searchJobsByKeyword: true, searchKeyword: q.keywords, searchLocation: q.location ?? "", maxItems: q.limit ?? 50,
      ...(days(q) ? { maxDaysOld: String(days(q)) } : {}), ...(q.remote === "remote" ? { remoteWorkType: "remote" } : {}) }),
  },
  ziprecruiter: {
    actor: "crawlerbros/ziprecruiter-scraper-pro", homepage: "https://apify.com/crawlerbros/ziprecruiter-scraper-pro",
    input: (q) => ({ search: q.keywords, location: q.location ?? "", maxItems: q.limit ?? 50, remoteOnly: q.remote === "remote",
      ...(days(q) ? { daysPosted: days(q) } : {}) }),
  },
  naukri: {
    actor: "muhammetakkurtt/naukri-job-scraper", homepage: "https://apify.com/muhammetakkurtt/naukri-job-scraper",
    input: (q) => ({ jobBoard: "naukri", keyword: q.keywords, maxJobs: q.limit ?? 50, ...(q.location ? { cities: [q.location] } : {}) }),
  },
  stepstone: {
    actor: "memo23/stepstone-search-cheerio-ppr", homepage: "https://apify.com/memo23/stepstone-search-cheerio-ppr",
    input: (q) => ({ keyword: q.keywords, country: (q.country ?? "de").toLowerCase(), location: q.location ?? "", maxItems: q.limit ?? 50 }),
  },
};

export async function runActor(actor: string, input: Record<string, unknown>, ctx: FetchContext, timeoutSecs = 300): Promise<any[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set (get one at https://console.apify.com/account/integrations)");
  const id = actor.replace("/", "~");
  ctx.log(`running Apify actor ${actor} (this can take a minute)`);
  const res = await fetch(`https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items?token=${token}&timeout=${timeoutSecs}&format=json&clean=true`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout((timeoutSecs + 30) * 1000),
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Map any actor's item to RawJob by trying the common field names. */
export function mapActorItem(it: any, source: string): RawJob | null {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = k.split(".").reduce((o, kk) => o?.[kk], it); if (v !== undefined && v !== null && v !== "") return v; } return undefined; };
  const title = pick("title", "positionName", "jobTitle", "name", "job_title");
  const url = pick("url", "jobUrl", "link", "applyUrl", "jobLink", "job_url", "externalApplyLink");
  if (!title || !url) return null;
  const company = pick("company", "companyName", "company.name", "employer", "hiringOrganization.name", "company_name") ?? "Unknown";
  const salary = pick("salary", "salaryText", "salary.text", "compensation");
  return {
    externalId: String(pick("id", "jobId", "jobKey", "jobkey", "key", "job_id") ?? url),
    title: String(title), company: typeof company === "string" ? company : String(company?.name ?? "Unknown"), url: String(url),
    location: (pick("location", "formattedLocation", "jobLocation", "location.name", "place") as string) ?? null,
    remote: pick("isRemote", "remote") ?? null,
    employmentType: (pick("jobType", "employmentType", "contractType") as any) ?? null,
    salaryMin: pick("salaryMin", "salary.min", "salary_min") ?? null, salaryMax: pick("salaryMax", "salary.max", "salary_max") ?? null,
    descriptionHtml: (pick("descriptionHtml", "description_html", "jobDescriptionHtml") as string) ?? null,
    descriptionText: (pick("description", "descriptionText", "jobDescription", "snippet") as string) ?? (typeof salary === "string" ? `Salary: ${salary}` : null),
    postedAt: (pick("postedAt", "datePosted", "publishedAt", "date", "postedDate", "listedAt", "created_at") as string) ?? null,
    raw: it,
  };
}

function makeApifyAdapter(preset: string): SourceAdapter {
  const p = presets[preset];
  return {
    name: `apify-${preset}`, kind: "board", keyKind: "none", requires: ["APIFY_TOKEN"],
    description: `${preset[0].toUpperCase()}${preset.slice(1)} via Apify actor ${p.actor} (needs APIFY_TOKEN, pay-per-result).`,
    async search(q, ctx) {
      const items = await runActor(p.actor, p.input(q), ctx);
      return items.map((it) => mapActorItem(it, preset)).filter((x): x is RawJob => !!x);
    },
    async fetchJobs(cfg, ctx) {
      const q = cfg.options?.query as SearchQuery | undefined;
      if (!q) throw new Error(`apify-${preset} needs options.query`);
      return this.search!(q, ctx);
    },
  };
}

export const apifyAdapters = Object.keys(presets).map(makeApifyAdapter);
