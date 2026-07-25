// Realized LP profit accounting — ground truth, not the allocator's optimistic
// burst estimates. The number that actually matters at our size:
//
//   net = fees COLLECTED (realized) − taker fees PAID to churn (rebalance/
//         re-center swaps) ; plus uncollected fees still accruing in-range.
//
// Fees collected are exact (lp-collect records = USDG swept). Taker fees paid
// are ESTIMATED from each swap's size × the pool's fee tier (the fee is taken
// on the swapped amount). Gas is excluded (tiny on this chain) and noted as such.
//
// SCOPE — this measures the LP business and nothing else. It used to also charge
// `rotation` and `entry` executions here, which are the retired directional
// momentum strategy's trades (they come only from executeIndexTrade, never from
// the LP path). That made the public number read −$1.36 net on the LP book when
// the LP mints' own swap cost was well under a dollar: market-making was being
// billed for a different experiment. The LP-attributable swaps are:
//   · lp-mint     — the rebalance leg that evens the pair before minting. Not
//                   separately recorded when it's a BUY, so it is estimated at
//                   ~half the position × the pool's fee tier.
//   · liquidation — the rebalance/exit leg when it's a SELL. This one IS
//                   recorded exactly (realSellStockForUsdg), and it is only ever
//                   reached from the LP path (lpGuard + /api/lp-close).
// A single retile produces at most ONE rebalance leg, so when a liquidation sits
// next to a mint we count the real number and drop the mint's estimate rather
// than charging both for the same swap.
import { readAllExecutions } from "./executionsLog.js";
import { poolFeePct } from "./venues/stockPools.js";
import { openPositionsOnChain, uncollectedFeesUsd } from "./venues/lpPositions.js";

export interface LpProfit {
  windowLabel: string;
  feesCollectedUsd: number;
  uncollectedAccruedUsd: number;
  takerFeesPaidUsd: number;
  netRealizedUsd: number; // collected − paid (gas excluded)
  netWithUncollectedUsd: number; // + fees still owed in-range
  collects: number;
  swaps: number;
}

function feeFrac(symbol?: string): number {
  return symbol ? poolFeePct(symbol) / 100 : 0;
}

// A rebalance sell and the mint it precedes belong to the same retile, so the
// mint's estimated buy leg is a double-count of a swap we already measured
// exactly. Anything inside this window of a mint is treated as the same retile.
const RETILE_WINDOW_MS = 15 * 60 * 1000;

function accountFor(sinceMs: number, label: string, uncollected: number): LpProfit {
  const execs = readAllExecutions().filter((r) => r.success && r.ts >= sinceMs);
  const liquidations = execs.filter((r) => r.kind === "liquidation");
  let feesCollected = 0;
  let takerPaid = 0;
  let collects = 0;
  let swaps = 0;
  for (const r of execs) {
    if (r.kind === "lp-collect") {
      feesCollected += r.amountUsd || 0;
      collects++;
    } else if (r.kind === "lp-mint") {
      // The rebalance leg is already counted exactly if it was a sell.
      const sellCounted = liquidations.some((l) => r.ts - l.ts >= 0 && r.ts - l.ts <= RETILE_WINDOW_MS);
      if (sellCounted) continue;
      // amountUsd = full position (both sides); the swap was ~half, to the stock.
      takerPaid += (r.amountUsd / 2) * feeFrac(r.toSymbol);
      swaps++;
    } else if (r.kind === "liquidation") {
      takerPaid += (r.amountUsd || 0) * feeFrac(r.fromSymbol);
      swaps++;
    }
    // `rotation` / `entry` are the directional strategy's trades, not LP churn —
    // deliberately not charged here. See the scope note at the top of the file.
  }
  const netRealized = feesCollected - takerPaid;
  return {
    windowLabel: label,
    feesCollectedUsd: round(feesCollected),
    uncollectedAccruedUsd: round(uncollected),
    takerFeesPaidUsd: round(takerPaid),
    netRealizedUsd: round(netRealized),
    netWithUncollectedUsd: round(netRealized + uncollected),
    collects,
    swaps,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * All-time and last-24h realized LP profit. Uncollected accrued (read on-chain
 * from open positions) is attributed to the all-time window.
 */
export async function lpProfit(): Promise<{ allTime: LpProfit; last24h: LpProfit; note: string }> {
  let uncollected = 0;
  for (const p of await openPositionsOnChain()) {
    try {
      uncollected += await uncollectedFeesUsd(p);
    } catch {
      /* skip on read failure */
    }
  }
  const now = Date.now();
  return {
    allTime: accountFor(0, "all-time", uncollected),
    last24h: accountFor(now - 24 * 60 * 60 * 1000, "last-24h", 0),
    note: "netRealized = fees collected − taker fees paid on LP rebalance/re-center swaps. Scope is the LP book only: the retired directional strategy's rotations and entries are not charged here. Sell legs are measured exactly; a mint's buy leg is estimated from swap size × pool fee tier. Gas excluded (small on this chain). Uncollected = fees still owed in-range (counted once, in all-time).",
  };
}
