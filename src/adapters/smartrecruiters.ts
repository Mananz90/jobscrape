// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import type { SourceAdapter, RawJob } from "../types.ts";
export const smartrecruiters: SourceAdapter = {
  name: "smartrecruiters",
  description: "SmartRecruiters Posting API (public). key = company identifier, e.g. 'Bosch'.",
  keyKind: "slug",
  detect: (_url, html) => html.match(/jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    const out: RawJob[] = [];
    const maxPages = Number(cfg.options?.maxPages ?? 50);
    for (let offset = 0; offset < maxPages * 100; offset += 100) {
      const data = await ctx.fetchJson(`https://api.smartrecruiters.com/v1/companies/${cfg.key}/postings?limit=100&offset=${offset}`);
      for (const j of data.content ?? []) {
        out.push({
          externalId: j.id,
          title: j.name,
          company: cfg.company ?? j.company?.name ?? cfg.key,
          url: `https://jobs.smartrecruiters.com/${cfg.key}/${j.id}`,
          location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", ") || null,
          city: j.location?.city ?? null,
          country: j.location?.country?.toUpperCase?.() ?? null,
          remote: j.location?.remote ?? null,
          employmentType: j.typeOfEmployment?.label ?? null,
          department: j.department?.label ?? null,
          postedAt: j.releasedDate ?? null,
          raw: j,
        });
      }
      if (!data.content?.length || out.length >= (data.totalFound ?? 0)) break;
    }
    return out;
  },
};
