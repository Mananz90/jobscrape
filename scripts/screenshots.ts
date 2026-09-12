// Regenerates docs/img/*.png: node scripts/screenshots.ts <wizard-transcript.txt> <file:///…/digest.html> [profile-name]
// Needs `JOBSCRAPE_PORT=3215 node src/index.ts serve` running.
import { chromium } from "patchright";
import { readFileSync, writeFileSync } from "node:fs";
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
// 1) dashboard with a CV-ranked search
await page.goto("http://localhost:3215/", { waitUntil: "networkidle" });
await page.selectOption("#prof2", process.argv[4] ?? "");  // profile name to rank by, optional
await page.fill("#f input[name=q]", "consultant");
await page.click("#f button[type=submit], #f button:not([type=button])");
await page.waitForTimeout(2500);
await page.screenshot({ path: "docs/img/dashboard.png" });
// 2) the HTML digest report
await page.goto(process.argv[3]);  // file:// URL of a generated digest
await page.waitForTimeout(500);
await page.screenshot({ path: "docs/img/digest.png", clip: { x: 0, y: 0, width: 1280, height: 720 } });
// 3) wizard transcript rendered as a terminal
const transcript = readFileSync(process.argv[2], "utf8");
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const html = `<html><body style="margin:0;background:#0b0d12"><div style="width:1180px;margin:30px auto;background:#151821;border-radius:12px;box-shadow:0 20px 60px #0008;overflow:hidden;font:14px/1.45 'SF Mono',Menlo,monospace;color:#d7dae0">
<div style="background:#1f232e;padding:10px 14px;display:flex;gap:8px"><span style="width:12px;height:12px;border-radius:6px;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:6px;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:6px;background:#28c840"></span><span style="margin-left:12px;color:#8a90a0">jobscrape — node src/index.ts</span></div>
<pre style="margin:0;padding:18px 22px;white-space:pre-wrap">${esc(transcript).replace(/^(\? .*)$/gm, '<span style="color:#7ab4ff">$1</span>').replace(/^(Plan:.*)$/gm, '<span style="color:#febc2e">$1</span>').replace(/^(\d+ +\d+% +\d+%.*)$/gm, (m) => Number(m.split(/\s+/)[1]) >= 70 ? `<span style="color:#7ee0a0">${m}</span>` : m)}</pre></div></body></html>`;
await page.setContent(html);
await page.setViewportSize({ width: 1280, height: 900 });
await page.screenshot({ path: "docs/img/wizard.png", fullPage: true });
await b.close();
console.log("screenshots done");
