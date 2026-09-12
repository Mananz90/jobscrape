import type { SourceAdapter, RawJob } from "../types.ts";

/**
 * Workday (used by most large enterprises, all of big pharma). Each tenant has its own host + site path, so the key is
 * "host|tenant|site", e.g. "gsk.wd5|gsk|GSKCareers", or a name from the registry below. `detect` recognises
 * https://<tenant>.wd<N>.myworkdayjobs.com/<site> career URLs. Supports options.query.keywords for tenant-side search.
 */
export const WORKDAY_REGISTRY: Record<string, string> = {
  // verified 2026-09-12
  gsk: "gsk.wd5|gsk|GSKCareers", novartis: "novartis.wd3|novartis|Novartis_Careers", astrazeneca: "astrazeneca.wd3|astrazeneca|Careers",
  roche: "roche.wd3|roche|roche-ext", sanofi: "sanofi.wd3|sanofi|SanofiCareers", pfizer: "pfizer.wd1|pfizer|PfizerCareers", iqvia: "iqvia.wd1|iqvia|IQVIA",
  msd: "msd.wd5|msd|SearchJobs", merck: "msd.wd5|msd|SearchJobs", bms: "bristolmyerssquibb.wd5|bristolmyerssquibb|BMS", bristolmyerssquibb: "bristolmyerssquibb.wd5|bristolmyerssquibb|BMS",
  biogen: "biibhr.wd3|biibhr|external", moderna: "modernatx.wd1|modernatx|M_tx", takeda: "takeda.wd502|takeda|external",
};

function parseKey(key: string): { host: string; tenant: string; site: string } {
  const k = WORKDAY_REGISTRY[key.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? key;
  const [host, tenant, site] = k.split("|");
  if (!host || !tenant || !site) throw new Error(`workday key must be "host|tenant|site" (e.g. gsk.wd5|gsk|GSKCareers) or one of: ${Object.keys(WORKDAY_REGISTRY).join(", ")}`);
  return { host, tenant, site };
}

export const workday: SourceAdapter = {
  name: "workday", kind: "ats", keyKind: "slug",
  description: "Workday tenant search API. key = 'host|tenant|site' (gsk.wd5|gsk|GSKCareers) or a registry name (gsk, novartis, astrazeneca, bayer, roche, ...).",
  detect: (url) => { const m = url.match(/https?:\/\/([a-z0-9-]+\.wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/); return m ? `${m[1]}|${m[1].split(".")[0]}|${m[2]}` : null; },
  async fetchJobs(cfg, ctx) {
    const { host, tenant, site } = parseKey(cfg.key);
    const url = `https://${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
    const searchText = String((cfg.options?.query as any)?.keywords ?? cfg.options?.searchText ?? "");
    const max = Number(cfg.options?.maxJobs ?? 400);
    const out: RawJob[] = [];
    let total = Infinity; // Workday reports `total` on the first page only
    for (let offset = 0; offset < max && offset < total; offset += 20) {
      const data = await ctx.fetchJson(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }) });
      if (offset === 0 && Number.isFinite(Number(data.total)) && data.total > 0) total = data.total;
      const posts: any[] = data.jobPostings ?? [];
      for (const j of posts) {
        const path = j.externalPath ?? "";
        out.push({ externalId: path.split("/").pop() ?? path, title: j.title, company: cfg.company ?? cfg.key, url: `https://${host}.myworkdayjobs.com/en-US/${site}${path}`,
          location: j.locationsText ?? null, descriptionText: (j.bulletFields ?? []).join(" · ") || null, postedAt: relDate(j.postedOn), raw: j });
      }
      if (!posts.length) break;
    }
    return out;
  },
};

/** Relative → absolute date, rounded to the day so re-scrapes do not look like changes. */
function relDate(t?: string): string | null {
  if (!t) return null;
  const day = (n: number) => { const d = new Date(Date.now() - n * 864e5); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
  if (/today|just posted/i.test(t)) return day(0);
  if (/yesterday/i.test(t)) return day(1);
  const m = t.match(/(\d+)\+?\s*day/i);
  return m ? day(Number(m[1])) : null;
}
