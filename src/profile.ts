// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";

/** What we know about a candidate (from a CV) or a role (from a JD). Drives search + matching. */
export const ProfileSchema = z.object({
  kind: z.enum(["cv", "jd"]),
  titles: z.array(z.string()).describe("Target or stated job titles, most relevant first (3-6)"),
  skills: z.array(z.string()).describe("Hard skills, tools, technologies, methodologies, domain knowledge"),
  seniority: z.enum(["entry", "mid", "senior", "lead", "any"]),
  yearsExperience: z.number().nullable(),
  locations: z.array(z.string()).describe("Cities/countries the person is in or the role is based in"),
  country: z.string().nullable().describe("ISO-3166 alpha-2 of the primary location"),
  remotePreference: z.enum(["remote", "hybrid", "onsite", "any"]),
  industries: z.array(z.string()),
  languages: z.array(z.string()).describe("Spoken languages"),
  keywords: z.array(z.string()).describe("Search keywords that would find matching jobs (2-4 short phrases)"),
  summary: z.string().describe("One-sentence summary"),
});
export type Profile = z.infer<typeof ProfileSchema>;

export async function readDocument(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: readFileSync(path) })).value;
  }
  return readFileSync(path, "utf8");
}

/** Heuristic extraction, no LLM required. Good enough to drive a search; the LLM path is much better at titles/seniority. */
export function extractProfileHeuristic(text: string, kind: "cv" | "jd"): Profile {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const t = text.replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  const skills = SKILLS.filter((s) => new RegExp(`(^|[^a-z0-9+#.])${escape(s.toLowerCase())}([^a-z0-9+#]|$)`).test(lower));

  // Titles: title-cased phrases ending in a role noun. Headline lines first, then "Title | Company" / "Title at Company" / "Title, Company (dates)" lines.
  const TITLE_RE = new RegExp(`\\b((?:(?:${TITLE_MODIFIERS.join("|")})\\s+)?(?:[A-Z][A-Za-z&/-]+\\s+){0,5}(?:${TITLE_WORDS.join("|")})(?:\\s+(?:of|&|and)\\s+[A-Z][A-Za-z&/-]+(?:\\s+[A-Z][A-Za-z&/-]+)?)?)\\b`, "g");
  const found: string[] = [];
  const head = lines.slice(0, 6).join(" ").replace(/\b[A-Z]{4,}\b/g, " "); // drop section headers like SUMMARY / EXPERIENCE
  for (const m of head.matchAll(TITLE_RE)) found.push(m[1]);
  for (const l of lines.slice(0, 200)) {
    if (!/\||\bat\b|–|—| - |\d{4}/.test(l)) continue;
    const left = l.split(/\s\|\s|\sat\s|\s[–—-]\s|,/)[0];
    for (const m of left.matchAll(TITLE_RE)) found.push(m[1]);
  }
  const clean = (x: string) => x.replace(/\s+/g, " ").trim();
  const bad = /\b(Certified|Administrator|Member|Award|University|Bachelor|Master|MBA)\b/;
  const titles = [...new Set(found.map(clean).filter((x) => x.split(" ").length >= 2 && !bad.test(x)))].slice(0, 6);

  const years = t.match(/(\d{1,2})\+?\s*(?:years|yrs|jahre)/i);
  const y = years ? Number(years[1]) : null;
  const seniority = /\b(head of|director|vp|chief|principal)\b/i.test(head) ? "lead" : /\bsenior|sr\.|lead\b/i.test(head) || (y ?? 0) >= 6 ? "senior" : /\bjunior|intern|graduate|entry/i.test(t) || (y !== null && y < 2) ? "entry" : "mid";
  const locations = LOCATIONS.filter((l) => new RegExp(`\\b${escape(l)}\\b`).test(lines.slice(0, 8).join(" "))).slice(0, 3);
  const allLocs = locations.length ? locations : LOCATIONS.filter((l) => lower.includes(l.toLowerCase())).slice(0, 3);
  const country = allLocs.map((l) => COUNTRY_OF[l]).find(Boolean) ?? null;
  const remote = /\bremote\b/i.test(t) ? (/\bhybrid\b/i.test(t) ? "hybrid" : "remote") : "any";

  // Search keywords: primary title without seniority words, plus its core noun phrase and a second title if any.
  const strip = (x: string) => clean(x.replace(new RegExp(`\\b(${TITLE_MODIFIERS.join("|")})\\b`, "gi"), ""));
  const core = (x: string) => strip(x).split(" ").slice(-3).join(" ");
  const keywords = [...new Set([titles[0] && strip(titles[0]), titles[0] && core(titles[0]), titles[1] && strip(titles[1])].filter(Boolean) as string[])].slice(0, 3);
  return { kind, titles, skills: [...new Set(skills)].slice(0, 40), seniority, yearsExperience: y, locations: allLocs, country, remotePreference: remote,
    industries: INDUSTRIES.filter((i) => lower.includes(i)), languages: LANGS.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(t)),
    keywords: keywords.length ? keywords : skills.slice(0, 2), summary: `${kind === "cv" ? "Candidate" : "Role"}: ${titles[0] ?? "unknown title"}, ${seniority}, ${skills.slice(0, 5).join(", ")}` };
}

/** LLM extraction with Claude when credentials are available; falls back to heuristics otherwise. */
export async function extractProfile(text: string, kind: "cv" | "jd", log?: (m: string) => void): Promise<{ profile: Profile; method: "claude" | "heuristic" }> {
  const heuristic = extractProfileHeuristic(text, kind);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && process.env.JOBSCRAPE_LLM !== "1") return { profile: heuristic, method: "heuristic" };
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: process.env.JOBSCRAPE_MODEL ?? "claude-opus-5",
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(ProfileSchema), effort: "low" },
      system: `You extract structured job-search profiles from ${kind === "cv" ? "CVs/resumes" : "job descriptions"}. ` +
        `Infer target titles that a job board would use (not internal titles), normalise skills to common names, ` +
        `set country as ISO-3166 alpha-2, and propose 2-4 short search keywords (e.g. "product manager", "data engineer python").`,
      messages: [{ role: "user", content: `Document (${kind}):\n\n${text.slice(0, 60_000)}` }],
    });
    if (res.parsed_output) return { profile: { ...res.parsed_output, kind }, method: "claude" };
    log?.("Claude returned no parsed output; using heuristic profile");
  } catch (e) {
    log?.(`Claude extraction failed (${(e as Error).message}); using heuristic profile`);
  }
  return { profile: heuristic, method: "heuristic" };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TITLE_MODIFIERS = ["Senior", "Junior", "Lead", "Principal", "Staff", "Associate", "Chief", "Head of", "Global", "Sr\\.?", "Jr\\.?"];
const TITLE_WORDS = ["Consultant", "Engineer", "Developer", "Manager", "Analyst", "Scientist", "Designer", "Architect", "Director", "Lead", "Leader", "Specialist", "Coordinator", "Advisor", "Owner", "Strategist", "Executive", "Partner", "Officer", "Recruiter", "Researcher", "Technician", "Nurse", "Teacher", "Accountant", "Administrator"];
const _TITLE_WORDS_LOWER = ["engineer", "developer", "manager", "analyst", "scientist", "designer", "consultant", "architect", "director", "lead", "specialist", "coordinator", "administrator", "accountant", "recruiter", "marketer", "nurse", "teacher", "technician", "researcher", "owner", "strategist", "executive"];
const SKILLS = ["Python", "JavaScript", "TypeScript", "Java", "C++", "C#", "Go", "Rust", "Ruby", "PHP", "Swift", "Kotlin", "SQL", "NoSQL", "React", "Angular", "Vue", "Node.js", "Next.js", "Django", "Flask", "FastAPI", "Spring", ".NET", "Rails", "GraphQL", "REST", "Docker", "Kubernetes", "Terraform", "AWS", "Azure", "GCP", "Linux", "Git", "CI/CD", "Jenkins", "GitHub Actions", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "Spark", "Hadoop", "Airflow", "dbt", "Snowflake", "BigQuery", "Databricks", "Tableau", "Power BI", "Looker", "Excel", "Pandas", "NumPy", "scikit-learn", "TensorFlow", "PyTorch", "Machine Learning", "Deep Learning", "NLP", "LLM", "Computer Vision", "Data Analysis", "Data Engineering", "ETL", "Statistics", "A/B Testing", "Product Management", "Project Management", "Agile", "Scrum", "Kanban", "Jira", "Confluence", "Salesforce", "SAP", "HubSpot", "SEO", "SEM", "Google Analytics", "Content Marketing", "Figma", "Sketch", "Adobe XD", "Photoshop", "UX", "UI", "User Research", "Wireframing", "Prototyping", "Stakeholder Management", "Business Analysis", "Requirements", "Process Design", "Six Sigma", "Lean", "Supply Chain", "Procurement", "Finance", "Accounting", "Budgeting", "Forecasting", "Financial Modelling", "Compliance", "GxP", "GMP", "Validation", "Regulatory Affairs", "Clinical", "Pharma", "Veeva", "Vault", "CRM", "ERP", "Change Management", "Workshop Facilitation", "Consulting", "Strategy", "OKRs", "Roadmap", "Go-to-Market", "B2B", "SaaS", "Cybersecurity", "Networking", "DevOps", "SRE", "Microservices", "System Design", "Testing", "QA", "Selenium", "Cypress", "Playwright", "Mobile", "iOS", "Android", "Flutter", "React Native", "Blockchain", "Solidity", "German", "English", "French", "Spanish",
  "Target Operating Model", "Operating Model", "Process Architecture", "Business Process", "Process Design", "Process Mining", "Process Improvement", "Business Transformation", "Digital Transformation", "Transformation", "Governance", "Value Realization", "Regulatory", "Quality Management", "Agentic AI", "Generative AI", "n8n", "Automation", "RPA", "Power Platform", "Power Automate", "BPMN", "Lean Six Sigma", "PMP", "PRINCE2", "SAFe", "Clinical Operations", "Medical Affairs", "Commercial Operations", "Pharmacovigilance", "R&D", "Signavio", "Celonis", "ServiceNow", "Workday", "Microsoft 365", "PowerPoint", "Program Management", "Portfolio Management", "Vendor Management", "Business Development", "Pre-sales", "Proposal", "C-suite", "Executive Presentation", "Life Sciences", "Biopharma", "Operations"];
const INDUSTRIES = ["pharma", "pharmaceutical", "biotech", "healthcare", "fintech", "banking", "insurance", "automotive", "e-commerce", "retail", "logistics", "saas", "consulting", "telecom", "energy", "manufacturing", "media", "gaming", "education", "public sector", "life sciences", "medical devices"];
const LANGS = ["English", "German", "French", "Spanish", "Italian", "Dutch", "Portuguese", "Hindi", "Punjabi", "Mandarin", "Japanese", "Arabic"];
const COUNTRY_OF: Record<string, string> = { Germany: "DE", Berlin: "DE", Munich: "DE", München: "DE", Hamburg: "DE", Frankfurt: "DE", Cologne: "DE", Stuttgart: "DE", Düsseldorf: "DE", Austria: "AT", Vienna: "AT", Switzerland: "CH", Zurich: "CH", Basel: "CH", "United Kingdom": "GB", London: "GB", Manchester: "GB", "United States": "US", "New York": "US", "San Francisco": "US", Seattle: "US", Austin: "US", Boston: "US", Chicago: "US", India: "IN", Bangalore: "IN", Bengaluru: "IN", Mumbai: "IN", Delhi: "IN", Hyderabad: "IN", Pune: "IN", Chandigarh: "IN", Canada: "CA", Toronto: "CA", Vancouver: "CA", Netherlands: "NL", Amsterdam: "NL", France: "FR", Paris: "FR", Spain: "ES", Madrid: "ES", Barcelona: "ES", Ireland: "IE", Dublin: "IE", Singapore: "SG", Australia: "AU", Sydney: "AU", UAE: "AE", Dubai: "AE", Sweden: "SE", Stockholm: "SE", Poland: "PL", Warsaw: "PL", Italy: "IT", Milan: "IT" };
const LOCATIONS = Object.keys(COUNTRY_OF);
