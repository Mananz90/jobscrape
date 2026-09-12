import type { SourceAdapter } from "../types.ts";
export const ashby: SourceAdapter = {
  name: "ashby",
  description: "Ashby public job board API. key = org slug, e.g. 'openai'.",
  keyKind: "slug",
  detect: (_url, html) => html.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    const data = await ctx.fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${cfg.key}?includeCompensation=true`);
    return (data.jobs ?? []).map((j: any) => ({
      externalId: j.id,
      title: j.title,
      company: cfg.company ?? cfg.key,
      url: j.jobUrl,
      location: j.location ?? null,
      department: j.department ?? null,
      employmentType: j.employmentType ?? null,
      remote: j.isRemote ?? null,
      descriptionHtml: j.descriptionHtml ?? null,
      postedAt: j.publishedAt ?? null,
      salaryMin: j.compensation?.compensationTierSummary ? undefined : null,
      raw: j,
    }));
  },
};
