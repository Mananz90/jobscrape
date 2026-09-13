// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { adapters } from "./adapters/index.ts";
import { makeContext } from "./http.ts";
import { normalize } from "./normalize.ts";
import { Store } from "./store.ts";
import type { RunResult, SourceConfig } from "./types.ts";

const CONCURRENCY = Number(process.env.JOBSCRAPE_CONCURRENCY ?? 4);

export async function runSource(store: Store, cfg: SourceConfig): Promise<RunResult> {
  const adapter = adapters[cfg.adapter];
  const key = cfg.key ?? "";
  const started = Date.now();
  if (!adapter) return { source: cfg.adapter, key, fetched: 0, inserted: 0, updated: 0, closed: 0, durationMs: 0, error: "unknown adapter" };
  const ctx = makeContext(`${cfg.adapter}:${key || "*"}`);
  try {
    const raws = await adapter.fetchJobs(cfg, ctx);
    const seen = new Set<string>();
    const jobs = raws.filter((r) => r.title && r.url).map((r) => normalize(r, adapter.name, key || "*"))
      .filter((j) => !seen.has(j.id) && seen.add(j.id)); // some feeds repeat the same posting across pages
    // Guard: if a source that previously had jobs suddenly returns zero, don't mass-close (likely a block or layout change).
    if (jobs.length === 0) {
      const existing = store.query({ source: adapter.name, limit: 1 }).length;
      if (existing) throw new Error("adapter returned 0 jobs while DB has open jobs; refusing to close them (possible block/layout change)");
    }
    const r = store.upsertRun(adapter.name, key || "*", jobs);
    const res = { source: adapter.name, key, fetched: jobs.length, ...r, durationMs: Date.now() - started };
    store.recordRun(res);
    ctx.log(`fetched=${res.fetched} inserted=${res.inserted} updated=${res.updated} closed=${res.closed} (${res.durationMs}ms)`);
    return res;
  } catch (e) {
    const res = { source: adapter.name, key, fetched: 0, inserted: 0, updated: 0, closed: 0, durationMs: Date.now() - started, error: (e as Error).message };
    store.recordRun(res);
    ctx.log(`ERROR ${res.error}`);
    return res;
  }
}

/** Run all enabled sources with bounded concurrency. */
export async function runAll(store: Store, sources: SourceConfig[], filter?: string): Promise<RunResult[]> {
  const todo = sources.filter((s) => s.enabled !== false && (!filter || s.adapter === filter || s.key === filter));
  const results: RunResult[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (i < todo.length) results.push(await runSource(store, todo[i++]));
  }));
  return results;
}
