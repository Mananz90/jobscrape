import * as cheerio from "cheerio";
import type { SourceAdapter, RawJob } from "../types.ts";
import { renderWithBrowser } from "../http.ts";

/**
 * Generic fallback for career pages with no known ATS:
 *  1. Fetch the page (optionally via headless browser when options.render = true).
 *  2. Extract schema.org JobPosting JSON-LD blocks (the single most reliable generic signal).
 *  3. Otherwise follow links that look like job detail pages (limited crawl) and parse JSON-LD there.
 *  4. Also try /sitemap.xml for job-like URLs.
 */
export const careerpage: SourceAdapter = {
  name: "careerpage",
  description: "Generic career page: JSON-LD JobPosting extraction + shallow crawl. key = careers URL. options.render=true uses Playwright.",
  keyKind: "url",
  async fetchJobs(cfg, ctx) {
    const base = new URL(cfg.key);
    const company = cfg.company ?? base.hostname.replace(/^www\./, "").split(".")[0];
    const maxPages = Number(cfg.options?.maxPages ?? 40);
    const render = cfg.options?.render === true;
    const load = async (u: string) => (render ? renderWithBrowser(u) : ctx.fetchText(u));

    const seen = new Set<string>();
    const jobs = new Map<string, RawJob>();
    const queue: string[] = [cfg.key];

    // Seed queue with sitemap URLs that look like jobs.
    try {
      const sm = await ctx.fetchText(`${base.origin}/sitemap.xml`);
      const $ = cheerio.load(sm, { xml: true });
      $("loc").each((_, el) => {
        const u = $(el).text().trim();
        // Only same-section URLs, and only job-looking ones; they go to the back of the queue (crawl links first).
        if (u.startsWith(base.origin + base.pathname) && /job|career|position|opening|vacanc/i.test(u)) queue.push(u);
      });
    } catch { /* no sitemap */ }

    while (queue.length && seen.size < maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      let html: string;
      try { html = await load(url); } catch (e) { ctx.log(`skip ${url}: ${(e as Error).message}`); continue; }
      const $ = cheerio.load(html);
      const found = extractJsonLd($);
      if (process.env.JOBSCRAPE_DEBUG) ctx.log(`visited ${url} (${html.length} bytes, ${found.length} JobPosting, queue=${queue.length})`);

      for (const jp of found) {
        const id = jp.identifier?.value ?? jp.identifier?.name ?? jp.url ?? url;
        const loc = jp.jobLocation?.[0]?.address ?? jp.jobLocation?.address;
        jobs.set(String(id), {
          externalId: String(id), title: jp.title, company: jp.hiringOrganization?.name ?? company, url: jp.url ?? url,
          location: loc ? [loc.addressLocality, loc.addressRegion, loc.addressCountry].filter(Boolean).join(", ") : null,
          country: typeof loc?.addressCountry === "string" && loc.addressCountry.length === 2 ? loc.addressCountry : null,
          remote: jp.jobLocationType === "TELECOMMUTE" ? true : null,
          employmentType: Array.isArray(jp.employmentType) ? jp.employmentType[0] : jp.employmentType ?? null,
          salaryMin: jp.baseSalary?.value?.minValue ?? null, salaryMax: jp.baseSalary?.value?.maxValue ?? null, salaryCurrency: jp.baseSalary?.currency ?? null,
          descriptionHtml: jp.description ?? null, postedAt: jp.datePosted ?? null, raw: jp,
        });
      }

      // Shallow crawl: same-host links that look like job listings.
      if (url === cfg.key) {
        const found: string[] = [];
        $("a[href]").each((_, a) => {
          try {
            const u = new URL($(a).attr("href")!, url);
            u.search = ""; u.hash = ""; // filter/sort variants of the listing page are not new jobs
            if (u.host === base.host && u.href !== url && /job|career|position|opening|vacanc/i.test(u.href) && !seen.has(u.href)) found.push(u.href);
          } catch { /* ignore */ }
        });
        // Deeper paths (detail pages) first; links from the careers page itself take priority over sitemap seeds.
        queue.unshift(...[...new Set(found)].sort((a, b) => b.split("/").length - a.split("/").length));
      }
    }
    ctx.log(`crawled ${seen.size} page(s), found ${jobs.size} JobPosting record(s)`);
    return [...jobs.values()];
  },
};

function extractJsonLd($: cheerio.CheerioAPI): any[] {
  const out: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : data["@graph"] ?? [data];
      for (const it of items) if (it?.["@type"] === "JobPosting" || (Array.isArray(it?.["@type"]) && it["@type"].includes("JobPosting"))) out.push(it);
    } catch { /* malformed */ }
  });
  return out;
}
