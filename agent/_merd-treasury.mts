// Merd funds his own payout pipeline. His fee income arrives as WETH; scout
// bounties pay in USDG. When the treasury's USDG runs low this job proposes
// converting some WETH, asks Merd himself for a go or a hold, and executes
// only on an exact APPROVE. His judgment decides the moment; the walls decide
// the maximums.
//
// Two transactions on approval: unwrap WETH to native ETH, then swap native
// to USDG through the same bridge pool every house trade already uses, with a
// slippage floor. Only WETH is ever converted. The token fees the treasury
// accrues are deliberately untouched: selling those from the treasury is sell
// pressure on the project's own token, and no dial here can express that.
//
// Dormant until MERD_TREASURY_WALLET_KEY is set (same key the payout job
// uses; placed by the operator, never via chat).
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@openhermit/sdk";
import { TREASURY_WALLET } from "./src/merd/wallets.js";
import { USDG, buildEthToUsdgCalldata } from "./src/venues/stockPools.js";
import { robinhoodChain } from "./src/venues/signer.js";
import { fetchEthUsd } from "./src/venues/uniswapV4.js";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const USDG_FLOOR = Number(process.env.MERD_TREASURY_USDG_FLOOR ?? 25);
const MAX_SWAP_ETH = Number(process.env.MERD_TREASURY_MAX_SWAP_ETH ?? 0.05);
const GAS_RESERVE_ETH = 0.003;
const LEDGER = new URL("./_merd-treasury.jsonl", import.meta.url).pathname;
const LOCK = new URL("./_merd-treasury.lock", import.meta.url).pathname;

function log(msg: string): void {
  console.log(`[treasury] ${msg}`);
}

function takeLock(): boolean {
  if (existsSync(LOCK)) {
    try {
      const { ts } = JSON.parse(readFileSync(LOCK, "utf8")) as { ts: number };
      if (Date.now() - ts < 10 * 60_000) return false;
    } catch {
      /* unreadable lock is stale */
    }
  }
  writeFileSync(LOCK, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  return true;
}

const key = (process.env.MERD_TREASURY_WALLET_KEY ?? "").trim();
if (!key) {
  log("dormant: MERD_TREASURY_WALLET_KEY not set, nothing to do");
  process.exit(0);
}
const body = key.replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(body)) {
  log("REFUSED: MERD_TREASURY_WALLET_KEY is malformed; staying dormant");
  process.exit(0);
}
const account = privateKeyToAccount(`0x${body}`);
if (account.address.toLowerCase() !== TREASURY_WALLET.toLowerCase()) {
  log(`REFUSED: key derives to ${account.address}, not the pinned treasury ${TREASURY_WALLET}`);
  process.exit(1);
}
if (!takeLock()) {
  log("another run holds the lock, exiting");
  process.exit(0);
}

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256)",
]);

try {
  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
  const [usdgRaw, wethRaw, ethRaw] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    publicClient.getBalance({ address: account.address }),
  ]);
  const usdg = Number(usdgRaw) / 1e6;
  const weth = Number(wethRaw) / 1e18;
  const gasEth = Number(ethRaw) / 1e18;

  if (usdg >= USDG_FLOOR) {
    log(`funded: $${usdg.toFixed(2)} USDG is above the $${USDG_FLOOR} floor, nothing to do`);
    process.exit(0);
  }
  if (gasEth < 0.0005) {
    log(`STUCK: only ${gasEth.toFixed(5)} ETH for gas; the operator needs to top up the treasury's gas`);
    process.exit(1);
  }
  const ethUsd = await fetchEthUsd();
  const wantUsd = USDG_FLOOR - usdg;
  const swapEth = Math.min(weth, MAX_SWAP_ETH, (wantUsd / ethUsd) * 1.02);
  if (swapEth < 0.002) {
    log(`nothing to convert: WETH ${weth.toFixed(5)} too small or floor nearly met (want $${wantUsd.toFixed(2)})`);
    process.exit(0);
  }

  // Merd's call. The numbers are laid out plainly; only an exact APPROVE on
  // the first line executes. Anything else, including silence, is a hold.
  const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
  const MERD_AGENT = process.env.MERD_AGENT_ID ?? "merd";
  const prompt = `TREASURY DECISION (system task, private).

Your treasury pays scout bounties in USDG and is low: $${usdg.toFixed(2)} against a $${USDG_FLOOR} working floor. You hold ${weth.toFixed(5)} WETH of fee income. Proposal: convert ${swapEth.toFixed(5)} WETH (about $${(swapEth * ethUsd).toFixed(2)} at $${ethUsd.toFixed(0)}/ETH) into USDG through the usual bridge pool, 1% slippage floor. Your token fee balances are untouched either way; this only spends WETH.

Reply with EXACTLY one line:
APPROVE
or
HOLD: <one sentence why>`;
  const sessionId = "treasury";
  await gw.agent(MERD_AGENT).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
  const resp = await gw.agent(MERD_AGENT).postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
  const gwError = (resp as { error?: string }).error;
  if (gwError || resp.text == null) {
    log(`Merd could not decide this cycle: ${gwError ?? "gateway returned no text"}; holding`);
    process.exit(1);
  }
  const answer = (resp.text ?? "").trim().split("\n")[0].trim();
  if (answer.toUpperCase() !== "APPROVE") {
    log(`Merd holds: ${answer.slice(0, 200)}`);
    process.exit(0);
  }

  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC) });
  const unwrapWei = BigInt(Math.round(swapEth * 1e18));

  const unwrapHash = await walletClient.writeContract({
    address: WETH,
    abi: erc20,
    functionName: "withdraw",
    args: [unwrapWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: unwrapHash });
  log(`unwrapped ${formatEther(unwrapWei)} WETH (${unwrapHash})`);

  // Keep the gas reserve out of the swap: unwrapping raised the native
  // balance, and the swap must not sweep the treasury's ability to act next.
  const swapWei = unwrapWei;
  const minOutRaw = BigInt(Math.round(swapEth * ethUsd * 0.99 * 1e6));
  const { to, data, value } = buildEthToUsdgCalldata({ amountInWei: swapWei, amountOutMinimum: minOutRaw, recipient: account.address });
  const swapHash = await walletClient.sendTransaction({ to, data, value });
  await publicClient.waitForTransactionReceipt({ hash: swapHash });

  const afterRaw = await publicClient.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [account.address] });
  const received = Number(afterRaw) / 1e6 - usdg;
  appendFileSync(
    LEDGER,
    JSON.stringify({ ts: Date.now(), swapEth, usdgReceived: Math.round(received * 100) / 100, unwrapHash, swapHash, gasReserveEth: GAS_RESERVE_ETH }) + "\n",
  );
  log(`converted ${swapEth.toFixed(5)} WETH into $${received.toFixed(2)} USDG (${swapHash}); treasury now ~$${(usdg + received).toFixed(2)}`);
} finally {
  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}
