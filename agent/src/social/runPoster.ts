// Standalone poster: Merd's X cadence and NOTHING else.
//
// The cadence lives inside the main server, but starting that process to get
// tweets would also start startLpGuard() and startLpAllocator() — and
// AGENT_SIGNER_PRIVATE_KEY is set, so those are a live guard over the house
// wallet, autonomously moving real liquidity. Turning on a social account is
// not a reason to turn on money movement.
//
// This runs the read-only yield sampler (chain reads, no signer) so the
// composer has real numbers to speak from, and the cadence loop. It holds no
// key and can move nothing.
//
//   npx tsx --env-file=.env src/social/runPoster.ts
import { startYieldLogger, yieldSummary } from "../research/yieldLogger.js";
import { startMerdCadence } from "./cadence.js";
import { xLive } from "./xClient.js";

console.log(`[poster] starting — X_LIVE=${xLive()}`);
startYieldLogger();

startMerdCadence(() => {
  const y = yieldSummary() as { latest?: { measuredSyrupAprPct?: number | null; indexImpliedAprPct?: number | null } | null };
  const syrup = y?.latest?.measuredSyrupAprPct;
  const index = y?.latest?.indexImpliedAprPct;
  const best =
    syrup != null && (index == null || syrup >= index)
      ? { label: "syrupUSDG carry", aprPct: syrup }
      : index != null
        ? { label: "$INDEX distributions", aprPct: index }
        : null;
  return { topYield: best };
});

process.on("SIGINT", () => {
  console.log("\n[poster] stopped");
  process.exit(0);
});
