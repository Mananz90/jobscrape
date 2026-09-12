# Building an Apify-style job scraper for "all job boards and career pages": challenges and solutions

Short version: the hard part is not writing a scraper, it is operating thousands of them. The winning strategy is to
**avoid HTML scraping wherever a structured source exists** (ATS APIs, JSON-LD, feeds), reserve browsers and proxies
for the long tail, and invest most engineering effort in normalization, dedup, monitoring and self-healing.

## 1. Coverage: there is no "all"

**Challenge.** Millions of employers, thousands of job boards, dozens of applicant tracking systems (ATS), and a long
tail of hand-built career pages. A per-site scraper approach never finishes.

**Solutions.**
- **Scrape the ATS, not the company.** Roughly 70 to 80 percent of tech and mid-market employers use one of about 15
  ATSs (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio, Teamtailor, BambooHR, iCIMS, Workday,
  SuccessFactors, Taleo, Jobvite, Rippling). One adapter per ATS covers thousands of companies. Most have public,
  keyless JSON endpoints (implemented here for 7 of them).
- **Auto-detection + slug probing** (`detect` command) turns a careers URL into a configured source without a human
  writing a scraper. Stripe and Anthropic hide Greenhouse behind custom frontends; probing the API with the domain
  slug finds it anyway.
- **Generic fallback that leans on standards:** schema.org `JobPosting` JSON-LD is present on most career pages
  because Google for Jobs requires it. Sitemaps and RSS/XML feeds cover more. Only the residue needs custom code.
- **Discovery pipeline:** seed company lists from Crunchbase/LinkedIn/registers, find careers URLs via search or
  `/careers`, `/jobs` heuristics, run detection, queue the unresolved ones for LLM-assisted or manual adapter writing.

## 1b. "All companies in the world" is a discovery problem, not a scraping problem

**Challenge.** Nobody has a list. Company registers do not link to career pages, and career pages do not announce
which ATS they use.

**Solutions (implemented).**
- **Name → ATS resolution:** probe the public endpoints of seven ATSs with slugs derived from the name. Four of five
  German scale-ups resolved from their bare names in testing.
- **Search-engine discovery:** query `site:boards.greenhouse.io <keyword>` (and the other ATS hosts) to find boards
  by region or industry; Brave Search API when a key is present, DuckDuckGo HTML otherwise. "Berlin fintech" returned
  20 boards in one pass. Precision is imperfect (a few unrelated companies), so the wizard lets you pick.
- **Company packs:** curated lists shipped as plain text, importable in one command; easy to crowd-source.
- **Scope on purpose:** the wizard never launches a world-wide crawl. It asks for region, country, job type, dates
  and sources first, and the cost of the plan is visible before it runs.

## 2. Anti-bot defences on the big boards

**Challenge.** LinkedIn, Indeed, Glassdoor, ZipRecruiter and Workday-hosted pages use Cloudflare/Akamai/DataDome,
fingerprinting, rate limits, login walls and CAPTCHAs. LinkedIn also litigates.

**Solutions (implemented in this repo).**
- **LinkedIn:** the public "guest" search endpoint needs no login and returns 25 cards per page with filters for
  date, job type, work mode and seniority. It rate-limits after a few dozen requests, so the app keeps limits small,
  throttles per host, fetches full descriptions only for the first N results, and offers an Apify actor for volume.
- **Indeed:** direct fetches are blocked by Cloudflare from most networks (confirmed here). The adapter tries the
  embedded JSON on the search page first, detects the challenge page, and falls back to a pay-per-result Apify actor
  when `APIFY_TOKEN` is set. Otherwise it explains the situation and suggests Adzuna, Jooble or LinkedIn.
- **Glassdoor, ZipRecruiter, Naukri, StepStone:** Apify actors behind one generic adapter with a heuristic field
  mapper, so adding another actor-backed board is a six-line preset.
- **Aggregators with official APIs (Adzuna, Jooble, USAJOBS)** cover much of Indeed's inventory legally and cheaply.

**Further solutions.**
- **Prefer official channels:** Indeed Publisher/partner feeds, LinkedIn's partner programs, Adzuna/Jooble/
  CareerJet APIs, XML job feeds employers already publish for aggregators. Slower to get access, but stable and legal.
- **Politeness by default** (implemented: per-host delay, retries with backoff, `Retry-After` support, UA rotation,
  bounded concurrency). Many "blocks" are just rate limits.
- **Tiered fetching:** plain HTTP → HTTP with residential/rotating proxy → headless browser (Playwright, stealth
  patches) → browser with proxy. Escalate per source only when the cheaper tier fails; track cost per source.
- **Do not bypass CAPTCHAs or login walls.** Treat them as a signal to switch to an official source or drop the site.
- **Proxy hygiene:** session-sticky proxies per source, geo-matched to the job market, quota per provider.

## 3. JavaScript-rendered pages and infinite scroll

**Challenge.** Many career pages are SPAs (Workday, Phenom, Eightfold, custom React). The HTML has no jobs in it.

**Solutions.**
- **Find the XHR behind the page** (dev tools → Network) and call it directly; it is usually a JSON endpoint with
  pagination parameters. 10 to 100x cheaper than rendering. The ATS adapters here are exactly this.
- **Headless rendering as fallback** (`options.render = true` uses Playwright), with request interception to block
  images/fonts, a hard page budget, and `networkidle` waits.
- **Detect SPA shells** (`<div id="root"></div>` with no `JobPosting` text) at detection time so the right tier is
  chosen automatically.

## 4. Layout drift and silent breakage

**Challenge.** Sites change markup without notice. A scraper that returns zero results looks identical to a company
with no openings, and a mass "closed" event corrupts downstream data.

**Solutions.**
- **Zero-result guard** (implemented): refuse to close jobs when a source that had jobs returns none.
- **Per-run metrics** (`runs` table): fetched/inserted/updated/closed/duration/error. Alert on anomalies: fetched
  drops >50 percent vs. 7-day median, error streaks, duration spikes, field null-rate spikes (title present but
  location suddenly 100 percent null means a selector broke).
- **Contract tests per adapter** run on a schedule against live sources; snapshot tests against stored HTML.
- **Self-healing for the long tail:** when a generic adapter breaks, feed the new HTML plus the last known good
  output to an LLM to regenerate selectors or a JSON-LD/XHR strategy, then validate against the schema before
  promoting. Keep raw payloads (done) so history can be re-parsed after a fix.

## 4b. Turning a CV or a job description into a search

**Challenge.** Users do not think in boolean queries. A CV has 40 skills and five past titles; a JD has
responsibilities, nice-to-haves and a title nobody else uses. Boards want two or three keywords.

**Solutions (implemented).** Parse PDF/DOCX/text, extract a structured profile (target titles as boards phrase them,
normalized skills, seniority, location, remote preference, 2–4 search keywords) with Claude using a strict schema,
or with a dictionary-based heuristic when no key is configured. Pre-fill the wizard from the profile so the user
confirms rather than types. Score every result 0–100 from title overlap (40%), skills present in the description
(35%), location/remote fit (15%) and seniority distance (10%), and show matched vs. missing skills so the score is
explainable. Descriptions matter for skill scoring, so the app fetches them where the source allows.

## 5. Normalization: same job, fifty shapes

**Challenge.** Every source has its own schema. Location is free text ("Remote - US", "Berlin / Hybrid",
"NYC, SF or remote"), salary is a range in a sentence, employment type and seniority are inconsistent, dates are
missing or mean different things (posted vs. updated vs. reposted).

**Solutions.**
- **One canonical schema** (`src/types.ts`) with raw payload retained. Adapters map, `normalize()` derives.
- **Location:** rule-based parser first (implemented: country map, US state codes, remote keywords), then a geocoder
  (Nominatim/Mapbox/Google) with caching for the residue; store city/region/country codes plus a `remote` tri-state.
- **Salary:** regex for currency + range + period ("€60k–80k/yr", "$45/hr"), normalize to annual in original currency,
  keep the raw string. Comply with pay-transparency data where present (Ashby, Greenhouse expose structured comp).
- **Taxonomy:** map titles to a job family/seniority using a classifier (embedding nearest-neighbour or small LLM)
  with human-reviewed labels for the top few thousand titles.
- **Dates:** store what the source gives plus `first_seen` from your own crawl; the latter is the only reliable
  "posted" signal across sources.

## 6. Deduplication and lifecycle

**Challenge.** The same posting appears on the company page, three aggregators and a staffing agency's board, with
different titles and IDs. Reposts look like new jobs. Postings vanish without a "closed" event.

**Solutions.**
- **Source identity** `source:key:externalId` for exact dedup within a source (implemented).
- **Cross-source fingerprint** company + normalized title + location (implemented, `/api/duplicates`), then a
  second pass with description similarity (MinHash/SimHash or embeddings) for fuzzy matches; cluster into a
  canonical job with a preferred source order (employer page > ATS > aggregator).
- **Company entity resolution:** map "Bosch", "Robert Bosch GmbH", "BoschGroup" to one company via domain matching.
- **Lifecycle:** `first_seen`/`last_seen`/`closed_at` from your own crawls; treat "missing for N consecutive runs" as
  closed to survive one-off fetch failures; detect reposts by fingerprint reappearing after close.

## 7. Scale and cost

**Challenge.** 100k sources × hourly freshness is millions of fetches per day. Browser rendering costs 50 to 100x
plain HTTP. Storage of descriptions grows fast.

**Solutions.**
- **Adaptive scheduling:** crawl frequency proportional to observed change rate per source (a board that changes
  hourly gets hourly; a 10-person company gets daily). Use `ETag`/`If-Modified-Since` and content hashes
  (implemented) to skip unchanged pages.
- **Queue-based workers** (BullMQ/SQS/Temporal) with per-host concurrency limits and priority lanes, instead of the
  single-process loop here. The adapter interface does not change.
- **Storage:** Postgres for the catalogue, object storage for raw HTML/JSON, full-text search in Postgres or
  OpenSearch; compress descriptions.
- **Cost accounting per source** so you can decide what is worth a browser and a proxy.

## 8. Legal, ethical and compliance

**Challenge.** Terms of service, robots.txt, copyright in descriptions, GDPR when postings contain recruiter names
and emails, and the risk of being the target of anti-scraping litigation (hiQ v. LinkedIn settled; the CFAA
question is narrower now but ToS/contract claims remain).

**Solutions.**
- Prefer APIs, feeds and partner programs; honour `robots.txt` and rate limits; identify your bot in the UA for
  sites that allow crawling.
- Store and display facts (title, company, location, link) and link out for full descriptions where the source's
  terms restrict republication; keep descriptions internal for search/classification.
- Strip personal data (recruiter emails, phone numbers) unless there is a lawful basis; keep a takedown process.
- Get legal review of which large boards you scrape directly versus license.

## 9. Multi-language and multi-region

**Challenge.** Titles and locations in dozens of languages; date/number formats; regional boards (Naukri, StepStone,
Xing, Seek, Zhaopin) with their own defences.

**Solutions.** Language detection per posting; multilingual title classifier; locale-aware date parsing; geo-matched
proxies; regional adapter ownership.

## 10. Data quality and product trust

**Challenge.** Users notice stale, duplicate or wrongly located jobs immediately. Ghost jobs (evergreen postings
never filled) pollute results.

**Solutions.** Freshness SLAs per source tier; expose `last_verified` to users; ghost-job heuristics (open > 90 days,
reposted repeatedly, identical text across many locations); user feedback loop feeding source-level quality scores.

## 11. Real browsers for the hostile boards: what actually works

Tested from a residential Mac in Germany, September 2026:

| board | plain HTTP | headless Chromium | headless real Chrome | visible real Chrome |
|---|---|---|---|---|
| LinkedIn (guest search) | works, ~25/page, rate-limited | works, scrolls to 300, full descriptions | works | works, plus logged-in view after one manual login |
| Indeed (country editions) | 403 Cloudflare | "verification" wall | hard "Request Blocked" page even with clearance cookie | Turnstile checkbox **loops forever under stock Playwright** (CDP fingerprint); passes with patchright + real Chrome + no emulation overrides; page 2+ and descriptions need sign-in |
| Glassdoor (country editions) | 403 Cloudflare | "Nur für Menschen" wall | wall | as Indeed; then ~30 cards per page, "show more" pagination; city must be set through the page's own location box |

**Scrapling (Python) tested on the same boards:** its `Fetcher` (curl_cffi with a Chrome TLS/HTTP2 fingerprint) gets
Glassdoor's German listing with a 200 and 30 cards per page, no browser at all, which is why `glassdoor` now runs
headless through a small Python sidecar. The same request to Indeed gets a 403 "Security Check", and Scrapling's
stealth Firefox (Camoufox) gets the "Just a moment" interstitial; Scrapling only passes Indeed when its option that
automates the Turnstile check is switched on. That option is not used here: automating a human-verification step is
the line this project does not cross, for personal use and even more so for a product. Indeed stays on the
visible-window path where the user passes the check once. Scrapling's other asset, adaptive selectors that relocate
elements after markup changes, is available through the bridge's `extract` mode for future adapters.

The single most important finding: **the checkbox looping is not the user failing the check, it is the site detecting
the automation layer**. Stock Playwright, even visible and on real Chrome, was rejected every time; patchright with a
clean profile and no user-agent, locale or timezone overrides passed on the first click. Emulation overrides that
look harmless (`locale`, `timezoneId`) are CDP commands and are part of the fingerprint.

Design that follows from this (implemented):
- **One persistent browser profile** (`data/browser-profile`): cookies, Cloudflare clearance and logins survive between runs.
- **Escalation, not evasion:** start headless; if a challenge appears and a human is at the terminal, re-open the page in a
  visible window and wait for them to pass it once. We never solve CAPTCHAs programmatically. Unattended runs
  (`serve`, `schedule`) fail fast with a message instead.
- **`login <site>`** opens the site's login page in the visible window; the app never sees the password.
- **Regional editions:** each board is opened on its country site (de.indeed.com, glassdoor.co.uk, ...) and each source
  declares its coverage, so a search for India never hits StepStone and a search for Germany never hits USAJOBS.
- **Cheap tiers first:** LinkedIn guest HTTP for quick checks, browser for depth, Apify actors for volume without a
  local browser.

## 12. From personal tool to commercial product

What is fine for one person's job hunt is not automatically fine for a product. The main differences:

- **Legal exposure changes.** Scraping LinkedIn, Indeed and Glassdoor with a personal account for personal use is
  low-risk; doing it for paying customers invites ToS enforcement, account bans and, for LinkedIn, litigation.
  A product should move those three to licensed data or partner APIs (Indeed Publisher program, LinkedIn Talent
  partners, Glassdoor/Indeed via their parent's programs), keep the browser tier as a customer-side "bring your own
  session" feature, and lean on sources that permit commercial use (ATS public APIs, Adzuna, Jooble, Apify actors
  where the actor's terms allow). Descriptions are copyrighted: index them, show snippets, link out.
- **GDPR.** Postings contain recruiter names and contact details, CVs are special-category-adjacent personal data.
  You need a lawful basis, retention limits, deletion, and a processor agreement with whoever hosts the LLM.
  Keep CV text on the customer's side or encrypt it at rest; never log it.
- **Multi-tenancy.** Profiles, saved searches, statuses and browser sessions become per-user rows; the SQLite file
  becomes Postgres; the single-process runner becomes a queue with per-host rate limits shared across all tenants
  (one customer's burst must not get everyone blocked).
- **Cost model.** Browser minutes and Apify results have real costs per search; price per seat with fair-use caps or
  pass through per-result pricing. Show the estimated cost before running, as the wizard does with its plan.
- **Reliability engineering.** Adapter contract tests on a schedule, anomaly alerts on fetched-count drops,
  raw-payload retention for re-parsing, and an LLM-assisted repair loop for selector drift (section 4).
- **Product surface.** The CLI wizard becomes an onboarding flow; the REST API already exists and is the integration
  point; add auth, webhooks and CSV/ATS exports. The matching engine (profile + explainable score) is the
  differentiator; invest in evaluation data (which matches users actually applied to) before adding more sources.

The code is structured to keep that path open: sources are plugins behind one interface, search and ranking are
separate modules, storage is behind one class, and every job keeps its raw payload.

## 13. Lessons merged from the earlier Python prototype (jobsnag)

A first Python attempt at the same idea lived in `~/jobsnag`. Its README documented Indeed and Glassdoor as
"blocked on every route", which jobscrape has since solved (visible-window Chrome for Indeed, TLS-fingerprinted
HTTP for Glassdoor). What it did better was folded in here: local embedding-based semantic matching (Ollama,
`nomic-embed-text`) blended with keyword scoring; a Workday adapter with a verified tenant registry, which is how big
pharma publishes jobs; Telegram alerts; live-link verification so dead postings drop out of digests; a per-company
cap so one employer's board does not swamp a list; whole-region fan-out for LinkedIn; a portable dark HTML report;
and a double-click launcher. Its remaining code is superseded and kept only for reference.

A second pass over jobsnag later the same day found that most of its newer files were a port of jobscrape back into
Python (its own summaries say so), so only the leftover ideas were taken: anomaly detection on the run metrics
(`health` command and daily alert when a source fails or its fetch count halves), a 40-day age ceiling on digests, a
pause between LinkedIn searches, country tagging for bare city names on regional editions, region term lists for
whole-region filtering, a "new" marker in results, an in-wizard link check, and a scripted smoke test of the wizard.
Its Workable endpoint was compared against ours and returned fewer jobs, so ours stays.

## Suggested roadmap

1. **Now (this repo):** ATS adapters + public boards + JSON-LD fallback + detection + SQLite + API. Enough for a
   focused vertical (e.g., tech jobs in DACH) with a few thousand companies.
2. **Next:** queue-based workers, Postgres, per-source scheduling, monitoring/alerts, proxy tiering, Playwright pool,
   more ATS adapters (Workday, Teamtailor, BambooHR, iCIMS, SuccessFactors), fuzzy dedup, company entity resolution.
3. **Later:** LLM-assisted adapter generation and repair for the long tail, title/seniority taxonomy, salary parsing,
   partner feeds for the major boards, public actor marketplace + billing if you want the Apify business model rather
   than just the tech.
