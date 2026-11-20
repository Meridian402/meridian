// THE PAPER REPLAY. Read-only arithmetic over the hour ledgers. No capital.
//
// The question it answers (operator, 2026-11-16): if the desk's own rules had
// been running across every chain we record, picking the best-paying pool at
// each moment, what would the book have done? And which of the rules carried?
//
// How it stays honest:
//
//   - The DECISIONS are the desk's, not a paraphrase. Entries come from
//     pilotGuard.autoEntryVerdict, the floor from pilotGuard.effectiveFloorUsd,
//     the idle-bid exit from pilotGuard.idleBidVerdict, the breaker limit from
//     portfolioBreaker's formula. A change to a rule in the desk changes it here.
//   - No lookahead. A decision at the end of hour H sees hours up to H and takes
//     effect from hour H+1.
//   - A seat is a real concentrated-liquidity position, valued by its own
//     formula at each hour's close. That is the part the watchers' "LP net"
//     leaves out: fees minus 30-minute markout says nothing about the inventory
//     a seat is left holding when a token trends for a day. Here the inventory
//     is carried and marked.
//   - Fees are the pool's recorded LP fees for the hour times the seat's share
//     of in-range liquidity, for the fraction of the hour's range that lay
//     inside the seat's band.
//
// What it cannot see, said once here and again in the report:
//   - Inside an hour. The desk checks every 150 seconds; this sees one
//     open/high/low/close per hour. A floor is taken at the floor when the
//     hour's low breached it (or at the open when the hour gapped through);
//     the dump early-warning exit is not modelled at all.
//   - Moving money between chains is treated as free and instant. It is not.
//   - Gas is measured on the desk's chain and ASSUMED elsewhere.
//   - Our own seat changing the pool: other LPs respond to a new seat.
//
// So read it as: do these rules pick anything, does what they pick make money
// on paper, and which gate is doing the work. Not as a forecast.
import { fileURLToPath } from "node:url";
import { autoEntryVerdict, effectiveFloorUsd, idleBidVerdict, type AutoEntryCandidate } from "../pilotGuard.js";
import { portfolioLimitUsd } from "../portfolioBreaker.js";
import { readHourLedger, type LedgerHour } from "./poolWatch.js";
import { CHAINS, WATCHED, type ChainKey } from "./chainTrack.js";
import { bandAt, bidBand, balancedBand, GAS_PER_OP_USD, inRangeFraction, poolLiquidity, priceAtValue, refSeatNet, seatNetScore, SWAP_SLIPPAGE, type Band } from "./seatMath.js";

const HOUR = 3600;
const REF_WIDTH = 1.25;

// ---- seat arithmetic: shared with the live pilot guard, see seatMath.ts ---------------------
export { bandAt, bidBand, balancedBand, inRangeFraction, poolLiquidity, refLiquidity, refSeatNet, seatNetScore, type Band } from "./seatMath.js";

// ---- inputs ----------------------------------------------------------------------------------

export interface ReplayPool {
  key: string;
  chain: string;
  label: string;
  feePct: number;
  rows: LedgerHour[];
}

/** Every enterable pool on every ledger, with its hours in order. */
export function loadPools(): ReplayPool[] {
  const out: ReplayPool[] = [];
  for (const [id, rows] of readHourLedger("pool-watch.jsonl")) {
    if (!rows.length || rows[rows.length - 1].enterable === false) continue;
    const r = rows[rows.length - 1];
    out.push({ key: `robinhood:${id}`, chain: "robinhood", label: `${r.symbol}/${r.quote} ${r.feePct}%`, feePct: r.feePct, rows });
  }
  for (const chain of Object.keys(CHAINS) as ChainKey[]) {
    const ledger = readHourLedger(`${chain}-track.jsonl`);
    for (const p of WATCHED[chain]) {
      const rows = ledger.get(p.address.toLowerCase()) ?? [];
      if (rows.length) out.push({ key: `${chain}:${p.address.toLowerCase()}`, chain, label: p.label, feePct: rows[rows.length - 1].feePct, rows });
    }
  }
  return out;
}

// ---- the rules, as one configuration ---------------------------------------------------------

export interface Rules {
  name: string;
  note: string;
  capitalUsd: number;
  seatUsd: number;
  maxSeats: number;
  reserveUsd: number;
  minFlowUsdPerHour: number;
  minFeeUsdPerHour: number;
  minYieldToMove: number;
  maxSpikePct: number;
  cooldownMin: number;
  perDay: number;
  widthPct: number;
  floorPct: number;
  envFloorUsd: number;
  idleBidMaxMin: number;
  /** our own realized net on a pool over the trailing 7 days must be at least this */
  admissionFloorUsd: number;
  breakerFloorUsd: number;
  breakerPct: number;
  breakerStandDownHours: number;
  /** hours of record a pool needs before it may be entered */
  minHistoryHours: number;

  // ---- stay-put settings (2026-11-18). All optional, and absent they change nothing: the rule
  // sets that were already running are the control and must replay exactly as they did. ----
  /** Judge a pool's seat fee on the average of this many hours, not on its last hour alone. */
  feeLookbackHours?: number;
  /** Move an unfilled bid up to the price at most this often. The desk did it every tick. */
  trailEveryHours?: number;
  /** Leave a seat once a full day of its own fees comes to less than this. Off when absent. */
  stayFeeUsdPerDay?: number;
  /** Unix seconds. The set takes no seat before this, so a set added late is scored only on hours after it was added. */
  startAt?: number;
  /** A balanced seat in a tight band around the price instead of the desk's wide bid: the band runs
   *  from price / this to price * this (1.03 is three percent either side). Absent: the bid. */
  balancedWidth?: number;
  /** Take a seat only where the price's whole range over the look-back stayed within this percent. */
  steadyRangePct?: number;

  // ---- seat-net settings (2026-11-20). Optional, and absent they change nothing. ----
  /** Rank and admit pools on what this set's own seat would have KEPT there (fees, plus what the
   *  price did to it, minus costs), not on fees alone: see refSeatNet and seatNetScore. */
  rankOnSeatNet?: boolean;
  /** Leave a seat once a fresh seat in its pool would have lost more than this percent of itself
   *  over the last day. Off when absent. */
  leaveOnSeatLossPct?: number;
}

/** The desk exactly as it was configured when the record closed (Railway, 2026-09-07). */
export const DESK_FINAL: Rules = {
  name: "desk rules as closed", note: "every knob as it stood on Railway at the close",
  capitalUsd: 1600, seatUsd: 1000, maxSeats: 3, reserveUsd: 300,
  minFlowUsdPerHour: 150_000, minFeeUsdPerHour: 6, minYieldToMove: 0.25, maxSpikePct: 10, cooldownMin: 120, perDay: 6,
  widthPct: 50, floorPct: 70, envFloorUsd: 120, idleBidMaxMin: 120, admissionFloorUsd: -25,
  breakerFloorUsd: 300, breakerPct: 15, breakerStandDownHours: 12, minHistoryHours: 3,
};

/** Named variants. Each changes as little as possible, so a difference in the
 *  result can be pinned on the rule that changed. */
export function variants(capitalUsd = DESK_FINAL.capitalUsd): Rules[] {
  const base = { ...DESK_FINAL, capitalUsd };
  return [
    base,
    { ...base, name: "no flow bar", note: "the $150k/h flow bar off; the $6/h seat bar still decides", minFlowUsdPerHour: 0 },
    { ...base, name: "bars for small pools", note: "flow bar off, seat bar $2/h", minFlowUsdPerHour: 0, minFeeUsdPerHour: 2 },
    { ...base, name: "two $500 seats", note: "flow bar off, seat bar $1/h on a $500 seat (the same 0.2%/h)", minFlowUsdPerHour: 0, seatUsd: 500, minFeeUsdPerHour: 1, breakerFloorUsd: 150 },
    { ...base, name: "no entry gates", note: "always in the best-paying pool: flow, seat, yield-to-move and spike bars all off; the exits unchanged", minFlowUsdPerHour: 0, minFeeUsdPerHour: 0, minYieldToMove: 0, maxSpikePct: 0 },
    fewPools(base),
    steadyRange(base),
    seatNet(base),
  ];
}

/**
 * FEW POOLS, STAY PUT (added 2026-11-18, on the operator's word: "select fewer
 * pools so we aren't bouncing around in between all the time losing money on
 * churn").
 *
 * What the first 70 hours showed. A seat in every watched pool collected $677
 * in fees and gave back $291 to prices, and the two halves came from different
 * pools: the five best payers earned 69% of the fees and were up on price,
 * while the other twenty-three earned $211 and lost $358. Choosing pools on
 * their first day of seat fees and scoring them only on the hours after kept
 * 86% of the later fees and avoided 93% of the later price loss. And the five
 * sets above differ less in their rules than in how often they change seats:
 * the two that look best took nine seats each to do it.
 *
 * So this set changes the two things that make a desk bounce:
 *   - HOW A POOL IS CHOSEN: on a full day of what a seat there would have
 *     earned (at least 1% of the seat a day), not on its last hour. A hot hour
 *     is how a seat gets opened in a pool that pays for one hour.
 *   - HOW A SEAT IS LEFT: at its floor, or after a full day of paying under the
 *     bar. Not because the price ran above the bid for two hours. A bid left
 *     behind is moved up at most every six hours and earns nothing in between,
 *     which is the price of staying put and is charged here, not hidden.
 * and spreads the book over up to four $300 seats, because which token a seat
 * sat in decided every result in the first three days.
 *
 * The desk's yield-to-move bar is off in this set on purpose: it compares one
 * hour of fees with one hour of price movement, and the whole point here is to
 * stop deciding on an hour.
 *
 * It takes no seat before `startAt`. The sets above have replayed every hour
 * since the record began; this one was written after looking at those hours,
 * so scoring it on them would be marking its own homework.
 */
/**
 * STEADY RANGE (added 2026-11-18, on the operator's word after seeing the replay at a larger
 * book: "we dont want to hold more seats with a bigger book we want to enter high volume and
 * a steady range").
 *
 * Two seats, each a little under half the book, not more seats as the book grows. A pool is
 * taken only if, over a full day, it traded at least $50,000 an hour, its price never left a
 * 6% range, and a seat there would have earned at least 1% of itself. The seat is balanced in
 * a band three percent either side of the price, which is the shape a steady pool rewards and
 * the desk's wide bid does not. If the price leaves the band the seat is put back around it
 * at most every six hours, and the swap that takes is charged.
 *
 * What the first hours on the desk's own chain already said, and why this needs testing and
 * not assuming: volume and a steady price were not enough. The lowest-fee stock pools lost
 * their LPs money on $4.8M a day, because the traders there know where the real stock is.
 * The fee bar in this set is what is supposed to tell those pools from the ones that pay.
 *
 * Like the set above it, it takes no seat before it was added.
 */
export const STEADY_RANGE_START = Date.UTC(2026, 10, 18, 21, 0, 0) / 1000;
function steadyRange(base: Rules): Rules {
  const seatUsd = Math.max(100, Math.floor((base.capitalUsd - base.reserveUsd) / 2 / 50) * 50);
  return {
    ...base,
    name: "steady range (from 11-18)",
    note:
      "added 2026-11-18 and takes no seat before 21:00 UTC that day, so its figures cover fewer hours than the rows above. Two seats of a little under half the book each, however large the book; " +
      "a pool is taken only if over a full day it traded at least $50,000 an hour, its price stayed inside a 6% range and a seat would have earned at least 1% of itself; the seat is balanced in a band three percent either side of the price, " +
      "not the desk's wide bid; out of its band it is put back at most every six hours and the swap is charged; it is left at its floor or after a full day of paying under the bar; the hourly yield-to-move bar is off",
    seatUsd, maxSeats: 2, breakerFloorUsd: 150,
    balancedWidth: 1.03, steadyRangePct: 6,
    minFlowUsdPerHour: 50_000, minYieldToMove: 0,
    minFeeUsdPerHour: (seatUsd * 0.01) / 24, feeLookbackHours: 24, minHistoryHours: 24,
    idleBidMaxMin: 24 * 60, trailEveryHours: 6, stayFeeUsdPerDay: seatUsd * 0.01,
    cooldownMin: 24 * 60, perDay: 2,
    startAt: STEADY_RANGE_START,
  };
}

export const FEW_POOLS_START = Date.UTC(2026, 10, 18, 19, 0, 0) / 1000;
function fewPools(base: Rules): Rules {
  return {
    ...base,
    name: "few pools, stay put (from 11-18)",
    note:
      "added 2026-11-18 and takes no seat before 19:00 UTC that day, so its figures cover fewer hours than the rows above. Up to four $300 seats; a pool is chosen on a full day of its seat fees (at least 1% of the seat a day), not on its last hour; " +
      "an unfilled bid is moved up at most every six hours; a seat is left only at its floor or after a full day of paying under the bar; a pool that was left is not re-entered for a day; the hourly yield-to-move bar is off",
    minFlowUsdPerHour: 0, minYieldToMove: 0,
    seatUsd: 300, maxSeats: 4, breakerFloorUsd: 150,
    minFeeUsdPerHour: 0.125, feeLookbackHours: 24, minHistoryHours: 24,
    idleBidMaxMin: 24 * 60, trailEveryHours: 6, stayFeeUsdPerDay: 3,
    cooldownMin: 24 * 60, perDay: 2,
    startAt: FEW_POOLS_START,
  };
}

/**
 * RANKED ON WHAT A SEAT KEPT (added 2026-11-20, on the operator's word: "how can we optimize to
 * have the correct entries + exits and increase profit").
 *
 * What the record showed when this was written (11-16 to 11-19, every pool-hour with a day on
 * either side, a $500 bid seat followed for a day, the record split in two halves):
 *   - Fees alone do not tell a paying pool from a dumping one, because a dump is busy. In the
 *     second half the pool with the most seat fees over the last day lost about $30 on the next
 *     day, on average, per $500 seat.
 *   - What a seat had KEPT there over the last day did carry over, in both halves. Where the
 *     same seat had lost money over the last day (the worst third), the next day lost about $26
 *     to $30 per $500 seat and won 7% to 8% of the time. No other signal on the record, the
 *     buyer and seller counts and holder spread included, held its order in both halves.
 *   - Tighter floors (85%, 90%) and moving an unfilled bid up every hour cost money in both
 *     halves: they sell bottoms and buy back higher.
 * Even with all of that, the second half lost money on average: the market fell, and a filled
 * bid holds the token. This set is the rules that evidence supports, not a promise that they pay:
 * replayed over the hours it was drawn from it lost $9 across all four chains, and $42 to $56 on
 * the desk's own chain alone, which is all the live engine can trade by itself.
 *
 * So:
 *   - A POOL IS RANKED on the average of what this set's own seat would have kept there, opened
 *     at each of the last 24 hours and held a day (refSeatNet), and admitted only if that average
 *     is above zero AND the most recent full day kept money too.
 *   - A SEAT IS LEFT at its floor, or when a fresh seat in its pool would have lost more than 1%
 *     of itself over the last day ("pool turned"): the same evidence, read as an exit.
 *   - AN UNFILLED BID IS NOT MOVED UP. It is given back after a full day unfilled and the pool
 *     can be taken again two hours later if it still ranks.
 *   - Two seats of a little under half the book, as the operator asked: fewer, larger seats.
 *   - The flow, fee, yield-to-move and spike bars are off: what the seat kept replaces them.
 *
 * Known bias: Ethereum gas is assumed at $5 an action (measured nearer $0.14), so Ethereum pools
 * rank lower here than they should. The assumption is shared with every other set and is left
 * alone so the sets stay comparable.
 *
 * It takes no seat before it was added.
 */
export const SEAT_NET_START = Date.UTC(2026, 10, 20, 13, 0, 0) / 1000;
function seatNet(base: Rules): Rules {
  const seatUsd = Math.max(100, Math.floor((base.capitalUsd - base.reserveUsd) / 2 / 50) * 50);
  return {
    ...base,
    name: "ranked on what a seat kept (from 11-20)",
    note:
      "added 2026-11-20 and takes no seat before 13:00 UTC that day, so its figures cover fewer hours than the rows above. Two seats of a little under half the book each; " +
      "a pool is ranked on what this set's own seat would have kept there (fees, plus what the price did to it, minus costs), opened at each of the last 24 hours and held a day, and is taken only if that average and the latest full day both kept money; " +
      "a seat is left at its floor or when a fresh seat in its pool would have lost more than 1% of itself over the last day; an unfilled bid is not moved up but given back after a full day; the flow, fee, yield-to-move and spike bars are off",
    seatUsd, maxSeats: 2, breakerFloorUsd: 150,
    minFlowUsdPerHour: 0, minFeeUsdPerHour: 0, minYieldToMove: 0, maxSpikePct: 0,
    minHistoryHours: 48, rankOnSeatNet: true, leaveOnSeatLossPct: 1,
    trailEveryHours: 24 * 365, idleBidMaxMin: 24 * 60, cooldownMin: 120, perDay: 4,
    startAt: SEAT_NET_START,
  };
}

export { GAS_PER_OP_USD } from "./seatMath.js";

// ---- the replay ------------------------------------------------------------------------------

export interface SeatRecord {
  pool: string;
  chain: string;
  openedAt: number;
  closedAt: number | null;
  exit: string;
  seatUsd: number;
  hours: number;
  feesUsd: number;
  principalUsd: number; // change in the position's own value, entry to exit
  costsUsd: number;
  netUsd: number;
  hoursInRange: number;
}

interface OpenSeat {
  pool: ReplayPool;
  band: Band;
  depositUsd: number;
  openedAt: number;
  feesUsd: number;
  costsUsd: number;
  hours: number;
  hoursInRange: number;
  unfilledSince: number | undefined;
  /** when the bid was last moved up to the price (stay-put sets) */
  lastTrailAt?: number;
  /** the seat's own fees, hour by hour, for the last day (stay-put sets) */
  feeHist?: number[];
}

export interface ReplayResult {
  rules: Rules;
  hours: number;
  from: number;
  to: number;
  seats: SeatRecord[];
  endBookUsd: number;
  netUsd: number;
  feesUsd: number;
  principalUsd: number;
  costsUsd: number;
  maxDrawdownUsd: number;
  seatHours: number;
  /** candidate-hours refused, by the gate that refused them */
  refusals: Record<string, number>;
  candidateHours: number;
  breakerFires: number;
}

/** PURE: which gate a verdict's per-venue reason names. */
export function gateOf(reason: string): string {
  if (/seat open/.test(reason)) return "already seated";
  if (/cash \$/.test(reason)) return "cash";
  if (/under admission/.test(reason)) return "admission";
  if (/cooldown/.test(reason)) return "cooldown";
  if (/tape too thin/.test(reason)) return "thin tape";
  if (/flow \$/.test(reason)) return "flow bar";
  if (/\/h bar/.test(reason)) return "seat fee bar";
  if (/not buying the spike/.test(reason)) return "spike";
  if (/vs moves|no move reading/.test(reason)) return "yield to move";
  return "other";
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** PURE: run one rule set over the recorded hours. */
export function replay(pools: readonly ReplayPool[], rules: Rules): ReplayResult {
  const byHour = new Map<string, Map<number, LedgerHour>>();
  const allHours = new Set<number>();
  for (const p of pools) {
    const m = new Map<number, LedgerHour>();
    for (const r of p.rows) { m.set(r.hourStart, r); allHours.add(r.hourStart); }
    byHour.set(p.key, m);
  }
  const hours = [...allHours].sort((a, b) => a - b);
  const gas = (chain: string) => GAS_PER_OP_USD[chain] ?? 0.2;
  // Seat-net sets: what this set's own seat would have kept in a pool, opened at the close of
  // row i0 and held a day. Fixed for a given pool and hour within one run, so it is kept.
  const keptMemo = new Map<string, number>();
  const kept = (p: ReplayPool, i0: number): number => {
    const k = `${p.key}:${i0}`;
    let v = keptMemo.get(k);
    if (v === undefined) {
      v = refSeatNet(p.rows, i0, 24, rules.seatUsd, rules.widthPct, effectiveFloorUsd(rules.seatUsd, rules.envFloorUsd, rules.floorPct), gas(p.chain), p.feePct);
      keptMemo.set(k, v);
    }
    return v;
  };

  let cash = rules.capitalUsd;
  const open = new Map<string, OpenSeat>();
  const seats: SeatRecord[] = [];
  const lastExit = new Map<string, number>();
  const realized = new Map<string, Array<{ t: number; net: number }>>();
  const entries: number[] = [];
  const refusals: Record<string, number> = {};
  let candidateHours = 0, seatHours = 0, breakerFires = 0;
  let hwm = rules.capitalUsd, hwmDay = "", standDownUntil = 0, peak = rules.capitalUsd, maxDrawdown = 0;

  const close = (key: string, t: number, exitValueUsd: number, tokenUsdAtExit: number, why: string) => {
    const s = open.get(key)!;
    const swapCost = tokenUsdAtExit * (s.pool.feePct / 100 + SWAP_SLIPPAGE);
    const cost = gas(s.pool.chain) * (tokenUsdAtExit > 0.01 ? 2 : 1) + swapCost;
    s.costsUsd += cost;
    cash += exitValueUsd - cost;
    const principal = exitValueUsd - s.depositUsd;
    const net = s.feesUsd + principal - s.costsUsd;
    seats.push({ pool: s.pool.label, chain: s.pool.chain, openedAt: s.openedAt, closedAt: t, exit: why, seatUsd: s.depositUsd, hours: s.hours, feesUsd: s.feesUsd, principalUsd: principal, costsUsd: s.costsUsd, netUsd: net, hoursInRange: s.hoursInRange });
    const arr = realized.get(key) ?? [];
    arr.push({ t, net });
    realized.set(key, arr);
    lastExit.set(key, t);
    open.delete(key);
  };

  for (const h of hours) {
    const tEnd = h + HOUR;
    // 1. carry every open seat through this hour
    for (const [key, s] of [...open]) {
      const r = byHour.get(key)!.get(h);
      if (!r) continue; // no row this hour: the watcher was down; nothing is known, nothing is done
      s.hours++;
      seatHours++;
      const floor = effectiveFloorUsd(s.depositUsd, rules.envFloorUsd, rules.floorPct);
      const atLow = bandAt(s.band, r.pxLow);
      if (atLow.valueUsd < floor) {
        const atOpen = bandAt(s.band, r.pxOpen);
        const gapped = atOpen.valueUsd < floor;
        const exitValue = gapped ? atOpen.valueUsd : floor;
        const exitPrice = gapped ? r.pxOpen : priceAtValue(s.band, floor, r.pxLow, r.pxOpen);
        // half the hour's in-range fees: it left partway through
        const share = s.band.L / (poolLiquidity(r) + s.band.L);
        const lastFees = 0.5 * r.feesUsd * share * inRangeFraction(r.pxLow, r.pxHigh, s.band.pa, s.band.pb);
        s.feesUsd += lastFees;
        cash += lastFees;
        close(key, tEnd, exitValue, bandAt(s.band, exitPrice).tokenUsd, gapped ? "floor (gapped through)" : "floor");
        continue;
      }
      const f = inRangeFraction(r.pxLow, r.pxHigh, s.band.pa, s.band.pb);
      const share = s.band.L / (poolLiquidity(r) + s.band.L);
      const fee = r.feesUsd * share * f;
      s.feesUsd += fee;
      cash += fee;
      if (f > 0) s.hoursInRange++;
      if (fee >= 1) { s.costsUsd += gas(s.pool.chain); cash -= gas(s.pool.chain); } // one collect
      // Stay-put sets: the one exit that is about the pool and not about the price. A seat is
      // left once a full day of its own fees has come to less than the bar.
      if (rules.stayFeeUsdPerDay != null) {
        (s.feeHist ??= []).push(fee);
        if (s.feeHist.length > 24) s.feeHist.shift();
        if (s.feeHist.length === 24 && s.feeHist.reduce((a, b) => a + b, 0) < rules.stayFeeUsdPerDay) {
          const at = bandAt(s.band, r.pxClose);
          close(key, tEnd, at.valueUsd, at.tokenUsd, "stopped paying");
          continue;
        }
      }
      // Seat-net sets: leave once a fresh seat in this pool would have lost more than the bar over
      // the last day. It reads rows up to this hour only.
      if (rules.leaveOnSeatLossPct != null) {
        const lastDay = kept(s.pool, s.pool.rows.findIndex((x) => x.hourStart === h) - 24);
        if (Number.isFinite(lastDay) && lastDay < -(s.depositUsd * rules.leaveOnSeatLossPct) / 100) {
          const at = bandAt(s.band, r.pxClose);
          close(key, tEnd, at.valueUsd, at.tokenUsd, "pool turned");
          continue;
        }
      }
      if (rules.balancedWidth) {
        // A balanced seat the price has left, on either side, earns nothing. It is put back around
        // the price at most every trailEveryHours, and putting it back is not free: half of what it
        // holds has to be swapped to make it balanced again, at the pool's fee plus slippage.
        if ((r.pxClose > s.band.pb || r.pxClose < s.band.pa) && tEnd - (s.lastTrailAt ?? s.openedAt) >= (rules.trailEveryHours ?? 1) * HOUR) {
          const value = bandAt(s.band, r.pxClose).valueUsd;
          const cost = 2 * gas(s.pool.chain) + 0.5 * value * (s.pool.feePct / 100 + SWAP_SLIPPAGE);
          s.band = balancedBand(value, r.pxClose, rules.balancedWidth);
          s.costsUsd += cost;
          cash -= cost;
          s.lastTrailAt = tEnd;
        }
        continue;
      }
      if (r.pxClose > s.band.pb) {
        // above the band the seat is all dollars: an unfilled bid. The desk trails it up for gas
        // and gives the slot back once it has sat unfilled long enough.
        if (s.unfilledSince == null) s.unfilledSince = tEnd * 1000;
        if (idleBidVerdict(s.unfilledSince - HOUR * 1000, tEnd * 1000, rules.idleBidMaxMin * 60_000).act) {
          close(key, tEnd, bandAt(s.band, r.pxClose).valueUsd, 0, "idle bid");
          continue;
        }
        // The desk moved an unfilled bid up every tick. A stay-put set does it at most every
        // trailEveryHours and earns nothing from the bid in between.
        if (tEnd - (s.lastTrailAt ?? s.openedAt) >= (rules.trailEveryHours ?? 1) * HOUR) {
          const value = bandAt(s.band, r.pxClose).valueUsd;
          s.band = bidBand(value, r.pxClose, rules.widthPct);
          s.costsUsd += 2 * gas(s.pool.chain);
          cash -= 2 * gas(s.pool.chain);
          s.lastTrailAt = tEnd;
        }
      } else if (r.pxLow < s.band.pb) {
        s.unfilledSince = undefined; // it traded into the band
      }
    }

    // 2. mark the book; the portfolio breaker
    let working = 0;
    for (const [key, s] of open) {
      const r = byHour.get(key)!.get(h);
      working += bandAt(s.band, r ? r.pxClose : s.band.pb).valueUsd;
    }
    const book = cash + working;
    if (book > peak) peak = book;
    if (peak - book > maxDrawdown) maxDrawdown = peak - book;
    const day = new Date(tEnd * 1000).toISOString().slice(0, 10);
    if (day !== hwmDay || book > hwm) { hwmDay = day; hwm = book; }
    if (tEnd >= standDownUntil && open.size && hwm - book >= portfolioLimitUsd(working, rules.breakerFloorUsd, rules.breakerPct)) {
      breakerFires++;
      for (const [key, s] of [...open]) {
        const r = byHour.get(key)!.get(h);
        const at = bandAt(s.band, r ? r.pxClose : s.band.pb);
        close(key, tEnd, at.valueUsd, at.tokenUsd, "portfolio breaker");
      }
      standDownUntil = tEnd + rules.breakerStandDownHours * HOUR;
      hwm = cash;
    }

    // 3. entries, decided on what is known at the end of this hour
    const notYet = rules.startAt != null && tEnd < rules.startAt; // a set added late takes no seat before it was added
    const seatBand = (usd: number, px: number): Band => (rules.balancedWidth ? balancedBand(usd, px, rules.balancedWidth) : bidBand(usd, px, rules.widthPct));
    const look = Math.max(1, rules.feeLookbackHours ?? 1);
    for (let guard = 0; guard < rules.maxSeats && !notYet; guard++) {
      const candidates: AutoEntryCandidate[] = [];
      const rowOf = new Map<string, LedgerHour>();
      for (const p of pools) {
        const r = byHour.get(p.key)!.get(h);
        if (!r) continue;
        const idx = p.rows.findIndex((x) => x.hourStart === h);
        if (idx + 1 < Math.max(rules.minHistoryHours, look)) continue;
        const recent = p.rows.slice(Math.max(0, idx - 5), idx + 1);
        const window = p.rows.slice(idx + 1 - look, idx + 1);
        // Steady-range sets: the price's whole range over the look-back must fit inside the bar.
        // A pool with one wild print in the window fails it, which is the cautious way to be wrong.
        if (rules.steadyRangePct != null) {
          const hi = Math.max(...window.map((x) => x.pxHigh)), lo = Math.min(...window.map((x) => x.pxLow));
          if (!(lo > 0) || (hi / lo - 1) * 100 > rules.steadyRangePct) {
            if (guard === 0) { candidateHours++; refusals["not steady"] = (refusals["not steady"] ?? 0) + 1; }
            continue;
          }
        }
        // Seat-net sets: a pool is taken only where this set's own seat has been keeping money,
        // over the last two days on average and over the latest full day.
        let keptPerHour: number | undefined;
        if (rules.rankOnSeatNet) {
          const score = seatNetScore(idx, (i0) => kept(p, i0));
          const gate = !Number.isFinite(score.avg) ? "gap in record" : score.avg <= 0 ? "seat lost money over two days" : score.lastDay <= 0 ? "seat lost money over the last day" : null;
          if (gate) {
            if (guard === 0) { candidateHours++; refusals[gate] = (refusals[gate] ?? 0) + 1; }
            continue;
          }
          keptPerHour = score.avg / 24;
        }
        const bid = seatBand(rules.seatUsd, r.pxClose);
        const sharePct = (100 * bid.L) / (poolLiquidity(r) + bid.L);
        const netRecent = (realized.get(p.key) ?? []).filter((x) => tEnd - x.t <= 7 * 86400).reduce((a, x) => a + x.net, 0);
        rowOf.set(p.key, r);
        candidates.push({
          symbol: p.key,
          // one hour as the desk read it, or the average over the look-back for a set that judges on a day
          flowUsdPerHour: r.swaps > 0 ? (look === 1 ? r.volumeUsd : window.reduce((a, x) => a + x.volumeUsd, 0) / look) : NaN,
          admitted: netRecent >= rules.admissionFloorUsd,
          admissionNetUsd: netRecent,
          hasSeat: open.has(p.key),
          lockedOut: false,
          denied: false,
          lastExitMs: lastExit.has(p.key) ? lastExit.get(p.key)! * 1000 : undefined,
          // One hour as the desk judged it, or the average of the last `look` hours for a stay-put set,
          // each hour at the share a seat would have had in that hour. A seat-net set ranks on what its
          // seat KEPT per hour instead; its fee bar is off, so this number only orders the pools.
          feeUsdPerHour: keptPerHour != null ? keptPerHour : look === 1
            ? (r.feesUsd * sharePct) / 100
            : window.reduce((a, x) => { const b = seatBand(rules.seatUsd, x.pxClose); return a + x.feesUsd * (b.L / (poolLiquidity(x) + b.L)); }, 0) / look,
          sharePct,
          hourlyMovePct: recent.length >= 3 ? median(recent.map((x) => Math.abs(x.pxClose / x.pxOpen - 1) * 100)) : NaN,
          last60mPct: (r.pxClose / r.pxOpen - 1) * 100,
        });
      }
      if (guard === 0) candidateHours += candidates.length;
      const verdict = autoEntryVerdict({
        enabled: true, now: tEnd * 1000, openSeats: open.size, maxSeats: rules.maxSeats, cashUsd: cash, reserveUsd: rules.reserveUsd, seatUsd: rules.seatUsd,
        gasEth: 1, minGasEth: 0, stoodDown: tEnd < standDownUntil, opsAvailable: true,
        entriesToday: entries.filter((t) => tEnd - t < 86400).length, perDay: rules.perDay,
        minFlowUsdPerHour: rules.minFlowUsdPerHour, minFeeUsdPerHour: rules.minFeeUsdPerHour, minYieldToMove: rules.minYieldToMove, maxSpikePct: rules.maxSpikePct,
        cooldownMs: rules.cooldownMin * 60_000, candidates,
      });
      if (!verdict.act) {
        if (guard === 0) {
          const parts = verdict.reason.split("; ");
          const perVenue = parts.filter((x) => /^[a-z]+:0x/.test(x));
          if (perVenue.length) for (const x of perVenue) refusals[gateOf(x)] = (refusals[gateOf(x)] ?? 0) + 1;
          else if (candidates.length) {
            // a desk-level refusal (cash, seat cap, stand-down) turns away every pool that hour
            const k = `desk: ${verdict.reason.replace(/[\d.,$]+/g, "N").slice(0, 40)}`;
            refusals[k] = (refusals[k] ?? 0) + candidates.length;
          }
        }
        break;
      }
      const pool = pools.find((p) => p.key === verdict.symbol)!;
      const r = rowOf.get(pool.key)!;
      cash -= verdict.seatUsd + gas(pool.chain);
      open.set(pool.key, { pool, band: seatBand(verdict.seatUsd, r.pxClose), depositUsd: verdict.seatUsd, openedAt: tEnd, feesUsd: 0, costsUsd: gas(pool.chain), hours: 0, hoursInRange: 0, unfilledSince: undefined });
      entries.push(tEnd);
    }
  }

  // seats still open are marked at their last known close, not liquidated
  const lastHour = hours[hours.length - 1] ?? 0;
  let working = 0;
  for (const [key, s] of open) {
    const rows = s.pool.rows;
    const at = bandAt(s.band, rows[rows.length - 1].pxClose);
    working += at.valueUsd;
    seats.push({ pool: s.pool.label, chain: s.pool.chain, openedAt: s.openedAt, closedAt: null, exit: "still open", seatUsd: s.depositUsd, hours: s.hours, feesUsd: s.feesUsd, principalUsd: at.valueUsd - s.depositUsd, costsUsd: s.costsUsd, netUsd: s.feesUsd + at.valueUsd - s.depositUsd - s.costsUsd, hoursInRange: s.hoursInRange });
    void key;
  }
  const endBook = cash + working;
  const sum = (k: "feesUsd" | "principalUsd" | "costsUsd") => seats.reduce((a, s) => a + s[k], 0);
  return {
    rules, hours: hours.length, from: hours[0] ?? 0, to: lastHour + HOUR, seats, endBookUsd: endBook, netUsd: endBook - rules.capitalUsd,
    feesUsd: sum("feesUsd"), principalUsd: sum("principalUsd"), costsUsd: sum("costsUsd"), maxDrawdownUsd: maxDrawdown, seatHours, refusals, candidateHours, breakerFires,
  };
}

export interface PassiveRow {
  pool: string;
  chain: string;
  hours: number;
  feesUsd: number;
  principalUsd: number;
  netUsd: number;
  inRangePct: number;
  movePct: number;
}

/** PURE: the do-nothing baseline. One balanced $1,000 seat per pool, opened at
 *  the first recorded hour and never touched. It is what "LP net" looks like
 *  once the inventory is counted. */
export function passive(pools: readonly ReplayPool[], seatUsd = 1000, width = REF_WIDTH): PassiveRow[] {
  const out: PassiveRow[] = [];
  for (const p of pools) {
    if (p.rows.length < 2) continue;
    const band = balancedBand(seatUsd, p.rows[0].pxOpen, width);
    let fees = 0, inRange = 0;
    for (const r of p.rows) {
      const f = inRangeFraction(r.pxLow, r.pxHigh, band.pa, band.pb);
      fees += r.feesUsd * (band.L / (poolLiquidity(r) + band.L)) * f;
      if (f > 0) inRange++;
    }
    const last = p.rows[p.rows.length - 1];
    const principal = bandAt(band, last.pxClose).valueUsd - seatUsd;
    out.push({ pool: p.label, chain: p.chain, hours: p.rows.length, feesUsd: fees, principalUsd: principal, netUsd: fees + principal, inRangePct: (100 * inRange) / p.rows.length, movePct: (last.pxClose / p.rows[0].pxOpen - 1) * 100 });
  }
  return out.sort((a, b) => b.netUsd - a.netUsd);
}

// ---- the report ------------------------------------------------------------------------------

const usd = (n: number, digits = 0) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const at = (t: number) => new Date(t * 1000).toISOString().slice(5, 13).replace("T", " ") + "h";

export function report(capitalUsd = DESK_FINAL.capitalUsd, log: (line: string) => void = (l) => console.log(l)): ReplayResult[] {
  const pools = loadPools();
  const results = variants(capitalUsd).map((v) => replay(pools, v));
  const first = results[0];
  if (!first || !first.hours) {
    log("paper replay: no hours on record yet");
    return results;
  }
  const perChain = new Map<string, number>();
  for (const p of pools) perChain.set(p.chain, (perChain.get(p.chain) ?? 0) + 1);
  log(`PAPER REPLAY  ${at(first.from)} to ${at(first.to)} UTC, ${first.hours} hours, ${pools.length} pools (${[...perChain].map(([c, n]) => `${c} ${n}`).join(", ")}), starting book ${usd(capitalUsd)}`);
  log("Decisions are the desk's own rule functions on hourly data. Hour granularity, free instant moves between chains, and gas off the desk's chain are assumptions; read the notes at the end.");
  log("");
  log("RULE SET                 seats  seat-hours      fees  inventory     costs       net   end book  max drawdown  breaker");
  for (const r of results) {
    log(`${r.rules.name.padEnd(24)} ${String(r.seats.length).padStart(5)} ${String(r.seatHours).padStart(11)} ${usd(r.feesUsd, 2).padStart(9)} ${usd(r.principalUsd, 2).padStart(10)} ${usd(r.costsUsd, 2).padStart(9)} ${usd(r.netUsd, 2).padStart(9)} ${usd(r.endBookUsd, 2).padStart(10)} ${usd(r.maxDrawdownUsd, 2).padStart(13)} ${String(r.breakerFires).padStart(8)}`);
  }
  for (const r of results) {
    log("");
    log(`${r.rules.name.toUpperCase()}: ${r.rules.note}`);
    const ref = Object.entries(r.refusals).sort((a, b) => b[1] - a[1]);
    log(`  ${r.candidateHours} pool-hours were considered; refused by: ${ref.length ? ref.map(([k, n]) => `${k} ${n}`).join(", ") : "nothing"}`);
    if (!r.seats.length) { log("  no seat was opened"); continue; }
    log("  pool                     chain      opened      held  in range      fees  inventory    costs       net  exit");
    for (const s of r.seats.slice(0, 14)) {
      log(`  ${s.pool.slice(0, 24).padEnd(24)} ${s.chain.padEnd(10)} ${at(s.openedAt)} ${(s.hours + "h").padStart(6)} ${(s.hoursInRange + "h").padStart(9)} ${usd(s.feesUsd, 2).padStart(9)} ${usd(s.principalUsd, 2).padStart(10)} ${usd(s.costsUsd, 2).padStart(8)} ${usd(s.netUsd, 2).padStart(9)}  ${s.exit}`);
    }
    if (r.seats.length > 14) log(`  ... and ${r.seats.length - 14} more seats`);
    const byExit = new Map<string, { n: number; net: number }>();
    for (const s of r.seats) { const e = byExit.get(s.exit) ?? { n: 0, net: 0 }; e.n++; e.net += s.netUsd; byExit.set(s.exit, e); }
    log(`  by exit: ${[...byExit].map(([k, v]) => `${k} x${v.n} (${usd(v.net, 2)})`).join(", ")}`);
  }
  log("");
  log("DO-NOTHING BASELINE: one balanced $1,000 seat per pool, opened at its first recorded hour and never touched");
  log("  pool                     chain      hours  in range      fees  inventory       net   price");
  for (const p of passive(pools)) {
    log(`  ${p.pool.slice(0, 24).padEnd(24)} ${p.chain.padEnd(10)} ${String(p.hours).padStart(5)} ${(p.inRangePct.toFixed(0) + "%").padStart(9)} ${usd(p.feesUsd, 2).padStart(9)} ${usd(p.principalUsd, 2).padStart(10)} ${usd(p.netUsd, 2).padStart(9)} ${((p.movePct >= 0 ? "+" : "") + p.movePct.toFixed(1) + "%").padStart(7)}`);
  }
  log("");
  log("NOTES");
  log("  - Hourly data: the desk checks every 150 seconds. A floor is booked at the floor, or at the open if the hour gapped through it. The dump early-warning exit is not modelled.");
  log("  - Below-band re-centers, the break exit and the volume-fade exit are off, as they were on Railway at the close.");
  log("  - Moving money between chains is treated as free and instant.");
  log(`  - Gas per action: ${Object.entries(GAS_PER_OP_USD).map(([c, g]) => `${c} $${g}`).join(", ")}. Only the desk's chain is measured; the others are assumptions.`);
  log("  - A seat's fee share is against the liquidity the watcher recorded; other LPs would respond to a real seat.");
  log("  - A short record cannot separate a good rule from a lucky window. Judge the gates' behaviour first and the dollars second.");
  return results;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const i = process.argv.indexOf("--capital");
  report(i > 0 ? Number(process.argv[i + 1]) : undefined);
}
