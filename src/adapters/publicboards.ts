import type { SourceAdapter, SearchQuery, RawJob } from "../types.ts";

/** Boards with open, query-capable JSON APIs. All keyless unless `requires` says otherwise. */
const withQuery = (a: Omit<SourceAdapter, "fetchJobs" | "keyKind">): SourceAdapter => ({
  ...a, keyKind: "none", kind: a.kind ?? "board",
  async fetchJobs(cfg, ctx) { return a.search!((cfg.options?.query as SearchQuery) ?? { keywords: "" }, ctx); },
});

export const themuse = withQuery({
  name: "themuse", description: "The Muse public API (US-heavy, curated companies).",
  async search(q, ctx) {
    const out: RawJob[] = [];
    for (let page = 1; page <= Math.ceil((q.limit ?? 40) / 20); page++) {
      const p = new URLSearchParams({ page: String(page), descending: "true" });
      if (q.location) p.append("location", q.location);
      const data = await ctx.fetchJson(`https://www.themuse.com/api/public/jobs?${p}`);
      for (const j of data.results ?? []) {
        if (q.keywords && !kw(q.keywords, `${j.name} ${j.contents}`)) continue;
        out.push({ externalId: String(j.id), title: j.name, company: j.company?.name ?? "Unknown", url: j.refs?.landing_page,
          location: j.locations?.map((l: any) => l.name).join("; ") || null, department: j.categories?.[0]?.name ?? null,
          descriptionHtml: j.contents ?? null, postedAt: j.publication_date ?? null, employmentType: j.type ?? null, raw: j });
      }
      if (!data.results?.length || page >= (data.page_count ?? 1)) break;
    }
    return out;
  },
});

export const jobicy = withQuery({
  name: "jobicy", description: "Jobicy remote jobs API (global remote, region filter).",
  async search(q, ctx) {
    const GEO: Record<string, string> = { US: "usa", GB: "uk", DE: "germany", FR: "france", NL: "netherlands", ES: "spain", IT: "italy", CA: "canada", AU: "australia", IN: "india", SG: "singapore", AE: "uae", IE: "ireland", CH: "switzerland", AT: "austria", SE: "sweden", PL: "poland", PT: "portugal", BR: "brazil", MX: "mexico", JP: "japan" };
    const p = new URLSearchParams({ count: String(Math.min(q.limit ?? 50, 100)) });
    const tag = q.keywords.split(/\s+/)[0]; if (tag) p.set("tag", tag);
    if (q.country && GEO[q.country.toUpperCase()]) p.set("geo", GEO[q.country.toUpperCase()]);
    const data = await ctx.fetchJson(`https://jobicy.com/api/v2/remote-jobs?${p}`);
    return (data.jobs ?? []).filter((j: any) => kw(q.keywords, `${j.jobTitle} ${j.jobDescription ?? ""}`)).map((j: any): RawJob => ({ externalId: String(j.id), title: j.jobTitle, company: j.companyName, url: j.url,
      location: j.jobGeo ?? "Remote", remote: true, employmentType: j.jobType?.[0] ?? null, department: j.jobIndustry?.[0] ?? null,
      salaryMin: j.annualSalaryMin ?? null, salaryMax: j.annualSalaryMax ?? null, salaryCurrency: j.salaryCurrency ?? null,
      descriptionHtml: j.jobDescription ?? null, postedAt: j.pubDate ?? null, raw: j }));
  },
});

export const himalayas = withQuery({
  name: "himalayas", description: "Himalayas remote jobs API (global remote).",
  async search(q, ctx) {
    const data = await ctx.fetchJson(`https://himalayas.app/jobs/api?limit=${Math.min(q.limit ?? 50, 100)}`);
    return (data.jobs ?? []).filter((j: any) => !q.keywords || kw(q.keywords, `${j.title} ${j.description ?? ""}`))
      .map((j: any): RawJob => ({ externalId: j.guid ?? j.applicationLink ?? j.title, title: j.title, company: j.companyName, url: j.applicationLink ?? j.guid,
        location: j.locationRestrictions?.join(", ") || "Remote", remote: true, employmentType: j.employmentType ?? null,
        salaryMin: j.minSalary ?? null, salaryMax: j.maxSalary ?? null, salaryCurrency: j.currency ?? null,
        descriptionHtml: j.description ?? null, postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null, raw: j }));
  },
});

export const jooble = withQuery({
  name: "jooble", description: "Jooble aggregator API (70 countries, needs JOOBLE_API_KEY).", kind: "aggregator", requires: ["JOOBLE_API_KEY"],
  async search(q, ctx) {
    const key = process.env.JOOBLE_API_KEY; if (!key) throw new Error("JOOBLE_API_KEY not set (free at https://jooble.org/api/about)");
    const out: RawJob[] = [];
    for (let page = 1; out.length < (q.limit ?? 50); page++) {
      const data = await ctx.fetchJson(`https://jooble.org/api/${key}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ keywords: q.keywords, location: q.location ?? "", page, ...(q.postedWithin && q.postedWithin !== "any" ? { datecreatedfrom: since(q.postedWithin) } : {}) }) });
      for (const j of data.jobs ?? []) out.push({ externalId: String(j.id), title: j.title, company: j.company || "Unknown", url: j.link, location: j.location ?? null,
        employmentType: j.type || null, descriptionText: j.snippet ?? null, postedAt: j.updated ?? null, raw: j });
      if (!data.jobs?.length) break;
    }
    return out.slice(0, q.limit ?? 50);
  },
});

export const usajobs = withQuery({
  name: "usajobs", description: "USAJOBS federal jobs API (needs USAJOBS_API_KEY + USAJOBS_EMAIL).", requires: ["USAJOBS_API_KEY", "USAJOBS_EMAIL"],
  async search(q, ctx) {
    const key = process.env.USAJOBS_API_KEY, email = process.env.USAJOBS_EMAIL;
    if (!key || !email) throw new Error("USAJOBS_API_KEY / USAJOBS_EMAIL not set (https://developer.usajobs.gov)");
    const p = new URLSearchParams({ Keyword: q.keywords, ResultsPerPage: String(Math.min(q.limit ?? 50, 500)) });
    if (q.location) p.set("LocationName", q.location);
    const data = await ctx.fetchJson(`https://data.usajobs.gov/api/search?${p}`, { headers: { "Authorization-Key": key, "User-Agent": email, Host: "data.usajobs.gov" } });
    return (data.SearchResult?.SearchResultItems ?? []).map(({ MatchedObjectDescriptor: d, MatchedObjectId: id }: any): RawJob => ({
      externalId: id, title: d.PositionTitle, company: d.OrganizationName, url: d.PositionURI, location: d.PositionLocationDisplay ?? null, country: "US",
      salaryMin: Number(d.PositionRemuneration?.[0]?.MinimumRange) || null, salaryMax: Number(d.PositionRemuneration?.[0]?.MaximumRange) || null, salaryCurrency: "USD",
      descriptionText: d.UserArea?.Details?.JobSummary ?? null, postedAt: d.PublicationStartDate ?? null, raw: d }));
  },
});

function kw(keywords: string, text: string) {
  const t = text.toLowerCase();
  return keywords.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w));
}
function since(w: string) {
  const d = { "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 }[w as "24h"] ?? 30;
  return new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
}

/** Google for Jobs via SerpAPI: aggregates LinkedIn/Indeed/Glassdoor/company postings per country, legally, with a key (free tier: 100 searches/month). */
export const googlejobs = withQuery({
  name: "googlejobs", description: "Google for Jobs via SerpAPI (needs SERPAPI_KEY). Aggregates the big boards per country; great fallback when Indeed/Glassdoor block.", kind: "aggregator", requires: ["SERPAPI_KEY"],
  async search(q, ctx) {
    const key = process.env.SERPAPI_KEY; if (!key) throw new Error("SERPAPI_KEY not set (https://serpapi.com)");
    const out: RawJob[] = [];
    let token: string | undefined;
    for (let page = 0; page < Math.ceil((q.limit ?? 30) / 10); page++) {
      const p = new URLSearchParams({ engine: "google_jobs", api_key: key, q: q.keywords, hl: "en" });
      if (q.location) p.set("location", q.location);
      if (q.country) p.set("gl", q.country.toLowerCase());
      const chips: string[] = [];
      const d = ({ "24h": "today", "3d": "3days", "7d": "week", "14d": "week", "30d": "month" } as Record<string, string>)[q.postedWithin ?? ""];
      if (d) chips.push(`date_posted:${d}`);
      if (q.jobType && q.jobType !== "any") chips.push(`employment_type:${{ fulltime: "FULLTIME", parttime: "PARTTIME", contract: "CONTRACTOR", internship: "INTERN" }[q.jobType]}`);
      if (chips.length) p.set("chips", chips.join(","));
      if (q.remote === "remote") p.set("ltype", "1");
      if (token) p.set("next_page_token", token);
      const data = await ctx.fetchJson(`https://serpapi.com/search.json?${p}`);
      for (const j of data.jobs_results ?? []) out.push({
        externalId: j.job_id, title: j.title, company: j.company_name ?? "Unknown", url: j.apply_options?.[0]?.link ?? j.share_link ?? `https://www.google.com/search?q=${encodeURIComponent(j.title + " " + j.company_name)}&ibp=htl;jobs`,
        location: j.location ?? null, remote: j.detected_extensions?.work_from_home ?? null, employmentType: j.detected_extensions?.schedule_type ?? null,
        descriptionText: j.description ?? null, department: j.via ?? null, postedAt: null, raw: j,
      });
      token = data.serpapi_pagination?.next_page_token;
      if (!token || !data.jobs_results?.length) break;
    }
    return out.slice(0, q.limit ?? 30);
  },
});
