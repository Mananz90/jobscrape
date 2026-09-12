import type { Profile } from "./profile.ts";
import type { Store } from "./store.ts";
import { ollamaUp, embed, cosine, cosineToPercent, EMBED_MODEL } from "./embed.ts";

export interface MatchResult { score: number; keyword: number; semantic: number | null; titleScore: number; skillScore: number; locationScore: number; seniorityScore: number; matched: string[]; missing: string[]; reasons: string[] }

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9+#. ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
const STOP = new Set(["and", "or", "the", "of", "for", "in", "to", "a", "an", "with", "at", "on", "is", "we", "you", "our", "your", "will", "are", "be", "as", "by", "this", "that", "from", "it", "m", "f", "d", "w", "x"]);

/** Score a job (title + description text) against a profile. 0..100 with an explanation. */
export function scoreJob(job: { title: string; description_text?: string | null; location?: string | null; remote?: number | boolean | null; department?: string | null }, p: Profile): MatchResult {
  const title = job.title.toLowerCase();
  const text = `${job.title} ${job.department ?? ""} ${job.description_text ?? ""}`.toLowerCase();
  const reasons: string[] = [];

  // Title: best Jaccard overlap between job title tokens and any profile title.
  const jt = tokens(job.title);
  let titleScore = 0;
  for (const t of p.titles) {
    const pt = tokens(t);
    const inter = [...pt].filter((w) => jt.has(w)).length;
    const jac = inter / (new Set([...pt, ...jt]).size || 1);
    titleScore = Math.max(titleScore, jac, inter >= 2 ? 0.7 : 0);
    if (title.includes(t.toLowerCase())) titleScore = 1;
  }
  if (titleScore >= 0.7) reasons.push("title matches");

  // Skills: fraction of profile skills present in the job text (soft: only skills the JD actually mentions matter for missing).
  const matched: string[] = [], missing: string[] = [];
  for (const s of p.skills) {
    const re = new RegExp(`(^|[^a-z0-9+#])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9+#]|$)`);
    (re.test(text) ? matched : missing).push(s);
  }
  const hasText = (job.description_text?.length ?? 0) > 200;
  const skillScore = p.skills.length ? matched.length / Math.min(p.skills.length, hasText ? 12 : 4) : 0.5;
  if (matched.length) reasons.push(`${matched.length} skill${matched.length > 1 ? "s" : ""} match`);

  // Location / remote.
  const loc = (job.location ?? "").toLowerCase();
  const isRemote = job.remote === true || job.remote === 1 || /remote/.test(loc);
  let locationScore = 0.5;
  if (p.remotePreference === "remote" && isRemote) locationScore = 1;
  else if (p.locations.some((l) => loc.includes(l.toLowerCase()))) locationScore = 1;
  else if (p.remotePreference === "any" && isRemote) locationScore = 0.8;
  else if (!loc) locationScore = 0.5;
  else if (p.locations.length && p.remotePreference !== "remote") locationScore = 0.2;
  if (locationScore === 1) reasons.push("location fits");

  // Seniority.
  const js = /\b(head|director|vp|chief|principal)\b/.test(title) ? "lead" : /\b(senior|sr\.?|lead|staff)\b/.test(title) ? "senior" : /\b(junior|jr\.?|intern|graduate|trainee|working student|werkstudent)\b/.test(title) ? "entry" : "mid";
  const order = ["entry", "mid", "senior", "lead"];
  const seniorityScore = p.seniority === "any" ? 0.8 : 1 - Math.min(2, Math.abs(order.indexOf(js) - order.indexOf(p.seniority))) * 0.4;

  const score = Math.round(100 * Math.min(1, 0.4 * Math.min(1, titleScore) + 0.35 * Math.min(1, skillScore) + 0.15 * locationScore + 0.1 * seniorityScore));
  return { score, keyword: score, semantic: null, titleScore, skillScore, locationScore, seniorityScore, matched, missing: missing.slice(0, 8), reasons };
}

/**
 * Rank rows against a saved profile. Keyword score always; when Ollama + the embedding model are available and the profile
 * has its source text, blend in semantic similarity (CV text vs "title at company. description"), cached per job in SQLite.
 * Final = 0.5 keyword + 0.5 semantic. Optional per-company cap keeps one employer's board from swamping the list.
 */
export async function rankJobs(store: Store, rows: any[], profileName: string, opts: { semantic?: boolean; maxPerCompany?: number; log?: (m: string) => void } = {}): Promise<any[]> {
  const prof = store.getProfile(profileName);
  if (!prof) return rows;
  const p: Profile = prof.profile;
  const texts = new Map(store.texts(rows.map((r) => r.id)).map((t) => [t.id, t]));
  let ranked = rows.map((r) => ({ ...r, match: scoreJob({ ...r, description_text: texts.get(r.id)?.description_text ?? r.descriptionText ?? r.description_text }, p) }));

  const wantSemantic = opts.semantic !== false && !!prof.text && (await ollamaUp());
  if (wantSemantic) {
    const cached = store.getEmbeddings(ranked.map((r) => r.id), EMBED_MODEL);
    const todo = ranked.filter((r) => !cached.has(r.id)).slice(0, Number(process.env.JOBSCRAPE_EMBED_MAX ?? 400));
    if (todo.length) {
      opts.log?.(`embedding ${todo.length} new jobs with ${EMBED_MODEL}…`);
      const vecs = await embed(todo.map((r) => { const t = texts.get(r.id); return `${r.title} at ${r.company}. ${(t?.description_text ?? r.description_text ?? "").slice(0, 1200)}`; }));
      store.putEmbeddings(todo.map((r, i) => ({ id: r.id, vec: vecs[i] })), EMBED_MODEL);
      todo.forEach((r, i) => cached.set(r.id, vecs[i]));
    }
    const [cv] = await embed([`${p.summary}
${p.titles.join(", ")}
${prof.text.slice(0, 6000)}`]);
    if (cv.length) for (const r of ranked) {
      const v = cached.get(r.id);
      if (!v?.length) continue;
      const sem = cosineToPercent(cosine(cv, v));
      r.match.semantic = sem;
      r.match.score = Math.round(0.5 * r.match.keyword + 0.5 * sem);
      if (sem >= 60) r.match.reasons.push("semantically close");
    }
  }
  ranked.sort((a, b) => b.match.score - a.match.score);
  if (opts.maxPerCompany) {
    const counts = new Map<string, number>();
    ranked = ranked.filter((r) => { const k = r.company.toLowerCase(); const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n <= opts.maxPerCompany!; });
  }
  return ranked;
}

/** Build a SearchQuery-ish object from a profile. */
export function queryFromProfile(p: Profile) {
  return { keywords: p.keywords[0] ?? p.titles[0] ?? p.skills.slice(0, 2).join(" "), location: p.locations[0], country: p.country ?? undefined,
    remote: p.remotePreference, seniority: p.seniority, alternates: p.keywords.slice(1) };
}
