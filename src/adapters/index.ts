// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import type { SourceAdapter } from "../types.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import { ashby } from "./ashby.ts";
import { workable } from "./workable.ts";
import { smartrecruiters } from "./smartrecruiters.ts";
import { recruitee } from "./recruitee.ts";
import { personio } from "./personio.ts";
import { workday } from "./workday.ts";
import { remoteok, remotive, arbeitnow, adzuna } from "./boards.ts";
import { careerpage } from "./careerpage.ts";
import { linkedin } from "./linkedin.ts";
import { indeed } from "./indeed.ts";
import { apifyAdapters } from "./apify.ts";
import { themuse, jobicy, himalayas, jooble, usajobs, googlejobs } from "./publicboards.ts";
import { linkedinBrowser, indeedBrowser, glassdoorBrowser } from "./browser-boards.ts";
import { glassdoorScrapling } from "./scrapling-boards.ts";

for (const a of [greenhouse, lever, ashby, workable, smartrecruiters, recruitee, personio, workday]) a.kind = "ats";
for (const a of [remoteok, remotive, arbeitnow]) a.kind = "board";
adzuna.kind = "aggregator"; careerpage.kind = "generic";

export const adapters: Record<string, SourceAdapter> = Object.fromEntries(
  [greenhouse, lever, ashby, workable, smartrecruiters, recruitee, personio, workday, careerpage,
   linkedin, linkedinBrowser, indeed, indeedBrowser, glassdoorScrapling, glassdoorBrowser, ...apifyAdapters, themuse, jobicy, himalayas, jooble, usajobs, googlejobs, remoteok, remotive, arbeitnow, adzuna].map((a) => [a.name, a]),
);

/** Adapters that accept a SearchQuery. */
export const searchAdapters = () => Object.values(adapters).filter((a) => a.search);
/** Search adapters whose prerequisites (env vars) are satisfied. */
export const availableSearchAdapters = () => searchAdapters().filter((a) => (a.requires ?? []).every((k) => process.env[k]));
