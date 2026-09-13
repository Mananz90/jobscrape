// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import type { SourceAdapter } from "../types.ts";
export const workable: SourceAdapter = {
  name: "workable",
  description: "Workable public widget API. key = account subdomain, e.g. 'acme' for acme.workable.com.",
  keyKind: "slug",
  detect: (_url, html) => html.match(/apply\.workable\.com\/([a-z0-9_-]+)/i)?.[1] ?? html.match(/([a-z0-9_-]+)\.workable\.com/i)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    const data = await ctx.fetchJson(`https://www.workable.com/api/accounts/${cfg.key}?details=true`);
    return (data.jobs ?? []).map((j: any) => ({
      externalId: j.shortcode,
      title: j.title,
      company: cfg.company ?? data.name ?? cfg.key,
      url: j.url,
      location: [j.city, j.state, j.country].filter(Boolean).join(", ") || null,
      country: j.country_code ?? null,
      city: j.city ?? null,
      remote: j.telecommuting ?? null,
      employmentType: j.employment_type ?? null,
      department: j.department ?? null,
      descriptionHtml: j.description ?? null,
      postedAt: j.published_on ?? j.created_at ?? null,
      raw: j,
    }));
  },
};
