// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { adapters } from "./adapters/index.ts";
import { request, makeContext } from "./http.ts";
import type { SourceConfig } from "./types.ts";

/**
 * Given a company careers URL, figure out which ATS backs it and return a ready SourceConfig.
 *  1. Look for ATS fingerprints (embed scripts, links, API calls) in the served HTML.
 *  2. Probe public ATS APIs with a slug guessed from the domain (many custom career sites proxy an ATS but hide it).
 *  3. Fall back to the generic career page crawler, enabling headless rendering if the page looks like an empty SPA shell.
 */
export async function detectSource(careersUrl: string): Promise<SourceConfig> {
  const company = guessCompany(careersUrl);
  const slug = company.toLowerCase();
  let html = "";
  let finalUrl = careersUrl;
  try {
    const res = await request(careersUrl, { redirect: "follow" });
    finalUrl = res.url || careersUrl;
    html = await res.text();
  } catch (e) {
    console.error(`could not fetch ${careersUrl}: ${(e as Error).message}`);
  }
  const haystack = `${finalUrl}\n${html}`;
  for (const a of Object.values(adapters)) {
    const key = a.detect?.(finalUrl, haystack);
    if (key) return { adapter: a.name, key, company };
  }

  // Slug probing: cheap and surprisingly effective.
  const ctx = { ...makeContext("detect"), log: () => {} };
  for (const name of ["greenhouse", "lever", "ashby", "workable", "recruitee", "smartrecruiters", "personio"]) {
    try {
      const jobs = await adapters[name].fetchJobs({ adapter: name, key: slug, company }, ctx);
      if (jobs.length) return { adapter: name, key: slug, company };
    } catch { /* not this one */ }
  }

  const spaShell = /<div id="(root|app|__next)">\s*<\/div>|<app-root>/.test(html) && !/JobPosting/.test(html);
  return { adapter: "careerpage", key: careersUrl, company, options: { render: spaShell } };
}

function guessCompany(u: string) {
  const h = new URL(u).hostname.replace(/^(www|careers|jobs|boards|apply)\./, "");
  const name = h.split(".")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}
