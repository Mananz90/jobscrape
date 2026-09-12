import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { Store } from "./store.ts";
import { runSearch, searchLocal } from "./search.ts";
import { adapters, searchAdapters } from "./adapters/index.ts";
import { readDocument, extractProfile, type Profile } from "./profile.ts";
import { scoreJob, queryFromProfile, rankJobs } from "./match.ts";
import { discoverByKeyword, resolveCompanies } from "./discover.ts";
import { loadSources, addSource } from "./config.ts";
import { linkedinDescription } from "./adapters/linkedin.ts";
import { makeContext } from "./http.ts";
import { htmlToText } from "./normalize.ts";
import { covers, coverageLabel } from "./regions.ts";
import { scraplingAvailable } from "./scrapling.ts";
import { htmlReport } from "./report.ts";
import { runAll } from "./runner.ts";
import type { SearchQuery, Job } from "./types.ts";

// Line-buffered prompt that also works with piped stdin (answers arriving before the question is asked) and exits cleanly on EOF.
const rlRaw = readline.createInterface({ input, output, terminal: !!input.isTTY });
const pending: string[] = []; const waiters: ((s: string) => void)[] = []; let closed = false;
rlRaw.on("line", (l) => { const w = waiters.shift(); w ? w(l) : pending.push(l); });
rlRaw.on("close", () => { closed = true; while (waiters.length) waiters.shift()!(""); });
class EndOfInput extends Error {}
const rl = {
  question(prompt: string): Promise<string> {
    if (pending.length) { output.write(prompt + pending[0] + "\n"); return Promise.resolve(pending.shift()!); }
    if (closed) throw new EndOfInput("stdin closed");
    output.write(prompt);
    return new Promise((r) => waiters.push(r));
  },
  close() { rlRaw.close(); },
};
const c = { b: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, cy: (s: string) => `\x1b[36m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m` };

async function ask(q: string, def?: string): Promise<string> {
  const a = (await rl.question(`${c.cy("?")} ${q}${def !== undefined ? c.dim(` (${def})`) : ""}: `)).trim();
  return a || def || "";
}
async function choose<T extends string>(q: string, options: { key: T; label: string; hint?: string }[], def: T): Promise<T> {
  console.log(`${c.cy("?")} ${q}`);
  options.forEach((o, i) => console.log(`   ${c.b(String(i + 1))}) ${o.label}${o.hint ? c.dim(`  ${o.hint}`) : ""}${o.key === def ? c.dim("  [default]") : ""}`));
  const a = (await rl.question("   > ")).trim();
  if (!a) return def; // Enter = default (an option may legitimately have an empty key, so check this first)
  const n = Number(a);
  if (n >= 1 && n <= options.length) return options[n - 1].key;
  return (options.find((o) => o.key === a || o.label.toLowerCase() === a.toLowerCase())?.key ?? def);
}
async function multi(q: string, options: { key: string; label: string; hint?: string; on?: boolean }[]): Promise<string[]> {
  console.log(`${c.cy("?")} ${q} ${c.dim("(comma-separated numbers, 'all', or Enter for defaults)")}`);
  options.forEach((o, i) => console.log(`   ${c.b(String(i + 1))}) ${o.on ? c.g("●") : c.dim("○")} ${o.label}${o.hint ? c.dim(`  ${o.hint}`) : ""}`));
  const a = (await rl.question("   > ")).trim().toLowerCase();
  if (!a) return options.filter((o) => o.on).map((o) => o.key);
  if (a === "all") return options.map((o) => o.key);
  return a.split(/[\s,]+/).map((x) => options[Number(x) - 1]?.key).filter(Boolean);
}
const confirm = async (q: string, def = true) => /^y/i.test((await ask(`${q} [${def ? "Y/n" : "y/N"}]`)) || (def ? "y" : "n"));

const REGIONS: Record<string, { label: string; countries: [string, string][] }> = {
  europe: { label: "Europe", countries: [["DE", "Germany"], ["GB", "United Kingdom"], ["NL", "Netherlands"], ["FR", "France"], ["CH", "Switzerland"], ["AT", "Austria"], ["IE", "Ireland"], ["ES", "Spain"], ["SE", "Sweden"], ["PL", "Poland"], ["IT", "Italy"], ["PT", "Portugal"]] },
  northamerica: { label: "North America", countries: [["US", "United States"], ["CA", "Canada"], ["MX", "Mexico"]] },
  asia: { label: "Asia", countries: [["IN", "India"], ["SG", "Singapore"], ["JP", "Japan"], ["AE", "UAE"]] },
  oceania: { label: "Oceania", countries: [["AU", "Australia"], ["NZ", "New Zealand"]] },
  latam: { label: "Latin America", countries: [["BR", "Brazil"], ["MX", "Mexico"]] },
  remote: { label: "Remote only, anywhere", countries: [] },
};
const CITIES: Record<string, string[]> = { DE: ["Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne", "Stuttgart", "Düsseldorf"], GB: ["London", "Manchester", "Edinburgh", "Birmingham"], US: ["New York", "San Francisco", "Seattle", "Austin", "Boston", "Chicago", "Los Angeles"], IN: ["Bangalore", "Mumbai", "Delhi", "Hyderabad", "Pune", "Chennai"], NL: ["Amsterdam", "Rotterdam", "Utrecht"], CH: ["Zurich", "Basel", "Geneva"], CA: ["Toronto", "Vancouver", "Montreal"], AU: ["Sydney", "Melbourne"], SG: ["Singapore"], AE: ["Dubai", "Abu Dhabi"], FR: ["Paris", "Lyon"], IE: ["Dublin"], AT: ["Vienna"], ES: ["Madrid", "Barcelona"] };
const COUNTRY_NAME: Record<string, string> = Object.fromEntries(Object.values(REGIONS).flatMap((r) => r.countries));

/** Main wizard loop. */
export async function interactive(store: Store) {
  console.log(`\n${c.b("jobscrape")} ${c.dim("— interactive job search")}\n`);
  const stats = store.stats();
  console.log(c.dim(`DB: ${stats.open} open jobs from ${stats.bySource.length} sources · ${(stats.status as any[]).map((s) => `${s.c} ${s.status}`).join(", ") || "nothing tracked yet"}\n`));
  for (;;) {
    const action = await choose("What do you want to do?", [
      { key: "search", label: "Search jobs now", hint: "guided: keywords, region, country, type, dates, sources" },
      { key: "cv", label: "Match a CV / resume", hint: "read the file, build a profile, search + rank by fit" },
      { key: "jd", label: "Find jobs like a job description", hint: "paste or load a JD, find similar roles" },
      { key: "companies", label: "Add companies to watch", hint: "names, domains, careers URLs, or discover by region/industry" },
      { key: "run", label: "Refresh watched companies", hint: "re-scrape every configured ATS/company source" },
      { key: "saved", label: "Saved searches & alerts", hint: "re-run, schedule, delete" },
      { key: "tracker", label: "Application tracker", hint: "interested / applied / interview / rejected" },
      { key: "quit", label: "Quit" },
    ], "search");
    if (action === "quit" || closed && !pending.length) break;
    try {
      if (action === "search") await searchFlow(store);
      else if (action === "cv" || action === "jd") await documentFlow(store, action);
      else if (action === "companies") await companiesFlow(store);
      else if (action === "run") { const res = await runAll(store, loadSources()); console.log(c.g(`\n${res.filter((r) => !r.error).length}/${res.length} sources ok, ${res.reduce((a, r) => a + r.inserted, 0)} new jobs\n`)); }
      else if (action === "saved") await savedFlow(store);
      else if (action === "tracker") await trackerFlow(store);
    } catch (e) { if (e instanceof EndOfInput) break; console.log(c.r(`\n✗ ${(e as Error).message}\n`)); }
  }
  rl.close();
}

async function buildQuery(defaults: Partial<SearchQuery> = {}, hint?: string): Promise<SearchQuery> {
  const keywords = await ask("Job title or keywords", defaults.keywords ?? hint);
  const region = await choose("Region", Object.entries(REGIONS).map(([key, r]) => ({ key, label: r.label })), defaults.country ? regionOf(defaults.country) : "europe");
  let country: string | undefined, location: string | undefined, remote: SearchQuery["remote"] = defaults.remote ?? "any";
  if (region === "remote") remote = "remote";
  else {
    const cs = REGIONS[region].countries;
    country = await choose("Country", [...cs.map(([k, l]) => ({ key: k, label: l })), { key: "", label: "Whole region / any" }], defaults.country && cs.some(([k]) => k === defaults.country) ? defaults.country : cs[0][0]);
    country = country || undefined;
    const cities = country ? CITIES[country] ?? [] : [];
    const city = await choose("City", [...cities.map((x) => ({ key: x, label: x })), { key: "", label: country ? `Anywhere in ${COUNTRY_NAME[country]}` : "Anywhere" }, { key: "__other", label: "Type a city" }], defaults.location?.split(",")[0] && cities.includes(defaults.location.split(",")[0]) ? defaults.location.split(",")[0] : "");
    const cityName = city === "__other" ? await ask("City") : city;
    location = cityName ? `${cityName}${country ? ", " + COUNTRY_NAME[country] : ""}` : country ? COUNTRY_NAME[country] : undefined;
    remote = await choose<NonNullable<SearchQuery["remote"]>>("Work mode", [{ key: "any", label: "Any" }, { key: "remote", label: "Remote" }, { key: "hybrid", label: "Hybrid" }, { key: "onsite", label: "On-site" }], remote ?? "any");
  }
  const jobType = await choose("Job type", [{ key: "any", label: "Any" }, { key: "fulltime", label: "Full-time" }, { key: "parttime", label: "Part-time" }, { key: "contract", label: "Contract / freelance" }, { key: "internship", label: "Internship / working student" }], defaults.jobType ?? "fulltime");
  const seniority = await choose("Seniority", [{ key: "any", label: "Any" }, { key: "entry", label: "Entry / junior" }, { key: "mid", label: "Mid-level" }, { key: "senior", label: "Senior" }, { key: "lead", label: "Lead / head / director" }], defaults.seniority ?? "any");
  const postedWithin = await choose("Posted within", [{ key: "24h", label: "Last 24 hours" }, { key: "3d", label: "Last 3 days" }, { key: "7d", label: "Last week" }, { key: "14d", label: "Last 2 weeks" }, { key: "30d", label: "Last month" }, { key: "any", label: "Any time" }], defaults.postedWithin ?? "7d");
  const all = searchAdapters();
  const sources = await multi("Sources", all.filter((a) => covers(a.name, country) || !country).map((a) => {
    const ok = (a.requires ?? []).every((k) => process.env[k]);
    const browser = a.name.endsWith("-browser");
    const scr = scraplingAvailable(); // headless Glassdoor via Scrapling when installed, else the visible-window one
    const on = ok && !a.name.startsWith("apify-") && a.name !== "indeed" && a.name !== "linkedin" /* browser version preferred */
      && !(scr && a.name === "glassdoor-browser") && !(!scr && a.name === "glassdoor") && (remote === "remote" || !["jobicy", "himalayas"].includes(a.name));
    return { key: a.name, label: a.name.padEnd(18), hint: `${coverageLabel(a.name)}${browser ? " · real browser" : ""}${ok ? "" : ` · needs ${a.requires!.join(", ")}`}`, on };
  }));
  const notReady = sources.filter((n) => !(adapters[n].requires ?? []).every((k) => process.env[k]));
  if (notReady.length) console.log(c.y(`  skipping ${notReady.join(", ")}: missing ${[...new Set(notReady.flatMap((n) => adapters[n].requires ?? []))].join(", ")} (see .env.example)`));
  const ready = sources.filter((n) => !notReady.includes(n));
  const limit = Number(await ask("Max results per source", String(defaults.limit ?? 50)));
  const ex = await ask("Exclude companies or title words (comma-separated, optional)", "");
  const exclude = ex.split(",").map((s) => s.trim()).filter(Boolean);
  const regionLocations = !country && region !== "remote" ? REGIONS[region].countries.map(([, name]) => name) : undefined;
  return { keywords, location, country, remote, jobType, seniority, postedWithin, sources: ready, limit, excludeCompanies: exclude, excludeKeywords: exclude, regionLocations, region: region === "remote" ? undefined : region };
}
const regionOf = (cc: string) => Object.entries(REGIONS).find(([, r]) => r.countries.some(([k]) => k === cc))?.[0] ?? "europe";

async function searchFlow(store: Store, profile?: Profile, profileName?: string) {
  const q = await buildQuery(profile ? { ...queryFromProfile(profile), jobType: "fulltime" } as any : {});
  console.log(`\n${c.dim("Plan:")} "${q.keywords}" · ${q.location ?? "anywhere"} · ${q.remote} · ${q.jobType} · ${q.seniority} · posted ${q.postedWithin} · sources: ${q.sources!.join(", ") || "none"}`);
  const includeLocal = await confirm("Also search jobs already scraped from watched companies in the local DB?");
  if (!(await confirm("Run it?"))) return;
  const out = await runSearch(store, q, (m) => console.log(c.dim("  " + m)));
  let jobs: any[] = out.jobs.map((j) => ({ ...j, isNew: out.newIds.includes(j.id) }));
  if (includeLocal) jobs = [...jobs, ...searchLocal(store, q).filter((l) => !jobs.some((j) => j.id === l.id))];
  console.log(`\n${c.g(`${jobs.length} jobs`)} (${out.newIds.length} never seen before) from ${out.perSource.filter((s) => !s.error).length} sources${out.perSource.some((s) => s.error) ? c.y(` · ${out.perSource.filter((s) => s.error).length} failed`) : ""}`);
  await resultsMenu(store, jobs, q, profile, profileName);
}

async function documentFlow(store: Store, kind: "cv" | "jd") {
  const existing = store.listProfiles().filter((p) => p.kind === kind);
  let profile: Profile | undefined; let profileName: string | undefined;
  if (existing.length) {
    const pick = await choose(`Use a saved ${kind.toUpperCase()} profile or load a new file?`, [...existing.map((p) => ({ key: p.name, label: p.name, hint: p.source_file ?? "" })), { key: "__new", label: "Load a new file" }], existing[0].name);
    if (pick !== "__new") { profile = store.getProfile(pick)!.profile; profileName = pick; }
  }
  if (!profile) {
    const path = kind === "jd" ? await ask("Path to the JD file (.pdf/.docx/.txt), or leave empty to paste text", "") : await ask("Path to your CV (.pdf/.docx/.txt)");
    let text: string;
    if (!path) { console.log(c.dim("Paste the text, then an empty line:")); const lines: string[] = []; for (;;) { const l = await rl.question(""); if (!l.trim()) break; lines.push(l); } text = lines.join("\n"); }
    else text = await readDocument(path.replace(/^~/, process.env.HOME ?? ""));
    if (text.trim().length < 50) throw new Error("could not extract meaningful text from that document");
    console.log(c.dim(`Read ${text.length} chars. Extracting profile${process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? " with Claude" : " (heuristic; set ANTHROPIC_API_KEY for better results)"}…`));
    const r = await extractProfile(text, kind, (m) => console.log(c.y("  " + m)));
    profile = r.profile;
    console.log(`\n${c.b("Profile")} ${c.dim(`(${r.method})`)}\n  ${profile.summary}\n  titles: ${profile.titles.join(" | ")}\n  skills: ${profile.skills.slice(0, 15).join(", ")}${profile.skills.length > 15 ? "…" : ""}\n  seniority: ${profile.seniority} · location: ${profile.locations.join(", ") || "?"} (${profile.country ?? "?"}) · ${profile.remotePreference}\n  search keywords: ${profile.keywords.join(" | ")}\n`);
    if (await confirm("Edit the search keywords?", false)) profile.keywords = (await ask("Keywords (| separated)", profile.keywords.join(" | "))).split("|").map((s) => s.trim()).filter(Boolean);
    const name = await ask("Save profile as", (path ? path.split("/").pop()!.replace(/\.[^.]+$/, "") : `${kind}-${Date.now().toString(36)}`));
    store.saveProfile(name, kind, profile, path || undefined, text);
    profileName = name;
  }
  await searchFlow(store, profile, profileName);
}

async function resultsMenu(store: Store, jobs: any[], q: SearchQuery, profile?: Profile, profileName?: string) {
  let ranked = jobs;
  if (profileName) ranked = await rankJobs(store, jobs, profileName, { log: (m) => console.log(c.dim("  " + m)) });
  else if (profile) {
    const texts = new Map(store.texts(jobs.map((j) => j.id)).map((t) => [t.id, t]));
    ranked = jobs.map((j) => ({ ...j, match: scoreJob({ ...j, description_text: texts.get(j.id)?.description_text ?? j.descriptionText }, profile) })).sort((a, b) => b.match.score - a.match.score);
  }
  let page = 0;
  const pageSize = 20;
  for (;;) {
    printTable(ranked.slice(page * pageSize, (page + 1) * pageSize), page * pageSize, !!profile);
    console.log(c.dim(`showing ${Math.min(ranked.length, (page + 1) * pageSize)}/${ranked.length}`));
    const a = (await rl.question(`${c.cy("›")} ${c.dim("n=next page, p=prev, <num>=details, o<num>=open, s<num>=status, v=verify links, x=export, w=save search, m=main menu")}: `)).trim().toLowerCase();
    if (a === "v") { const { verifyJobs } = await import("./verify.ts"); const v = await verifyJobs(ranked.slice(0, 60), { log: (m) => console.log(c.dim("  " + m)) }); const dead = new Set(v.filter((x) => x.verified === false).map((x) => x.id)); ranked = ranked.filter((j) => !dead.has(j.id)); console.log(c.g(`removed ${dead.size} dead link${dead.size === 1 ? "" : "s"}`)); continue; }
    if (a === "m" || a === "") return;
    if (a === "n") { if ((page + 1) * pageSize < ranked.length) page++; continue; }
    if (a === "p") { page = Math.max(0, page - 1); continue; }
    if (a === "x") { const fmt = await choose("Format", [{ key: "html", label: "HTML report (opens in browser)" }, { key: "csv", label: "CSV" }, { key: "json", label: "JSON" }, { key: "md", label: "Markdown" }], "html"); const f = exportJobs(ranked, fmt); console.log(c.g(`wrote ${f}`)); if (fmt === "html") execFile("open", [f], () => {}); continue; }
    if (a === "w") { const name = await ask("Name this search", q.keywords.replace(/\s+/g, "-")); store.saveSearch(name, q); console.log(c.g(`saved. Run 'node src/index.ts schedule' to get alerts for new matches.`)); continue; }
    const m = a.match(/^([os]?)(\d+)$/);
    if (!m) continue;
    const j = ranked[Number(m[2]) - 1];
    if (!j) continue;
    if (m[1] === "o") { execFile(process.platform === "darwin" ? "open" : "xdg-open", [j.url], () => {}); continue; }
    if (m[1] === "s") { const st = await choose(`Status for "${j.title}"`, STATUSES, "interested"); const notes = await ask("Notes (optional)", ""); store.setStatus(j.id, st, notes || undefined); j.status = st; continue; }
    let full: any = store.get(j.id);
    if (!full?.description_text && (j.source === "linkedin" || j.source === "linkedin-browser")) {
      try { const html = await linkedinDescription(full?.external_id ?? j.externalId, { ...makeContext("linkedin"), log: () => {} }); if (html) { store.setDescription(j.id, html, htmlToText(html)); full = store.get(j.id); } }
      catch (e) { console.log(c.dim(`  could not fetch description: ${(e as Error).message}`)); }
    }
    console.log(`\n${c.b(j.title)} — ${j.company}\n${j.location ?? ""} ${j.remote ? "· remote" : ""} · ${j.employment_type ?? j.employmentType ?? ""} · posted ${(j.posted_at ?? j.postedAt ?? "").slice(0, 10)} · via ${j.source}\n${c.cy(j.url)}`);
    if (j.match) console.log(`${c.b("match " + j.match.score + "%")} ${j.match.reasons.join(", ")}\n  matched: ${j.match.matched.join(", ") || "-"}\n  missing: ${j.match.missing.join(", ") || "-"}`);
    if (full?.salary_min || full?.salary_max) console.log(`salary: ${full.salary_min ?? "?"} – ${full.salary_max ?? "?"} ${full.salary_currency ?? ""}`);
    console.log(`\n${(full?.description_text ?? "(no description captured)").slice(0, 2500)}\n`);
  }
}

const STATUSES = [{ key: "interested", label: "Interested" }, { key: "applied", label: "Applied" }, { key: "interview", label: "Interview" }, { key: "offer", label: "Offer" }, { key: "rejected", label: "Rejected" }, { key: "skip", label: "Not for me" }];

function printTable(rows: any[], offset: number, withMatch: boolean) {
  const cols = [["#", 4], ["title", 44], ["company", 22], ["location", 22], ["posted", 10], ["src", 12]] as [string, number][];
  if (withMatch) cols.splice(1, 0, ["fit", 5], ["sem", 5]);
  const cut = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").slice(0, n).padEnd(n);
  console.log("\n" + c.b(cols.map(([h, w]) => cut(h, w)).join(" ")));
  rows.forEach((j, i) => {
    const vals: unknown[] = [offset + i + 1, (j.isNew ? "● " : "") + j.title, j.company, `${j.location ?? ""}${(j.remote === true || j.remote === 1) ? " 🏠" : ""}`, (j.posted_at ?? j.postedAt ?? j.first_seen ?? "").slice(0, 10), j.source];
    if (withMatch) vals.splice(1, 0, `${j.match?.score ?? ""}%`, j.match?.semantic != null ? `${j.match.semantic}%` : "");
    const line = cols.map(([, w], k) => cut(vals[k], w)).join(" ");
    console.log(j.status ? c.y(line + `  [${j.status}]`) : j.match && j.match.score >= 70 ? c.g(line) : line);
  });
}

function exportJobs(rows: any[], fmt: string) {
  mkdirSync("data/exports", { recursive: true });
  const file = `data/exports/search-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.${fmt}`;
  const slim = rows.map((j) => ({ score: j.match?.score, title: j.title, company: j.company, location: j.location, remote: j.remote, posted: (j.posted_at ?? j.postedAt ?? "").slice(0, 10), source: j.source, url: j.url, status: j.status ?? "", matched: j.match?.matched.join("; "), missing: j.match?.missing.join("; ") }));
  if (fmt === "html") writeFileSync(file, htmlReport(rows, `${rows.length} jobs`));
  else if (fmt === "json") writeFileSync(file, JSON.stringify(slim, null, 2));
  else if (fmt === "md") writeFileSync(file, `| # | fit | title | company | location | posted | source |\n|---|---|---|---|---|---|---|\n` + slim.map((r, i) => `| ${i + 1} | ${r.score ?? ""} | [${r.title}](${r.url}) | ${r.company} | ${r.location ?? ""} | ${r.posted} | ${r.source} |`).join("\n"));
  else { const cols = Object.keys(slim[0] ?? {}); const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`; writeFileSync(file, [cols.join(","), ...slim.map((r: any) => cols.map((k) => esc(r[k])).join(","))].join("\n")); }
  return file;
}

async function companiesFlow(store: Store) {
  const how = await choose("How do you want to add companies?", [
    { key: "list", label: "Type company names / domains / careers URLs", hint: "e.g. 'Stripe, sap.com, https://careers.example.com'" },
    { key: "file", label: "Load a file with one company per line" },
    { key: "discover", label: "Discover companies by region / industry / keyword", hint: "searches for public ATS boards, e.g. 'Berlin fintech'" },
  ], "list");
  let entries: string[] = [];
  if (how === "list") entries = (await ask("Companies (comma-separated)")).split(",");
  else if (how === "file") entries = (await readDocument((await ask("File path")).replace(/^~/, process.env.HOME ?? ""))).split(/\r?\n/);
  else {
    const kw = await ask("Keyword(s), e.g. 'Berlin', 'fintech Amsterdam', 'climate remote'");
    const found = await discoverByKeyword(kw, { log: (m) => console.log(c.dim("  " + m)) });
    if (!found.length) { console.log(c.y("Nothing found. Search engines may be rate-limiting; set BRAVE_API_KEY for reliable discovery, or add companies by name.")); return; }
    const pick = await multi(`Found ${found.length} companies. Add which?`, found.map((f) => ({ key: `${f.adapter}:${f.key}`, label: `${f.company}`, hint: `${f.adapter}`, on: true })));
    let added = 0; for (const f of found) if (pick.includes(`${f.adapter}:${f.key}`) && addSource(f)) added++;
    console.log(c.g(`added ${added} sources to config/sources.json`));
    if (added && (await confirm("Scrape them now?"))) { const res = await runAll(store, loadSources()); console.log(c.g(`${res.reduce((a, r) => a + r.inserted, 0)} new jobs`)); }
    return;
  }
  const { resolved, unresolved } = await resolveCompanies(entries, (m) => console.log(c.dim("  " + m)));
  let added = 0; for (const r of resolved) if (addSource(r)) added++;
  console.log(c.g(`resolved ${resolved.length}, added ${added} new sources`) + (unresolved.length ? c.y(`, could not resolve: ${unresolved.join(", ")}`) : ""));
  if (added && (await confirm("Scrape them now?"))) { const res = await runAll(store, loadSources()); console.log(c.g(`${res.reduce((a, r) => a + r.inserted, 0)} new jobs`)); }
}

async function savedFlow(store: Store) {
  const list = store.listSearches();
  if (!list.length) { console.log(c.y("No saved searches yet. Run a search and press 'w' to save it.")); return; }
  const pick = await choose("Saved searches", list.map((s) => ({ key: s.name, label: s.name, hint: `${s.query.keywords} · ${s.query.location ?? "anywhere"} · last run ${s.last_run?.slice(0, 16) ?? "never"}${s.last_new != null ? ` (${s.last_new} new)` : ""}` })), list[0].name);
  const s = list.find((x) => x.name === pick)!;
  const what = await choose(`"${pick}"`, [{ key: "run", label: "Run now" }, { key: "delete", label: "Delete" }, { key: "back", label: "Back" }], "run");
  if (what === "delete") { store.deleteSearch(pick); return; }
  if (what !== "run") return;
  const out = await runSearch(store, s.query, (m) => console.log(c.dim("  " + m)));
  store.touchSearch(pick, out.newIds.length);
  console.log(`\n${c.g(`${out.jobs.length} jobs, ${out.newIds.length} new since last time`)}`);
  await resultsMenu(store, out.jobs, s.query);
}

async function trackerFlow(store: Store) {
  const st = await choose("Show", [{ key: "", label: "All tracked" }, ...STATUSES], "");
  const rows = STATUSES.flatMap((s) => (st && s.key !== st) ? [] : store.query({ status: s.key, includeClosed: true, limit: 200 }) as any[]);
  if (!rows.length) { console.log(c.y("Nothing tracked yet. In any result list, type s<number> to set a status.")); return; }
  await resultsMenu(store, rows, { keywords: "" });
}
