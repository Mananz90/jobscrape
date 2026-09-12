import * as cheerio from "cheerio";
import type { SourceAdapter, SearchQuery, RawJob } from "../types.ts";
import { scrapling, scraplingAvailable } from "../scrapling.ts";
import { GLASSDOOR_HOSTS } from "../regions.ts";
import { glassdoorBrowser } from "./browser-boards.ts";

/**
 * Headless Glassdoor powered by the Scrapling sidecar (Python). Measured on glassdoor.de, Sept 2026: plain HTTP with a real
 * browser TLS/HTTP2 fingerprint (curl_cffi "chrome" impersonation) gets the listing page with status 200 and 30 cards, no
 * browser, no challenge, about one second per page. The visible-window `glassdoor-browser` stays as the fallback.
 *
 * Indeed is deliberately NOT here: its Cloudflare check blocks every headless path, and the only headless route Scrapling
 * offers is automating the "verify you are human" step, which this project does not do. Use `indeed-browser` (visible window).
 */
const days = (q: SearchQuery) => ({ "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 } as Record<string, number>)[q.postedWithin ?? ""];
const rel = (t: string | null | undefined) => {
  const m = t?.match(/(\d+)\+?\s*(day|tag|jour|día|dag|giorn|d\b)/i);
  if (!m) return /today|heute|just posted|gerade|aujourd|24 ?h/i.test(t ?? "") ? (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); })() : null;
  return (() => { const d = new Date(Date.now() - Number(m[1]) * 864e5); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); })();
};
// Scrapling returns non-HTML bodies wrapped in <html><body>…</body></html>; pull the JSON array/object back out.
const safeJson = (s?: string) => { try { const m = s?.match(/[\[{][\s\S]*[\]}]/); return m ? JSON.parse(m[0]) : null; } catch { return null; } };

export const glassdoorScrapling: SourceAdapter = {
  name: "glassdoor", kind: "board", keyKind: "none",
  description: "Glassdoor, headless via Scrapling HTTP (browser TLS fingerprint, no browser window). Country edition + city via Glassdoor's own location lookup. Needs scrapling/.venv.",
  async search(q, ctx) {
    if (!scraplingAvailable()) throw new Error("Scrapling sidecar not installed: run `npm run setup:scrapling`");
    const host = GLASSDOOR_HOSTS()[(q.country ?? "US").toUpperCase()] ?? "www.glassdoor.com";
    const limit = Math.min(q.limit ?? 50, 150);
    const p = new URLSearchParams({ "sc.keyword": q.keywords });
    if (days(q)) p.set("fromAge", String(days(q)));
    if (q.remote === "remote") p.set("remoteWorkType", "1");

    // Resolve city → locId with the site's autocomplete, then fetch the listing.
    const city = q.location?.split(",")[0]?.trim();
    if (city && !/^(germany|deutschland|united states|united kingdom|india|france|netherlands|canada|australia|switzerland|austria)$/i.test(city)) {
      const [ac] = await scrapling({ mode: "http", urls: [`https://${host}/autocomplete/location?locationTypeFilters=CITY,STATE,COUNTRY&caller=jobs&term=${encodeURIComponent(city)}`], timeout_ms: 30_000 });
      const loc = safeJson(ac?.html)?.[0];
      if (loc?.locationId) { p.set("locT", loc.locationType ?? "C"); p.set("locId", String(loc.locationId)); ctx.log(`location "${city}" → ${loc.longName ?? loc.locationName}`); }
      else ctx.log(`location "${city}" not found; country-wide results`);
    }
    const [first] = await scrapling({ mode: "http", urls: [`https://${host}/Job/jobs.htm?${p}`], timeout_ms: 45_000 });
    if (!first || (first.status ?? 500) >= 400) {
      // Glassdoor starts challenging an address after heavy use. The visible-window source carries the saved clearance
      // cookie and usually still passes; hand over to it rather than failing the search.
      if ((first?.status === 403 || first?.status === 429) && process.env.JOBSCRAPE_GLASSDOOR_FALLBACK !== "0") {
        ctx.log(`${host} answered ${first.status} on the HTTP path; falling back to the browser source`);
        return glassdoorBrowser.search!(q, ctx);
      }
      throw new Error(`${host} returned ${first?.status ?? "no response"} (${first?.title ?? ""})`);
    }

    const out = new Map<string, RawJob>();
    const parse = (html: string) => {
      const $ = cheerio.load(html);
      $("li[data-jobid], li[data-test='jobListing']").each((_, li) => {
        const c = $(li); const a = c.find("a[data-test='job-title'], a[data-test='job-link']").first();
        const id = c.attr("data-jobid") ?? a.attr("href")?.match(/jl=(\d+)/)?.[1]; const title = a.text().trim();
        if (!id || !title || out.has(id)) return;
        const href = a.attr("href"); const salary = c.find("[data-test='detailSalary'], [class*='salaryEstimate']").text().trim();
        out.set(id, {
          externalId: id, title,
          company: (c.find("[class*='EmployerProfile_compactEmployerName'], [data-test='employer-name'], [class*='employerName']").first().text().trim().replace(/\s*\d[.,]\d\s*$/, "") || "Unknown"),
          url: href ? new URL(href, `https://${host}`).href : `https://${host}/job-listing/j?jl=${id}`,
          location: c.find("[data-test='emp-location'], [class*='JobCard_location']").first().text().trim() || null,
          country: (q.country ?? "US").toUpperCase(), // regional edition implies the country even when the card shows a bare city
          descriptionText: [c.find("[class*='jobDescriptionSnippet']").text().trim(), salary ? `Salary: ${salary}` : ""].filter(Boolean).join("\n") || null,
          postedAt: rel(c.find("[class*='listingAge'], [data-test='job-age']").text()), raw: { source: "glassdoor-scrapling" },
        });
      });
    };
    parse(first.html ?? "");
    // Pagination: Glassdoor's canonical listing URL takes _IP<n> before .htm.
    const canon = first.final_url?.split("?")[0] ?? "";
    for (let n = 2; out.size < limit && canon.endsWith(".htm") && n <= 6; n++) {
      const before = out.size;
      const [pg] = await scrapling({ mode: "http", urls: [canon.replace(/(_IP\d+)?\.htm$/, `_IP${n}.htm`)], timeout_ms: 45_000 });
      if (!pg?.html || (pg.status ?? 500) >= 400) break;
      parse(pg.html);
      if (out.size === before) break;
    }
    ctx.log(`${out.size} jobs from ${host}`);
    return [...out.values()].slice(0, limit);
  },
  async fetchJobs(cfg, ctx) { const q = cfg.options?.query as SearchQuery | undefined; if (!q) throw new Error("glassdoor needs options.query"); return glassdoorScrapling.search!(q, ctx); },
};
