// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import type { SourceAdapter } from "../types.ts";
export const lever: SourceAdapter = {
  name: "lever",
  description: "Lever Postings API (public). key = company slug, e.g. 'netflix'.",
  keyKind: "slug",
  detect: (_url, html) => html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i)?.[1] ?? html.match(/api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    // Page through the feed: a whole-board response with descriptions can exceed 10 MB and Lever streams it slowly.
    let pageSize = Number(cfg.options?.pageSize ?? 100);
    const max = Number(cfg.options?.maxJobs ?? 2000);
    const out: any[] = [];
    for (let skip = 0; skip < max; skip += pageSize) {
      let data: any[];
      try { data = await ctx.fetchJson(`https://api.lever.co/v0/postings/${cfg.key}?mode=json&skip=${skip}&limit=${pageSize}`); }
      catch (e) {
        // Lever sometimes streams very slowly; smaller pages get through where large ones time out.
        if (/timed out|timeout/i.test((e as Error).message) && pageSize > 10) { pageSize = Math.max(10, Math.floor(pageSize / 2)); ctx.log(`slow response, retrying with ${pageSize} jobs per page`); skip -= pageSize; continue; }
        throw e;
      }
      for (const j of data) out.push({
        externalId: j.id,
        title: j.text,
        company: cfg.company ?? cfg.key,
        url: j.hostedUrl,
        location: j.categories?.location ?? null,
        department: j.categories?.team ?? j.categories?.department ?? null,
        employmentType: j.categories?.commitment ?? null,
        remote: j.workplaceType === "remote" ? true : j.workplaceType ? false : null,
        descriptionHtml: j.description ?? null,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        raw: j,
      });
      if (data.length < pageSize) break;
    }
    return out;
  },
};
