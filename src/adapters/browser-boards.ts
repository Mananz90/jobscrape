import type { SourceAdapter, SearchQuery, RawJob, FetchContext } from "../types.ts";
import type { Page } from "playwright";
import { withPage, waitForChallenge, humanPause, openWithEscalation, requireHeadful } from "../browser.ts";
import { INDEED_HOSTS, GLASSDOOR_HOSTS } from "../regions.ts";

/**
 * Real-browser adapters for the three boards that resist plain HTTP. They share one persistent Chromium profile, so a
 * one-time manual login (`node src/index.ts login linkedin`) unlocks the logged-in experience, and Cloudflare clearance
 * cookies persist between runs. Each opens the board's regional edition for the requested country.
 */
const days = (q: SearchQuery) => ({ "24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30 } as Record<string, number>)[q.postedWithin ?? ""];
const browserAdapter = (a: Omit<SourceAdapter, "fetchJobs" | "keyKind" | "kind">): SourceAdapter => ({
  ...a, keyKind: "none", kind: "board",
  async fetchJobs(cfg, ctx) { const q = cfg.options?.query as SearchQuery | undefined; if (!q) throw new Error(`${a.name} needs options.query`); return a.search!(q, ctx); },
});

// ---------------------------------------------------------------- LinkedIn
const TPR: Record<string, string> = { "24h": "r86400", "3d": "r259200", "7d": "r604800", "14d": "r1209600", "30d": "r2592000" };
const JT: Record<string, string> = { fulltime: "F", parttime: "P", contract: "C", internship: "I" };
const WT: Record<string, string> = { onsite: "1", remote: "2", hybrid: "3" };
const EXP: Record<string, string> = { entry: "2", mid: "3", senior: "4", lead: "5" };

export const linkedinBrowser = browserAdapter({
  name: "linkedin-browser",
  description: "LinkedIn via real browser (guest or your logged-in session). Scrolls the result list, opens each job for the description.",
  async search(q, ctx) {
    if (!q.location && q.regionLocations?.length) {
      const out: RawJob[] = [];
      for (const loc of q.regionLocations.slice(0, 8)) { try { out.push(...await linkedinBrowser.search!({ ...q, location: loc, regionLocations: undefined, limit: Math.max(25, Math.floor((q.limit ?? 50) / q.regionLocations.length)) }, ctx)); } catch (e) { ctx.log(`${loc}: ${(e as Error).message}`); break; } }
      return out;
    }
    const limit = Math.min(q.limit ?? 50, 300);
    const p = new URLSearchParams({ keywords: q.keywords.replace(/[&|/]+/g, " ").replace(/\s+/g, " ").trim() });
    if (q.location) p.set("location", q.location);
    if (q.postedWithin && TPR[q.postedWithin]) p.set("f_TPR", TPR[q.postedWithin]);
    if (q.jobType && JT[q.jobType]) p.set("f_JT", JT[q.jobType]);
    if (q.remote && WT[q.remote]) p.set("f_WT", WT[q.remote]);
    if (q.seniority && EXP[q.seniority]) p.set("f_E", EXP[q.seniority]);
    return withPage(async (page) => {
      await page.goto(`https://www.linkedin.com/jobs/search/?${p}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await humanPause(page);
      if (page.url().includes("/authwall") || page.url().includes("/login")) { await page.goto(`https://www.linkedin.com/jobs/search?${p}`, { waitUntil: "domcontentloaded" }); await humanPause(page); }
      const loggedIn = await page.locator("li[data-occludable-job-id]").count() > 0;
      ctx.log(loggedIn ? "using logged-in session" : "using guest view");
      const out = new Map<string, RawJob>();
      const collect = async () => {
        const cards = await page.evaluate(() => {
          const rows: any[] = [];
          document.querySelectorAll("li[data-occludable-job-id]").forEach((li) => {
            const id = li.getAttribute("data-occludable-job-id");
            const a = li.querySelector<HTMLAnchorElement>("a.job-card-list__title--link, a.job-card-container__link");
            rows.push({ id, title: a?.innerText?.split("\n")[0]?.trim(), company: li.querySelector(".artdeco-entity-lockup__subtitle, .job-card-container__primary-description")?.textContent?.trim(),
              location: li.querySelector(".job-card-container__metadata-item, .artdeco-entity-lockup__caption")?.textContent?.trim(), posted: li.querySelector("time")?.getAttribute("datetime") });
          });
          document.querySelectorAll("div.base-card[data-entity-urn], div.base-search-card[data-entity-urn]").forEach((c) => {
            rows.push({ id: c.getAttribute("data-entity-urn")?.split(":").pop(), title: c.querySelector(".base-search-card__title")?.textContent?.trim(),
              company: c.querySelector(".base-search-card__subtitle")?.textContent?.trim(), location: c.querySelector(".job-search-card__location")?.textContent?.trim(), posted: c.querySelector("time")?.getAttribute("datetime") });
          });
          return rows;
        });
        for (const c of cards) if (c.id && c.title && !out.has(c.id)) out.set(c.id, { externalId: c.id, title: c.title, company: c.company || "Unknown", url: `https://www.linkedin.com/jobs/view/${c.id}`, location: c.location || null, postedAt: c.posted || null, remote: q.remote === "remote" ? true : null });
      };
      for (let i = 0; i < 40 && out.size < limit; i++) {
        await collect();
        const before = out.size;
        if (loggedIn) {
          await page.locator(".jobs-search-results-list, .scaffold-layout__list > div").first().evaluate((el) => el.scrollBy(0, 2000)).catch(() => {});
          await humanPause(page, 800, 1500);
          await collect();
          if (out.size === before) { const next = page.locator("button[aria-label='View next page'], button.jobs-search-pagination__button--next"); if (await next.count() && await next.first().isEnabled()) { await next.first().click(); await humanPause(page, 1500, 2500); } else break; }
        } else {
          await page.mouse.wheel(0, 3000); await humanPause(page, 800, 1500);
          const more = page.locator("button.infinite-scroller__show-more-button:visible");
          if (await more.count()) { await more.first().click().catch(() => {}); await humanPause(page, 1000, 2000); }
          await collect();
          if (out.size === before) break;
        }
      }
      const jobs = [...out.values()].slice(0, limit);
      // Descriptions: open each job (capped) in the same tab.
      const details = Math.min(jobs.length, Number(process.env.JOBSCRAPE_BROWSER_DETAILS ?? 15));
      for (const j of jobs.slice(0, details)) {
        try {
          await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 45_000 }); await humanPause(page, 700, 1400);
          const d = await page.evaluate(() => {
            const el = document.querySelector(".show-more-less-html__markup, .jobs-description__content, #job-details");
            const crit: Record<string, string> = {};
            document.querySelectorAll(".description__job-criteria-item").forEach((li) => { crit[li.querySelector("h3")?.textContent?.trim().toLowerCase() ?? ""] = li.querySelector("span")?.textContent?.trim() ?? ""; });
            return { html: el?.innerHTML ?? null, crit };
          });
          j.descriptionHtml = d.html;
          for (const [k, v] of Object.entries(d.crit)) { if (k.includes("employment")) j.employmentType = v; if (k.includes("seniority")) j.department = v; }
        } catch (e) { const m = (e as Error).message; ctx.log(`detail ${j.externalId}: ${m.split("\n")[0]}`); if (!/ERR_ABORTED|Timeout/.test(m)) break; }
      }
      ctx.log(`${jobs.length} jobs, ${details} with descriptions`);
      return jobs;
    });
  },
});

// ---------------------------------------------------------------- Indeed
export const indeedBrowser = browserAdapter({
  name: "indeed-browser", needsHeadful: true,
  description: "Indeed via real Chrome on the country edition (de.indeed.com, uk.indeed.com, ...). Runs in a visible window: Indeed hard-blocks headless Chrome.",
  async search(q, ctx) {
    requireHeadful();
    const host = INDEED_HOSTS()[(q.country ?? "US").toUpperCase()] ?? "www.indeed.com";
    const limit = Math.min(q.limit ?? 50, 200);
    return withPage(async (page0) => {
      let page = page0;
      const out = new Map<string, RawJob>();
      for (let start = 0; start < limit; start += 10) {
        const p = new URLSearchParams({ q: q.keywords, start: String(start) });
        if (q.location) p.set("l", q.location);
        if (days(q)) p.set("fromage", String(days(q)));
        if (q.jobType && q.jobType !== "any") p.set("jt", q.jobType);
        if (q.remote === "remote") p.set("sc", "0kf:attr(DSQF7);");
        if (start === 0) page = await openWithEscalation(page, `https://${host}/jobs?${p}`, ctx.log);
        else { await page.goto(`https://${host}/jobs?${p}`, { waitUntil: "domcontentloaded", timeout: 60_000 }); if (!(await waitForChallenge(page))) break; }
        await humanPause(page);
        if (/secure\.indeed\.com\/auth/.test(page.url())) { ctx.log(`${host} asks for sign-in${start ? " beyond page 1" : ""}; run 'node src/index.ts login indeed' and sign in to get more pages and descriptions`); break; }
        await page.waitForSelector("a[data-jk], [data-jk], #mosaic-provider-jobcards", { timeout: 12_000 }).catch(() => {}); // cards render after DOMContentLoaded
        const rows: any[] = await page.evaluate(() => {
          // @ts-ignore
          const model = window.mosaic?.providerData?.["mosaic-provider-jobcards"]?.metaData?.mosaicProviderJobCardsModel?.results;
          if (model?.length) return model.map((r: any) => ({ id: r.jobkey, title: r.title, company: r.company, location: r.formattedLocation, remote: r.remoteLocation, salaryMin: r.extractedSalary?.min, salaryMax: r.extractedSalary?.max, snippet: r.snippet, posted: r.pubDate }));
          const dom: any[] = [];
          const rel = (t: string | null | undefined) => { const m = t?.match(/(\d+)\+?\s*(day|tag|jour|día|dag|giorn)/i); if (!m) return /today|heute|just posted|gerade|aujourd/i.test(t ?? "") ? (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); })() : null; return (() => { const d = new Date(Date.now() - Number(m[1]) * 864e5); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); })(); };
          document.querySelectorAll("a[data-jk], [data-jk]").forEach((el) => {
            const jk = el.getAttribute("data-jk");
            const card = el.closest(".job_seen_beacon, li, .cardOutline") ?? el;
            const titleEl = el.tagName === "A" ? el : card.querySelector("h2 a, a.jcs-JobTitle, .jobTitle a");
            const title = titleEl?.querySelector("span[title]")?.getAttribute("title") ?? titleEl?.textContent?.trim();
            if (!jk || !title || dom.some((d) => d.id === jk)) return;
            dom.push({ id: jk, title, company: card.querySelector("[data-testid='company-name'], .companyName")?.textContent?.trim(),
              location: card.querySelector("[data-testid='text-location'], .companyLocation")?.textContent?.trim(),
              salary: card.querySelector("[data-testid='attribute_snippet_testid'], .salary-snippet-container, .estimated-salary")?.textContent?.trim(),
              snippet: card.querySelector("[data-testid='jobsnippet'], .job-snippet, [class*='jobsnippet']")?.textContent?.trim(),
              posted: rel(card.querySelector("[data-testid='myJobsStateDate'], .date, [class*='date']")?.textContent) });
          });
          return dom;
        });
        if (!rows.length) break;
        for (const r of rows) if (r.id && r.title && !out.has(r.id)) out.set(r.id, { externalId: r.id, title: r.title, company: r.company || "Unknown", url: `https://${host}/viewjob?jk=${r.id}`, location: r.location || null, remote: r.remote ?? null, country: (q.country ?? "US").toUpperCase(),
          salaryMin: r.salaryMin ?? null, salaryMax: r.salaryMax ?? null, descriptionText: [r.snippet?.replace(/<[^>]+>/g, " "), r.salary ? `Salary: ${r.salary}` : null].filter(Boolean).join("\n") || null, postedAt: r.posted ? new Date(r.posted).toISOString() : null, raw: r });
        if (rows.length < 10) break;
      }
      const jobs = [...out.values()].slice(0, limit);
      const details = Math.min(jobs.length, Number(process.env.JOBSCRAPE_BROWSER_DETAILS ?? 15));
      for (const j of jobs.slice(0, details)) {
        try {
          await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 45_000 }); await humanPause(page, 500, 1200);
          if (/secure\.indeed\.com\/auth/.test(page.url())) { ctx.log("descriptions need a signed-in Indeed session; skipping"); break; }
          j.descriptionHtml = await page.locator("#jobDescriptionText, [id*='jobDescription'], [class*='jobsearch-JobComponent-description']").first().innerHTML({ timeout: 8000 }).catch(() => null) as any;
        } catch { break; }
      }
      ctx.log(`${jobs.length} jobs from ${host}, ${details} with descriptions`);
      return jobs;
    });
  },
});

// ---------------------------------------------------------------- Glassdoor
export const glassdoorBrowser = browserAdapter({
  name: "glassdoor-browser", needsHeadful: true,
  description: "Glassdoor via real Chrome on the country edition (glassdoor.de, .co.uk, .co.in, ...). Visible window (headless is blocked); login modal is dismissed.",
  async search(q, ctx) {
    requireHeadful();
    const host = GLASSDOOR_HOSTS()[(q.country ?? "US").toUpperCase()] ?? "www.glassdoor.com";
    const limit = Math.min(q.limit ?? 50, 150);
    return withPage(async (page0) => {
      const p = new URLSearchParams({ "sc.keyword": q.keywords });
      if (q.location) p.set("locKeyword", q.location);
      if (days(q)) p.set("fromAge", String(days(q)));
      if (q.remote === "remote") p.set("remoteWorkType", "1");
      const page = await openWithEscalation(page0, `https://${host}/Job/jobs.htm?${p}`, ctx.log);
      await humanPause(page, 1500, 2500);
      // Glassdoor ignores free-text location in the URL; resolve the city to its internal locId via the site's autocomplete (same session, same cookies).
      const city = q.location?.split(",")[0]?.trim();
      if (city && !/^(germany|deutschland|united states|united kingdom|india|france|netherlands|canada|australia|switzerland|austria)$/i.test(city)) {
        try {
          const loc: any = await page.evaluate(async (term) => { const r = await fetch(`/autocomplete/location?locationTypeFilters=CITY,STATE,COUNTRY&caller=jobs&term=${encodeURIComponent(term)}`, { headers: { accept: "application/json" } }); return r.ok ? (await r.json())[0] ?? null : null; }, city);
          if (loc?.locationId) {
            p.set("locT", loc.locationType ?? "C"); p.set("locId", String(loc.locationId)); p.delete("locKeyword");
            await page.goto(`https://${host}/Job/jobs.htm?${p}`, { waitUntil: "domcontentloaded", timeout: 60_000 }); await humanPause(page, 1500, 2500);
            ctx.log(`location "${city}" → ${loc.longName ?? loc.locationName} (locId ${loc.locationId})`);
          } else ctx.log(`location "${city}" not found on ${host}; results are country-wide`);
        } catch (e) { ctx.log(`could not resolve location "${city}" (${(e as Error).message.split("\n")[0]}); results are country-wide`); }
      }
      const dismiss = async () => { for (const sel of ["button[alt='Close']", "[data-test='modal-close']", "button.CloseButton", "button[aria-label='Close']"]) { const b = page.locator(sel).first(); if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await humanPause(page, 300, 700); } } };
      await dismiss();
      const out = new Map<string, RawJob>();
      const collect = async () => {
        const rows: any[] = await page.evaluate(() => {
          const res: any[] = [];
          // 1) Apollo/Next data embedded in the page
          try {
            const nd = document.getElementById("__NEXT_DATA__")?.textContent;
            if (nd) {
              const state = JSON.parse(nd)?.props?.pageProps?.apolloCache ?? JSON.parse(nd)?.props?.pageProps?.apolloState ?? {};
              const walk = (o: any) => { if (!o || typeof o !== "object") return; if (o.__typename === "JobView" && o.job) { const h = o.header ?? {}; res.push({ id: String(o.job.listingId ?? h.jobLink?.match(/jl=(\d+)/)?.[1]), title: o.job.jobTitleText ?? h.jobTitleText, company: h.employerNameFromSearch ?? h.employer?.name, location: h.locationName, posted: h.ageInDays != null ? new Date(Date.now() - h.ageInDays * 864e5).toISOString() : null, salary: h.payPeriodAdjustedPay ? `${h.payPeriodAdjustedPay.p10}-${h.payPeriodAdjustedPay.p90} ${h.payCurrency}` : null, url: h.jobLink ? new URL(h.jobLink, location.origin).href : null, snippet: o.job.descriptionFragmentsText?.join(" ") }); } for (const v of Object.values(o)) walk(v); };
              walk(state);
            }
          } catch { /* fall through */ }
          if (res.length) return res;
          // 2) DOM
          document.querySelectorAll("li[data-jobid], li[data-test='jobListing']").forEach((li) => {
            const a = li.querySelector<HTMLAnchorElement>("a[data-test='job-title'], a[data-test='job-link']");
            res.push({ id: li.getAttribute("data-jobid") ?? a?.href.match(/jl=(\d+)/)?.[1], title: a?.textContent?.trim(), company: li.querySelector("[class*='EmployerProfile_compactEmployerName'], [data-test='employer-name'], .EmployerProfile_employerName")?.textContent?.trim().replace(/\s*\d[.,]\d\s*$/, ""), location: li.querySelector("[data-test='emp-location'], [class*='JobCard_location']")?.textContent?.trim(), salary: li.querySelector("[data-test='detailSalary'], [class*='JobCard_salaryEstimate']")?.textContent?.trim(), url: a?.href, posted: null, snippet: li.querySelector("[class*='JobCard_jobDescriptionSnippet']")?.textContent?.trim() });
          });
          return res;
        });
        for (const r of rows) if (r.id && r.title && !out.has(r.id)) out.set(r.id, { externalId: r.id, title: r.title, company: r.company || "Unknown", url: r.url ?? `https://${host}/job-listing/j?jl=${r.id}`, location: r.location || null, country: (q.country ?? "US").toUpperCase(), postedAt: r.posted, descriptionText: [r.snippet, r.salary ? `Salary: ${r.salary}` : null].filter(Boolean).join("\n") || null, raw: r });
      };
      await collect();
      for (let i = 0; i < 12 && out.size < limit; i++) {
        const before = out.size;
        const more = page.locator("button[data-test='load-more'], button:has-text('Show more jobs'), button:has-text('Mehr Jobs anzeigen')").first();
        if (!(await more.count())) break;
        await more.click().catch(() => {}); await humanPause(page, 1500, 2500); await dismiss(); await collect();
        if (out.size === before) break;
      }
      const jobs = [...out.values()].slice(0, limit);
      ctx.log(`${jobs.length} jobs from ${host}`);
      return jobs;
    });
  },
});
