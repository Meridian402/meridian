// The track record: Meridian's proof-of-work made permanent and auditable.
// Everything here is derived from durable on-chain-backed logs — the same
// executions.jsonl the cooldown guard trusts, plus a forward mark-to-market
// series this module snapshots — so the "nothing to hide" thesis is a data
// endpoint, not a claim. Read-only; safe on the open internet.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { parseAbiItem } from "viem";
import { dataPath } from "./dataDir.js";
import { getAgentAddress, getAgentSigner, getPublicClient } from "./venues/signer.js";
import { readStockBalances } from "./venues/positionAccounting.js";
import { poolPricesUsd } from "./venues/stockPools.js";
import { lpPositionsWithValue } from "./venues/lpPositions.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { readAllExecutions, type ExecutionRecord } from "./executionsLog.js";
import { capitalFlows } from "./capitalFlows.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EQUITY_PATH = dataPath("equity-snapshots.jsonl");
// Resolved from the configured signer rather than hardcoded, so rotating the
// house wallet is an env change and not a code change. The previous address
// (0x76a4fF...FB38c) was pinned here, which meant a key rotation would have
// silently kept reporting the old wallet's holdings as the book.
const WALLET = getAgentAddress() ?? "0x0000000000000000000000000000000000000000";

// The market-making pivot: executions before this are the momentum experiment,
// after are the LP era. Used to split the track record into its two chapters.
const MARKET_MAKING_SINCE = Date.parse("2026-07-14T00:00:00Z");
// Inception isn't fully in executions.jsonl (the very first funding predates
// it), so we anchor the equity series with the known starting mark.
// Pinned to the WALLET it describes. The house key was rotated on 2026-07-23 and
// this anchor still described the previous wallet's funding, so a brand-new
// empty wallet was published as "-$244 since inception". An anchor that outlives
// the wallet it belongs to is just another wrong number.
const INCEPTION = {
  wallet: "0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c",
  ts: Date.parse("2026-07-11T20:50:00Z"),
  totalUsd: 244,
  note: "Agent funded and made its first autonomous trade: ~$180 USDG deployed + ~$64 ETH gas reserve.",
};
/** True only when the anchor actually describes the wallet we are reporting on. */
const inceptionApplies = INCEPTION.wallet.toLowerCase() === WALLET.toLowerCase();

export interface EquityPoint {
  ts: number;
  totalUsd: number;
  lpValueUsd: number;
  stockUsd: number;
  cashUsd: number;
  /** Set when a holdings read failed, so totalUsd is known to be incomplete. */
  degraded?: string;
}

/** Live mark-to-market of the whole wallet: LP position value + loose stock + cash. */
export async function computeEquityNow(): Promise<EquityPoint | null> {
  const address = getAgentAddress();
  if (!address) return null;
  const client = getPublicClient();
  const [balances, prices, ethUsd, ethRaw, usdgRaw, lp] = await Promise.all([
    readStockBalances(address).catch(() => ({}) as Record<string, number>),
    poolPricesUsd().catch(() => ({}) as Record<string, number>),
    fetchEthUsd().catch(() => 0),
    client.getBalance({ address }),
    client.readContract({
      address: USDG as `0x${string}`,
      abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
      functionName: "balanceOf",
      args: [address],
    }),
    // NOT `.catch(() => [])`. A failed read there is indistinguishable from
    // "no positions", so a transient RPC failure published the wallet as $0.81
    // while a healthy $157 NVDA position sat in the PoolManager, and the public
    // track record read -99.67%. Silence about a failure is worse than the
    // failure. Carry the outcome so the caller can refuse to publish a total it
    // knows is incomplete.
    lpPositionsWithValue().then(
      (p) => ({ ok: true as const, positions: p }),
      (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e).slice(0, 160) }),
    ),
  ]);
  let stockUsd = 0;
  for (const [sym, qty] of Object.entries(balances)) {
    const px = prices[sym];
    if (qty && px && qty * px >= 0.01) stockUsd += qty * px;
  }
  const lpValueUsd = lp.ok ? lp.positions.reduce((a, p) => a + p.valueUsd, 0) : 0;
  const usdg = Number(usdgRaw) / 1e6;
  const eth = Number(ethRaw) / 1e18;
  const cashUsd = usdg + eth * ethUsd;
  return {
    ts: Date.now(),
    totalUsd: stockUsd + lpValueUsd + cashUsd,
    lpValueUsd,
    stockUsd,
    cashUsd,
    ...(lp.ok ? {} : { degraded: `LP position read failed (${lp.error}) — total EXCLUDES LP value` }),
  };
}

/** Forward mark-to-market log. Operator-only writer (needs no key, but gating on the signer keeps ONE writer; the cloud serves the pushed file). */
export function startEquitySnapshotter(): NodeJS.Timeout | undefined {
  if (!getAgentSigner()) return undefined;
  const snap = async () => {
    try {
      const e = await computeEquityNow();
      if (e) appendLedger("equity-snapshots.jsonl", e);
    } catch {
      /* a missed snapshot is harmless; the series is sparse by design */
    }
  };
  const timer = setInterval(() => void snap(), 30 * 60 * 1000);
  timer.unref?.();
  void snap();
  return timer;
}

function readEquitySeries(): EquityPoint[] {
  if (!existsSync(EQUITY_PATH)) return [];
  const rows: EquityPoint[] = [];
  for (const line of readFileSync(EQUITY_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as EquityPoint);
    } catch {}
  }
  return rows;
}

const EXPLORER = "https://robinhoodchain.blockscout.com";

function label(e: ExecutionRecord): { title: string; detail: string } {
  const pair = e.fromSymbol && e.toSymbol ? `${e.fromSymbol} → ${e.toSymbol}` : e.toSymbol ?? "";
  switch (e.kind) {
    case "entry":
      return { title: `Entered ${e.toSymbol}`, detail: `First position, ~$${e.amountUsd.toFixed(0)}.` };
    case "rotation":
      return { title: `Rotated ${pair}`, detail: `Momentum rotation, ~$${e.amountUsd.toFixed(0)}.` };
    case "liquidation":
      return { title: `Liquidated ${e.fromSymbol}`, detail: `Closed the momentum experiment to cash.` };
    case "lp-mint":
      return { title: `Opened LP range · ${e.toSymbol}/USDG`, detail: `Began market-making with ~$${e.amountUsd.toFixed(0)}.` };
    case "lp-exit":
      return { title: `Closed LP range · ${e.fromSymbol}/USDG`, detail: `Withdrew liquidity (re-center, re-tighten, or weekend guard).` };
    case "lp-collect":
      return { title: `Collected fees · ${e.fromSymbol}/USDG`, detail: `Realized ~$${e.amountUsd.toFixed(2)} of accrued LP fees to the wallet; position kept earning.` };
    case "yield-enter":
      return { title: `Entered $INDEX`, detail: `Yield position, ~$${e.amountUsd.toFixed(0)}.` };
    case "yield-exit":
      return { title: `Exited $INDEX`, detail: `Closed yield position.` };
    default:
      return { title: e.kind, detail: `~$${e.amountUsd.toFixed(0)}.` };
  }
}

// The momentum-experiment trades predate executions.jsonl (that ledger was
// added after the churn it failed to catch), so we seed them from their real,
// verified on-chain hashes. This is the honest heart of the record: the first
// trade, and the open-churn that lost money — receipts and all.
interface TimelineEvent {
  ts: number;
  title: string;
  detail: string;
  success: boolean;
  error: string | null;
  era: string;
  txUrl: string | null;
}
const GENESIS: TimelineEvent[] = [
  {
    ts: Date.parse("2026-07-11T20:50:08Z"),
    title: "First autonomous trade",
    detail: "Bought ~$178 of META from USDG — the first real on-chain fill after four stacked bugs were cleared.",
    success: true,
    error: null,
    era: "momentum-experiment",
    txUrl: `${EXPLORER}/tx/0xccff3a584286209af76282762f18a76895a5e39eeee3755f9461b8a3cfb7b352`,
  },
  {
    ts: Date.parse("2026-07-12T02:43:03Z"),
    title: "Rotated META → NVDA",
    detail: "First stock-to-stock rotation through the depth-verified pools, in one atomic multi-hop swap.",
    success: true,
    error: null,
    era: "momentum-experiment",
    txUrl: `${EXPLORER}/tx/0xa690d66cfcdf5221e8de15334ae41719fb78b456512a3e07e2bf6e60d2f017f4`,
  },
  {
    ts: Date.parse("2026-07-13T13:36:57Z"),
    title: "Chased the open: NVDA → AAPL",
    detail: "Momentum fired on AAPL's opening gap through a 1% pool — the first leg of a churn the backtest had warned about.",
    success: true,
    error: null,
    era: "momentum-experiment",
    txUrl: `${EXPLORER}/tx/0x309c49d35e8d6846f1a5db3e42a96c514b2db2e084a5502cadfde993c14b1da2`,
  },
  {
    ts: Date.parse("2026-07-13T15:27:47Z"),
    title: "Reversed: AAPL → NVDA",
    detail: "The gap snapped back and the trade reversed ~2 hours later. Two round trips through a 1% pool cost ~$5 — the loss that retired momentum trading.",
    success: true,
    error: null,
    era: "momentum-experiment",
    txUrl: `${EXPLORER}/tx/0xfadea90504347a6b066ea0e8f0f29118f72827a5c0272c462c50a6449f3038e2`,
  },
];

/**
 * DELIBERATELY UNREFERENCED. Do not delete this as dead code.
 *
 * The /api/performance route was removed when the track record page went, so
 * nothing calls this today. The WRITER is still running: startEquitySnapshotter
 * appends to equity-snapshots.jsonl every 30 minutes, and that file is
 * ledgered, backed up and synced. Deleting the reader would leave us
 * accumulating a history nobody can read without writing it again from scratch,
 * and an equity series is the one thing that cannot be backfilled after the
 * fact. It stays as the way back into data we are still collecting on purpose.
 */
export async function performanceSummary() {
  const live = await computeEquityNow();
  const execs = readAllExecutions();
  const snapshots = readEquitySeries();

  const logged: TimelineEvent[] = execs.map((e) => {
    const { title, detail } = label(e);
    return {
      ts: e.ts,
      title,
      detail,
      success: e.success,
      error: e.error ?? null,
      era: e.ts >= MARKET_MAKING_SINCE ? "market-making" : "momentum-experiment",
      txUrl: e.txHash ? `${EXPLORER}/tx/${e.txHash}` : null,
    };
  });
  // Merge genesis + logged, dedupe by tx, oldest first.
  const seenTx = new Set(logged.map((e) => e.txUrl).filter(Boolean));
  const timeline = [...GENESIS.filter((g) => !seenTx.has(g.txUrl)), ...logged].sort((a, b) => a.ts - b.ts);

  // Equity series: inception anchor → forward snapshots → live point. The anchor
  // and the historical snapshots belong to the previous wallet, so after a
  // rotation the series starts from the new wallet's own observations only.
  const series: EquityPoint[] = [
    ...(inceptionApplies
      ? [{ ts: INCEPTION.ts, totalUsd: INCEPTION.totalUsd, lpValueUsd: 0, stockUsd: 180, cashUsd: 64 }]
      : []),
    ...(inceptionApplies ? snapshots : []),
    ...(live ? [live] : []),
  ].sort((a, b) => a.ts - b.ts);

  const currentUsd = live?.totalUsd ?? series[series.length - 1]?.totalUsd ?? 0;
  const fills = timeline.filter((e) => e.success && e.txUrl).length;

  // Real P&L needs capital flows. `currentUsd - inception` counts every deposit
  // as profit and every withdrawal as loss: a deliberate 0.0754 ETH withdrawal
  // on 2026-07-22 was being published as part of a -99.67% "loss". Contributed
  // capital is deposits minus withdrawals, so P&L is what the book actually did.
  const ethUsdNow = await fetchEthUsd().catch(() => 0);
  const flows = ethUsdNow > 0 ? await capitalFlows(WALLET, ethUsdNow).catch(() => null) : null;
  const contributed = flows && !flows.degraded && flows.netContributedUsd > 0 ? flows.netContributedUsd : null;
  const pnlUsd = contributed === null ? null : currentUsd - contributed;

  return {
    wallet: WALLET,
    explorer: `${EXPLORER}/address/${WALLET}`,
    inception: inceptionApplies ? INCEPTION : null,
    current: {
      totalUsd: currentUsd,
      lpValueUsd: live?.lpValueUsd ?? 0,
      cashUsd: live?.cashUsd ?? 0,
      // Only meaningful while the anchor describes THIS wallet. Kept explicitly
      // labelled either way: it is not profit and loss, it is the change in
      // wallet value including every deposit and withdrawal. Use pnl below.
      ...(inceptionApplies
        ? {
            changeVsInceptionUsd: currentUsd - INCEPTION.totalUsd,
            changeVsInceptionNote: "wallet value vs inception — INCLUDES deposits and withdrawals, not P&L",
          }
        : { changeVsInceptionNote: "no inception anchor for this wallet (house wallet rotated)" }),
    },
    capital: flows
      ? {
          depositedUsd: Math.round((flows.ethInUsd + flows.usdgInUsd) * 100) / 100,
          withdrawnUsd: Math.round((flows.ethOutUsd + flows.usdgOutUsd) * 100) / 100,
          netContributedUsd: Math.round(flows.netContributedUsd * 100) / 100,
          transfers: flows.transfers,
          degraded: flows.degraded ?? null,
        }
      : null,
    pnl:
      live?.degraded
        ? { available: false, note: `holdings incomplete: ${live.degraded}` }
        : pnlUsd === null
        ? {
            available: false,
            // Distinguish "we could not read the flows" from "this wallet has
            // not been funded yet". Both withhold P&L; only one is a fault.
            note:
              flows && !flows.degraded
                ? "no capital contributed to this wallet yet — nothing to measure"
                : "capital flows unavailable — P&L cannot be computed without them",
          }
        : {
            available: true,
            netUsd: Math.round(pnlUsd * 100) / 100,
            netPct: contributed ? Math.round((pnlUsd / contributed) * 10000) / 100 : null,
            note: "current wallet value minus net capital contributed (deposits less withdrawals)",
          },
    stats: {
      onChainFills: fills,
      totalEvents: execs.length,
      marketMakingSince: MARKET_MAKING_SINCE,
    },
    series,
    timeline,
    asOf: Date.now(),
  };
}
