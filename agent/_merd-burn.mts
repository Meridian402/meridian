// One-shot, operator-ordered burn from the treasury. Sends an exact amount of
// an ERC-20 the treasury holds to the canonical dead address, which no key
// controls, making the burn permanent and publicly checkable.
//
// DELIBERATELY GENERIC: the token comes in as an argument, never hardcoded,
// because this file is public and some token addresses are not ours to
// publish. Usage:
//
//   ./_merd-burn.sh <tokenAddress> <amount|all>
//
// Refuses: a missing or malformed key, a key that is not the treasury's, the
// platform's own working assets (USDG, WETH), a zero balance, and an amount
// above the balance. Simulates before sending. This is a hand-run tool, not
// a scheduled job: a burn is irreversible, so a human types the amount.
import { appendFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TREASURY_WALLET } from "./src/merd/wallets.js";
import { USDG } from "./src/venues/stockPools.js";
import { robinhoodChain } from "./src/venues/signer.js";

const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const LEDGER = new URL("./_merd-burns.jsonl", import.meta.url).pathname;

function log(msg: string): void {
  console.log(`[burn] ${msg}`);
}

const [token, amountArg] = process.argv.slice(2);
if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
  log("usage: ./_merd-burn.sh <tokenAddress> <amount|all>");
  process.exit(1);
}
if (!amountArg) {
  log("no amount given. Say how much to burn, or the word: all");
  process.exit(1);
}
if ([USDG.toLowerCase(), WETH.toLowerCase()].includes(token.toLowerCase())) {
  log("REFUSED: that is a working asset of the platform, not a burnable holding");
  process.exit(1);
}

const key = (process.env.MERD_TREASURY_WALLET_KEY ?? "").trim();
if (!key) {
  log("dormant: MERD_TREASURY_WALLET_KEY not set; place the key, then rerun");
  process.exit(0);
}
const body = key.replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(body)) {
  log("REFUSED: MERD_TREASURY_WALLET_KEY is malformed");
  process.exit(1);
}
const account = privateKeyToAccount(`0x${body}`);
if (account.address.toLowerCase() !== TREASURY_WALLET.toLowerCase()) {
  log(`REFUSED: key derives to ${account.address}, not the pinned treasury ${TREASURY_WALLET}`);
  process.exit(1);
}

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
const [balance, decimals, symbol] = await Promise.all([
  publicClient.readContract({ address: token as `0x${string}`, abi: erc20, functionName: "balanceOf", args: [account.address] }),
  publicClient.readContract({ address: token as `0x${string}`, abi: erc20, functionName: "decimals" }).catch(() => 18),
  publicClient.readContract({ address: token as `0x${string}`, abi: erc20, functionName: "symbol" }).catch(() => "?"),
]);
if (balance === 0n) {
  log(`the treasury holds no ${symbol} at ${token}; nothing to burn`);
  process.exit(1);
}

let amount: bigint;
if (amountArg.toLowerCase() === "all") {
  amount = balance;
} else {
  const n = Number(amountArg);
  if (!Number.isFinite(n) || n <= 0) {
    log(`REFUSED: '${amountArg}' is not a positive amount`);
    process.exit(1);
  }
  amount = BigInt(Math.round(n)) * 10n ** BigInt(decimals);
  if (amount > balance) {
    log(`REFUSED: asked to burn ${amountArg} ${symbol} but the treasury holds ${Number(balance) / 10 ** Number(decimals)}`);
    process.exit(1);
  }
}

const human = Number(amount) / 10 ** Number(decimals);
log(`burning ${human.toLocaleString()} ${symbol} (${token}) from ${account.address} to ${DEAD}`);

const { request } = await publicClient.simulateContract({
  account,
  address: token as `0x${string}`,
  abi: erc20,
  functionName: "transfer",
  args: [DEAD, amount],
});
const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC) });
const txHash = await walletClient.writeContract(request);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== "success") {
  log(`burn transaction reverted: ${txHash}`);
  process.exit(1);
}
appendFileSync(LEDGER, JSON.stringify({ ts: Date.now(), token: token.toLowerCase(), symbol, amount: human, txHash }) + "\n");
log(`done. ${human.toLocaleString()} ${symbol} is permanently dead: ${txHash}`);
log(`proof: https://robinhoodchain.blockscout.com/tx/${txHash}`);
