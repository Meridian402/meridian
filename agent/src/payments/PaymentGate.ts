import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { formatUnits, verifyMessage, type Address } from "viem";
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
    /** Present only for non-USDG settlement, so the USDG challenge body is
     *  unchanged for clients that already parse it. */
    asset?: { symbol: string; address: string; decimals: number };
  }>;
  /** How to build the X-PAYMENT header, so the proof requirement is discoverable from the challenge itself. */
  proof: {
    header: string;
    format: string;
    signMessage: string;
    note: string;
  };
}

/** A token a payment can settle in. The gate never converts between assets: a
 *  price is quoted and checked in the asset's own units, full stop. */
export interface SettlementAsset {
  symbol: string;
  address: Address;
  decimals: number;
  /**
   * Where payment in this asset must land, when that is NOT the treasury.
   *
   * MERD uses it to route straight to a burn address, so paying in MERD destroys
   * the tokens at the moment of payment rather than parking them somewhere that
   * later has to be trusted to destroy them. There is no custody step to get
   * wrong and no second transaction to forget.
   *
   * Absent means the treasury, which is what USDG has always meant.
   */
  payTo?: Address;
}

/**
 * Where MERD paid for credits goes: an address with no known private key, so
 * the tokens can never move again.
 *
 * Be exact about what this is. MeridianToken has no burn function and its
 * transfer reverts on address(0), so supply cannot actually be reduced. This
 * removes the tokens from circulation permanently, which is what "burned"
 * means in practice, but totalSupply does not change and nothing here should
 * ever claim it does.
 */
export const BURN_ADDRESS = (process.env.MERD_BURN_ADDRESS ?? "0x000000000000000000000000000000000000dEaD") as Address;

/** USDG on Robinhood Chain. The default settlement asset: every call site that
 *  omits an asset means exactly this, which is what it has always meant. */
export const USDG_ASSET: SettlementAsset = {
  symbol: "USDG",
  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  decimals: 6,
};

/** True for the asset that predates multi-asset settlement. Everything that
 *  must stay byte-identical for existing payers keys off this. */
export function isDefaultAsset(asset: SettlementAsset): boolean {
  return asset.address.toLowerCase() === USDG_ASSET.address.toLowerCase();
}

/** A price: a USD figure (USDG only) or raw token units for any asset. */
export type PaymentAmount = number | bigint;

/**
 * The price in the asset's own raw units.
 *
 * A number is a USD figure and only means something for USDG, whose unit IS the
 * dollar. Any other asset must be priced directly in raw units, because this
 * gate has no exchange rate and must not acquire one: a rate read from a thin
 * pool is a rate an attacker can move seconds before paying.
 */
function rawUnits(amount: PaymentAmount, asset: SettlementAsset): bigint {
  if (typeof amount === "bigint") return amount;
  if (!isDefaultAsset(asset)) {
    throw new Error(`${asset.symbol} payments must be priced in raw token units, not USD: this gate has no conversion rate`);
  }
  return BigInt(Math.round(amount * 1_000_000));
}

/** Human price for challenges and logs. USD for USDG, token units otherwise. */
function displayAmount(amount: PaymentAmount, asset: SettlementAsset): string {
  if (typeof amount === "number" && isDefaultAsset(asset)) return `$${amount.toFixed(4)}`;
  return `${formatUnits(rawUnits(amount, asset), asset.decimals)} ${asset.symbol}`;
}

/** Where a payment in this asset must land: its own payTo, else the treasury. */
export function destinationFor(asset: SettlementAsset, treasury: string): string {
  return (asset.payTo ?? treasury).toLowerCase();
}

/**
 * The exact message a payer signs to prove the payment is THEIRS.
 *
 * Binds four things: the specific transfer (txHash), the specific tool it pays
 * for (resource), this deployment (chain + treasury), and the asset it settles
 * in, so a signature cannot be lifted to a different call, a different tool, a
 * different operator, or a different token.
 *
 * The asset matters because the same resource can be priced in more than one
 * token. Without it, a signature authorising "MERD for credits:pro" would also
 * authorise "USDG for credits:pro" and vice versa, letting one proof settle in
 * whichever token happens to be cheaper for the attacker.
 *
 * The asset line is APPENDED and only for non-default assets, so the USDG
 * message is byte-identical to the one payers already sign: absence of the line
 * IS the USDG commitment. That keeps every 402 challenge currently in flight
 * valid while still making the two messages provably different.
 *
 * Deliberately does NOT include the price. The transfer already carries the
 * value and the gate checks it covers the cost; including it would only add a
 * failure mode where a price change between the 402 and the retry invalidates an
 * otherwise-honest payment.
 */
export function paymentMessage(params: { txHash: string; resource: string; treasury: string; asset?: SettlementAsset }): string {
  const asset = params.asset ?? USDG_ASSET;
  // The message is newline-delimited and the asset commitment is a line that is
  // present or absent, so a resource containing a newline could write that line
  // itself: signing the USDG message for the resource
  // "credits:pro\nAsset: MERD 0x..." would produce bytes identical to a genuine
  // MERD authorization. No caller can do that today (every resource is either a
  // key of the tool price table or "credits:" plus one of three literal pack
  // ids) which is why this throws instead of escaping. It is an assertion that
  // the invariant still holds, and it fails loudly the day someone adds a
  // resource built from user input.
  if (/[\r\n]/.test(params.resource)) throw new Error("payment resource must not contain a line break");
  const lines = [
    "Meridian x402 payment authorization",
    "Chain: 4663",
    `Treasury: ${params.treasury.toLowerCase()}`,
    `Resource: ${params.resource}`,
    `Tx: ${params.txHash.toLowerCase()}`,
  ];
  if (!isDefaultAsset(asset)) {
    lines.push(`Asset: ${asset.symbol} ${asset.address.toLowerCase()}`);
    // Bind the destination too when it is not the treasury, so a signature
    // authorising a BURN cannot be replayed as one authorising a payment to the
    // treasury. The USDG branch is untouched and stays byte-identical.
    if (asset.payTo) lines.push(`PayTo: ${asset.payTo.toLowerCase()}`);
  }
  return lines.join("\n");
}

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
  // Tx hashes currently being verified. The used-set is only written at the END
  // of verification, after several awaits, so without this a payer could fire N
  // concurrent requests with the same X-PAYMENT header and have all N pass the
  // used-check before any of them burns. Reserving synchronously (no await
  // between the check and the add) makes verification one-at-a-time per tx, so
  // one transfer can never settle two calls. It also closes the variant where
  // the payer signs the same tx for several different resources at once.
  private reserving = new Set<string>();

  /**
   * ROTATING THE TREASURY STRANDS IN-FLIGHT PAYMENTS. Worth knowing before
   * anyone changes MERIDIAN_TREASURY_ADDRESS.
   *
   * This address is bound into the message a payer signs, and both verify()
   * and settleStranded() look for a transfer to whatever it is set to NOW. So
   * the moment it changes:
   *   - a 402 challenge already handed out becomes unpayable, because the payer
   *     signs the old treasury and verification rebuilds the message with the
   *     new one;
   *   - USDG already sent to the old address cannot be verified, and cannot be
   *     rescued by settleStranded either, since that checks the same field.
   * The money is not lost, it is sitting in an address we control, but there is
   * no path in this code that turns it into credits.
   *
   * A safe cutover therefore needs a grace window where the previous address is
   * still accepted for verification, or purchases stopped for the duration.
   * Neither exists yet because nothing has needed it. Build the window BEFORE
   * the rotation, not after somebody pays into the old address.
   */
  constructor(private treasuryAddress: string, private facilitatorUrl: string) {}

  /**
   * The 402 challenge. `amount` is USD for USDG (as it always was) and raw token
   * units for any other asset. Omitting `asset` means USDG, and the body it
   * produces then is unchanged: the asset descriptor is attached only for
   * non-default assets, so existing payers see exactly the challenge they parse
   * today while a MERD payer is told which token to send.
   */
  requirements(amount: PaymentAmount, resource: string, asset: SettlementAsset = USDG_ASSET): X402Requirements {
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          // The treasury is an EVM wallet on Robinhood Chain (id 4663) and
          // payments settle in USDG there — the old "solana" label predated
          // the Robinhood-only scope and pointed payers at the wrong chain.
          network: "robinhood-chain",
          maxAmountRequired: String(rawUnits(amount, asset)), // the asset's own raw units
          resource,
          payTo: this.treasuryAddress ? destinationFor(asset, this.treasuryAddress) : "unconfigured",
          description: `Meridian ${resource} - ${displayAmount(amount, asset)}`,
          ...(isDefaultAsset(asset) ? {} : { asset: { symbol: asset.symbol, address: asset.address, decimals: asset.decimals } }),
        },
      ],
      proof: {
        header: "X-PAYMENT",
        format: 'base64(JSON) or raw JSON: { "txHash": "0x…", "signature": "0x…" }',
        signMessage: paymentMessage({ txHash: "<your payment tx hash>", resource, treasury: this.treasuryAddress || "unconfigured", asset }),
        note:
          `Sign the message above with the wallet that SENT the ${asset.symbol}. A tx hash alone is not proof of payment: ` +
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

  /**
   * Burn the tx. The amountUsd column of this ledger is dollars, so a non-USD
   * settlement records 0 there and carries its real size in raw units instead:
   * writing a MERD amount into a USD column would misstate every total that
   * reads this file. Replay protection itself is the txHash and is unchanged.
   */
  private burnTx(txHash: string, resource: string, amount: PaymentAmount, asset: SettlementAsset): void {
    this.loadUsed().add(txHash.toLowerCase());
    const row = isDefaultAsset(asset)
      ? { amountUsd: typeof amount === "number" ? amount : Number(amount) / 1e6 }
      : { amountUsd: 0, asset: asset.symbol, amountRaw: rawUnits(amount, asset).toString() };
    appendLedger("x402-used.jsonl", { txHash: txHash.toLowerCase(), resource, ...row, at: Date.now() });
  }

  async verify(
    paymentHeader: string,
    amount: PaymentAmount,
    resource: string,
    asset: SettlementAsset = USDG_ASSET,
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
        `[PaymentGate:stub] accepting ${displayAmount(amount, asset)} for ${resource} ` +
          `(no facilitator AND no treasury configured — local dev only, proof not verified)`,
      );
      return { ok: true };
    }

    if (this.facilitatorUrl === "self") {
      return this.verifyOnChain(paymentHeader, amount, resource, asset);
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
   * signature proves the caller controls the wallet whose tokens actually moved.
   */
  private async verifyOnChain(
    header: string,
    amount: PaymentAmount,
    resource: string,
    asset: SettlementAsset,
  ): Promise<{ ok: boolean; error?: string; txHash?: string }> {
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
      return {
        ok: false,
        error: `missing signature: sign the payment authorization message from the 402 challenge with the wallet that sent the ${asset.symbol}`,
      };
    }
    if (this.loadUsed().has(txHash.toLowerCase())) return { ok: false, error: "payment tx already used" };

    // Hold this tx for the duration of the on-chain checks. Nothing may await
    // between the used-check above and this add, or the race reopens.
    const held = txHash.toLowerCase();
    if (this.reserving.has(held)) return { ok: false, error: "this payment is already being verified" };
    this.reserving.add(held);
    try {
      return await this.settleOnChain(txHash, signature, amount, resource, asset);
    } finally {
      // Released either way: on success the tx is now in the used set, so the
      // next attempt fails as already-used rather than racing again.
      this.reserving.delete(held);
    }
  }

  /** The awaiting half of on-chain verification, run under the tx reservation. */
  private async settleOnChain(
    txHash: string,
    signature: string,
    amount: PaymentAmount,
    resource: string,
    asset: SettlementAsset,
  ): Promise<{ ok: boolean; error?: string; txHash?: string }> {
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

    // Sum the transfers of THIS asset that reached the treasury, and remember
    // WHO sent them. Transfer is (from indexed, to indexed, value) so topics[1]
    // is the payer of record, the token holder whose balance moved, which is who
    // must sign. That is not always receipt.from (a contract can transfer on
    // someone's behalf), so bind to the log rather than the transaction
    // submitter. Logs of any OTHER token are ignored, so sending a worthless
    // token cannot pay for a pack priced in a real one.
    const senders = new Set<string>();
    const required = rawUnits(amount, asset);
    const paid = receipt.logs
      .filter((l) => l.address.toLowerCase() === asset.address.toLowerCase())
      .reduce((sum, l) => {
        try {
          const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
          if (l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && to === destinationFor(asset, this.treasuryAddress)) {
            senders.add(`0x${l.topics[1]!.slice(26)}`.toLowerCase());
            return sum + BigInt(l.data);
          }
        } catch {}
        return sum;
      }, 0n);

    if (paid < required) {
      return { ok: false, error: `insufficient payment: ${paid} ${asset.symbol}-units < ${required} required` };
    }
    if (senders.size === 0) return { ok: false, error: `no ${asset.symbol} transfer to ${destinationFor(asset, this.treasuryAddress)} in that tx` };

    // The signature must recover to one of the wallets that actually paid.
    // verifyMessage covers both EOAs and ERC-1271 smart accounts, so an agent
    // paying from a contract wallet still works.
    const message = paymentMessage({ txHash, resource, treasury: this.treasuryAddress, asset });
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

    this.burnTx(txHash, resource, amount, asset);
    console.log(
      `[PaymentGate:self] verified ${displayAmount(amount, asset)} for ${resource} from ${signer.slice(0, 10)}… via ${txHash.slice(0, 10)}…`,
    );
    return { ok: true, txHash };
  }

  /**
   * Settle a payment that landed on-chain but never reached us.
   *
   * The x402 flow is two calls with a real transfer between them, so any break
   * after the transfer leaves the money moved and the credits unissued. It
   * happened on the very first real purchase: X-PAYMENT was missing from the
   * CORS allow-list, so the browser blocked the settlement call after $5 of USDG
   * had already left the wallet. A dropped connection, a closed tab or a phone
   * losing signal does exactly the same thing, so this needs a recovery path
   * rather than a one-off apology.
   *
   * Runs every on-chain check verifyOnChain does EXCEPT the signature, and it
   * does not need one: the caller is an authenticated operator, and the payer is
   * read from the transfer log rather than supplied, so the credits can only go
   * to the wallet whose tokens actually moved. It cannot invent a payment, and
   * the burn makes it single-use like any other settlement.
   *
   * Deliberately ignores MAX_AGE_SECONDS. Age exists to stop someone dredging up
   * an ancient transfer as fresh proof; a stuck payment is old precisely BECAUSE
   * it got stuck, and refusing to honour it would punish the person it failed.
   */
  async settleStranded(
    txHash: string,
    amount: PaymentAmount,
    resource: string,
    asset: SettlementAsset = USDG_ASSET,
  ): Promise<{ ok: true; payer: string; txHash: string } | { ok: false; error: string }> {
    if (!this.treasuryAddress) return { ok: false, error: "treasury not configured" };
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "invalid txHash" };
    if (this.loadUsed().has(txHash.toLowerCase())) return { ok: false, error: "payment tx already used" };

    const client = getPublicClient();
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return { ok: false, error: "payment tx not found on Robinhood Chain" };
    }
    if (receipt.status !== "success") return { ok: false, error: "payment tx reverted" };

    const senders = new Set<string>();
    const required = rawUnits(amount, asset);
    const paid = receipt.logs
      .filter((l) => l.address.toLowerCase() === asset.address.toLowerCase())
      .reduce((sum, l) => {
        try {
          const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
          if (l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && to === destinationFor(asset, this.treasuryAddress)) {
            senders.add(`0x${l.topics[1]!.slice(26)}`.toLowerCase());
            return sum + BigInt(l.data);
          }
        } catch {}
        return sum;
      }, 0n);

    if (senders.size === 0) return { ok: false, error: `no ${asset.symbol} transfer to ${destinationFor(asset, this.treasuryAddress)} in that tx` };
    if (paid < required) return { ok: false, error: `insufficient payment: ${paid} ${asset.symbol}-units < ${required} required` };
    // One payer, or we cannot say whose credits these are.
    if (senders.size > 1) return { ok: false, error: `ambiguous payer: ${[...senders].join(", ")}` };

    const payer = [...senders][0];
    this.burnTx(txHash, resource, amount, asset);
    console.log(`[PaymentGate] settled STRANDED ${displayAmount(amount, asset)} for ${resource} from ${payer} via ${txHash}`);
    return { ok: true, payer, txHash };
  }
}
