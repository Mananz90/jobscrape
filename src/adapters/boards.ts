import type { SourceAdapter } from "../types.ts";

/** Global remote job boards with open JSON APIs. keyKind none: one source covers the whole board. */
export const remoteok: SourceAdapter = {
  name: "remoteok",
  description: "RemoteOK public API (whole board, all jobs).",
  keyKind: "none",
  async fetchJobs(_cfg, ctx) {
    const data: any[] = await ctx.fetchJson("https://remoteok.com/api");
    return data.filter((j) => j.id && j.position).map((j) => ({
      externalId: String(j.id), title: j.position, company: j.company, url: j.url,
      location: j.location || "Remote", remote: true, descriptionHtml: j.description ?? null,
      salaryMin: j.salary_min || null, salaryMax: j.salary_max || null, salaryCurrency: j.salary_min ? "USD" : null,
      postedAt: j.date ?? null, raw: j,
    }));
  },
};

export const remotive: SourceAdapter = {
  name: "remotive",
  description: "Remotive public API (whole board). options.category filters, e.g. 'software-dev'.",
  keyKind: "none",
  async fetchJobs(cfg, ctx) {
    const cat = cfg.options?.category ? `?category=${cfg.options.category}` : "";
    const data = await ctx.fetchJson(`https://remotive.com/api/remote-jobs${cat}`);
    return (data.jobs ?? []).map((j: any) => ({
      externalId: String(j.id), title: j.title, company: j.company_name, url: j.url,
      location: j.candidate_required_location || "Remote", remote: true, employmentType: j.job_type ?? null,
      department: j.category ?? null, descriptionHtml: j.description ?? null, postedAt: j.publication_date ?? null, raw: j,
    }));
  },
};

export const arbeitnow: SourceAdapter = {
  name: "arbeitnow",
  description: "Arbeitnow public API (Europe-focused board, paginated).",
  keyKind: "none",
  async fetchJobs(cfg, ctx) {
    const maxPages = Number(cfg.options?.pages ?? 3);
    const out: any[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const data = await ctx.fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${p}`);
      for (const j of data.data ?? []) out.push({
        externalId: j.slug, title: j.title, company: j.company_name, url: j.url, location: j.location ?? null,
        remote: j.remote ?? null, descriptionHtml: j.description ?? null,
        postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null, raw: j,
      });
      if (!data.links?.next) break;
    }
    return out;
  },
};

const ADZUNA_COUNTRIES = new Set(["gb", "us", "at", "au", "be", "br", "ca", "ch", "de", "es", "fr", "in", "it", "mx", "nl", "nz", "pl", "sg", "za"]);
export const adzuna: SourceAdapter = {
  name: "adzuna",
  description: "Adzuna aggregator API, 19 countries (needs ADZUNA_APP_ID/KEY). Query-driven.",
  keyKind: "slug", requires: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
  async search(q, ctx) {
    const { ADZUNA_APP_ID: id, ADZUNA_APP_KEY: key } = process.env;
    if (!id || !key) throw new Error("ADZUNA_APP_ID / ADZUNA_APP_KEY not set (free at https://developer.adzuna.com)");
    const cc = (q.country ?? "gb").toLowerCase();
    if (!ADZUNA_COUNTRIES.has(cc)) throw new Error(`Adzuna does not cover country ${cc}`);
    const out: any[] = [];
    const limit = q.limit ?? 50;
    for (let p = 1; out.length < limit; p++) {
      const params = new URLSearchParams({ app_id: id, app_key: key, results_per_page: "50", what: q.keywords });
      if (q.location) params.set("where", q.location);
      const d = ({ "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 } as Record<string, number>)[q.postedWithin ?? ""];
      if (d) params.set("max_days_old", String(d));
      if (q.jobType === "fulltime") params.set("full_time", "1");
      if (q.jobType === "parttime") params.set("part_time", "1");
      if (q.jobType === "contract") params.set("contract", "1");
      const data = await ctx.fetchJson(`https://api.adzuna.com/v1/api/jobs/${cc}/search/${p}?${params}`);
      for (const j of data.results ?? []) out.push({
        externalId: String(j.id), title: j.title, company: j.company?.display_name ?? "Unknown", url: j.redirect_url,
        location: j.location?.display_name ?? null, country: cc.toUpperCase(), salaryMin: j.salary_min ?? null, salaryMax: j.salary_max ?? null,
        employmentType: j.contract_time ?? null, descriptionText: j.description ?? null, postedAt: j.created ?? null, raw: j,
      });
      if (!data.results?.length) break;
    }
    return out.slice(0, limit);
  },
  async fetchJobs(cfg, ctx) {
    return adzuna.search!({ keywords: String(cfg.options?.what ?? ""), country: cfg.key, limit: Number(cfg.options?.pages ?? 2) * 50 }, ctx);
  },
};
