// One-shot, operator-ordered bridge: treasury ETH from Ethereum mainnet to
// Robinhood Chain via Relay's deposit-address flow (a plain transfer, no
// contract call), recipient hardwired to the treasury itself on 4663.
//
// Why Relay: the canonical Arbitrum bridge needs a depositEth call; Relay is
// on Robinhood's own bridging docs and its deposit-address flow is built for
// transfer-only wallets. The quote is fetched FRESH at run time, so the
// deposit address can never be stale, and it is verified before anything is
// signed: plain transfer (data 0x), origin chain 1, destination 4663,
// recipient equals the treasury, quoted output within 2% of the amount sent.
//
// Refuses: a missing or malformed key, a key that is not the treasury's, an
// amount above balance minus L1 gas, and any quote that fails the checks
// above. This is a hand-run tool, not a scheduled job: bridging is
// irreversible, so a human types the amount.
//
//   MERD_TREASURY_WALLET_KEY=0x... ./_merd-bridge.sh <amountEth>
import { appendFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { TREASURY_WALLET } from "./src/merd/wallets.js";

const L1_RPC = process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const RH_CHAIN_ID = 4663;
const NATIVE = "0x0000000000000000000000000000000000000000";
const LEDGER = new URL("./_merd-bridge.jsonl", import.meta.url).pathname;

function log(msg: string): void {
  console.log(`[bridge] ${msg}`);
}

const [amountArg] = process.argv.slice(2);
if (!amountArg || !/^\d*\.?\d+$/.test(amountArg)) {
  log("usage: MERD_TREASURY_WALLET_KEY=0x... ./_merd-bridge.sh <amountEth>");
  process.exit(1);
}
const amountWei = parseEther(amountArg);

const key = (process.env.MERD_TREASURY_WALLET_KEY ?? "").trim();
if (!key) {
  log("dormant: MERD_TREASURY_WALLET_KEY not set; supply it inline, never in .env");
  process.exit(0);
}
if (!/^[0-9a-fA-F]{64}$/.test(key.replace(/^0x/, ""))) {
  log("REFUSED: MERD_TREASURY_WALLET_KEY is malformed");
  process.exit(1);
}
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
if (account.address.toLowerCase() !== TREASURY_WALLET.toLowerCase()) {
  log(`REFUSED: key derives to ${account.address}, not the treasury ${TREASURY_WALLET}`);
  process.exit(1);
}

const pub = createPublicClient({ chain: mainnet, transport: http(L1_RPC) });
const balance = await pub.getBalance({ address: account.address });
const gasBufferWei = parseEther("0.0005"); // one plain transfer costs ~0.00005 at 2 gwei; 10x margin
if (amountWei + gasBufferWei > balance) {
  log(`REFUSED: sending ${amountArg} + gas buffer exceeds L1 balance ${formatEther(balance)}`);
  process.exit(1);
}

// Fresh quote every run: deposit addresses are single-use and per-amount.
log(`quoting ${amountArg} ETH mainnet -> Robinhood Chain for ${TREASURY_WALLET}...`);
const res = await fetch("https://api.relay.link/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    user: TREASURY_WALLET,
    recipient: TREASURY_WALLET,
    originChainId: mainnet.id,
    destinationChainId: RH_CHAIN_ID,
    originCurrency: NATIVE,
    destinationCurrency: NATIVE,
    amount: amountWei.toString(),
    tradeType: "EXACT_INPUT",
    useDepositAddress: true,
  }),
  signal: AbortSignal.timeout(30_000),
});
const quote = (await res.json()) as {
  message?: string;
  details?: { currencyOut?: { amount?: string; currency?: { chainId?: number } } };
  steps?: Array<{ id?: string; requestId?: string; items?: Array<{ data?: { to?: string; value?: string; data?: string; chainId?: number } }> }>;
};
if (quote.message) {
  log(`REFUSED: relay quote failed: ${quote.message}`);
  process.exit(1);
}
const step = quote.steps?.[0];
const tx = step?.items?.[0]?.data;
const outRaw = BigInt(quote.details?.currencyOut?.amount ?? "0");
const outChain = quote.details?.currencyOut?.currency?.chainId;

// The quote must describe EXACTLY the transaction we are willing to make.
if (!tx?.to || (tx.data ?? "0x") !== "0x") {
  log(`REFUSED: quote is not a plain transfer (data ${tx?.data}); will not sign a contract call`);
  process.exit(1);
}
if (BigInt(tx.value ?? "0") !== amountWei) {
  log(`REFUSED: quote value ${tx.value} != requested ${amountWei}`);
  process.exit(1);
}
if ((tx.chainId ?? mainnet.id) !== mainnet.id) {
  log(`REFUSED: quote origin chain ${tx.chainId} is not mainnet`);
  process.exit(1);
}
if (outChain !== RH_CHAIN_ID) {
  log(`REFUSED: quote destination chain ${outChain} is not ${RH_CHAIN_ID}`);
  process.exit(1);
}
if (outRaw < (amountWei * 98n) / 100n) {
  log(`REFUSED: quoted output ${formatEther(outRaw)} is more than 2% below input ${amountArg}`);
  process.exit(1);
}

log(`deposit address ${tx.to} | quoted out ${formatEther(outRaw)} ETH on ${RH_CHAIN_ID} | requestId ${step?.requestId}`);

const wallet = createWalletClient({ account, chain: mainnet, transport: http(L1_RPC) });
const hash = await wallet.sendTransaction({ to: tx.to as `0x${string}`, value: amountWei });
log(`sent: https://eth.blockscout.com/tx/${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
log(`L1 ${receipt.status} in block ${receipt.blockNumber}. Relay delivers to ${TREASURY_WALLET} on Robinhood Chain, ETA seconds.`);
appendFileSync(
  LEDGER,
  JSON.stringify({ at: Date.now(), amountEth: amountArg, depositAddress: tx.to, requestId: step?.requestId, l1Tx: hash, quotedOutEth: formatEther(outRaw) }) + "\n",
);
