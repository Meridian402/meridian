// Scout-to-earn: a signed-in user sends THEIR agent hunting for a tokenized-RWA
// venue the research universe doesn't know yet. A validated, genuinely novel
// find is upserted into the same universe the fleet feeds (credited
// scout:<wallet>) and accrues a small USDG bounty against the treasury.
// Attribution is the SIWE session the route already proved — never a value the
// model claims — so a prompt-injected agent can misdescribe a venue but cannot
// redirect whose bounty it is. Accrual is capped per wallet and per day;
// settlement is a deliberate operator action through the same circuit-breaker
// the house wallet's own ops run under.
import { existsSync, readFileSync } from "node:fs";
import { parseAbiItem } from "viem";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { config } from "../config.js";
import { messageUserAgent, agentDisplayName } from "../deploy/myAgent.js";
import { getUniverseStore, isKnownVenue, type Venue } from "../research/universe.js";
import { SEGMENTS } from "../research/segments.js";
import { getPublicClient, getWalletClient, getAgentAddress } from "../venues/signer.js";
import { guardWalletOp, recordWalletOp } from "../risk.js";
import { withHouseWalletLock } from "../houseWallet.js";
import { USDG } from "../venues/stockPools.js";
import { HOUSE_WALLET } from "../merd/wallets.js";
import { knobValue } from "../platformKnobs.js";

const LOG = "bounties.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;

interface BountyRow {
  ts: number;
  kind: "scout" | "payout" | "xpost"; // xpost rows are written by earn/xTalk.ts into this same ledger
  wallet: string;
  // "attempt" is written before the model runs and is what the per-wallet daily
  // cap counts. The other scout statuses are outcomes, recorded after.
  // "voided" cancels an earlier attempt by the same wallet: the run never
  // reached the model (gateway timeout, search provider down), so charging it
  // against a daily allowance would bill a user for our outage.
  status: "attempt" | "accrued" | "duplicate" | "invalid" | "paid" | "voided";
  amountUsd: number;
  name?: string;
  url?: string;
  segment?: string;
  txHash?: string;
  covering?: number;
  /** xpost rows only: the X author id the wallet is bound to. */
  authorId?: string;
}

function readRows(): BountyRow[] {
  try {
    const p = dataPath(LOG);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as BountyRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is BountyRow => !!r && typeof r.ts === "number" && typeof r.wallet === "string");
  } catch {
    return [];
  }
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function walletBalanceUsd(rows: BountyRow[], wallet: string): number {
  const w = wallet.toLowerCase();
  let bal = 0;
  for (const r of rows) {
    if (r.wallet !== w) continue;
    if ((r.kind === "scout" || r.kind === "xpost") && r.status === "accrued") bal += r.amountUsd; // xpost: talk-about-Merd bounties settle through the same balance
    if (r.kind === "payout" && r.status === "paid") bal -= r.amountUsd;
  }
  return Math.round(bal * 100) / 100;
}

// The scouting brief sent to the user's own agent. Structured-output contract
// up top, then just enough context (segments + a sample of recent names) to
// steer it away from re-finding what the fleet already has. Novelty is enforced
// server-side regardless of what the model believes it found.
function scoutPrompt(): string {
  const known = getUniverseStore().all();
  const recentNames = known
    .slice(-40)
    .map((v) => v.name)
    .join("; ");
  const segmentKeys = SEGMENTS.map((s) => s.key).join(", ");
  return [
    `SCOUTING RUN (system task, not a chat message). Your job: name ONE real tokenized-RWA venue, protocol, or product that Meridian's research universe does not already track.`,
    ``,
    `Reply with ONLY a single JSON object, no prose before or after, exactly this shape:`,
    `{"name": "<venue name>", "url": "<https link to the venue itself>", "segment": "<one of: ${segmentKeys}>", "chains": ["<chain>", ...], "tokenizes": "<what real-world asset it tokenizes>", "note": "<one sentence on why it matters>"}`,
    ``,
    `Rules:`,
    // The search tool shares a provider quota and returns HTTP 429 in bursts.
    // Left to itself the agent retried the same query ten-plus times, spent the
    // whole turn budget on refusals, and the run died at the gateway timeout
    // with nothing to show: the user lost a daily run to a rate limit. Give it
    // an explicit budget and an explicit fallback so a throttled search costs
    // one query, not the entire run.
    `- SEARCH BUDGET: at most 3 web searches for this whole run. If a search fails or returns nothing usable, do NOT retry the same query: either try one different query or answer from what you already know. Running out of searches is not a reason to give up, it is a reason to name a venue you are already confident about.`,
    `- It must be a real venue you are confident exists. Never invent one; a fabricated find is worthless and gets rejected.`,
    `- It must NOT be one of these already-known venues: ${recentNames || "(none yet)"}. Well-known anchors (Ondo, BUIDL, Maple, Centrifuge, PAXG, RealT and similar majors) are also already known.`,
    `- Prefer smaller, newer, or regional venues the big lists miss.`,
    `- If you truly cannot name a confident novel venue, reply with exactly: {"name": null}`,
  ].join("\n");
}

// Balanced-slice JSON extraction: models wrap JSON in prose/fences despite
// instructions, so take the outermost brace pair and parse that.
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clamp = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return t ? t.slice(0, max) : undefined;
};

export interface ScoutResult {
  ok: boolean;
  novel?: boolean;
  name?: string;
  segment?: string;
  bountyUsd?: number;
  balanceUsd?: number;
  agentName?: string;
  message: string;
  /** The gateway resolved with an error and no text, so this run produced
   *  nothing at all. The route refunds the credit, exactly as /message does for
   *  the same case. Internal: the route strips it before replying. */
  refundable?: boolean;
}

/**
 * Caps checked BEFORE spending model tokens on a run.
 *
 * The per-wallet cap counts ATTEMPTS, not wins. Counting accruals was the wrong
 * meter: an accrual is the outcome, and the cost is incurred at the attempt. A
 * run that finds nothing, returns unparsable output, or names a venue we already
 * track burns exactly as many model tokens as one that earns a bounty, so
 * metering on wins left every unsuccessful run uncapped and free, and the
 * cheapest way to spend our model budget without limit was to scout badly.
 *
 * The global cap still meters on accrued USD, which is correct: that one is a
 * bound on money owed, and money is only owed when a find lands.
 */
export function scoutAllowed(wallet: string): { ok: boolean; reason?: string } {
  const rows = readRows();
  const cutoff = Date.now() - DAY_MS;
  const w = wallet.toLowerCase();
  const today = rows.filter((r) => r.kind === "scout" && r.ts >= cutoff);
  // Attempts minus the ones voided by an infrastructure failure. Without the
  // subtraction a user whose runs all timed out is locked out for the day
  // having received nothing, which is the opposite of an earning surface.
  const mine = today.filter((r) => r.wallet === w);
  const spent = mine.filter((r) => r.status === "attempt").length - mine.filter((r) => r.status === "voided").length;
  if (spent >= knobValue("scoutMaxPerWalletPerDay")) {
    return { ok: false, reason: `your agent has used today's ${knobValue("scoutMaxPerWalletPerDay")} scout runs, successful or not. scout again tomorrow.` };
  }
  if (today.filter((r) => r.status === "accrued").reduce((s, r) => s + r.amountUsd, 0) >= config.scoutMaxDailyTotalUsd) {
    return { ok: false, reason: "today's global bounty pool is spent, scout again tomorrow" };
  }
  return { ok: true };
}

/**
 * One scouting run for a SIWE-verified wallet. The caller (the route) owns the
 * chat-limit guards; this owns the prompt, validation, novelty gate, universe
 * upsert, and bounty accrual.
 */
export async function runScout(wallet: string): Promise<ScoutResult> {
  const w = wallet.toLowerCase();
  const agentName = agentDisplayName(wallet);

  // Recorded BEFORE the model runs, because this is the row the per-wallet daily
  // cap counts and the cost is incurred here, whatever comes back. A run that
  // throws still leaves its attempt behind, which is the point.
  appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "attempt", amountUsd: 0 } satisfies BountyRow);

  const reply = await messageUserAgent(wallet, scoutPrompt(), { sessionKind: "scout" });
  const parsed = extractJson(reply.text);
  if (!parsed) {
    // Same distinction /message draws: an error with no text means the turn
    // produced nothing and is refunded, while unusable text is a real answer we
    // simply could not use.
    const produced = Boolean(reply.text.trim());
    const ourFault = !produced && Boolean(reply.error);
    if (ourFault) {
      // The run never got an answer out of the agent: the gateway timed out, or
      // the search provider rate-limited every query (a live 429 storm did
      // exactly this). Give the attempt back rather than spending a daily run
      // on our own outage.
      appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "voided", amountUsd: 0 } satisfies BountyRow);
    }
    return {
      ok: false,
      agentName,
      refundable: ourFault,
      message: ourFault
        ? `${agentName} could not finish this run: the research tools did not answer in time. This one does not count against today's runs, so try again in a minute.`
        : `${agentName} did not return a usable finding this run, nothing recorded. Try again.`,
    };
  }
  if (parsed.name === null) {
    return { ok: true, novel: false, agentName, message: `${agentName} came back empty-handed: no confident novel venue this run. No bounty, nothing spent.` };
  }

  const name = clamp(parsed.name, 80);
  const url = clamp(parsed.url, 300);
  const segment = clamp(parsed.segment, 60)?.toLowerCase();
  const tokenizes = clamp(parsed.tokenizes, 120);
  const note = clamp(parsed.note, 300);
  const chains = Array.isArray(parsed.chains)
    ? parsed.chains
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (!name || name.length < 3 || !url || !/^https?:\/\/\S+$/i.test(url)) {
    appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "invalid", amountUsd: 0, name } satisfies BountyRow);
    return { ok: false, agentName, message: `${agentName}'s finding was missing a usable name or link, so it was rejected. No bounty.` };
  }

  if (isKnownVenue(name)) {
    appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "duplicate", amountUsd: 0, name, url, segment } satisfies BountyRow);
    return {
      ok: true,
      novel: false,
      name,
      agentName,
      message: `${agentName} found ${name} — real, but the universe already tracks it. No bounty for re-finds.`,
    };
  }

  const venue: Venue = {
    name,
    url,
    segment,
    chains: chains.length ? chains : undefined,
    tokenizes,
    integrationNotes: note,
    sources: [url],
    confidence: "low",
  };
  getUniverseStore().upsertMany([venue], `scout:${w}`);

  const bountyUsd = knobValue("scoutBountyUsd");
  appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "accrued", amountUsd: bountyUsd, name, url, segment } satisfies BountyRow);
  const balanceUsd = walletBalanceUsd(readRows(), w);
  return {
    ok: true,
    novel: true,
    name,
    segment,
    bountyUsd,
    balanceUsd,
    agentName,
    message: `${agentName} scouted ${name} — new to the universe. $${bountyUsd.toFixed(2)} bounty accrued (your balance: $${balanceUsd.toFixed(2)}).`,
  };
}

/** The public bounty board + (optionally) one wallet's own tally. */
export function bountyBoard(address?: string): Record<string, unknown> {
  const rows = readRows();
  const accrued = rows.filter((r) => r.kind === "scout" && r.status === "accrued");
  const paid = rows.filter((r) => r.kind === "payout" && r.status === "paid");
  const board: Record<string, unknown> = {
    bountyUsd: knobValue("scoutBountyUsd"),
    maxPerWalletPerDay: knobValue("scoutMaxPerWalletPerDay"),
    minPayoutUsd: knobValue("scoutMinPayoutUsd"),
    findings: accrued.length,
    scouts: new Set(accrued.map((r) => r.wallet)).size,
    totalAccruedUsd: Math.round(accrued.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
    totalPaidUsd: Math.round(paid.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
    recent: accrued
      .slice(-12)
      .reverse()
      .map((r) => ({ ts: r.ts, scout: shortAddr(r.wallet), name: r.name, segment: r.segment, amountUsd: r.amountUsd })),
  };
  if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
    const w = address.toLowerCase();
    const mine = accrued.filter((r) => r.wallet === w);
    const cutoff = Date.now() - DAY_MS;
    board.me = {
      findings: mine.length,
      accruedUsd: Math.round(mine.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
      balanceUsd: walletBalanceUsd(rows, w),
      todayCount: mine.filter((r) => r.ts >= cutoff).length,
      recent: mine.slice(-10).reverse().map((r) => ({ ts: r.ts, name: r.name, segment: r.segment, amountUsd: r.amountUsd })),
    };
  }
  return board;
}

const transferAbi = [parseAbiItem("function transfer(address to, uint256 amount) returns (bool)")];

/**
 * Operator-triggered settlement: pay every wallet whose accrued-minus-paid
 * balance clears the minimum, in USDG from the house wallet. Runs under the
 * house-wallet mutex — it signs with the same wallet the LP guard retiles
 * with, and serializing also makes a double-settle safe: the second run
 * re-reads the ledger AFTER the first has landed its payout rows, sees zero
 * balances, and pays nothing. Each transfer passes the same runaway circuit
 * breaker as every other house-wallet op.
 */
/**
 * The settle-worthy set, for a payer whose key lives OFF this box: Merd's own
 * treasury wallet, signing from the machine his runtime lives on. Read-only
 * and lock-free on purpose; the remote payer serializes itself and reports
 * each landed transfer back through recordExternalPayout, which is where the
 * atomicity lives. Includes the treasury and token so the payer can hard-check
 * it is signing from the right wallet for the right asset.
 */
export function pendingPayouts(): Record<string, unknown> {
  const rows = readRows();
  const wallets = [...new Set(rows.filter((r) => (r.kind === "scout" || r.kind === "xpost") && r.status === "accrued").map((r) => r.wallet))];
  const payouts = wallets
    .map((w) => ({ wallet: w, balanceUsd: Math.round(walletBalanceUsd(rows, w) * 100) / 100 }))
    .filter((p) => p.balanceUsd >= knobValue("scoutMinPayoutUsd"));
  return { ok: true, minPayoutUsd: knobValue("scoutMinPayoutUsd"), treasury: HOUSE_WALLET, usdg: USDG, payouts };
}

/** What an on-chain check of a claimed payout tx must prove. */
export interface TransferProof {
  from: string;
  to: string;
  amountUsd: number;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Read the USDG Transfer to `to` out of a landed tx. Injectable for tests. */
async function readUsdgTransfer(txHash: `0x${string}`, to: string): Promise<TransferProof | null> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") return null;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== USDG.toLowerCase()) continue;
    if (l.topics[0] !== TRANSFER_TOPIC) continue;
    const toAddr = `0x${(l.topics[2] ?? "").slice(-40)}`.toLowerCase();
    if (toAddr !== to.toLowerCase()) continue;
    const from = `0x${(l.topics[1] ?? "").slice(-40)}`.toLowerCase();
    return { from, to: toAddr, amountUsd: Number(BigInt(l.data)) / 1e6 };
  }
  return null;
}

/**
 * Record a payout that Merd's treasury signed elsewhere. The claim is not
 * trusted: the tx must exist, have succeeded, and contain a USDG Transfer of
 * at least the claimed amount from the treasury to that scout. Verified so a
 * buggy payer script cannot zero a scout's balance with a fabricated hash,
 * and deduped by txHash so a retried report cannot burn the balance twice.
 * Runs under the house-wallet lock so the balance check and the append are
 * atomic against a concurrent operator settleBounties run.
 */
export async function recordExternalPayout(
  input: { wallet?: unknown; amountUsd?: unknown; txHash?: unknown },
  verify: (txHash: `0x${string}`, to: string) => Promise<TransferProof | null> = readUsdgTransfer,
): Promise<Record<string, unknown>> {
  const wallet = typeof input.wallet === "string" ? input.wallet.toLowerCase() : "";
  const amountUsd = typeof input.amountUsd === "number" && Number.isFinite(input.amountUsd) ? input.amountUsd : NaN;
  const txHash = typeof input.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.txHash) ? (input.txHash as `0x${string}`) : null;
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return { ok: false, error: "wallet must be a 0x address" };
  if (!(amountUsd > 0)) return { ok: false, error: "amountUsd must be a positive number" };
  if (!txHash) return { ok: false, error: "txHash must be a 66-character transaction hash" };

  return withHouseWalletLock("record-external-payout", async () => {
    const rows = readRows();
    if (rows.some((r) => r.kind === "payout" && r.txHash === txHash)) {
      return { ok: false, error: "txHash already recorded" };
    }
    const balanceUsd = walletBalanceUsd(rows, wallet);
    if (amountUsd > balanceUsd + 0.01) {
      return { ok: false, error: `claimed $${amountUsd.toFixed(2)} exceeds the accrued balance $${balanceUsd.toFixed(2)}` };
    }
    const proof = await verify(txHash, wallet);
    if (!proof) return { ok: false, error: "no successful USDG transfer to that wallet in that tx" };
    if (proof.from !== HOUSE_WALLET.toLowerCase()) {
      return { ok: false, error: "the transfer is not from the treasury" };
    }
    if (proof.amountUsd + 1e-6 < amountUsd) {
      return { ok: false, error: `on-chain amount $${proof.amountUsd.toFixed(2)} is below the claimed $${amountUsd.toFixed(2)}` };
    }
    appendLedger(LOG, { ts: Date.now(), kind: "payout", wallet, status: "paid", amountUsd, txHash } satisfies BountyRow);
    return { ok: true, wallet: shortAddr(wallet), amountUsd, txHash };
  });
}

export async function settleBounties(): Promise<Record<string, unknown>> {
  return withHouseWalletLock("settle-bounties", async () => {
    const rows = readRows(); // MUST be read inside the lock — see the double-settle note above
    const wallets = [...new Set(rows.filter((r) => (r.kind === "scout" || r.kind === "xpost") && r.status === "accrued").map((r) => r.wallet))];
    const paid: Array<{ wallet: string; amountUsd: number; txHash: string }> = [];
    const skipped: Array<{ wallet: string; balanceUsd: number; reason: string }> = [];

    const client = getPublicClient();

    // This path spends USDG held by the SIGNER, and since the 2026-08-01 split
    // the signer has no income: revenue collects to the agent's treasury. So
    // an empty signer here is the normal state, not an anomaly, and letting it
    // proceed produces one cryptic transfer revert per scout. Say what is
    // actually true and point at the funded path instead.
    const signer = getAgentAddress();
    if (signer) {
      const held = (await client.readContract({
        address: USDG,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
        functionName: "balanceOf",
        args: [signer],
      })) as bigint;
      const owed = wallets.reduce((s, w) => {
        const b = walletBalanceUsd(rows, w);
        return b >= knobValue("scoutMinPayoutUsd") ? s + b : s;
      }, 0);
      if (owed > 0 && Number(held) / 1e6 < owed) {
        return {
          ok: false,
          error:
            `the signer holds $${(Number(held) / 1e6).toFixed(2)} USDG against $${owed.toFixed(2)} payable. ` +
            "Revenue collects to the treasury now, so fund settlement there and pay from the treasury rather than topping this wallet up.",
          paid,
          skipped,
        };
      }
    }
    for (const w of wallets) {
      const balanceUsd = walletBalanceUsd(rows, w);
      if (balanceUsd < knobValue("scoutMinPayoutUsd")) {
        skipped.push({ wallet: shortAddr(w), balanceUsd, reason: `below $${knobValue("scoutMinPayoutUsd")} minimum` });
        continue;
      }
      try {
        guardWalletOp(`bounty payout ${shortAddr(w)} $${balanceUsd.toFixed(2)}`);
        const walletClient = getWalletClient();
        const raw = BigInt(Math.round(balanceUsd * 1e6));
        const txHash = await walletClient.writeContract({
          address: USDG,
          abi: transferAbi,
          functionName: "transfer",
          args: [w as `0x${string}`, raw],
        });
        await client.waitForTransactionReceipt({ hash: txHash });
        recordWalletOp(balanceUsd, "bounty-payout");
        appendLedger(LOG, { ts: Date.now(), kind: "payout", wallet: w, status: "paid", amountUsd: balanceUsd, txHash } satisfies BountyRow);
        paid.push({ wallet: shortAddr(w), amountUsd: balanceUsd, txHash });
      } catch (err) {
        skipped.push({ wallet: shortAddr(w), balanceUsd, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ok: true, paid, skipped };
  });
}
