// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, RunResult } from "./types.ts";
import { fingerprint } from "./normalize.ts";

export class Store {
  db: DatabaseSync;
  constructor(path = process.env.JOBSCRAPE_DB ?? "data/jobs.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source TEXT, source_key TEXT, external_id TEXT,
        fingerprint TEXT, title TEXT, company TEXT, url TEXT, location TEXT, city TEXT, country TEXT,
        remote INTEGER, employment_type TEXT, department TEXT,
        salary_min REAL, salary_max REAL, salary_currency TEXT,
        description_html TEXT, description_text TEXT, posted_at TEXT, raw TEXT,
        first_seen TEXT, last_seen TEXT, closed_at TEXT, content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_fp ON jobs(fingerprint);
      CREATE INDEX IF NOT EXISTS jobs_src ON jobs(source, source_key);
      CREATE INDEX IF NOT EXISTS jobs_seen ON jobs(last_seen);
      CREATE TABLE IF NOT EXISTS job_status (job_id TEXT PRIMARY KEY, status TEXT, notes TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS profiles (name TEXT PRIMARY KEY, kind TEXT, json TEXT, source_file TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS saved_searches (name TEXT PRIMARY KEY, json TEXT, created_at TEXT, last_run TEXT, last_new INTEGER);
      CREATE TABLE IF NOT EXISTS embeddings (job_id TEXT, model TEXT, vec BLOB, PRIMARY KEY (job_id, model));
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, source_key TEXT, started_at TEXT,
        fetched INTEGER, inserted INTEGER, updated INTEGER, closed INTEGER, duration_ms INTEGER, error TEXT
      );
    `);
    const cols = (this.db.prepare("PRAGMA table_info(profiles)").all() as any[]).map((c) => c.name);
    if (!cols.includes("text")) this.db.exec("ALTER TABLE profiles ADD COLUMN text TEXT");
  }

  /** Upsert a batch from one source run; marks jobs not seen in this run as closed. */
  upsertRun(source: string, sourceKey: string, jobs: Job[], opts: { close?: boolean } = {}): Pick<RunResult, "inserted" | "updated" | "closed"> & { newIds: string[] } {
    const now = new Date().toISOString();
    const sel = this.db.prepare("SELECT content_hash FROM jobs WHERE id = ?");
    const ins = this.db.prepare(`INSERT INTO jobs (id, source, source_key, external_id, fingerprint, title, company, url, location, city, country, remote,
        employment_type, department, salary_min, salary_max, salary_currency, description_html, description_text, posted_at, raw, first_seen, last_seen, closed_at, content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`);
    const upd = this.db.prepare(`UPDATE jobs SET title=?, url=?, location=?, city=?, country=?, remote=?, employment_type=?, department=?,
        salary_min=?, salary_max=?, salary_currency=?, description_html=?, description_text=?, posted_at=?, raw=?, last_seen=?, closed_at=NULL, content_hash=? WHERE id=?`);
    const touch = this.db.prepare("UPDATE jobs SET last_seen=?, closed_at=NULL WHERE id=?");
    let inserted = 0, updated = 0;
    const ids: string[] = [];
    const newIds: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const j of jobs) {
        ids.push(j.id);
        const hash = contentHash(j);
        const row = sel.get(j.id) as { content_hash: string } | undefined;
        const remote = j.remote === null ? null : j.remote ? 1 : 0;
        if (!row) {
          ins.run(j.id, j.source, j.sourceKey, j.externalId, fingerprint(j), j.title, j.company, j.url, j.location, j.city, j.country, remote,
            j.employmentType, j.department, j.salaryMin, j.salaryMax, j.salaryCurrency, j.descriptionHtml, j.descriptionText, j.postedAt,
            j.raw ? JSON.stringify(j.raw) : null, now, now, hash);
          inserted++; newIds.push(j.id);
        } else if (row.content_hash !== hash) {
          upd.run(j.title, j.url, j.location, j.city, j.country, remote, j.employmentType, j.department, j.salaryMin, j.salaryMax, j.salaryCurrency,
            j.descriptionHtml, j.descriptionText, j.postedAt, j.raw ? JSON.stringify(j.raw) : null, now, hash, j.id);
          updated++;
        } else {
          touch.run(now, j.id);
        }
      }
      // Anything from this source not seen in this run is now closed.
      const placeholders = ids.map(() => "?").join(",") || "''";
      const closed = opts.close === false ? 0 : this.db.prepare(
        `UPDATE jobs SET closed_at=? WHERE source=? AND source_key=? AND closed_at IS NULL AND id NOT IN (${placeholders})`,
      ).run(now, source, sourceKey, ...ids).changes;
      this.db.exec("COMMIT");
      return { inserted, updated, closed: Number(closed), newIds };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  recordRun(r: RunResult) {
    this.db.prepare("INSERT INTO runs (source, source_key, started_at, fetched, inserted, updated, closed, duration_ms, error) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(r.source, r.key, new Date().toISOString(), r.fetched, r.inserted, r.updated, r.closed, r.durationMs, r.error ?? null);
  }

  query(q: { q?: string; company?: string; country?: string; remote?: boolean; source?: string; since?: string; postedDays?: number; status?: string;
             ids?: string[]; excludeCompanies?: string[]; excludeKeywords?: string[]; includeClosed?: boolean; limit?: number; offset?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (!q.includeClosed) where.push("closed_at IS NULL");
    if (q.ids) { where.push(`id IN (${q.ids.map(() => "?").join(",") || "''"})`); args.push(...q.ids); }
    if (q.postedDays) { where.push("COALESCE(posted_at, first_seen) >= ?"); args.push(new Date(Date.now() - q.postedDays * 864e5).toISOString()); }
    if (q.status) { where.push(q.status === "none" ? "s.status IS NULL" : "s.status = ?"); if (q.status !== "none") args.push(q.status); }
    for (const c of q.excludeCompanies ?? []) { where.push("company NOT LIKE ?"); args.push(`%${c}%`); }
    for (const k of q.excludeKeywords ?? []) { where.push("title NOT LIKE ?"); args.push(`%${k}%`); }
    if (q.q) { where.push("(title LIKE ? OR description_text LIKE ?)"); args.push(`%${q.q}%`, `%${q.q}%`); }
    if (q.company) { where.push("company LIKE ?"); args.push(`%${q.company}%`); }
    if (q.country) { where.push("country = ?"); args.push(q.country.toUpperCase()); }
    if (q.remote !== undefined) { where.push("remote = ?"); args.push(q.remote ? 1 : 0); }
    if (q.source) { where.push("source = ?"); args.push(q.source); }
    if (q.since) { where.push("first_seen >= ?"); args.push(q.since); }
    const sql = `SELECT j.id, source, source_key, title, company, url, location, city, country, remote, employment_type, department,
        salary_min, salary_max, salary_currency, posted_at, first_seen, last_seen, closed_at, fingerprint, s.status, s.notes,
        CAST(julianday('now') - julianday(COALESCE(posted_at, first_seen)) AS INTEGER) AS days_open,
        (SELECT COUNT(*) FROM jobs d WHERE d.fingerprint = j.fingerprint AND d.closed_at IS NULL) AS seen_on
      FROM jobs j LEFT JOIN job_status s ON s.job_id = j.id ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(posted_at, first_seen) DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...(args as any[]), q.limit ?? 100, q.offset ?? 0);
  }

  get(id: string) { return this.db.prepare("SELECT j.*, s.status, s.notes FROM jobs j LEFT JOIN job_status s ON s.job_id = j.id WHERE j.id = ?").get(id); }

  /** Full text for matching (title + description) for a set of ids. */
  texts(ids: string[]) {
    if (!ids.length) return [];
    return this.db.prepare(`SELECT id, title, company, location, remote, description_text, department FROM jobs WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
  }

  setDescription(jobId: string, html: string, text: string | null) {
    this.db.prepare("UPDATE jobs SET description_html=?, description_text=? WHERE id=?").run(html, text, jobId);
  }

  setStatus(jobId: string, status: string, notes?: string) {
    this.db.prepare("INSERT INTO job_status (job_id, status, notes, updated_at) VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, notes=COALESCE(excluded.notes, notes), updated_at=excluded.updated_at")
      .run(jobId, status, notes ?? null, new Date().toISOString());
  }
  statusCounts() { return this.db.prepare("SELECT status, COUNT(*) c FROM job_status GROUP BY status").all(); }

  saveProfile(name: string, kind: string, profile: unknown, sourceFile?: string, text?: string) {
    this.db.prepare("INSERT OR REPLACE INTO profiles (name, kind, json, source_file, created_at, text) VALUES (?,?,?,?,?,?)").run(name, kind, JSON.stringify(profile), sourceFile ?? null, new Date().toISOString(), text ?? null);
  }
  getProfile(name: string) { const r = this.db.prepare("SELECT * FROM profiles WHERE name = ?").get(name) as any; return r ? { ...r, profile: JSON.parse(r.json) } : null; }

  getEmbeddings(ids: string[], model: string): Map<string, Float32Array> {
    const m = new Map<string, Float32Array>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of this.db.prepare(`SELECT job_id, vec FROM embeddings WHERE model = ? AND job_id IN (${chunk.map(() => "?").join(",")})`).all(model, ...chunk) as any[])
        m.set(r.job_id, new Float32Array(new Uint8Array(r.vec).buffer.slice(0)));
    }
    return m;
  }
  putEmbeddings(rows: { id: string; vec: Float32Array }[], model: string) {
    const ins = this.db.prepare("INSERT OR REPLACE INTO embeddings (job_id, model, vec) VALUES (?,?,?)");
    this.db.exec("BEGIN"); try { for (const r of rows) if (r.vec.length) ins.run(r.id, model, new Uint8Array(r.vec.buffer)); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  listProfiles() { return (this.db.prepare("SELECT name, kind, source_file, created_at FROM profiles ORDER BY created_at DESC").all() as any[]); }

  saveSearch(name: string, query: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO saved_searches (name, json, created_at, last_run, last_new) VALUES (?,?,?,NULL,NULL)").run(name, JSON.stringify(query), new Date().toISOString());
  }
  listSearches() { return (this.db.prepare("SELECT * FROM saved_searches ORDER BY created_at DESC").all() as any[]).map((r) => ({ ...r, query: JSON.parse(r.json) })); }
  touchSearch(name: string, newCount: number) { this.db.prepare("UPDATE saved_searches SET last_run=?, last_new=? WHERE name=?").run(new Date().toISOString(), newCount, name); }
  deleteSearch(name: string) { this.db.prepare("DELETE FROM saved_searches WHERE name=?").run(name); }

  /** Cross-source duplicates: same fingerprint appearing under multiple sources. */
  duplicates(limit = 100) {
    return this.db.prepare(`SELECT fingerprint, COUNT(*) n, GROUP_CONCAT(source || ':' || source_key) sources, MIN(title) title, MIN(company) company
      FROM jobs WHERE closed_at IS NULL GROUP BY fingerprint HAVING n > 1 ORDER BY n DESC LIMIT ?`).all(limit);
  }

  /** Sources whose latest fetch dropped below half their 7-day average (likely block or layout change), and sources with no new jobs for N days. */
  health(staleDays = 14, onlyKeys?: Set<string>) {
    const drops = this.db.prepare(`
      WITH recent AS (SELECT source, source_key, AVG(fetched) avg7, COUNT(*) n FROM runs WHERE started_at > datetime('now', '-7 days') AND error IS NULL GROUP BY source, source_key),
           latest AS (SELECT source, source_key, fetched, error, started_at FROM runs r WHERE id = (SELECT MAX(id) FROM runs WHERE source = r.source AND source_key = r.source_key))
      SELECT l.source, l.source_key, ROUND(r.avg7) avg7, l.fetched latest, l.error, l.started_at FROM latest l JOIN recent r USING (source, source_key)
      WHERE r.n >= 2 AND r.avg7 >= 10 AND (l.fetched < r.avg7 * 0.5 OR l.error IS NOT NULL) ORDER BY r.avg7 DESC`).all() as any[];
    const stale = this.db.prepare(`
      SELECT source, source_key, MAX(CASE WHEN inserted > 0 THEN started_at END) last_new, MAX(started_at) last_run, COUNT(*) runs
      FROM runs GROUP BY source, source_key HAVING last_new IS NULL OR last_new < datetime('now', ?) ORDER BY last_new`).all(`-${staleDays} days`) as any[];
    const failing = this.db.prepare(`SELECT source, source_key, error, started_at FROM runs r WHERE id = (SELECT MAX(id) FROM runs WHERE source = r.source AND source_key = r.source_key) AND error IS NOT NULL`).all() as any[];
    // Only report sources that are still configured (or ad-hoc searches); old entries from removed sources are noise.
    const keep = (r: any) => !onlyKeys || r.source_key === "search" || onlyKeys.has(`${r.source}:${r.source_key}`);
    return { drops: drops.filter(keep), stale: stale.filter(keep), failing: failing.filter(keep) };
  }

  stats() {
    return {
      open: (this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE closed_at IS NULL").get() as any).c,
      closed: (this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE closed_at IS NOT NULL").get() as any).c,
      bySource: this.db.prepare("SELECT source, COUNT(*) c FROM jobs WHERE closed_at IS NULL GROUP BY source ORDER BY c DESC").all(),
      byCountry: this.db.prepare("SELECT country, COUNT(*) c FROM jobs WHERE closed_at IS NULL AND country IS NOT NULL GROUP BY country ORDER BY c DESC LIMIT 15").all(),
      status: this.statusCounts(),
      ghost: (this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE closed_at IS NULL AND julianday('now') - julianday(COALESCE(posted_at, first_seen)) > 90").get() as any).c,
      lastRuns: this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 20").all(),
    };
  }
}

function contentHash(j: Job) {
  const { raw: _raw, ...rest } = j;
  return fingerprint({ title: JSON.stringify(rest), company: "", location: "" });
}
