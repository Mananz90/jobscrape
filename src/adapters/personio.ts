// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import type { SourceAdapter } from "../types.ts";
import * as cheerio from "cheerio";
export const personio: SourceAdapter = {
  name: "personio",
  description: "Personio XML feed (public). key = company subdomain (company.jobs.personio.de).",
  keyKind: "slug",
  detect: (_url, html) => html.match(/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i)?.[1] ?? null,
  async fetchJobs(cfg, ctx) {
    const xml = await ctx.fetchText(`https://${cfg.key}.jobs.personio.de/xml?language=en`);
    const $ = cheerio.load(xml, { xml: true });
    return $("position").map((_, el) => {
      const g = (t: string) => $(el).children(t).first().text().trim() || null;
      return {
        externalId: g("id")!,
        title: g("name")!,
        company: cfg.company ?? cfg.key,
        url: `https://${cfg.key}.jobs.personio.de/job/${g("id")}`,
        location: g("office"),
        department: g("department"),
        employmentType: g("employmentType"),
        descriptionHtml: $(el).find("jobDescription").map((_, d) => `<h3>${$(d).children("name").text()}</h3>${$(d).children("value").text()}`).get().join("\n") || null,
        postedAt: g("createdAt"),
      };
    }).get();
  },
};
