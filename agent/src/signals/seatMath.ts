// SEAT ARITHMETIC, in dollars and dollar prices. Pure, no I/O, no imports at run time.
//
// Shared by the paper replay (signals/paperReplay.ts) and the live pilot guard, so the
// number the paper desk judges a pool on and the number the live desk acts on are the same
// function. Moved here from paperReplay.ts on 2026-11-20, unchanged.
import type { LedgerHour } from "./poolWatch.js";

const HOUR = 3600;
/** The watchers wrote seatSharePct for this seat; pool liquidity is recovered from it. */
const REF_SEAT_USD = 1000;
const REF_WIDTH = 1.25;
/** Slippage charged on top of the pool fee when inventory is swapped back to dollars. */
export const SWAP_SLIPPAGE = 0.003;
/** Dollars per on-chain action. Measured on the desk's chain (about 145k gas a
 *  collect, $0.19 at the time); the rest are ASSUMPTIONS until we transact there. */
export const GAS_PER_OP_USD: Record<string, number> = { robinhood: 0.19, bnb: 0.1, base: 0.03, eth: 5 };

/** PURE: liquidity of the reference seat (balanced, price / w .. price * w) at a price. */
export const refLiquidity = (price: number, usd = REF_SEAT_USD, width = REF_WIDTH): number => usd / (2 * Math.sqrt(price) * (1 - 1 / Math.sqrt(width)));

/** PURE: the pool's active liquidity, in the same units as a seat's, from the
 *  share the watcher recorded for the reference seat at that hour's close. */
export function poolLiquidity(row: Pick<LedgerHour, "pxClose" | "seatSharePct">): number {
  const s = row.seatSharePct / 100;
  if (!(s > 0)) return Infinity; // the seat rounded to nothing next to this pool
  if (s >= 1) return 0;
  return (refLiquidity(row.pxClose) * (1 - s)) / s;
}

export interface Band {
  L: number;
  pa: number;
  pb: number;
}

/** PURE: the desk's entry shape. All dollars, top edge at spot, reaching
 *  widthPct/2 percent of range below it (width 50 is spot/1.25 .. spot). */
export function bidBand(usd: number, spot: number, widthPct = 50): Band {
  const pb = spot;
  const pa = spot / (1 + widthPct / 200);
  return { L: usd / (Math.sqrt(pb) - Math.sqrt(pa)), pa, pb };
}

/** PURE: a balanced seat, half each side of spot. Used for the passive baseline. */
export function balancedBand(usd: number, spot: number, width = REF_WIDTH): Band {
  return { L: refLiquidity(spot, usd, width), pa: spot / width, pb: spot * width };
}

/** PURE: what a band holds at a price. Above the band it is all dollars,
 *  below it all token; the value rises with the price throughout. */
export function bandAt(b: Band, price: number): { quoteUsd: number; tokenUsd: number; valueUsd: number } {
  const q = Math.min(Math.max(price, b.pa), b.pb);
  const quoteUsd = b.L * (Math.sqrt(q) - Math.sqrt(b.pa));
  const tokenUsd = b.L * (1 / Math.sqrt(q) - 1 / Math.sqrt(b.pb)) * price;
  return { quoteUsd, tokenUsd, valueUsd: quoteUsd + tokenUsd };
}

/** PURE: the share of an hour's traded range that lay inside a band (log scale). */
export function inRangeFraction(low: number, high: number, pa: number, pb: number): number {
  if (!(high > low)) return low >= pa && low <= pb ? 1 : 0;
  const lo = Math.max(low, pa), hi = Math.min(high, pb);
  return hi > lo ? Math.log(hi / lo) / Math.log(high / low) : 0;
}

/** PURE: the price at which a band is worth `target` dollars, between two prices. */
export function priceAtValue(b: Band, target: number, lowPrice: number, highPrice: number): number {
  let lo = lowPrice, hi = highPrice;
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if (bandAt(b, mid).valueUsd < target) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/**
 * PURE: what a bid seat of `seatUsd` would have KEPT, opened at the close of rows[i0] and held
 * for `hours` hours without being moved: its fees, plus what the price did to it, minus gas, the
 * collects and the swap back to dollars at the end. It leaves at `floorUsd` like a real seat.
 * NaN when the record has a gap or does not reach that far. Reads rows[i0 .. i0 + hours] only.
 */
export function refSeatNet(rows: readonly LedgerHour[], i0: number, hours: number, seatUsd: number, widthPct: number, floorUsd: number, gasUsd: number, feePct: number): number {
  if (i0 < 0 || i0 + hours >= rows.length) return NaN;
  if (rows[i0 + hours].hourStart - rows[i0].hourStart !== hours * HOUR) return NaN;
  const band = bidBand(seatUsd, rows[i0].pxClose, widthPct);
  const exitCost = (tokenUsd: number) => gasUsd * (tokenUsd > 0.01 ? 2 : 1) + tokenUsd * (feePct / 100 + SWAP_SLIPPAGE);
  let fees = 0, costs = gasUsd;
  for (let j = i0 + 1; j <= i0 + hours; j++) {
    const r = rows[j];
    const share = band.L / (poolLiquidity(r) + band.L);
    if (bandAt(band, r.pxLow).valueUsd < floorUsd) {
      const gapped = bandAt(band, r.pxOpen).valueUsd < floorUsd;
      const exitValue = gapped ? bandAt(band, r.pxOpen).valueUsd : floorUsd;
      const exitPrice = gapped ? r.pxOpen : priceAtValue(band, floorUsd, r.pxLow, r.pxOpen);
      fees += 0.5 * r.feesUsd * share * inRangeFraction(r.pxLow, r.pxHigh, band.pa, band.pb);
      return fees + exitValue - seatUsd - costs - exitCost(bandAt(band, exitPrice).tokenUsd);
    }
    const fee = r.feesUsd * share * inRangeFraction(r.pxLow, r.pxHigh, band.pa, band.pb);
    fees += fee;
    if (fee >= 1) costs += gasUsd;
  }
  const at = bandAt(band, rows[i0 + hours].pxClose);
  return fees + at.valueUsd - seatUsd - costs - exitCost(at.tokenUsd);
}

/** PURE: the average of refSeatNet over the day-long seats that ended at each of the last 24
 *  hours up to rows[idx], and the latest of them on its own. Reads nothing after rows[idx]. */
export function seatNetScore(idx: number, seat: (i0: number) => number): { avg: number; lastDay: number } {
  const nets: number[] = [];
  for (let k = 0; k < 24; k++) nets.push(seat(idx - 24 - k));
  return { avg: nets.some((x) => !Number.isFinite(x)) ? NaN : nets.reduce((a, b) => a + b, 0) / nets.length, lastDay: nets[0] };
}
