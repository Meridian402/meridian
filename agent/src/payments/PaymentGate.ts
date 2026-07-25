import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { verifyMessage, type Address } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { dataPath } from "../dataDir.js";

export interface X402Requirements {
  x402Version: number;
  accepts: Array<{
    scheme: "exact";
    network: string;
    maxAmountRequired: string;
    resource: string;
    payTo: string;
    description: string;
  }>;
  /** How to build the X-PAYMENT header, so the proof requirement is discoverable from the challenge itself. */
  proof: {
    header: string;
    format: string;
    signMessage: string;
    note: string;
  };
}

/**
 * The exact message a payer signs to prove the payment is THEIRS.
 *
 * Binds three things: the specific transfer (txHash), the specific tool it pays
 * for (resource), and this deployment (chain + treasury), so a signature cannot
 * be lifted to a different call, a different tool, or a different operator.
 *
 * Deliberately does NOT include the price. The transfer already carries the
 * value and the gate checks it covers the cost; including it would only add a
 * failure mode where a price change between the 402 and the retry invalidates an
 * otherwise-honest payment.
 */
export function paymentMessage(params: { txHash: string; resource: string; treasury: string }): string {
  return [
    "Meridian x402 payment authorization",
    "Chain: 4663",
    `Treasury: ${params.treasury.toLowerCase()}`,
    `Resource: ${params.resource}`,
    `Tx: ${params.txHash.toLowerCase()}`,
  ].join("\n");
}

const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// Replay ledger: every accepted payment tx is burned here so one on-chain
// transfer can never pay for two tool calls, across restarts.
const USED_TX_PATH = dataPath("x402-used.jsonl");
const MAX_AGE_SECONDS = 15 * 60;

/**
 * Receiving side of x402 — gates a priced tool call on an X-PAYMENT header.
 *
 * Verification modes by facilitatorUrl:
 *   ""      stub: accept anything, log loudly (local dev only)
 *   "self"  built-in facilitator: the header carries a tx hash, and we verify
 *           directly against Robinhood Chain that it's a successful, recent,
 *           previously-unused USDG transfer to the treasury of at least the
 *           required amount. No external service exists for this chain, so
 *           the chain itself is the source of truth.
 *   https…  a remote facilitator, when the ecosystem standardizes one.
 */
export class PaymentGate {
  private usedTx: Set<string> | null = null;

  constructor(private treasuryAddress: string, private facilitatorUrl: string) {}

  requirements(amountUsd: number, resource: string): X402Requirements {
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          // The treasury is an EVM wallet on Robinhood Chain (id 4663) and
          // payments settle in USDG there — the old "solana" label predated
          // the Robinhood-only scope and pointed payers at the wrong chain.
          network: "robinhood-chain",
          maxAmountRequired: String(Math.round(amountUsd * 1_000_000)), // USDG, 6 decimals
          resource,
          payTo: this.treasuryAddress || "unconfigured",
          description: `Meridian ${resource} - $${amountUsd.toFixed(4)}`,
        },
      ],
      proof: {
        header: "X-PAYMENT",
        format: 'base64(JSON) or raw JSON: { "txHash": "0x…", "signature": "0x…" }',
        signMessage: paymentMessage({ txHash: "<your payment tx hash>", resource, treasury: this.treasuryAddress || "unconfigured" }),
        note:
          "Sign the message above with the wallet that SENT the USDG. A tx hash alone is not proof of payment: " +
          "transfers to the treasury are public, so anyone watching the chain could otherwise present someone else's payment as their own.",
      },
    };
  }

  private loadUsed(): Set<string> {
    if (this.usedTx) return this.usedTx;
    this.usedTx = new Set();
    if (existsSync(USED_TX_PATH)) {
      for (const line of readFileSync(USED_TX_PATH, "utf8").split("\n")) {
        try {
          const r = JSON.parse(line);
          if (r.txHash) this.usedTx.add(r.txHash.toLowerCase());
        } catch {}
      }
    }
    return this.usedTx;
  }

  private burnTx(txHash: string, resource: string, amountUsd: number): void {
    this.loadUsed().add(txHash.toLowerCase());
    appendLedger("x402-used.jsonl", { txHash: txHash.toLowerCase(), resource, amountUsd, at: Date.now() });
  }

  async verify(
    paymentHeader: string,
    amountUsd: number,
    resource: string,
  ): Promise<{ ok: boolean; error?: string; txHash?: string }> {
    if (!this.facilitatorUrl) {
      // Stub mode accepts ANY proof without verification. That is fine for local
      // dev, but a deployment with a treasury configured has declared an intent
      // to collect real money — and pairing that with no verification means
      // every priced tool is silently free while the revenue ledger records
      // income that never arrived. Treat that combination as misconfiguration
      // and fail closed rather than quietly giving the product away.
      if (this.treasuryAddress) {
        console.error(
          `[PaymentGate] REFUSING ${resource}: a treasury is configured but X402_FACILITATOR_URL is not, ` +
            `so payments cannot be verified. Set it to "self" for on-chain verification.`,
        );
        return { ok: false, error: "payment verification is not configured on this deployment" };
      }
      console.log(
        `[PaymentGate:stub] accepting $${amountUsd} for ${resource} ` +
          `(no facilitator AND no treasury configured — local dev only, proof not verified)`,
      );
      return { ok: true };
    }

    if (this.facilitatorUrl === "self") {
      return this.verifyOnChain(paymentHeader, amountUsd, resource);
    }

    throw new Error("Remote x402 facilitator verification not implemented yet");
  }

  /**
   * Header: base64(JSON) or raw JSON containing { txHash, signature }.
   *
   * The signature is what makes the proof non-transferable. A tx hash is public
   * the moment the payment lands, and every transfer to the treasury is visible
   * on-chain — so a hash alone is a BEARER token: anyone watching the treasury
   * could lift an honest payer's hash and spend it on their own call first,
   * burning it and leaving the payer's request rejected as "already used". The
   * signature proves the caller controls the wallet whose USDG actually moved.
   */
  private async verifyOnChain(header: string, amountUsd: number, resource: string): Promise<{ ok: boolean; error?: string; txHash?: string }> {
    if (!this.treasuryAddress) return { ok: false, error: "treasury not configured" };
    let txHash: string | undefined;
    let signature: string | undefined;
    try {
      const raw = header.trim().startsWith("{") ? header : Buffer.from(header, "base64").toString("utf8");
      const parsed = JSON.parse(raw) as { txHash?: string; signature?: string };
      txHash = parsed.txHash;
      signature = parsed.signature;
    } catch {
      return { ok: false, error: "X-PAYMENT must be JSON (optionally base64) with txHash and signature fields" };
    }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "invalid txHash" };
    if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return { ok: false, error: "missing signature — sign the payment authorization message from the 402 challenge with the wallet that sent the USDG" };
    }
    if (this.loadUsed().has(txHash.toLowerCase())) return { ok: false, error: "payment tx already used" };

    const client = getPublicClient();
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return { ok: false, error: "payment tx not found on Robinhood Chain" };
    }
    if (receipt.status !== "success") return { ok: false, error: "payment tx reverted" };

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
    if (age > MAX_AGE_SECONDS) return { ok: false, error: `payment tx too old (${age}s > ${MAX_AGE_SECONDS}s)` };

    // Sum USDG that reached the treasury, and remember WHO sent it. Transfer is
    // (from indexed, to indexed, value) so topics[1] is the payer of record —
    // the token holder whose balance moved, which is who must sign. That is not
    // always receipt.from (a contract can transfer on someone's behalf), so bind
    // to the log rather than the transaction submitter.
    const senders = new Set<string>();
    const required = BigInt(Math.round(amountUsd * 1_000_000));
    const paid = receipt.logs
      .filter((l) => l.address.toLowerCase() === USDG.toLowerCase())
      .reduce((sum, l) => {
        try {
          const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
          if (l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && to === this.treasuryAddress.toLowerCase()) {
            senders.add(`0x${l.topics[1]!.slice(26)}`.toLowerCase());
            return sum + BigInt(l.data);
          }
        } catch {}
        return sum;
      }, 0n);

    if (paid < required) {
      return { ok: false, error: `insufficient payment: ${paid} USDG-units < ${required} required` };
    }
    if (senders.size === 0) return { ok: false, error: "no USDG transfer to the treasury in that tx" };

    // The signature must recover to one of the wallets that actually paid.
    // verifyMessage covers both EOAs and ERC-1271 smart accounts, so an agent
    // paying from a contract wallet still works.
    const message = paymentMessage({ txHash, resource, treasury: this.treasuryAddress });
    let signer: string | null = null;
    for (const addr of senders) {
      try {
        if (await verifyMessage({ address: addr as Address, message, signature: signature as `0x${string}` })) {
          signer = addr;
          break;
        }
      } catch {
        /* malformed signature for this candidate — try the next */
      }
    }
    if (!signer) {
      return {
        ok: false,
        error: `signature does not match the wallet that sent this payment (expected a signature over the authorization message from ${[...senders].join(" or ")})`,
      };
    }

    this.burnTx(txHash, resource, amountUsd);
    console.log(`[PaymentGate:self] verified $${amountUsd} for ${resource} from ${signer.slice(0, 10)}… via ${txHash.slice(0, 10)}…`);
    return { ok: true, txHash };
  }
}
