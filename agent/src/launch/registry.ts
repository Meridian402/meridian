// The agent-launch registry: which launches Meridian routed, for which team,
// through which splitter, and whether they graduated. This file is what turns
// "deploy a tokenized agent" into an engine key: hasGraduatedLaunch() feeds
// the access gate's tokenized-agent path, and access arrives AT GRADUATION,
// never at launch (operator decision 2026-08-26).
//
// Registration is verified on-chain, not trusted: the team submits their
// launch txHash, we read the factory's TokenLaunched event from the receipt,
// require the deployer to be the registering wallet, and require the launch's
// creatorFeeRecipient to be a real Meridian splitter whose treasury() is OUR
// treasury and whose team() is the registering wallet. A launch that skipped
// the splitter simply is not a routed launch and earns nothing here.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { decodeEventLog, type Address, type Hex } from "viem";
import { dataPath } from "../dataDir.js";
import { getPublicClient } from "../venues/signer.js";
import { PONS_V2, factoryAbi, splitterAbi, splitterFactoryAbi, isGraduated } from "./ponsV2.js";
import { splitterFactoryAddress } from "./prepare.js";

const REGISTRY_PATH = dataPath("agent-launches.jsonl");
const WATCH_MS = Number(process.env.MERIDIAN_LAUNCH_WATCH_MS ?? 5 * 60_000);

export interface LaunchRecord {
  token: Address;
  curve: Address;
  team: Address;
  splitter: Address;
  txHash: Hex;
  routedAt: number;
  graduatedAt?: number;
}

let cache: Map<string, LaunchRecord> | null = null;

function load(): Map<string, LaunchRecord> {
  if (cache) return cache;
  cache = new Map();
  if (existsSync(REGISTRY_PATH)) {
    for (const line of readFileSync(REGISTRY_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Partial<LaunchRecord> & { token?: string };
        if (!r.token) continue;
        const key = r.token.toLowerCase();
        const prev = cache.get(key);
        // Later rows override earlier ones; a graduation row carries only
        // token + graduatedAt and merges over the original record.
        cache.set(key, { ...(prev ?? ({} as LaunchRecord)), ...(r as LaunchRecord) });
      } catch {
        /* skip torn line */
      }
    }
  }
  return cache;
}

function append(row: object): void {
  appendFileSync(REGISTRY_PATH, JSON.stringify(row) + "\n");
}

export function allLaunches(): LaunchRecord[] {
  return [...load().values()];
}

export function launchesForWallet(wallet: string): LaunchRecord[] {
  const w = wallet.toLowerCase();
  return allLaunches().filter((r) => r.team?.toLowerCase() === w);
}

/** The gate's tokenized-agent path: true when the wallet routed a launch that
 *  has graduated. Registry-backed, synchronous, fails closed on empty. */
export function hasGraduatedLaunch(wallet: string): boolean {
  return launchesForWallet(wallet).some((r) => r.graduatedAt && r.graduatedAt > 0);
}

/**
 * Verify and register a routed launch from its transaction hash. Everything
 * that matters is read from chain; the caller only points at the receipt.
 */
export async function registerLaunchFromTx(txHash: Hex, teamWallet: Address): Promise<{ ok: true; record: LaunchRecord } | { ok: false; error: string }> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success") return { ok: false, error: "that transaction did not succeed on chain" };

  let launched: { token: Address; curve: Address; deployer: Address } | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PONS_V2.factory.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "TokenLaunched") {
        const a = ev.args as { token: Address; curve: Address; deployer: Address };
        launched = { token: a.token, curve: a.curve, deployer: a.deployer };
        break;
      }
    } catch {
      /* not our event */
    }
  }
  if (!launched) return { ok: false, error: "no PONS v2 TokenLaunched event in that transaction" };
  if (launched.deployer.toLowerCase() !== teamWallet.toLowerCase()) {
    return { ok: false, error: "that launch was not deployed by this wallet" };
  }
  if (load().has(launched.token.toLowerCase())) return { ok: false, error: "that launch is already registered" };

  // The launch must route its fee stream through a REAL Meridian splitter.
  // Identity comes from PROVENANCE, not self-report: we ask our own factory
  // whether it deployed this recipient. A look-alike contract can return our
  // treasury from a treasury() getter while routing 100% of fees to the
  // attacker; only factory.isSplitter() can tell the genuine article apart,
  // because only the factory's create() writes it. Fails closed if the router
  // isn't armed (no factory address) — an unverifiable recipient is rejected.
  const info = await client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [launched.token] });
  const recipient = info.creatorFeeRecipient;
  const factory = splitterFactoryAddress();
  if (!factory) return { ok: false, error: "the launch router is not armed (no splitter factory configured)" };
  const genuine = await client
    .readContract({ address: factory, abi: splitterFactoryAbi, functionName: "isSplitter", args: [recipient] })
    .catch(() => false);
  if (!genuine) return { ok: false, error: "the launch's fee recipient was not deployed by the Meridian splitter factory" };
  // Now that provenance is established (bytecode is our splitter, treasury is
  // pinned to ours by the factory, ROUTER_BPS is compiled in), team() is the
  // only remaining fact to bind: this launch's splitter must pay THIS wallet.
  const splitTeam = await client.readContract({ address: recipient, abi: splitterAbi, functionName: "team" }).catch(() => null);
  if (!splitTeam) return { ok: false, error: "the launch's fee recipient is not a Meridian splitter" };
  if (splitTeam.toLowerCase() !== teamWallet.toLowerCase()) {
    return { ok: false, error: "the launch's splitter is not set to this team" };
  }

  const record: LaunchRecord = {
    token: launched.token,
    curve: launched.curve,
    team: teamWallet,
    splitter: recipient,
    txHash,
    routedAt: Date.now(),
  };
  append(record);
  load().set(record.token.toLowerCase(), record);
  console.error(`[launch] registered agent launch ${record.token} for team ${teamWallet} via splitter ${recipient}`);
  return { ok: true, record };
}

async function watchTick(): Promise<void> {
  const pending = allLaunches().filter((r) => !r.graduatedAt);
  if (pending.length === 0) return;
  const client = getPublicClient();
  for (const r of pending) {
    try {
      const info = await client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [r.token] });
      if (isGraduated(info)) {
        const row = { token: r.token, graduatedAt: Date.now() };
        append(row);
        load().set(r.token.toLowerCase(), { ...r, graduatedAt: row.graduatedAt });
        console.error(`[launch] GRADUATED: ${r.token} (team ${r.team}) — engine access is now live for the team`);
      }
    } catch (e) {
      console.error(`[launch] graduation check failed for ${r.token}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }
}

export function startGraduationWatch(): NodeJS.Timeout | undefined {
  if (process.env.MERIDIAN_LAUNCH_WATCH === "off") {
    console.log("[launch] graduation watch off (MERIDIAN_LAUNCH_WATCH=off)");
    return;
  }
  console.log(`[launch] graduation watch armed: registered launches checked every ${Math.round(WATCH_MS / 1000)}s; engine access flips ON at graduation (sweptAt > 0)`);
  const t = setInterval(() => void watchTick(), WATCH_MS);
  t.unref?.();
  void watchTick();
  return t;
}

/** Test hook: reset the in-memory cache (the file is the durable truth). */
export function _resetLaunchCache(): void {
  cache = null;
}
