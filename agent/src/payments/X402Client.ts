import { parseAbiItem, type Address } from "viem";
import type { PaymentReceipt } from "../types.js";
import { paymentMessage, type X402Requirements } from "./PaymentGate.js";
import { getPublicClient, getWalletClient, getAgentSigner } from "../venues/signer.js";
import { config } from "../config.js";

const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const transferAbi = [parseAbiItem("function transfer(address to, uint256 value) returns (bool)")];

/**
 * Paying side of x402 — the mirror of PaymentGate. With no facilitator mode
 * configured it stays the loud stub (local dev). In "self" mode (or any
 * configured mode) it settles for real: a USDG transfer on Robinhood Chain
 * to the payee, with the tx hash as the payment reference — exactly what
 * PaymentGate's on-chain verification checks for.
 */
export class X402Client {
  constructor(private mode: string) {}

  async pay(params: { amountUsd: number; payer: string; memo?: string; payTo?: string }): Promise<PaymentReceipt> {
    if (!this.mode) {
      console.log(
        `[X402Client:stub] would pay $${params.amountUsd} from ${params.payer} ` +
          `(no facilitator URL configured)`,
      );
      return { success: true, amountUsd: params.amountUsd, payer: params.payer, facilitator: "stub" };
    }

    const payTo = (params.payTo ?? config.treasuryAddress) as Address;
    if (!payTo) {
      return { success: false, amountUsd: params.amountUsd, payer: params.payer, facilitator: this.mode, error: "no payTo/treasury configured" };
    }
    const signer = getAgentSigner();
    if (!signer) {
      return { success: false, amountUsd: params.amountUsd, payer: params.payer, facilitator: this.mode, error: "no signer configured" };
    }
    const rawUsdg = BigInt(Math.round(params.amountUsd * 1_000_000));
    if (rawUsdg === 0n) {
      return { success: true, amountUsd: 0, payer: signer.address, facilitator: this.mode };
    }

    try {
      const wallet = getWalletClient();
      const hash = await wallet.writeContract({ address: USDG, abi: transferAbi, functionName: "transfer", args: [payTo, rawUsdg] });
      await getPublicClient().waitForTransactionReceipt({ hash });
      console.log(`[x402] paid $${params.amountUsd.toFixed(4)} USDG -> ${payTo}${params.memo ? ` (${params.memo})` : ""} tx ${hash}`);
      return { success: true, amountUsd: params.amountUsd, payer: signer.address, facilitator: this.mode, reference: hash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[x402] payment failed: ${error.slice(0, 160)}`);
      return { success: false, amountUsd: params.amountUsd, payer: signer.address, facilitator: this.mode, error };
    }
  }

  /**
   * Settle a 402 challenge and return the X-PAYMENT header for the retry.
   * Throws when the challenge can't be satisfied — callers treat that as
   * "this tool call stays unpaid and unanswered".
   */
  async settleChallenge(requirements: X402Requirements): Promise<string> {
    const accept = requirements.accepts?.[0];
    if (!accept) throw new Error("402 challenge carries no payment terms");
    if (accept.network !== "robinhood-chain") throw new Error(`unsupported x402 network: ${accept.network}`);
    const amountUsd = Number(accept.maxAmountRequired) / 1_000_000;
    const signer = getAgentSigner();
    const receipt = await this.pay({
      amountUsd,
      payer: signer?.address ?? "unknown",
      payTo: accept.payTo,
      memo: `x402 ${accept.resource}`,
    });
    if (!receipt.success || !receipt.reference) {
      throw new Error(`x402 settlement failed: ${receipt.error ?? "no tx reference"}`);
    }
    // Sign the authorization so the proof is ours and no one else's. Without
    // this the tx hash is a bearer token: it is public on-chain the instant the
    // payment lands, and whoever presents it first gets the call.
    if (!signer) throw new Error("x402 settlement needs a signer to authorize the payment proof");
    const signature = await signer.account.signMessage({
      message: paymentMessage({ txHash: receipt.reference, resource: accept.resource, treasury: accept.payTo }),
    });
    return Buffer.from(JSON.stringify({ txHash: receipt.reference, signature })).toString("base64");
  }
}
