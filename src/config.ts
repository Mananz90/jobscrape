import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import type { SourceConfig } from "./types.ts";

/**
 * The watched-company list is personal, so `config/sources.json` is gitignored. On first run it is seeded from
 * `config/sources.example.json`, which is the version in the repository.
 */
const PATH = process.env.JOBSCRAPE_SOURCES ?? "config/sources.json";
const EXAMPLE = "config/sources.example.json";
export function loadSources(): SourceConfig[] {
  if (!existsSync(PATH) && existsSync(EXAMPLE)) { copyFileSync(EXAMPLE, PATH); console.error(`created ${PATH} from ${EXAMPLE}`); }
  return JSON.parse(readFileSync(PATH, "utf8"));
}
export function addSource(cfg: SourceConfig) {
  const list = loadSources();
  if (list.some((s) => s.adapter === cfg.adapter && s.key === cfg.key)) return false;
  list.push(cfg);
  writeFileSync(PATH, JSON.stringify(list, null, 2) + "\n");
  return true;
}
