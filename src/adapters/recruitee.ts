import type { SourceAdapter } from "../types.ts";
export const recruitee: SourceAdapter = {
  name: "recruitee",
  description: "Recruitee public offers API. key = company subdomain (company.recruitee.com).",
  keyKind: "slug",
  detect: (_url, html) => html.match(/([a-z0-9-]+)\.recruitee\.com/i)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    const data = await ctx.fetchJson(`https://${cfg.key}.recruitee.com/api/offers/`);
    return (data.offers ?? []).map((j: any) => ({
      externalId: String(j.id),
      title: j.title,
      company: cfg.company ?? j.company_name ?? cfg.key,
      url: j.careers_url,
      location: j.location ?? null,
      city: j.city ?? null,
      country: j.country_code ?? null,
      remote: j.remote ?? null,
      employmentType: j.employment_type_code ?? null,
      department: j.department ?? null,
      descriptionHtml: [j.description, j.requirements].filter(Boolean).join("\n") || null,
      postedAt: j.published_at ?? j.created_at ?? null,
      raw: j,
    }));
  },
};
