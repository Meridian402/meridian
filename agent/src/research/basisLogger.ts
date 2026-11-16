// Standalone basis logger: samples on-chain pool price vs NYSE (Yahoo) price
// for the five depth-verified tickers and appends JSONL to basis-log.jsonl.
// The point is the weekend -> Monday-open window: pools trade 24/7 but lose
// their price anchor while NYSE is closed. If the drift we log reliably
// converges to the opening prints, "buy pool discount / sell pool premium vs
// NYSE, net of fees" is a tradable signal with a mechanical anchor — unlike
// the momentum spread, which our own backtest showed trails buy-and-hold.
// Run: npx tsx --env-file=.env src/research/basisLogger.ts   (one instance)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { fileURLToPath } from "node:url";
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem, type Address } from "viem";
import { INDEX_CONTRACTS } from "../venues/indexContracts.js";
import { dataPath } from "../dataDir.js";
import { getPublicClient } from "../venues/signer.js";
import { redactRpcText } from "../venues/rpcBreaker.js";

// Reads go through the desk's shared client, which fails over from the
// dedicated provider to the public endpoint. This logger used to build its own
// client on ROBINHOOD_RPC_URL alone, so when that provider revoked the network
// (found 2026-11-16) every sample failed, and each failure wrote the provider's
// full URL, key included, into basis-log.jsonl.

const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;
const SAMPLE_MS = Number(process.env.BASIS_SAMPLE_MS ?? 5 * 60 * 1000);
const OUT = dataPath("basis-log.jsonl");
// Bound the append-only log so it can't grow forever on the volume. ~2 weeks of
// 5 tickers every 5min. Trimmed opportunistically (~every 4h of samples).
const MAX_LINES = Number(process.env.BASIS_LOG_MAX_LINES ?? 20000);
let _samplesSinceTrim = 0;
function trimBasisLog(): void {
  if (++_samplesSinceTrim < 50) return;
  _samplesSinceTrim = 0;
  try {
    if (!existsSync(OUT)) return;
    const lines = readFileSync(OUT, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > MAX_LINES) writeFileSync(OUT, lines.slice(-MAX_LINES).join("\n") + "\n");
  } catch {}
}

// Same five (symbol, fee, tickSpacing) as stockPools.POOLS — the depth-verified set.
const TICKERS: [string, number, number][] = [
  ["AAPL", 10000, 200],
  ["GOOGL", 10000, 200],
  ["META", 3000, 60],
  ["NVDA", 3000, 60],
  ["TSLA", 3000, 60],
];

async function poolPx(token: Address, fee: number, tickSpacing: number): Promise<number> {
  const [c0, c1] = token.toLowerCase() < USDG.toLowerCase() ? [token, USDG] : [USDG, token];
  const id = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, fee, tickSpacing, NATIVE]),
  );
  const [sqrtP] = await getPublicClient().readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [id],
  });
  const p = (Number(sqrtP) / Q96) ** 2;
  const raw = c0.toLowerCase() === token.toLowerCase() ? p : 1 / p;
  return raw * 1e12; // USDG 6 decimals vs token 18
}

async function nysePx(symbol: string): Promise<{ price: number; marketTime: number; state: string }> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  const meta = ((await res.json()) as any).chart.result[0].meta;
  return { price: meta.regularMarketPrice, marketTime: meta.regularMarketTime, state: meta.marketState ?? "?" };
}

async function sample(): Promise<void> {
  const ts = Date.now();
  for (const [symbol, fee, tickSpacing] of TICKERS) {
    try {
      const token = (INDEX_CONTRACTS.tokens as Record<string, string>)[symbol] as Address;
      const [pool, nyse] = await Promise.all([poolPx(token, fee, tickSpacing), nysePx(symbol)]);
      const row = {
        ts,
        symbol,
        poolUsd: pool,
        nyseUsd: nyse.price,
        basisPct: ((pool - nyse.price) / nyse.price) * 100,
        nyseMarketTime: nyse.marketTime,
        nyseState: nyse.state,
      };
      appendLedger("basis-log.jsonl", row);
    } catch (err) {
      // Redacted and bounded: an RPC error prints its request URL, and a row here
      // is mirrored to Postgres and kept for weeks.
      appendLedger("basis-log.jsonl", { ts, symbol, error: redactRpcText(err, 200) });
    }
  }
  trimBasisLog();
}

/** Start the basis sampler in-process (used by the main server so it runs wherever the agent runs). */
export function startBasisLogger(): NodeJS.Timeout {
  console.log(`[basisLogger] sampling ${TICKERS.length} tickers every ${SAMPLE_MS / 60000}min -> ${OUT}`);
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref?.();
  void sample();
  return timer;
}

// Standalone entry (npx tsx src/research/basisLogger.ts) still works.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) startBasisLogger();
