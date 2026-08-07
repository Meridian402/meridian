// Merd's Telegram voice: a compact desk update to the Meridian group every
// cycle, composed by the same copywriter agent that runs his X presence, from
// the same real data (book, fees, revenue, the journal), under the same
// rules: no invented numbers, no yield promises, stops told straight.
//
// DORMANT until armed: exits quietly unless MERD_TG_BOT_TOKEN and
// MERD_TG_CHAT_ID are set. DRY_RUN=1 composes and prints without sending.
// State (last send, last book) lives in merd-telegram-state.json so an
// unchanged desk skips a cycle instead of repeating itself.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { GatewayClient } from "@openhermit/sdk";

const TOKEN = process.env.MERD_TG_BOT_TOKEN;
const CHAT = process.env.MERD_TG_CHAT_ID;
const DRY = process.env.DRY_RUN === "1";
const API = process.env.MERIDIAN_API_URL ?? "https://meridian402-api-production.up.railway.app";
const X_AGENT = process.env.MERD_X_AGENT_ID ?? "copywriter";
const STATE_PATH = new URL("./merd-telegram-state.json", import.meta.url);
const MIN_GAP_MIN = Number(process.env.MERD_TG_MIN_GAP_MIN ?? 240);

if (!DRY && (!TOKEN || !CHAT)) {
  console.log("[merd-tg] dormant: MERD_TG_BOT_TOKEN / MERD_TG_CHAT_ID not set");
  process.exit(0);
}

interface TgState {
  lastSentAt?: number;
  lastBook?: number;
  lastJournalTs?: number;
}
const state: TgState = existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as TgState) : {};

const j = async (path: string) => (await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20000) })).json();

const book = (await j("/api/book-history")) as { points?: { ts: number; book: number; feesUsd?: number }[] };
const pts = book.points ?? [];
const last = pts[pts.length - 1];
if (!last) {
  console.log("[merd-tg] no book data; skipping");
  process.exit(0);
}
const gapMin = (Date.now() - (state.lastSentAt ?? 0)) / 60000;
if (gapMin < MIN_GAP_MIN) {
  console.log(`[merd-tg] last update ${Math.round(gapMin)}m ago, floor ${MIN_GAP_MIN}m; holding`);
  process.exit(0);
}

const journal = (await j("/api/desk-journal")) as { entries?: { ts: number; kind?: string; pool?: string; venue?: string; reason?: string }[] };
const entries = (journal.entries ?? []).filter((e) => e.ts > (state.lastJournalTs ?? Date.now() - 6 * 3600e3));
// Nothing moved and nothing happened: stay quiet rather than repeat.
if (entries.length === 0 && state.lastBook != null && Math.abs(last.book - state.lastBook) < 5) {
  console.log("[merd-tg] desk unchanged; staying quiet this cycle");
  process.exit(0);
}

const dayStart = pts.find((p) => new Date(p.ts).toDateString() === new Date().toDateString()) ?? pts[0];
const feesToday = (last.feesUsd ?? 0) - (dayStart.feesUsd ?? 0);
const events = entries
  .slice(-6)
  .map((e) => `${new Date(e.ts).toISOString().slice(11, 16)}utc ${e.kind ?? "rotate"} ${e.pool ?? e.venue ?? ""}${e.reason ? ` (${e.reason})` : ""}`);

const prompt = `Write ONE short Telegram update for the Meridian community group, as Merd, the agent who runs this desk. Plain text, no markdown, no hashtags, 2-4 sentences, lowercase style is fine. Numbers below are real; use at most two of them, never promise yield, never hype. If a stop-loss happened, say it plainly.

book now: $${last.book.toFixed(2)}
lp fees earned today: $${feesToday.toFixed(2)}
recent desk events (utc):
${events.join("\n") || "(quiet: no events since the last update)"}

End with one short observation in your own voice, the kind you'd actually think.`;

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const sid = `tg-${new Date().toISOString().slice(0, 10)}`;
await gw.agent(X_AGENT).openSession({ sessionId: sid, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(X_AGENT).postMessageSync(sid, { text: prompt }, { timeout: 90000 });
const text = (resp?.text ?? "").trim().replace(/^["']|["']$/g, "");
if (!text || text.length > 900) {
  console.error(`[merd-tg] draft unusable (${text.length} chars); skipping`);
  process.exit(0);
}

if (DRY) {
  console.log("[merd-tg] DRY RUN, would send:\n" + text);
  process.exit(0);
}

const res = (await (
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000),
  })
).json()) as { ok: boolean; description?: string };
if (!res.ok) {
  console.error(`[merd-tg] send failed: ${res.description}`);
  process.exit(1);
}
writeFileSync(STATE_PATH, JSON.stringify({ lastSentAt: Date.now(), lastBook: last.book, lastJournalTs: entries.length ? entries[entries.length - 1].ts : state.lastJournalTs }));
console.log("[merd-tg] sent:\n" + text);
