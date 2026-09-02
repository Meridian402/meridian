// The treasury skim, redesigned 2026-08-14. The old skim fired only inside
// the collect path, which starved it: the desk banked ~$80 lifetime against
// ~$695 of fees earned, because re-quotes swept fees back into bands before
// any collect ever triggered. Fees the treasury never receives are fees the
// track record cannot show.
//
// The new rule is a FLOAT TARGET, not an event: once an hour, if the signer
// holds more native ETH than its working float needs, the excess goes to the
// treasury. Simple, direct, and immune to which code path the fees took to
// reach the wallet. USDG is never swept: dollars are the USDG sleeve's
// working capital, and the treasury's revenue unit is ETH.
import { getAgentSigner, getPublicClient, getWalletClient } from "./venues/signer.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { TREASURY_WALLET } from "./merd/wallets.js";
import { guardWalletOp, recordWalletOp } from "./risk.js";
import { registerLoop, beat } from "./liveness.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { recordExecution } from "./executionsLog.js";
import { appendLedger } from "./ledger.js";

const CHECK_MS = 60 * 60 * 1000;
/** ETH float the signer keeps for gas + meme-rotor allowance + slippage room. */
const FLOAT_TARGET_USD = Number(process.env.MERIDIAN_SKIM_FLOAT_TARGET_USD ?? 300);
const MIN_SKIM_USD = 10;

/** PURE: how many USD of ETH to skim, or 0. Exported for tests. */
export function skimAmountUsd(ethFloatUsd: number, targetUsd = FLOAT_TARGET_USD, minSkim = MIN_SKIM_USD): number {
  const excess = ethFloatUsd - targetUsd;
  return excess >= minSkim ? excess : 0;
}

async function runSkim(): Promise<void> {
  const signer = getAgentSigner();
  if (!signer) return;
  const client = getPublicClient();
  const [wei, ethUsd] = await Promise.all([client.getBalance({ address: signer.address }), fetchEthUsd()]);
  if (!ethUsd) return;
  const floatUsd = (Number(wei) / 1e18) * ethUsd;
  const skimUsd = skimAmountUsd(floatUsd);
  if (skimUsd === 0) return;
  guardWalletOp(`treasury-skim $${skimUsd.toFixed(0)}`);
  recordWalletOp(skimUsd, "treasury-skim");
  const valueWei = BigInt(Math.round((skimUsd / ethUsd) * 1e18));
  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({ to: TREASURY_WALLET, value: valueWei });
  await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  recordExecution({ ts: Date.now(), kind: "treasury-skim", fromSymbol: "ETH", toSymbol: "TREASURY", amountUsd: skimUsd, success: true, txHash: hash });
  appendLedger("treasury-skims.jsonl", { ts: Date.now(), usd: skimUsd, wei: valueWei.toString(), tx: hash, floatBeforeUsd: floatUsd, targetUsd: FLOAT_TARGET_USD });
  console.error(`[skim] $${skimUsd.toFixed(2)} of ETH swept to the treasury (float $${floatUsd.toFixed(0)} -> target $${FLOAT_TARGET_USD}), tx ${hash}`);
}

export function startTreasurySkim(): NodeJS.Timeout | undefined {
  if (!getAgentSigner()) return undefined;
  registerLoop("treasurySkim", CHECK_MS, { money: true });
  const tick = () =>
    void withHouseWalletLock("treasurySkim", runSkim)
      .catch((err) => console.error(`[skim] failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`))
      .finally(() => beat("treasurySkim"));
  const timer = setInterval(tick, CHECK_MS);
  timer.unref?.();
  setTimeout(tick, 90 * 1000).unref?.(); // first pass shortly after boot, off the boot rush
  console.error(`[skim] armed: hourly, float target $${FLOAT_TARGET_USD}, min sweep $${MIN_SKIM_USD}`);
  return timer;
}
