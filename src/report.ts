// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Manandeep Gill
/** Self-contained dark HTML report (portable; open anywhere, no server). */
const esc = (s: unknown) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
export function htmlReport(rows: any[], meta: string): string {
  const withMatch = rows.some((r) => r.match);
  const tr = rows.map((j, i) => `<tr class="${j.match?.score >= 70 ? "hi" : ""}"><td>${i + 1}</td>${withMatch ? `<td class=m title="${esc(j.match?.reasons?.join(", "))}">${j.match ? j.match.score + "%" : ""}${j.match?.semantic != null ? `<small> · sem ${j.match.semantic}%</small>` : ""}</td>` : ""}` +
    `<td><a href="${esc(j.url)}" target=_blank>${esc(j.title)}</a>${j.isNew ? ' <span class=badge>NEW</span>' : ""}${j.status ? ` <span class=badge>${esc(j.status)}</span>` : ""}${j.verified === false ? ' <span class=dead>dead link</span>' : ""}</td><td>${esc(j.company)}</td><td>${esc(j.location ?? "")}${(j.remote === 1 || j.remote === true) ? " 🏠" : ""}</td>` +
    `<td>${esc((j.posted_at ?? j.postedAt ?? j.first_seen ?? "").slice(0, 10))}</td><td><span class=src>${esc(j.source)}</span></td>${withMatch ? `<td class=sk>${esc(j.match?.matched?.slice(0, 6).join(", "))}</td><td class=sk>${esc(j.match?.missing?.slice(0, 4).join(", "))}</td>` : ""}</tr>`).join("\n");
  return `<!doctype html><meta charset=utf-8><title>jobscrape report</title><style>
body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:24px;background:#0f1115;color:#d7dae0}h1{font-size:20px;margin:0 0 4px}.meta{color:#8a90a0;margin-bottom:16px;font-size:13px}
table{border-collapse:collapse;width:100%}th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #23262e;vertical-align:top}th{position:sticky;top:0;background:#161920}tr:hover{background:#1a1e27}
a{color:#7ab4ff;text-decoration:none}a:hover{text-decoration:underline}.m{color:#7ee0a0;font-weight:600;white-space:nowrap}.src{background:#22262f;border-radius:4px;padding:2px 7px;font-size:11px;color:#9aa2b1}
.badge{background:#2f6b3a;color:#c6f0cd;border-radius:4px;padding:1px 6px;font-size:11px}.dead{color:#e07a7a;font-size:11px}.sk{color:#9aa2b1;font-size:12px}tr.hi td{background:#14201a}</style>
<h1>jobscrape — ${rows.length} jobs</h1><div class=meta>${esc(meta)} · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}</div>
<table><tr><th>#</th>${withMatch ? "<th>fit</th>" : ""}<th>Title</th><th>Company</th><th>Location</th><th>Posted</th><th>Source</th>${withMatch ? "<th>matched</th><th>missing</th>" : ""}</tr>${tr}</table>`;
}
