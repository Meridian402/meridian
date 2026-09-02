// THE LAUNCH-HOUR WATCHER, pure half. Everything here is arithmetic on data
// the runner (watch.ts) hands in; nothing reads the chain or the clock, so all
// of it is testable offline. Spec: agent/LAUNCH-HOUR-SPEC.md (D1).
//
// The model deliberately mirrors how the live desk would trade it: a wide
// two-sided band, pro-rata fee share against the pool's ACTIVE liquidity at
// each swap (the Swap event carries it), probe first, scale at ignition, exit
// on volume roll-over rather than price. Numbers out of here are estimates of
// what a seat WOULD have earned; they never move money.

export const Q96 = 2 ** 96;

/** One swap as the watcher records it. `usd` is the USDG leg; `L` is the
 *  pool's active liquidity after the swap; `px` is the token's USDG price. */
export interface SwapSample {
  t: number; // unix seconds
  usd: number;
  px: number;
  sqrtP: number; // sqrtPriceX96 / 2^96, as a float
  L: number; // active liquidity after the swap, as a float
  sender: string;
}

// --- token gate -------------------------------------------------------------

/** PURE: does runtime bytecode match a reference standard? Same length and no
 *  more than `tolerance` of hex chars differing, which is what immutables
 *  (names, launcher pointers) change between two deployments of one contract.
 *  microduck and GG differed from the verified GPRO token by 1.8%; an
 *  unrelated contract of the same size differed by 86%. */
export function bytecodeMatches(code: string, reference: string, tolerance = 0.03): boolean {
  const a = code.toLowerCase().replace(/^0x/, "");
  const b = reference.toLowerCase().replace(/^0x/, "");
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff / a.length <= tolerance;
}

/** PURE: the implementation behind a minimal proxy (EIP-1167 and the Solady
 *  variant Doppler uses), or null when the code is not a minimal proxy. */
export function proxyTarget(code: string): string | null {
  const c = code.toLowerCase().replace(/^0x/, "");
  if (c.length > 200) return null;
  const m = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(c) ?? /3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e602a57fd5bf3/.exec(c);
  return m ? `0x${m[1]}` : null;
}

export interface GateInput {
  code: string;
  references: { name: string; code: string }[]; // verified standards, full runtime bytecode
  proxyImplementations: { name: string; address: string }[]; // verified implementations behind proxies
  creatorTaxBps?: number | null;
  pairToken?: string | null;
  pairAllowlist: string[];
  decimals?: number | null;
}

/** PURE: the minute-one gate. Mechanical by design: a standard we have read
 *  the source of, a creator tax the launcher reports, a pair we know, 18
 *  decimals. Anything else fails closed with the reason spelled out. */
export function gateToken(input: GateInput): { ok: boolean; standard: string | null; reason: string } {
  let standard: string | null = null;
  const target = proxyTarget(input.code);
  if (target) {
    const impl = input.proxyImplementations.find((p) => p.address.toLowerCase() === target.toLowerCase());
    if (!impl) return { ok: false, standard: null, reason: `minimal proxy to unknown implementation ${target}` };
    standard = impl.name;
  } else {
    const ref = input.references.find((r) => bytecodeMatches(input.code, r.code));
    if (!ref) return { ok: false, standard: null, reason: "bytecode matches no verified standard" };
    standard = ref.name;
  }
  if (input.creatorTaxBps != null && input.creatorTaxBps > 100) return { ok: false, standard, reason: `creator tax ${input.creatorTaxBps} bps > 100` };
  if (input.pairToken && !input.pairAllowlist.some((p) => p.toLowerCase() === input.pairToken!.toLowerCase())) {
    return { ok: false, standard, reason: `pair token ${input.pairToken} not on the allowlist` };
  }
  if (input.decimals != null && input.decimals !== 18) return { ok: false, standard, reason: `decimals ${input.decimals} != 18` };
  return { ok: true, standard, reason: "" };
}

// --- ignition -----------------------------------------------------------------

export interface IgnitionConfig {
  windowSec: number; // measured from launch
  minSwaps: number;
  minSenders: number;
  minUsd: number; // 0 when the curve is not USDG-quoted
}

/** PURE: the first moment inside the window at which the launch's tape (curve
 *  plus side pools, whatever the runner hands in) clears every threshold, or
 *  null. Sorted by time; thresholds are cumulative from launch. */
export function ignitionTime(launchTs: number, swaps: readonly SwapSample[], cfg: IgnitionConfig): number | null {
  const s = [...swaps].filter((x) => x.t >= launchTs && x.t <= launchTs + cfg.windowSec).sort((a, b) => a.t - b.t);
  const senders = new Set<string>();
  let usd = 0;
  for (let i = 0; i < s.length; i++) {
    senders.add(s[i].sender.toLowerCase());
    usd += s[i].usd;
    if (i + 1 >= cfg.minSwaps && senders.size >= cfg.minSenders && usd >= cfg.minUsd) return s[i].t;
  }
  return null;
}

// --- concentrated-liquidity arithmetic ----------------------------------------

/** PURE: liquidity for a two-sided seat of `usd` dollars split evenly, with
 *  the band spanning price/width .. price*width. sqrtP is in raw units
 *  (sqrt of currency1-raw per currency0-raw). USDG has 6 decimals. */
export function seatLiquidity(usd: number, sqrtP: number, width: number, usdgIs0: boolean): number {
  const half = (usd / 2) * 1e6;
  const w = Math.sqrt(width);
  // USDG side amount for the half of the band on its side of the price:
  // currency0 side covers price..upper: amount0 = L * (1/sqrtP - 1/sqrtPb)
  // currency1 side covers lower..price: amount1 = L * (sqrtP - sqrtPa)
  return usdgIs0 ? half / (1 / sqrtP - 1 / (sqrtP * w)) : half / (sqrtP - sqrtP / w);
}

/** PURE: USD value of a seat with liquidity L and bounds [sqrtPa, sqrtPb] at
 *  the current sqrtP, priced with the token's USDG price `px`. Handles the
 *  three regimes (below, inside, above the band). Token assumed 18 decimals. */
export function seatValueUsd(L: number, sqrtP: number, sqrtPa: number, sqrtPb: number, usdgIs0: boolean, px: number): number {
  const p = Math.min(Math.max(sqrtP, sqrtPa), sqrtPb);
  const amount0 = L * (1 / p - 1 / sqrtPb); // raw currency0
  const amount1 = L * (p - sqrtPa); // raw currency1
  const usdgRaw = usdgIs0 ? amount0 : amount1;
  const tokenRaw = usdgIs0 ? amount1 : amount0;
  return usdgRaw / 1e6 + (tokenRaw / 1e18) * px;
}

// --- the simulation -------------------------------------------------------------

export interface SimPlan {
  probeUsd: number;
  scaleUsd: number;
  width: number; // 1.5 = +/-50%
  ignitionTs: number | null; // null = never scale
  maxAgeSec: number;
  rolloverDropPct: number; // 30 = an hour down 30% vs the prior hour
  crowdingMultiple: number; // exit when pool L >= multiple x entry L
  outOfRangeExitSec: number; // exit after this long outside the band
  /** Hard floor: exit when the seat marks below this fraction of its capital
   *  (the spec's 60%). The first report week ran WITHOUT this check and the
   *  simulation rode dumps unbounded for the out-of-range window, marking
   *  -$600..-$900 rides no live desk would ever hold (2026-09-01). */
  floorFrac: number;
}

export interface SimResult {
  entryTs: number | null;
  scaledTs: number | null;
  exitTs: number | null;
  exitReason: string;
  feesUsd: number;
  capitalUsd: number;
  valueAtExitUsd: number;
  exitCostUsd: number;
  netUsd: number;
  hoursInRange: number;
}

/** PURE: what probe-then-scale would have earned on this pool's tape. The
 *  seat earns usd * fee * L_ours / (L_pool + L_ours) on every swap while the
 *  price is inside its band; the pool's L is the Swap event's own reading, so
 *  the crowd is priced in swap by swap. Conservative choices: fees and value
 *  are marked at the exit swap, the token half pays one pool fee to leave,
 *  and an out-of-range spell longer than the limit is an exit, not a
 *  re-center. Returns capital 0 when the tape is empty. */
export function simulateSeat(swaps: readonly SwapSample[], feeRate: number, usdgIs0: boolean, plan: SimPlan): SimResult {
  const s = [...swaps].sort((a, b) => a.t - b.t);
  const empty: SimResult = { entryTs: null, scaledTs: null, exitTs: null, exitReason: "no tape", feesUsd: 0, capitalUsd: 0, valueAtExitUsd: 0, exitCostUsd: 0, netUsd: 0, hoursInRange: 0 };
  if (s.length === 0) return empty;
  const w = Math.sqrt(plan.width);
  let capital = plan.probeUsd;
  let entry = s[0];
  let L = seatLiquidity(plan.probeUsd, entry.sqrtP, plan.width, usdgIs0);
  let lo = entry.sqrtP / w;
  let hi = entry.sqrtP * w;
  let entryPoolL = entry.L;
  let scaledTs: number | null = null;
  let fees = 0;
  let inRangeSec = 0;
  let outSince: number | null = null;
  let lastT = s[0].t;
  const hourly = new Map<number, number>();
  const finish = (at: SwapSample, reason: string): SimResult => {
    const value = seatValueUsd(L, at.sqrtP, lo, hi, usdgIs0, at.px);
    const exitCost = (value / 2) * feeRate + 1;
    return { entryTs: s[0].t, scaledTs, exitTs: at.t, exitReason: reason, feesUsd: round(fees), capitalUsd: capital, valueAtExitUsd: round(value), exitCostUsd: round(exitCost), netUsd: round(fees + value - exitCost - capital), hoursInRange: round(inRangeSec / 3600) };
  };
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    // scale at ignition: re-center the whole seat at the ignition price
    if (scaledTs == null && plan.ignitionTs != null && x.t >= plan.ignitionTs) {
      const probeValue = seatValueUsd(L, x.sqrtP, lo, hi, usdgIs0, x.px);
      capital = plan.scaleUsd + (plan.probeUsd - probeValue); // the probe rolls in at its marked value
      L = seatLiquidity(plan.scaleUsd, x.sqrtP, plan.width, usdgIs0);
      lo = x.sqrtP / w;
      hi = x.sqrtP * w;
      entryPoolL = x.L;
      entry = x;
      scaledTs = x.t;
    }
    const inRange = x.sqrtP >= lo && x.sqrtP <= hi;
    if (inRange) {
      inRangeSec += x.t - lastT;
      outSince = null;
      fees += x.usd * feeRate * (L / (x.L + L));
    } else if (outSince == null) outSince = x.t;
    lastT = x.t;
    const h = Math.floor((x.t - s[0].t) / 3600);
    hourly.set(h, (hourly.get(h) ?? 0) + x.usd);
    // exits, checked after the swap is credited; the floor first: it is the
    // hard bound every other exit is allowed to be slower than.
    if (seatValueUsd(L, x.sqrtP, lo, hi, usdgIs0, x.px) < plan.floorFrac * capital) return finish(x, "floor");
    if (x.t - entry.t >= plan.maxAgeSec) return finish(x, "time stop");
    if (outSince != null && x.t - outSince >= plan.outOfRangeExitSec) return finish(x, "out of range too long");
    if (x.L >= entryPoolL * plan.crowdingMultiple) return finish(x, "crowded out");
    if (h >= 3) {
      const a = hourly.get(h - 1) ?? 0;
      const b = hourly.get(h - 2) ?? 0;
      const c = hourly.get(h - 3) ?? 0;
      if (b > 0 && c > 0 && a < b * (1 - plan.rolloverDropPct / 100) && b < c * (1 - plan.rolloverDropPct / 100)) return finish(x, "volume roll-over");
    }
  }
  const last = s[s.length - 1];
  const r = finish(last, "still open at end of tape");
  return r;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** PURE: hourly aggregates for the report. */
export function hourlyTable(swaps: readonly SwapSample[], feeRate: number): { hour: number; swaps: number; usd: number; fees: number; senders: number; pxOpen: number; pxClose: number; L: number }[] {
  const out = new Map<number, { hour: number; swaps: number; usd: number; fees: number; senders: Set<string>; pxOpen: number; pxClose: number; L: number }>();
  for (const x of [...swaps].sort((a, b) => a.t - b.t)) {
    const h = Math.floor(x.t / 3600) * 3600;
    let e = out.get(h);
    if (!e) out.set(h, (e = { hour: h, swaps: 0, usd: 0, fees: 0, senders: new Set(), pxOpen: x.px, pxClose: x.px, L: x.L }));
    e.swaps++;
    e.usd += x.usd;
    e.fees += x.usd * feeRate;
    e.senders.add(x.sender.toLowerCase());
    e.pxClose = x.px;
    e.L = x.L;
  }
  return [...out.values()].map((e) => ({ ...e, senders: e.senders.size }));
}

// --- the candidate feed (2026-09-02) ------------------------------------------
// One day of the watcher's tape said minute-one probes lose at every filter
// (-$7k/day on 274 gated launches) while joining a pool AFTER it has proved an
// hour of flow was the one shape that netted positive, which is also how the
// desk's real winners (BONER, MICRODUCK) were found by hand. This is that rule,
// read-only: the runner logs a candidate, the operator decides, the desk's
// rails hold it. Reads ONLY the hour before `atTs`, never the future.
export interface CandidateConfig {
  minUsd: number; // prior-hour volume bar
  maxMovePct: number; // |price move| over the prior hour, first swap to last
  minSenders: number; // distinct senders in the prior hour
}
export interface CandidateVerdict {
  ok: boolean;
  reason: string;
  volUsd: number;
  movePct: number;
  senders: number;
  swaps: number;
  poolL: number;
  px: number;
}
/** PURE: did the hour ending at `atTs` prove flow worth joining? */
export function candidateVerdict(swaps: readonly SwapSample[], atTs: number, cfg: CandidateConfig): CandidateVerdict {
  const win = swaps.filter((x) => x.t >= atTs - 3600 && x.t < atTs).sort((a, b) => a.t - b.t);
  if (win.length === 0) return { ok: false, reason: "no swaps in the prior hour", volUsd: 0, movePct: 0, senders: 0, swaps: 0, poolL: 0, px: 0 };
  const volUsd = win.reduce((s, x) => s + x.usd, 0);
  const first = win[0], last = win[win.length - 1];
  const movePct = first.px > 0 ? (last.px / first.px - 1) * 100 : 0;
  const senders = new Set(win.map((x) => x.sender.toLowerCase())).size;
  const out = { volUsd: Math.round(volUsd), movePct: Math.round(movePct * 10) / 10, senders, swaps: win.length, poolL: last.L, px: last.px };
  if (volUsd < cfg.minUsd) return { ok: false, reason: `prior hour $${Math.round(volUsd).toLocaleString()} is under the $${cfg.minUsd.toLocaleString()} bar`, ...out };
  if (Math.abs(movePct) > cfg.maxMovePct) return { ok: false, reason: `price moved ${movePct.toFixed(0)}% over the prior hour, past the ${cfg.maxMovePct}% bar`, ...out };
  if (senders < cfg.minSenders) return { ok: false, reason: `${senders} senders in the prior hour, under ${cfg.minSenders}`, ...out };
  return { ok: true, reason: `$${Math.round(volUsd).toLocaleString()} over the prior hour from ${senders} senders, price ${movePct >= 0 ? "+" : ""}${movePct.toFixed(0)}%`, ...out };
}
