// THE PORTFOLIO BREAKER: the guard the 2026-08-18 crash proved missing.
// That day a chain-wide token dump hit a fully deployed board (~$1,690
// working across seats and rotor bands) and every per-sleeve guard did its
// job: floors exited, stops benched, collects banked $90 of fees. Ten
// individually bounded losses landing together were still -$323, because
// nothing watched the book as a whole. Correlated venues do not care how the
// capital is sleeved.
//
// This breaker watches the SAME whole-book marks the rotor breaker rides,
// but its limit scales to TOTAL working capital and its response is total:
// flatten the meme sleeve, close every LP seat, sell the inventory to cash
// (queue-backed, so a failed sale retries instead of stranding), and stand
// the desk down. The stand-down blocks every entry path, rotor and seats
// alike, and only the operator clears it: a desk that just lost a limit
// across every sleeve at once does not get to decide on its own that the
// coast is clear.
//
// It deliberately sits ABOVE the per-sleeve limits. On an ordinary bad day
// the sleeve guards handle it and this never fires; it exists for the day
// they all fire correctly and the book bleeds anyway.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { appendLedger } from "./ledger.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { getAgentSigner } from "./venues/signer.js";
import { sellSymbolsOrEnqueue } from "./pendingSells.js";

const LIMIT_FLOOR_USD = Number(process.env.MERIDIAN_PORTFOLIO_LOSS_LIMIT_USD ?? 200);
const LIMIT_PCT = Number(process.env.MERIDIAN_PORTFOLIO_LOSS_PCT ?? 15);
const STAND_DOWN_MS = Number(process.env.MERIDIAN_PORTFOLIO_STAND_DOWN_HOURS ?? 12) * 3600e3;
// THREE consecutive marks (~6 minutes at the 2-minute cadence), one more
// than the rotor's stage 2 demands. This trigger liquidates every position
// the desk holds; the phantom-crater history (08-05, 08-11, 08-16) says the
// extra mark of patience is cheap next to flattening a healthy book on a
// gauge artifact. Marks arrive despiked and only on good reads.
const CONFIRM_MARKS = 3;
const STATE_PATH = dataPath("portfolio-breaker.json");

export interface PortfolioState {
  hwm: number;
  hwmDay: string;
  streak: number;
  standDownUntil: number;
}

/** PURE: the day's portfolio loss limit for a given total working size.
 *  Same shape as the rotor's scaled limit: a floor when small, proportional
 *  at size. As guards de-risk during a crash, working shrinks and the limit
 *  tightens toward the floor, which is the right direction. */
export function portfolioLimitUsd(workingUsd: number, floorUsd = LIMIT_FLOOR_USD, pct = LIMIT_PCT): number {
  return Math.max(floorUsd, (pct / 100) * Math.max(0, workingUsd));
}

/** PURE: fold one whole-book mark into the state; says whether to fire.
 *  Eastern-day high-water, ratchet on up-marks, confirmation streak on
 *  breach, re-arm at the surviving level on fire. */
export function portfolioVerdict(
  state: PortfolioState,
  book: number,
  workingUsd: number,
  today: string,
  now: number,
  opts: { floorUsd?: number; pct?: number; confirmMarks?: number; standDownMs?: number } = {},
): { next: PortfolioState; fire: boolean; drawdownUsd: number; limitUsd: number } {
  const confirm = opts.confirmMarks ?? CONFIRM_MARKS;
  const limitUsd = portfolioLimitUsd(workingUsd, opts.floorUsd, opts.pct);
  const s = { ...state };
  // Already stood down: keep the high-water honest but judge nothing. The
  // positions are gone; there is nothing left for a re-fire to protect.
  if (now < s.standDownUntil) {
    if (today !== s.hwmDay || book > s.hwm) {
      s.hwmDay = today;
      s.hwm = book;
    }
    s.streak = 0;
    return { next: s, fire: false, drawdownUsd: 0, limitUsd };
  }
  if (today !== s.hwmDay) {
    s.hwmDay = today;
    s.hwm = book;
    s.streak = 0;
  }
  if (book >= s.hwm) {
    s.hwm = book;
    s.streak = 0;
    return { next: s, fire: false, drawdownUsd: 0, limitUsd };
  }
  const drawdownUsd = s.hwm - book;
  if (drawdownUsd < limitUsd) {
    s.streak = 0;
    return { next: s, fire: false, drawdownUsd, limitUsd };
  }
  s.streak += 1;
  if (s.streak < confirm) return { next: s, fire: false, drawdownUsd, limitUsd };
  s.standDownUntil = now + (opts.standDownMs ?? STAND_DOWN_MS);
  s.hwm = book;
  s.streak = 0;
  return { next: s, fire: true, drawdownUsd, limitUsd };
}

let state: PortfolioState = { hwm: 0, hwmDay: "", streak: 0, standDownUntil: 0 };
let stateLoaded = false;

function ensureState(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    if (!existsSync(STATE_PATH)) return;
    const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<PortfolioState>;
    // A stand-down survives a redeploy: the reason the desk stood down did
    // not restart with the process. The high-water carries within its day.
    if (typeof saved.standDownUntil === "number" && saved.standDownUntil > Date.now()) state.standDownUntil = saved.standDownUntil;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (saved.hwmDay === today && typeof saved.hwm === "number" && saved.hwm > 0) {
      state.hwm = saved.hwm;
      state.hwmDay = saved.hwmDay;
    }
  } catch {
    /* a fresh state re-seeds on the next mark */
  }
}

function saveState(): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[portfolioBreaker] state save failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
}

/** Every entry path in the desk checks this (rotor via deskHalted, seats via
 *  openInPool). Exits never check it: stood down or not, you can always sell. */
export function portfolioStoodDown(): boolean {
  ensureState();
  return Date.now() < state.standDownUntil;
}

/** Operator lever, wired to /api/admin/clear-halt next to the rotor's. */
export function clearPortfolioStandDown(): { cleared: boolean; wasStoodDownUntil: number } {
  ensureState();
  const was = state.standDownUntil;
  if (was === 0) return { cleared: false, wasStoodDownUntil: 0 };
  state.standDownUntil = 0;
  state.streak = 0;
  state.hwmDay = ""; // next mark re-seeds the high-water at the current book
  saveState();
  console.error(`[portfolioBreaker] stand-down CLEARED by operator (was until ${was ? new Date(was).toISOString() : "n/a"})`);
  return { cleared: true, wasStoodDownUntil: was };
}

/** Fed by the book snapshotter with every good mark, right after the rotor's
 *  noteBookMark. Same despiked source, same failed-reads-never-arrive rule. */
export function notePortfolioMark(book: number, workingUsd: number): void {
  if (!Number.isFinite(book) || book <= 0) return;
  ensureState();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const v = portfolioVerdict(state, book, Number.isFinite(workingUsd) ? workingUsd : 0, today, Date.now());
  state = v.next;
  saveState();
  if (!v.fire) return;
  const reason = `book $${book.toFixed(0)} is $${v.drawdownUsd.toFixed(0)} below the day's high across ALL sleeves (portfolio limit $${v.limitUsd.toFixed(0)}); flattening everything, desk stood down ${Math.round(STAND_DOWN_MS / 3600e3)}h pending operator clear`;
  appendLedger("portfolio-breaker.jsonl", { ts: Date.now(), kind: "portfolio-breaker", book, workingUsd, drawdownUsd: v.drawdownUsd, limitUsd: v.limitUsd, reason });
  console.error(`[portfolioBreaker] PORTFOLIO BREAKER: ${reason}`);
  void withHouseWalletLock("portfolioBreaker", flattenEverything).catch((err) =>
    console.error(`[portfolioBreaker] flatten failed (per-sleeve guards still active): ${err instanceof Error ? err.message.slice(0, 160) : err}`),
  );
}

/** The total response: meme sleeve flat, every seat closed, inventory sold or
 *  queued. Dynamic imports on purpose: this module sits below memeGuard and
 *  lpPositions in the static graph so their guards can import the stand-down
 *  flag without a cycle. */
async function flattenEverything(): Promise<void> {
  if (!getAgentSigner()) return;
  try {
    const { operatorFlattenMeme } = await import("./memeGuard.js");
    const r = await operatorFlattenMeme();
    console.error(`[portfolioBreaker] meme sleeve flattened: ${r.bandsSeen} band(s), ~$${r.workingUsdBefore.toFixed(2)} working`);
  } catch (err) {
    console.error(`[portfolioBreaker] meme flatten failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
  }
  const symbols = new Set<string>();
  try {
    const { openPositionsOnChain, withdrawPosition } = await import("./venues/lpPositions.js");
    for (const p of await openPositionsOnChain()) {
      try {
        await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
        symbols.add(p.symbol);
        console.error(`[portfolioBreaker] closed seat #${p.tokenId} (${p.symbol})`);
      } catch (err) {
        console.error(`[portfolioBreaker] close of #${p.tokenId} (${p.symbol}) failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
      }
    }
  } catch (err) {
    console.error(`[portfolioBreaker] seat enumeration failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
  }
  const sold = await sellSymbolsOrEnqueue([...symbols], "portfolio breaker flatten");
  appendLedger("portfolio-breaker.jsonl", { ts: Date.now(), kind: "flattened", seatsClosed: [...symbols], sold });
}
