// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
/** Canonical job record every adapter must produce. */
export interface Job {
  /** Stable id: `${source}:${externalId}` */
  id: string;
  source: string;          // adapter name, e.g. "greenhouse"
  sourceKey: string;       // company slug / board identifier within the adapter
  externalId: string;      // id assigned by the origin system
  title: string;
  company: string;
  url: string;             // canonical apply / detail URL
  location: string | null; // raw location text
  city: string | null;
  country: string | null;  // ISO-3166 alpha-2 where derivable
  remote: boolean | null;  // null = unknown
  employmentType: string | null; // FULL_TIME, PART_TIME, CONTRACT, INTERN, ...
  department: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  descriptionHtml: string | null;
  descriptionText: string | null;
  postedAt: string | null; // ISO-8601
  raw?: unknown;           // original payload, stored as JSON for re-processing
}

/** A partially filled job as adapters emit it; normalize() fills the rest. */
export type RawJob = Partial<Job> & Pick<Job, "externalId" | "title" | "url" | "company">;

export interface SourceConfig {
  adapter: string;         // adapter name
  key: string;             // company slug / board id / URL depending on adapter
  company?: string;        // display name override
  enabled?: boolean;
  options?: Record<string, unknown>;
}

export interface FetchContext {
  fetchJson: (url: string, init?: RequestInit) => Promise<any>;
  fetchText: (url: string, init?: RequestInit) => Promise<string>;
  log: (msg: string) => void;
}

/** A user-driven search (from the wizard, CLI flags or the API). */
export interface SearchQuery {
  keywords: string;
  location?: string;           // free text, e.g. "Berlin, Germany"
  country?: string;            // ISO-3166 alpha-2
  remote?: "remote" | "hybrid" | "onsite" | "any";
  jobType?: "fulltime" | "parttime" | "contract" | "internship" | "any";
  postedWithin?: "24h" | "3d" | "7d" | "14d" | "30d" | "any";
  seniority?: "entry" | "mid" | "senior" | "lead" | "any";
  limit?: number;              // max results per source
  sources?: string[];          // adapter names to use; default = all search-capable
  excludeCompanies?: string[];
  excludeKeywords?: string[];
  profile?: string;            // rank results against this saved profile
  regionLocations?: string[];  // whole-region searches: LinkedIn runs once per country listed here
  region?: string;             // wizard region key (europe, northamerica, asia, oceania, latam) for whole-region filtering
}

export interface SourceAdapter {
  name: string;
  /** Human description, shown in `sources` command. */
  description: string;
  /** ats = company career system, board = job board, aggregator = meta-search, generic = fallback crawler. */
  kind?: "ats" | "board" | "aggregator" | "generic";
  /** Query-driven search (LinkedIn, Indeed, boards with a search API). */
  search?: (q: SearchQuery, ctx: FetchContext) => Promise<RawJob[]>;
  /** What the adapter needs before it can run, e.g. "APIFY_TOKEN". */
  requires?: string[];
  /** Must run in a visible browser window (sites that hard-block headless Chrome). */
  needsHeadful?: boolean;
  /** Whether `key` should be a company slug, a URL, or nothing (global board). */
  keyKind: "slug" | "url" | "none";
  /** Given a careers URL, return the key if this adapter can serve it. */
  detect?: (careersUrl: string, html: string) => string | null;
  fetchJobs: (cfg: SourceConfig, ctx: FetchContext) => Promise<RawJob[]>;
}

export interface RunResult {
  source: string;
  key: string;
  fetched: number;
  inserted: number;
  updated: number;
  closed: number;
  durationMs: number;
  error?: string;
}
