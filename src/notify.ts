import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** Telegram bot token: TELEGRAM_BOT_TOKEN, or read from a file (TELEGRAM_TOKEN_FILE, e.g. ~/.hermes/.env) so the secret is never copied. */
function telegramToken(): string | null {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const f = process.env.TELEGRAM_TOKEN_FILE?.replace(/^~/, process.env.HOME ?? "");
  if (!f) return null;
  try { return readFileSync(f, "utf8").match(/([0-9]{8,12}:[A-Za-z0-9_-]{30,})/)?.[1] ?? null; } catch { return null; }
}

export async function telegram(html: string): Promise<boolean> {
  const token = telegramToken(), chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: html.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(20_000) });
    return (await r.json()).ok === true;
  } catch (e) { console.error(`telegram failed: ${(e as Error).message}`); return false; }
}

/** New-job alerts: Telegram, webhook (Slack/Discord/generic JSON) and macOS desktop notification. `links` enables rich Telegram lines. */
export async function notify(title: string, lines: string[], links?: { title: string; company: string; url: string; score?: number; location?: string | null }[]) {
  const text = `${title}\n${lines.join("\n")}`;
  const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
  const tg = links?.length
    ? `<b>${esc(title)}</b>\n\n` + links.slice(0, 15).map((l) => `${l.score != null ? `${l.score}% · ` : ""}<a href="${esc(l.url)}">${esc(l.title.slice(0, 70))}</a>\n  ${esc(l.company)}${l.location ? ` · ${esc(l.location.slice(0, 40))}` : ""}`).join("\n")
    : `<b>${esc(title)}</b>\n${lines.map(esc).join("\n")}`;
  if (await telegram(tg)) console.log("telegram alert sent");
  const url = process.env.JOBSCRAPE_WEBHOOK_URL;
  if (url) {
    try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text.slice(0, 1900) }) }); }
    catch (e) { console.error(`webhook failed: ${(e as Error).message}`); }
  }
  if (process.platform === "darwin" && process.env.JOBSCRAPE_DESKTOP_NOTIFY !== "0") {
    execFile("osascript", ["-e", `display notification ${JSON.stringify(lines.slice(0, 3).join(" · ").slice(0, 200))} with title ${JSON.stringify(title)}`], () => {});
  }
}
