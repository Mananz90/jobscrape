// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
import { createServer } from "node:http";
import { Store } from "./store.ts";
import { runAll } from "./runner.ts";
import { runSearch, searchLocal } from "./search.ts";
import { loadSources } from "./config.ts";
import { adapters, searchAdapters } from "./adapters/index.ts";
import { rankJobs } from "./match.ts";
import { extractProfile } from "./profile.ts";

export function serve(store: Store, port = Number(process.env.JOBSCRAPE_PORT ?? 3210)) {
  const json = (res: any, body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body, null, 2)); };
  const readBody = (req: any) => new Promise<any>((resolve) => { let b = ""; req.on("data", (c: any) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
  const withMatch = async (rows: any[], profileName?: string | null) => profileName ? rankJobs(store, rows, profileName) : rows;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.searchParams;
    try {
      if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(DASHBOARD); }
      if (url.pathname === "/api/jobs") return json(res, await withMatch(store.query({
        q: p.get("q") ?? undefined, company: p.get("company") ?? undefined, country: p.get("country") ?? undefined, source: p.get("source") ?? undefined,
        since: p.get("since") ?? undefined, postedDays: p.get("days") ? Number(p.get("days")) : undefined, status: p.get("status") ?? undefined,
        remote: p.has("remote") && p.get("remote") ? p.get("remote") === "true" : undefined, includeClosed: p.get("closed") === "true",
        limit: Number(p.get("limit") ?? 100), offset: Number(p.get("offset") ?? 0),
      }) as any[], p.get("profile")));
      if (url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/status") && req.method === "POST") {
        const id = decodeURIComponent(url.pathname.slice(10, -7)); const b = await readBody(req); store.setStatus(id, b.status, b.notes); return json(res, { ok: true });
      }
      if (url.pathname.startsWith("/api/jobs/")) { const row: any = store.get(decodeURIComponent(url.pathname.slice(10))); return row ? json(res, { ...row, raw: row.raw ? JSON.parse(row.raw) : null }) : json(res, { error: "not found" }, 404); }
      if (url.pathname === "/api/stats") return json(res, store.stats());
      if (url.pathname === "/api/duplicates") return json(res, store.duplicates());
      if (url.pathname === "/api/sources") return json(res, { configured: loadSources(), adapters: Object.values(adapters).map((a) => ({ name: a.name, kind: a.kind, search: !!a.search, requires: a.requires ?? [], ready: (a.requires ?? []).every((k) => process.env[k]), description: a.description })) });
      if (url.pathname === "/api/profiles") return json(res, store.listProfiles());
      if (url.pathname === "/api/profiles" && req.method === "POST") { const b = await readBody(req); const r = await extractProfile(b.text, b.kind ?? "cv"); store.saveProfile(b.name, b.kind ?? "cv", r.profile, undefined, b.text); return json(res, r); }
      if (url.pathname === "/api/searches") return json(res, store.listSearches());
      if (url.pathname === "/api/search" && req.method === "POST") {
        const q = await readBody(req); const out = await runSearch(store, q);
        const rows = [...out.jobs, ...(q.includeLocal ? searchLocal(store, q) : [])];
        if (q.save) store.saveSearch(q.save, q);
        return json(res, { perSource: out.perSource, newIds: out.newIds.length, jobs: await withMatch(rows as any[], q.profile) });
      }
      if (url.pathname === "/api/run" && req.method === "POST") return json(res, await runAll(store, loadSources(), p.get("source") ?? undefined));
      json(res, { error: "not found" }, 404);
    } catch (e) { json(res, { error: (e as Error).message }, 500); }
  });
  server.listen(port, () => console.log(`jobscrape API + dashboard on http://localhost:${port}`));
  return server;
}

const DASHBOARD = `<!doctype html><title>jobscrape</title><meta name=viewport content="width=device-width">
<style>body{font:14px system-ui;margin:1.5rem;max-width:1200px;color:#222}input,select,button{padding:.4rem;margin:.15rem}table{border-collapse:collapse;width:100%;margin-top:1rem}td,th{padding:.35rem .5rem;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top}small{color:#777}.fit{font-weight:600}.hi{background:#eefbea}.st{font-size:11px;padding:1px 6px;border-radius:8px;background:#eee}#log{font:12px monospace;color:#666;white-space:pre-wrap;max-height:8em;overflow:auto}fieldset{border:1px solid #ddd;margin:.5rem 0}</style>
<h1>jobscrape</h1><div id=stats></div>
<fieldset><legend>Search the web now</legend><form id=s>
<input name=keywords placeholder="keywords / title" required><input name=location placeholder="city, country"><input name=country placeholder="CC" size=3>
<select name=remote><option value=any>any mode</option><option value=remote>remote</option><option value=hybrid>hybrid</option><option value=onsite>on-site</option></select>
<select name=jobType><option value=any>any type</option><option value=fulltime>full-time</option><option value=parttime>part-time</option><option value=contract>contract</option><option value=internship>internship</option></select>
<select name=postedWithin><option value=7d>last week</option><option value=24h>24h</option><option value=3d>3 days</option><option value=14d>2 weeks</option><option value=30d>month</option><option value=any>any time</option></select>
<select name=seniority><option value=any>any level</option><option value=entry>entry</option><option value=mid>mid</option><option value=senior>senior</option><option value=lead>lead</option></select>
<input name=limit type=number value=50 size=4><span id=srcs></span><select name=profile id=prof><option value="">no CV ranking</option></select><button>Search</button></form><div id=log></div></fieldset>
<fieldset><legend>Local database</legend><form id=f><input name=q placeholder="keyword"><input name=company placeholder="company"><input name=country placeholder="CC" size=3>
<select name=days><option value="">any date</option><option value=1>24h</option><option value=7>week</option><option value=30>month</option></select>
<select name=status><option value="">any status</option><option value=none>untracked</option><option>interested</option><option>applied</option><option>interview</option><option>offer</option><option>rejected</option></select>
<select name=remote><option value="">any</option><option value=true>remote</option><option value=false>on-site</option></select><select name=profile id=prof2><option value="">no CV ranking</option></select>
<button>Filter</button> <button type=button id=run>Refresh watched companies</button></form></fieldset>
<table><thead><tr><th>#</th><th>fit</th><th>Title</th><th>Company</th><th>Location</th><th>Posted</th><th>Source</th><th>Status</th></tr></thead><tbody id=rows></tbody></table>
<script>
const $=s=>document.querySelector(s);const rows=$('#rows');let last=[];
const STATUSES=['','interested','applied','interview','offer','rejected','skip'];
function render(jobs){last=jobs;rows.innerHTML=jobs.map((j,i)=>'<tr class="'+(j.match&&j.match.score>=70?'hi':'')+'"><td>'+(i+1)+'</td><td class=fit title="'+(j.match?j.match.reasons.join(', ')+' | missing: '+j.match.missing.join(', '):'')+'">'+(j.match?j.match.score+'%':'')+'</td><td><a href="'+j.url+'" target=_blank>'+esc(j.title)+'</a>'+(j.seen_on>1?' <small>×'+j.seen_on+'</small>':'')+(j.days_open>90?' <small title="open >90 days: possible ghost job">👻</small>':'')+'</td><td>'+esc(j.company)+'</td><td>'+esc(j.location||'')+((j.remote===1||j.remote===true)?' 🏠':'')+'</td><td><small>'+((j.posted_at||j.postedAt||j.first_seen)||'').slice(0,10)+'</small></td><td><small>'+j.source+'</small></td><td><select onchange="setStatus(\\''+j.id+'\\',this.value)">'+STATUSES.map(s=>'<option '+(s===(j.status||'')?'selected':'')+'>'+s+'</option>').join('')+'</select></td></tr>').join('')}
function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
async function setStatus(id,status){await fetch('/api/jobs/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status})});loadStats()}
async function loadStats(){const s=await(await fetch('/api/stats')).json();$('#stats').innerHTML='<b>'+s.open+'</b> open jobs · '+s.bySource.map(b=>b.source+' '+b.c).join(' · ')+'<br><small>tracked: '+(s.status.map(x=>x.status+' '+x.c).join(', ')||'none')+' · '+s.ghost+' possible ghost jobs (open >90d)</small>'}
async function loadMeta(){const m=await(await fetch('/api/sources')).json();$('#srcs').innerHTML=m.adapters.filter(a=>a.search).map(a=>'<label title="'+esc(a.description)+'"><input type=checkbox name=sources value="'+a.name+'" '+(a.ready&&!a.name.startsWith('apify-')&&a.name!=='indeed'?'checked':'')+(a.ready?'':' disabled')+'>'+a.name+(a.ready?'':' <small>(needs '+a.requires.join(',')+')</small>')+'</label> ').join('');
 const ps=await(await fetch('/api/profiles')).json();for(const el of[$('#prof'),$('#prof2')])el.innerHTML='<option value="">no CV ranking</option>'+ps.map(p=>'<option>'+p.name+'</option>').join('')}
async function loadLocal(){const q=new URLSearchParams(new FormData($('#f')));for(const[k,v]of[...q])if(!v)q.delete(k);render(await(await fetch('/api/jobs?'+q)).json())}
$('#f').onsubmit=e=>{e.preventDefault();loadLocal()};
$('#s').onsubmit=async e=>{e.preventDefault();const fd=new FormData($('#s'));const q=Object.fromEntries(fd);q.sources=fd.getAll('sources');q.limit=Number(q.limit);$('#log').textContent='searching '+q.sources.join(', ')+'…';
 const r=await(await fetch('/api/search',{method:'POST',body:JSON.stringify(q)})).json();$('#log').textContent=r.error||r.perSource.map(s=>s.source+': '+(s.error?'✗ '+s.error:s.count+' jobs')).join('\\n');if(r.jobs)render(r.jobs);loadStats()};
$('#run').onclick=async()=>{$('#run').textContent='Running…';await fetch('/api/run',{method:'POST'});$('#run').textContent='Refresh watched companies';loadLocal();loadStats()};
loadStats();loadMeta();loadLocal();
</script>`;
