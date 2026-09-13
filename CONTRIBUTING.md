# Contributing to jobscrape

The most valuable contribution is **a new source adapter**, because coverage is the thing that decides whether this is
useful to you. A source is one file and one line of registration. Bug reports that name the source and paste the error
are the next most valuable, because scrapers break quietly.

## Getting set up

```bash
npm install
node src/index.ts            # the wizard; everything works from here
npm run typecheck            # must be clean before you open a PR
tests/wizard-smoke.sh        # scripted end-to-end run of the wizard
```

Node 22.6 or newer is the only hard requirement: TypeScript runs natively, SQLite is built in, there is no build step
and no native modules. Three things are optional and degrade gracefully when absent:

| Optional | Gives you | Without it |
|---|---|---|
| `ollama pull nomic-embed-text` | semantic half of the match score | keyword scoring only |
| `npm run setup:scrapling` | headless Glassdoor via a Python sidecar | the visible-browser Glassdoor source |
| API keys in `.env` (see `.env.example`) | Adzuna, Jooble, USAJOBS, Google for Jobs, Apify boards | the keyless sources, which are most of them |

## Adding a source

Every source implements one interface, in `src/types.ts`:

```ts
export interface SourceAdapter {
  name: string;                 // unique; how users select it
  description: string;          // one line, shown by `node src/index.ts sources`
  kind?: "ats" | "board" | "aggregator" | "generic";
  keyKind: "slug" | "url" | "none";   // what `key` means: company slug, a URL, or nothing
  requires?: string[];          // env vars that must be set, e.g. ["APIFY_TOKEN"]
  needsHeadful?: boolean;       // true if the site hard-blocks headless browsers
  detect?: (careersUrl: string, html: string) => string | null;   // recognise your platform from a careers page
  search?: (q: SearchQuery, ctx: FetchContext) => Promise<RawJob[]>;  // query-driven sources
  fetchJobs: (cfg: SourceConfig, ctx: FetchContext) => Promise<RawJob[]>;  // configured sources
}
```

**Implement `fetchJobs` if the source is per-company** (an applicant tracking system), and **`search` as well if it
accepts a query** (a job board). A board that only supports search can make `fetchJobs` read `cfg.options.query` and
delegate; see `src/adapters/publicboards.ts` for that pattern in three lines.

Return `RawJob[]`. Only four fields are required, because `normalize()` derives the rest:

```ts
{ externalId, title, url, company }   // everything else is optional: location, remote,
                                      // employmentType, salaryMin/Max, descriptionHtml, postedAt, raw
```

Use the `ctx` helpers rather than `fetch` directly. `ctx.fetchJson` and `ctx.fetchText` give you per-host throttling,
retries with backoff, `Retry-After` handling and user-agent rotation for free. `ctx.log` writes progress the wizard and
the daily run both display.

Then register it in two places:

1. `src/adapters/index.ts` — import it and add it to the array.
2. `src/regions.ts` — add a `COVERAGE` entry: `"global"`, or a list of ISO-3166 alpha-2 codes. This is what stops a
   search for India from wasting a request on a Germany-only board.

`src/adapters/publicboards.ts` is the shortest complete example. `src/adapters/greenhouse.ts` is the shortest ATS one.

### Before you open the PR

Run it against the live source and say what you saw. A one-line result is enough:

```
themuse: 14 jobs in 1.9s, Berlin query, descriptions present, second run 0 new (dedup works)
```

Adapters break when sites change, so a PR that says "compiles" tells us nothing. State the query you ran, how many jobs
came back, and whether a second run correctly reported zero new.

## Things this project will not do

These are settled, and a PR that crosses them will be declined however well it is written.

- **No CAPTCHA or bot-check solving.** When a site asks whether you are human, the app opens a window and waits for the
  person to answer. Scrapling's Cloudflare-solving option was evaluated and deliberately left switched off; the
  reasoning is in [CHALLENGES.md](CHALLENGES.md).
- **No credential entry.** The app never types a password. `login` opens the real site and the person signs in
  themselves; only the resulting cookies are stored, in a local browser profile.
- **No ignoring rate limits.** Per-host throttling, `Retry-After` and backoff are in `src/http.ts` and adapters go
  through it. If a source needs more volume, add a paid tier behind `requires`, do not hammer the free one.
- **No silent mass-closure.** A source that suddenly returns zero does not close everything it previously found. That
  guard lives in `src/runner.ts` and exists because a block looks exactly like an employer with no vacancies.

## Style

The codebase is dense on purpose and reads top to bottom. A few conventions worth matching:

- **Comments explain why, not what.** `// Lever sometimes streams very slowly; smaller pages get through where large
  ones time out.` is the register.
- **No build step.** Plain TypeScript that Node executes directly. `erasableSyntaxOnly` is on, so no enums, no
  parameter properties, no namespaces.
- **Fail loudly with a useful message.** `throw new Error("ADZUNA_APP_ID not set (free at https://developer.adzuna.com)")`
  beats a generic failure. The person reading it should know their next move.
- **Every source file carries the SPDX header.** Two lines, after the shebang if there is one.

## Reporting a broken source

Sites change and adapters rot. A good report names the source, the query and the output:

```bash
node src/index.ts search -k "your query" -c DE --sources <name> --limit 5
node src/index.ts health     # shows sources failing or whose fetch count halved
```

Paste both. `health` is often the faster diagnosis, because it compares against the last seven days rather than your
impression.

## Licence

Contributions are accepted under the **AGPL-3.0-or-later**, the same licence as the project, and you keep the copyright
in what you write. If a contribution is substantial, it is worth saying in the PR that you are happy for it to be
included in a commercially licensed version too, since the project offers that alongside the AGPL.
