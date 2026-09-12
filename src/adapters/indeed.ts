import type { SourceAdapter, SearchQuery, RawJob } from "../types.ts";
import { HttpError } from "../http.ts";
import { presets, runActor, mapActorItem } from "./apify.ts";

/**
 * Indeed. Tier 1: direct fetch of the search page and parse the embedded JSON (works from some networks,
 * often blocked by Cloudflare with 403). Tier 2: Apify actor when APIFY_TOKEN is set.
 */
const DOMAIN: Record<string, string> = { us: "www.indeed.com", gb: "uk.indeed.com", uk: "uk.indeed.com", de: "de.indeed.com", fr: "fr.indeed.com", in: "in.indeed.com",
  ca: "ca.indeed.com", au: "au.indeed.com", nl: "nl.indeed.com", es: "es.indeed.com", it: "it.indeed.com", ie: "ie.indeed.com", ch: "ch.indeed.com", at: "at.indeed.com",
  sg: "sg.indeed.com", ae: "ae.indeed.com", se: "se.indeed.com", pl: "pl.indeed.com", pt: "pt.indeed.com", br: "br.indeed.com", mx: "mx.indeed.com", jp: "jp.indeed.com" };
const JT: Record<string, string> = { fulltime: "fulltime", parttime: "parttime", contract: "contract", internship: "internship" };

export const indeed: SourceAdapter = {
  name: "indeed",
  description: "Indeed search. Direct fetch first (often blocked), then Apify actor fallback if APIFY_TOKEN is set.",
  kind: "board",
  keyKind: "none",
  async search(q, ctx) {
    const host = DOMAIN[(q.country ?? "us").toLowerCase()] ?? "www.indeed.com";
    const limit = Math.min(q.limit ?? 50, 150);
    const out: RawJob[] = [];
    try {
      for (let start = 0; start < limit; start += 10) {
        const p = new URLSearchParams({ q: q.keywords, start: String(start) });
        if (q.location) p.set("l", q.location);
        const d = ({ "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 } as Record<string, number>)[q.postedWithin ?? ""];
        if (d) p.set("fromage", String(d));
        if (q.jobType && JT[q.jobType]) p.set("jt", JT[q.jobType]);
        if (q.remote === "remote") p.set("remotejob", "032b3046-06a3-4876-8dfd-474eb5e7ed11");
        const html = await ctx.fetchText(`https://${host}/jobs?${p}`);
        const m = html.match(/window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*(\{.*?\});\s*\n/s) ?? html.match(/"mosaic-provider-jobcards":(\{.*?\}),"mosaic-provider-/s);
        if (!m) { if (/captcha|cf-chl|Just a moment|Additional Verification/i.test(html)) throw new HttpError(403, host); break; }
        const results = JSON.parse(m[1])?.metaData?.mosaicProviderJobCardsModel?.results ?? [];
        if (!results.length) break;
        for (const r of results) out.push({
          externalId: r.jobkey, title: r.title, company: r.company ?? "Unknown", url: `https://${host}/viewjob?jk=${r.jobkey}`,
          location: r.formattedLocation ?? null, remote: r.remoteLocation ?? null,
          salaryMin: r.extractedSalary?.min ?? null, salaryMax: r.extractedSalary?.max ?? null,
          descriptionText: r.snippet?.replace(/<[^>]+>/g, " ") ?? null,
          postedAt: r.pubDate ? new Date(r.pubDate).toISOString() : null, raw: r,
        });
        if (results.length < 10) break;
      }
      if (out.length) return out.slice(0, limit);
    } catch (e) {
      const blocked = e instanceof HttpError && (e.status === 403 || e.status === 429);
      ctx.log(`direct Indeed fetch ${blocked ? "blocked" : "failed"}: ${(e as Error).message}`);
      if (!blocked && !process.env.APIFY_TOKEN) throw e;
    }
    if (!process.env.APIFY_TOKEN) throw new Error("Indeed blocks direct scraping from this network. Set APIFY_TOKEN to use the Apify fallback, or use Adzuna/LinkedIn instead.");
    const items = await runActor(presets.indeed.actor, presets.indeed.input(q), ctx);
    return items.map((it) => mapActorItem(it, "indeed")).filter((x): x is RawJob => !!x);
  },
  async fetchJobs(cfg, ctx) {
    const q = cfg.options?.query as SearchQuery | undefined;
    if (!q) throw new Error("indeed needs options.query");
    return indeed.search!(q, ctx);
  },
};
