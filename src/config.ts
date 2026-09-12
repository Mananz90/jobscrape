import { readFileSync, writeFileSync } from "node:fs";
import type { SourceConfig } from "./types.ts";
const PATH = process.env.JOBSCRAPE_SOURCES ?? "config/sources.json";
export function loadSources(): SourceConfig[] { return JSON.parse(readFileSync(PATH, "utf8")); }
export function addSource(cfg: SourceConfig) {
  const list = loadSources();
  if (list.some((s) => s.adapter === cfg.adapter && s.key === cfg.key)) return false;
  list.push(cfg);
  writeFileSync(PATH, JSON.stringify(list, null, 2) + "\n");
  return true;
}
