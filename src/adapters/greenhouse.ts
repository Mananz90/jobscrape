import type { SourceAdapter } from "../types.ts";
export const greenhouse: SourceAdapter = {
  name: "greenhouse",
  description: "Greenhouse Job Board API (public, no key). key = board token, e.g. 'stripe'.",
  keyKind: "slug",
  detect: (_url, html) => html.match(/boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board\?for=)([a-z0-9_-]+)/i)?.[1]
    ?? html.match(/job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    const data = await ctx.fetchJson(`https://boards-api.greenhouse.io/v1/boards/${cfg.key}/jobs?content=true`);
    return (data.jobs ?? []).map((j: any) => ({
      externalId: String(j.id),
      title: j.title,
      company: cfg.company ?? cfg.key,
      url: j.absolute_url,
      location: j.location?.name ?? null,
      department: j.departments?.[0]?.name ?? null,
      descriptionHtml: j.content ? decodeEntities(j.content) : null,
      postedAt: j.updated_at ?? j.first_published ?? null,
      raw: j,
    }));
  },
};
function decodeEntities(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
