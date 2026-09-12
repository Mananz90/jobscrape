/**
 * Local embeddings through Ollama (default model nomic-embed-text, 768-dim, runs on the Mac, nothing leaves the machine).
 * Used to add semantic similarity to the match score so "K8s" matches "Kubernetes" and "process architecture" matches
 * "operating model design". Optional: everything degrades to keyword scoring when Ollama is not running.
 */
const OLLAMA = process.env.OLLAMA_HOST?.replace(/\/$/, "") ?? "http://localhost:11434";
export const EMBED_MODEL = process.env.JOBSCRAPE_EMBED_MODEL ?? "nomic-embed-text";
let upCache: { at: number; up: boolean } | null = null;

export async function ollamaUp(): Promise<boolean> {
  if (process.env.JOBSCRAPE_SEMANTIC === "0") return false;
  if (upCache && Date.now() - upCache.at < 60_000) return upCache.up;
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const models: string[] = (await r.json()).models?.map((m: any) => m.name) ?? [];
    upCache = { at: Date.now(), up: r.ok && models.some((m) => m.startsWith(EMBED_MODEL)) };
  } catch { upCache = { at: Date.now(), up: false }; }
  return upCache.up;
}

/** Batch embed; returns Float32Array per input (empty array on failure). */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 2000));
    try {
      const r = await fetch(`${OLLAMA}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: EMBED_MODEL, input: batch }), signal: AbortSignal.timeout(120_000) });
      const data = await r.json();
      for (const v of data.embeddings ?? []) out.push(Float32Array.from(v));
      while (out.length < i + batch.length) out.push(new Float32Array());
    } catch { for (const _ of batch) out.push(new Float32Array()); }
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Map raw cosine (nomic: ~0.45 unrelated, ~0.8 near-duplicate) to a 0..100 scale. */
export const cosineToPercent = (c: number) => Math.round(Math.max(0, Math.min(1, (c - 0.45) / 0.35)) * 100);
