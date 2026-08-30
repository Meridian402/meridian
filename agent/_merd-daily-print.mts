// THE DAILY PRINT (operator-approved 2026-08-30). One post a day at 9:15am ET
// on @Meridian402: the prior day's CERTIFIED close as a card + a few plain
// lines, both filled only with numbers the public API already publishes.
//
// Design decisions, all deliberate:
// - Runs on a 15-minute launchd tick and gates itself: posts the first tick
//   at or after 9:15am ET, once per day. A Mac asleep at 9:15 posts on wake
//   instead of skipping the day.
// - The text is DETERMINISTIC: the operator approved these exact shapes, and
//   a daily accounting post is the one place a model's paraphrase can only
//   subtract (a wrong number in a daily print is a false market claim). Merd
//   still owns everything else he posts; this is the desk speaking.
// - Data failure means SILENCE, never improvisation: no certified row for
//   yesterday, no post today, said loudly in the log.
// - The card renders from the same figures through headless Chromium; a
//   render failure posts nothing (an image-first post without its image is
//   worse than a gap, same rule as xClient's media-first ordering).
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { postTweet } from "./src/social/xClient.js";
import { forbiddenReason } from "./src/social/postGuards.js";
import { appendLedger } from "./src/ledger.js";
import { dataPath } from "./src/dataDir.js";

const API = process.env.MERIDIAN_API_BASE ?? "https://meridian402-api-production.up.railway.app";
const DRY = process.env.DRY_RUN === "1";
const POST_HOUR = 9;
const POST_MINUTE = 15;

const ET = "America/New_York";
const etDay = (ts: number) => new Date(ts).toLocaleDateString("en-CA", { timeZone: ET });
const nowParts = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { hour: get("hour"), minute: get("minute") };
};

// ---- the once-a-day gate ----------------------------------------------------
const STATE = dataPath("daily-print-state.json");
const state: { lastPostedDay?: string } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const today = etDay(Date.now());
const { hour, minute } = nowParts();
if (!DRY) {
  if (hour < POST_HOUR || (hour === POST_HOUR && minute < POST_MINUTE)) {
    process.exit(0); // before the slot: quiet tick
  }
  if (state.lastPostedDay === today) process.exit(0); // already out today
}

// ---- yesterday's certified close -------------------------------------------
const yesterday = etDay(Date.now() - 24 * 3600e3);
const j = async (path: string) => (await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20000) })).json();

interface DayRow { date: string; lpFeesUsd: number; bookOpen: number; bookClose: number; stops: number; collects: number }
const consistency = (await j("/api/consistency")) as { days: DayRow[]; summary: { totalLpFeesUsd: number } };
const row = consistency.days.find((d) => d.date === yesterday);
if (!row) {
  console.error(`[daily-print] no certified row for ${yesterday}; staying silent today`);
  process.exit(1);
}
const dayN = consistency.days.findIndex((d) => d.date === yesterday) + 1;
const priorCloses = consistency.days.filter((d) => d.date < yesterday).map((d) => d.bookClose);
const newHigh = row.bookClose > Math.max(...priorCloses, 0);

const hist = (await j("/api/book-history?hours=54")) as { points: { ts: number; book: number; banked: number }[] };
const trace = hist.points.filter((p) => etDay(p.ts) === yesterday);
if (trace.length < 20) {
  console.error(`[daily-print] only ${trace.length} book marks for ${yesterday}; staying silent today`);
  process.exit(1);
}
const bankedPct = Math.round((trace[trace.length - 1].banked / trace[trace.length - 1].book) * 100);

// ---- the text, in the approved shapes ---------------------------------------
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fees = row.lpFeesUsd.toFixed(2);
const delta = row.bookClose - row.bookOpen;
const up = delta >= 0;
const o = money(row.bookOpen);
const c = money(row.bookClose);

let text: string;
if (!up) {
  // The red day, in the same plain voice as a green one. No spin.
  text = `Daily print, day ${dayN}.

+$${fees} in fees across ${row.collects} collects, ${row.stops} bounded exit${row.stops === 1 ? "" : "s"}.
Book $${o} to $${c}, down $${money(Math.abs(delta))} on the day.

The token side marked down harder than the fees earned back. Fees only go up; the marks breathe. Both numbers are on the site.`;
} else if (dayN % 2 === 0) {
  text = `day ${dayN}: +$${fees} fees, ${row.collects} collects, ${row.stops} stops, book closed at $${c}${newHigh ? ", a new high" : ""}.

the numbers are on the site, live, from chain.`;
} else {
  const stopsLine = row.stops === 0 ? "Zero stops." : `${row.stops} bounded exit${row.stops === 1 ? "" : "s"}, every one small by construction.`;
  text = `Daily print, day ${dayN}.

+$${fees} in fees across ${row.collects} collects. ${stopsLine}
Book $${o} to $${c}${newHigh ? ", a new high" : ""}.

Quiet days like this are the whole strategy.`;
}

const bad = forbiddenReason(text);
if (bad) {
  console.error(`[daily-print] guard refused the skeleton (${bad}); not posting`);
  process.exit(1);
}

// ---- the card ---------------------------------------------------------------
const W = 1040;
const H = 118;
const lo = Math.min(...trace.map((p) => p.book));
const hi = Math.max(...trace.map((p) => p.book));
const t0 = trace[0].ts;
const t1 = trace[trace.length - 1].ts;
const step = Math.max(1, Math.floor(trace.length / 100));
const pts = trace
  .filter((_, i) => i % step === 0 || i === trace.length - 1)
  .map((p) => `${(((p.ts - t0) / Math.max(t1 - t0, 1)) * W).toFixed(0)},${(H - ((p.book - lo) / Math.max(hi - lo, 1)) * (H - 10) - 5).toFixed(0)}`)
  .join(" ");
const last = pts.split(" ").pop()!;

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=JetBrains+Mono:wght@400;500;600;700&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 675px; background: #08090b; color: #f4f5ef; font-family: "JetBrains Mono", ui-monospace, monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; }
  .console { width: 1072px; border: 1px solid rgba(214,251,79,0.22); border-radius: 14px; background: #070a18; box-shadow: 0 30px 80px -30px rgba(0,0,0,0.9); }
  .chrome { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 1px solid rgba(214,251,79,0.1); font-size: 15px; color: #8b9081; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { margin-left: 10px; letter-spacing: 0.06em; }
  .day { margin-left: auto; }
  .bodyx { padding: 24px 40px 26px; }
  .prompt { font-size: 19px; color: #d6fb4f; margin-bottom: 14px; }
  .prompt span { color: #8b9081; }
  .fees { display: flex; align-items: baseline; gap: 26px; }
  .big { font-size: 80px; font-weight: 700; line-height: 1; color: ${up ? "#78f5aa" : "#f4f5ef"}; letter-spacing: -0.01em; }
  .side { font-size: 18px; color: #a7ab9e; line-height: 1.7; }
  .side b { color: #f4f5ef; }
  .tracewrap { margin: 20px 0 6px; }
  .tl { display: flex; justify-content: space-between; font-size: 15px; color: #8b9081; margin-top: 6px; }
  .tl b { color: ${up ? "#78f5aa" : "#e8a0a0"}; }
  .cols { display: flex; margin-top: 16px; border-top: 1px solid rgba(214,251,79,0.1); padding-top: 16px; }
  .col { flex: 1; }
  .col + .col { border-left: 1px solid rgba(214,251,79,0.1); padding-left: 34px; }
  .cv { font-size: 30px; font-weight: 600; }
  .cl { font-size: 14px; color: #8b9081; margin-top: 3px; }
  .within { display: flex; justify-content: space-between; align-items: baseline; margin-top: 18px; font-size: 15px; color: #8b9081; }
  .mark { font-family: "Fraunces", Georgia, serif; font-size: 23px; font-weight: 600; color: #f4f5ef; }
  .mark i { font-style: normal; color: #d6fb4f; }
</style></head><body>
<div class="console">
  <div class="chrome">
    <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
    <span class="title">meridian · the daily print</span><span class="day">${yesterday} · day ${dayN} live</span>
  </div>
  <div class="bodyx">
    <p class="prompt">$ meridian daily --close <span>· every line below settled on-chain</span></p>
    <div class="fees">
      <span class="big">+$${fees}</span>
      <span class="side">fees earned on the day<br/><b>${row.collects} collects</b> · <b>${row.stops} stop${row.stops === 1 ? "" : "s"}</b></span>
    </div>
    <div class="tracewrap">
      <svg width="1040" height="96" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#78f5aa" stop-opacity="0.2"/><stop offset="100%" stop-color="#78f5aa" stop-opacity="0"/></linearGradient></defs>
        <polygon fill="url(#g)" points="${pts} ${W},${H} 0,${H}"/>
        <polyline fill="none" stroke="#78f5aa" stroke-width="2.5" stroke-linejoin="round" points="${pts}"/>
        <circle cx="${last.split(",")[0]}" cy="${last.split(",")[1]}" r="5" fill="#78f5aa"/>
      </svg>
      <div class="tl"><span>the book, every mark of the day · opened $${o}</span><span>closed <b>$${c}</b>${newHigh ? " · a new high" : ""}</span></div>
    </div>
    <div class="cols">
      <div class="col"><div class="cv">$${money(consistency.summary.totalLpFeesUsd)}</div><div class="cl">total fees, ${consistency.days.length} days live</div></div>
      <div class="col"><div class="cv">${bankedPct}%</div><div class="cl">of the book banked, out of the desk's reach</div></div>
      <div class="col"><div class="cv">$997</div><div class="cl">ever put in</div></div>
    </div>
    <div class="within"><span class="mark"><i>◈</i> Meridian</span><span>every number read from chain by your browser · meridian402.xyz</span></div>
  </div>
</div>
</body></html>`;

const htmlPath = dataPath("daily-print-card.html");
const pngPath = dataPath(`daily-print-${yesterday}.png`);
writeFileSync(htmlPath, html);
execFileSync("npx", ["-y", "playwright@1.62.1", "screenshot", "--viewport-size=1200,675", "--wait-for-timeout=2500", `file://${htmlPath}`, pngPath], {
  stdio: "inherit",
  timeout: 120_000,
});

console.log(`[daily-print] card at ${pngPath}`);
console.log(`[daily-print] text:\n${text}\n`);

if (DRY) {
  console.log("[daily-print] DRY RUN, not posting.");
  process.exit(0);
}

const res = await postTweet(text, pngPath);
appendLedger("daily-print.jsonl", { ts: Date.now(), day: yesterday, posted: res.posted, id: res.posted ? res.id : undefined, reason: res.posted ? undefined : res.reason });
if (!res.posted) {
  console.error(`[daily-print] post failed: ${res.reason}`);
  process.exit(1);
}
writeFileSync(STATE, JSON.stringify({ lastPostedDay: today }));
console.log(`[daily-print] POSTED https://x.com/Meridian402/status/${res.id}`);
