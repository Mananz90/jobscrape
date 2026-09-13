// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { Job, RawJob } from "./types.ts";

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|distributed)\b/i;
const COUNTRY_MAP: Record<string, string> = {
  "united states": "US", usa: "US", us: "US", "united kingdom": "GB", uk: "GB", england: "GB",
  germany: "DE", deutschland: "DE", france: "FR", india: "IN", canada: "CA", australia: "AU",
  netherlands: "NL", spain: "ES", italy: "IT", ireland: "IE", switzerland: "CH", austria: "AT",
  sweden: "SE", poland: "PL", portugal: "PT", singapore: "SG", japan: "JP", brazil: "BR",
  mexico: "MX", israel: "IL", uae: "AE", "united arab emirates": "AE",
};
const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));

export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  $("script,style").remove();
  return $.root().text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim() || null;
}

export function parseLocation(loc: string | null | undefined) {
  if (!loc) return { city: null, country: null, remote: null as boolean | null };
  const remote = REMOTE_RE.test(loc) ? true : null;
  const parts = loc.split(/[,\/|·•]/).map((s) => s.trim()).filter(Boolean);
  let country: string | null = null;
  let city: string | null = null;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (COUNTRY_MAP[lower]) country = COUNTRY_MAP[lower];
    else if (/^[A-Z]{2}$/.test(p) && US_STATES.has(p)) country = "US";
    else if (!city && !REMOTE_RE.test(p)) city = p;
  }
  return { city, country, remote };
}

export function normalizeEmploymentType(t: string | null | undefined): string | null {
  if (!t) return null;
  const s = t.toLowerCase();
  if (/full/.test(s)) return "FULL_TIME";
  if (/part/.test(s)) return "PART_TIME";
  if (/intern/.test(s)) return "INTERN";
  if (/contract|freelance|temporary/.test(s)) return "CONTRACT";
  return t.toUpperCase().replace(/[^A-Z]+/g, "_");
}

/** Content fingerprint used for cross-source dedup (same job on board + career page). */
export function fingerprint(j: Pick<Job, "title" | "company" | "location">): string {
  const key = [j.company, j.title, j.location ?? ""].map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export function normalize(raw: RawJob, source: string, sourceKey: string): Job {
  const loc = parseLocation(raw.location);
  const descriptionHtml = raw.descriptionHtml ?? null;
  return {
    id: `${source}:${sourceKey}:${raw.externalId}`,
    source,
    sourceKey,
    externalId: String(raw.externalId),
    title: raw.title.trim(),
    company: raw.company.trim(),
    url: raw.url,
    location: raw.location?.trim() ?? null,
    city: raw.city ?? loc.city,
    country: raw.country ?? loc.country,
    remote: raw.remote ?? loc.remote,
    employmentType: normalizeEmploymentType(raw.employmentType),
    department: raw.department ?? null,
    salaryMin: raw.salaryMin ?? null,
    salaryMax: raw.salaryMax ?? null,
    salaryCurrency: raw.salaryCurrency ?? null,
    descriptionHtml,
    descriptionText: raw.descriptionText ?? htmlToText(descriptionHtml),
    postedAt: raw.postedAt ? new Date(raw.postedAt).toISOString() : null,
    raw: raw.raw,
  };
}
