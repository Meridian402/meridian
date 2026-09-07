// The final figures of the Meridian desk, as the site displayed them at close
// on 2026-09-07. Shipped in code so the Railway image (which carries dist/,
// package.json and node_modules only) always has them; record-closed.json at
// the agent root is the same data for humans and tests.
import type { ClosedRecord } from "./recordClosed.js";

export const CLOSED_RECORD: ClosedRecord = {
  closedAt: "2026-09-07T11:11:43Z",
  closedLabel: "September 7, 2026",
  note: "The Meridian desk was wound down on 2026-09-07. These are the final figures as the site displayed them at close. They are not read live any more; the house wallet has since been retired.",
  book: {
    profitUsd: 3002.62,
    bookUsd: 3999.62,
    bankedUsd: 3999.62,
    workingUsd: 0,
    bookEth: 1.6083,
    totalAssetsUsd: 4075,
    merdAmt: 1200000,
    capitalInUsd: 997,
    startedLabel: "August 4",
  },
  record: {
    daysLive: 33,
    lifetimeFeesUsd: 3259.41,
    bestDayUsd: 359.24,
    worstDaySinceFloorUsd: -275.91,
    feesCollectedTimelineUsd: 3019.59,
  },
  wallets: {
    house: "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe",
    ethUsdAtClose: 2486.87,
  },
};
