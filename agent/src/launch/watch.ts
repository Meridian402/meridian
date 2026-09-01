// THE LAUNCH-HOUR WATCHER (D1 of agent/LAUNCH-HOUR-SPEC.md). READ-ONLY.
// No signer, no key, no wallet: this process cannot move money by
// construction. It watches launches and the hookless USDG side pools that
// appear beside them, gates the tokens, times ignition, and scores what a
// probe-then-scale seat WOULD have earned on the real tape. Output is a
// ledger (launch-watch.jsonl) and a resumable state file; `--report` prints
// the table. Runs anywhere with an RPC; meant for a laptop under launchd.
//
// Pacing: the public RPC is Cloudflare-fronted, rejects default User-Agents
// and 429s bursts, so every poll is at most three getLogs calls with a
// browser UA, a few seconds apart. Set LAUNCH_WATCH_RPC_URL to a provider
// endpoint for a faster feed.
import { createPublicClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "../dataDir.js";
import { appendLedger } from "../ledger.js";
import { PONS_V2, factoryAbi } from "./ponsV2.js";
import { gateToken, ignitionTime, simulateSeat, hourlyTable, type SwapSample, type SimPlan, type SimResult, Q96 } from "./watchCore.js";

const RPC = process.env.LAUNCH_WATCH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const POLL_MS = Number(process.env.LAUNCH_WATCH_POLL_MS ?? 3000);
const RUN_SECONDS = Number(process.env.LAUNCH_WATCH_SECONDS ?? 0); // 0 = forever
const MIN_TIER = Number(process.env.LAUNCH_WATCH_MIN_TIER ?? 5000); // 0.5%
const MAX_TIER = Number(process.env.LAUNCH_WATCH_MAX_TIER ?? 100000); // 10%: above that it is sniper dust, not a market
const DEAD_HOOKED_MIN = Number(process.env.LAUNCH_WATCH_DEAD_HOOKED_MIN ?? 20); // a launch market with no swap this long is spam
const DEAD_SIDE_MIN = Number(process.env.LAUNCH_WATCH_DEAD_SIDE_MIN ?? 60);
const GATES_PER_MINUTE = Number(process.env.LAUNCH_WATCH_GATES_PER_MINUTE ?? 10);
const BPS = 10; // blocks per second, measured 09-01
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const PONS_V2_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const DOPPLER_HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
/** Verified standards, read at startup: the PONS v2 launcher token (GPRO,
 *  source verified 09-01) and the Doppler ERC20 implementation behind BONER's
 *  proxy (source verified 08-31). */
const PONS_V2_TOKEN_REFERENCE: Address = "0x82fe7e669c0ce263436cf74b8ec7335654aa902d";
const DOPPLER_IMPLEMENTATION: Address = "0x3be8b97fd0e713b5abe0649fa830223b6b4bc599";
const PAIR_ALLOWLIST = [
  USDG,
  // Official Robinhood asset tokens (NVDA, GLD, QQQ, SPY, ...) are admitted by
  // name at gate time; these two are listed only as documentation.
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", // NVDA stock token
  "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", // GLD stock token
  "0x39dBED3a2bd333467115dE45665cC57F813C4571", // PONS
  "0x0000000000000000000000000000000000000000", // native ETH
  "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
];

const PLAN: SimPlan = {
  probeUsd: Number(process.env.LAUNCH_WATCH_PROBE_USD ?? 150),
  scaleUsd: Number(process.env.LAUNCH_WATCH_SCALE_USD ?? 1500),
  width: Number(process.env.LAUNCH_WATCH_WIDTH ?? 1.5),
  ignitionTs: null,
  maxAgeSec: Number(process.env.LAUNCH_WATCH_MAX_AGE_H ?? 6) * 3600,
  rolloverDropPct: Number(process.env.LAUNCH_WATCH_ROLLOVER_PCT ?? 30),
  floorFrac: Number(process.env.LAUNCH_WATCH_FLOOR_FRAC ?? 0.6),
  crowdingMultiple: Number(process.env.LAUNCH_WATCH_CROWDING_X ?? 3),
  outOfRangeExitSec: Number(process.env.LAUNCH_WATCH_OUT_OF_RANGE_MIN ?? 30) * 60,
};
const IGNITION = { windowSec: 600, minSwaps: Number(process.env.LAUNCH_WATCH_IGN_SWAPS ?? 60), minSenders: Number(process.env.LAUNCH_WATCH_IGN_SENDERS ?? 20), minUsd: Number(process.env.LAUNCH_WATCH_IGN_USD ?? 10000) };

const initEvent = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const swapEvent = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const launchedEvent = factoryAbi.find((x) => x.type === "event" && x.name === "TokenLaunched")!;
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

interface Launch {
  token: string;
  source: "pons-v2" | "doppler";
  ts: number;
  pair: string | null;
  pairSymbol?: string;
  curvePoolId: string | null;
  symbol: string;
  name: string;
  gate: { ok: boolean; standard: string | null; reason: string } | null;
  creatorTaxBps: number | null;
  ignitionTs: number | null;
  firstSwapTs: number | null;
}
interface TrackedPool {
  id: string;
  kind: "side" | "hooked";
  token: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  usdgIs0: boolean;
  usdgQuoted: boolean;
  createdTs: number;
  swaps: SwapSample[];
  swapCount?: number;
  senders: Record<string, number>;
  lastReportHour: number;
  sim: SimResult | null;
  closed: boolean;
}
interface State {
  lastBlock: string;
  launches: Record<string, Launch>;
  pools: Record<string, TrackedPool>;
  references: { ponsV2Code: string | null };
}

const STATE_PATH = dataPath("launch-watch-state.json");
const LEDGER = "launch-watch.jsonl";

function loadState(): State {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
    } catch {
      /* corrupt: start fresh, the ledger keeps history */
    }
  }
  return { lastBlock: "0", launches: {}, pools: {}, references: { ponsV2Code: null } };
}
function saveState(s: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(s));
}
function log(line: string): void {
  console.error(`[launchWatch] ${new Date().toISOString().slice(11, 19)} ${line}`);
}

const client = createPublicClient({
  chain: { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { fetchOptions: { headers: { "User-Agent": UA, Accept: "application/json" } }, retryCount: 3, retryDelay: 2000, timeout: 30_000 }),
});

async function gateLaunch(state: State, l: Launch): Promise<void> {
  try {
    const code = (await client.getCode({ address: l.token as Address })) ?? "0x";
    let decimals: number | null = null;
    try {
      decimals = Number(await client.readContract({ address: l.token as Address, abi: erc20Abi, functionName: "decimals" }));
    } catch {
      decimals = null;
    }
    try {
      l.symbol = String(await client.readContract({ address: l.token as Address, abi: erc20Abi, functionName: "symbol" }));
      l.name = String(await client.readContract({ address: l.token as Address, abi: erc20Abi, functionName: "name" }));
    } catch {
      /* a token that cannot say its name fails the gate on bytecode anyway */
    }
    if (l.source === "pons-v2") {
      try {
        const rec = (await client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [l.token as Address] })) as unknown as { creatorTaxBps: number; pairToken: string };
        l.creatorTaxBps = Number(rec.creatorTaxBps);
        l.pair = l.pair ?? rec.pairToken;
      } catch {
        l.creatorTaxBps = null;
      }
    }
    // The pair: USDG, ETH, PONS, or any official Robinhood asset token (their
    // names all carry the "Robinhood Token" mark: NVDA, GLD, QQQ, SPY, ...).
    // A launch paired against another launch token is not a market we read.
    let pairOfficial = false;
    if (l.pair && !l.pairSymbol) {
      try {
        if (Number(l.pair) === 0) l.pairSymbol = "ETH";
        else {
          l.pairSymbol = String(await client.readContract({ address: l.pair as Address, abi: erc20Abi, functionName: "symbol" }));
          const pairName = String(await client.readContract({ address: l.pair as Address, abi: erc20Abi, functionName: "name" }));
          pairOfficial = /Robinhood Token/i.test(pairName);
        }
      } catch {
        l.pairSymbol = "?";
      }
    }
    if (!state.references.ponsV2Code) state.references.ponsV2Code = (await client.getCode({ address: PONS_V2_TOKEN_REFERENCE })) ?? null;
    l.gate = gateToken({
      code,
      references: state.references.ponsV2Code ? [{ name: "PonsV2LauncherToken", code: state.references.ponsV2Code }] : [],
      proxyImplementations: [{ name: "DopplerERC20V1", address: DOPPLER_IMPLEMENTATION }],
      creatorTaxBps: l.creatorTaxBps,
      pairToken: l.pair,
      pairAllowlist: pairOfficial && l.pair ? [...PAIR_ALLOWLIST, l.pair] : PAIR_ALLOWLIST,
      decimals,
    });
    appendLedger(LEDGER, { kind: "launch", ...l, loggedAt: Date.now() });
    log(`launch ${l.source} ${l.symbol || l.token.slice(0, 10)} pair ${l.pairSymbol ?? (l.pair ?? "?").slice(0, 10)} tax ${l.creatorTaxBps ?? "?"}bps gate ${l.gate.ok ? "PASS" : "FAIL: " + l.gate.reason}`);
  } catch (err) {
    log(`gate failed for ${l.token}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
}

function tsOf(head: bigint, headTs: number, block: bigint): number {
  return headTs - Number(head - block) / BPS;
}

async function poll(state: State): Promise<void> {
  const head = await client.getBlockNumber();
  const headTs = Date.now() / 1000;
  let from = BigInt(state.lastBlock) + 1n;
  if (state.lastBlock === "0" || head - from > 20_000n) from = head - 100n; // never backfill a gap we cannot afford to scan
  if (from > head) return;
  const to = head - from > 5000n ? from + 5000n : head;

  const inits = await client.getLogs({ address: POOL_MANAGER, event: initEvent, fromBlock: from, toBlock: to });
  for (const l of inits) {
    const a = l.args;
    const hooks = String(a.hooks).toLowerCase();
    const c0 = String(a.currency0).toLowerCase();
    const c1 = String(a.currency1).toLowerCase();
    const id = String(a.id).toLowerCase();
    const usdgIs0 = c0 === USDG.toLowerCase();
    const usdgQuoted = usdgIs0 || c1 === USDG.toLowerCase();
    const ts = tsOf(head, headTs, l.blockNumber);
    const isHook = hooks === PONS_V2_HOOK || hooks === DOPPLER_HOOK;
    if (isHook) {
      // a launch market: for Doppler this IS the launch signal
      const known = [c0, c1].find((c) => state.launches[c]);
      const token = known ?? [c0, c1].find((c) => !PAIR_ALLOWLIST.some((p) => p.toLowerCase() === c)) ?? c1;
      if (hooks === DOPPLER_HOOK && !state.launches[token]) {
        const pair = c0 === token ? c1 : c0;
        state.launches[token] = { token, source: "doppler", ts, pair, curvePoolId: id, symbol: "", name: "", gate: null, creatorTaxBps: null, ignitionTs: null, firstSwapTs: null };
      }
      if (state.launches[token]) state.launches[token].curvePoolId = state.launches[token].curvePoolId ?? id;
      state.pools[id] = { id, kind: "hooked", token, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks, usdgIs0, usdgQuoted, createdTs: ts, swaps: [], senders: {}, lastReportHour: -1, sim: null, closed: false };
      continue;
    }
    if (Number(a.hooks) !== 0 && hooks !== "0x0000000000000000000000000000000000000000") continue;
    if (!usdgQuoted || Number(a.fee) < MIN_TIER || Number(a.fee) > MAX_TIER) continue;
    const token = usdgIs0 ? c1 : c0;
    state.pools[id] = { id, kind: "side", token, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks, usdgIs0, usdgQuoted, createdTs: ts, swaps: [], senders: {}, lastReportHour: -1, sim: null, closed: false };
    appendLedger(LEDGER, { ts: Date.now(), kind: "side-pool", id, token, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), launch: state.launches[token] ? state.launches[token].source : null });
    log(`side pool ${id.slice(0, 12)} ${(state.launches[token]?.symbol || token.slice(0, 10))} tier ${Number(a.fee) / 1e4}%${state.launches[token] ? " (known launch)" : ""}`);
  }

  const launched = await client.getLogs({ address: PONS_V2.factory, event: launchedEvent, fromBlock: from, toBlock: to });
  for (const l of launched) {
    const a = l.args as { token: string; curve: string; pairToken: string };
    const token = a.token.toLowerCase();
    if (state.launches[token]) continue;
    state.launches[token] = { token, source: "pons-v2", ts: tsOf(head, headTs, l.blockNumber), pair: a.pairToken, curvePoolId: null, symbol: "", name: "", gate: null, creatorTaxBps: null, ignitionTs: null, firstSwapTs: null };
  }

  const ids = Object.values(state.pools).filter((p) => !p.closed).map((p) => p.id as Hex);
  for (let i = 0; i < ids.length; i += 300) {
    const swaps = await client.getLogs({ address: POOL_MANAGER, event: swapEvent, args: { id: ids.slice(i, i + 300) }, fromBlock: from, toBlock: to });
    for (const l of swaps) {
      const a = l.args;
      const p = state.pools[String(a.id).toLowerCase()];
      if (!p) continue;
      const usdgAmt = p.usdgQuoted ? (p.usdgIs0 ? a.amount0 : a.amount1) : 0n;
      const sqrtP = Number(a.sqrtPriceX96) / Q96;
      const ratio = sqrtP * sqrtP;
      const px = p.usdgQuoted ? (p.usdgIs0 ? (1 / ratio) * 1e12 : ratio * 1e12) : 0;
      const sender = String(a.sender).toLowerCase();
      const x: SwapSample = { t: tsOf(head, headTs, l.blockNumber), usd: Math.abs(Number(usdgAmt)) / 1e6, px, sqrtP, L: Number(a.liquidity), sender };
      // A launch market's tape only matters for ignition (the first minutes);
      // a side pool's tape is the simulation, kept for its whole life.
      const keep = p.kind === "side" ? p.swaps.length < 20_000 : x.t - p.createdTs < 30 * 60 && p.swaps.length < 3_000;
      if (keep) p.swaps.push(x);
      p.swapCount = (p.swapCount ?? 0) + 1;
      p.senders[sender] = (p.senders[sender] ?? 0) + 1;
      const launch = state.launches[p.token];
      if (launch && launch.firstSwapTs == null) launch.firstSwapTs = x.t;
    }
  }
  state.lastBlock = to.toString();
}

/** Once a minute: lazy gates, ignition, simulation, hourly ledger lines, pruning. */
async function evaluate(state: State): Promise<void> {
  const now = Date.now() / 1000;
  // Gate lazily: ~13k PONS v2 launches a day are spam that never trades. A
  // launch earns its four gate calls only once one of its pools prints a swap.
  const traded = new Set(Object.values(state.pools).filter((p) => p.swaps.length > 0).map((p) => p.token));
  let gates = 0;
  for (const l of Object.values(state.launches)) {
    if (l.gate == null && traded.has(l.token) && gates < GATES_PER_MINUTE) {
      await gateLaunch(state, l);
      gates++;
    }
  }
  for (const l of Object.values(state.launches)) {
    if (l.ignitionTs != null) continue;
    const tape = Object.values(state.pools).filter((p) => p.token === l.token).flatMap((p) => p.swaps);
    const hasUsd = tape.some((x) => x.usd > 0);
    const ign = ignitionTime(l.ts, tape, { ...IGNITION, minUsd: hasUsd ? IGNITION.minUsd : 0 });
    if (ign != null) {
      l.ignitionTs = ign;
      appendLedger(LEDGER, { ts: Date.now(), kind: "ignition", token: l.token, symbol: l.symbol, launchTs: l.ts, ignitionTs: ign, minutesAfterLaunch: Math.round((ign - l.ts) / 60) });
      log(`IGNITION ${l.symbol || l.token.slice(0, 10)} at +${Math.round((ign - l.ts) / 60)}m`);
    }
  }
  for (const p of Object.values(state.pools)) {
    if (p.closed) continue;
    const age = now - p.createdTs;
    if (p.kind === "side" && p.swaps.length > 0) {
      const launch = state.launches[p.token];
      const ignitionTs = launch?.ignitionTs ?? ignitionTime(p.swaps[0].t, p.swaps, IGNITION);
      const gateOk = launch ? launch.gate?.ok === true : false;
      p.sim = simulateSeat(p.swaps, p.fee / 1e6, p.usdgIs0, { ...PLAN, ignitionTs });
      const hour = Math.floor((now - p.swaps[0].t) / 3600);
      if (hour > p.lastReportHour) {
        p.lastReportHour = hour;
        const table = hourlyTable(p.swaps, p.fee / 1e6);
        const last = table[table.length - 1];
        appendLedger(LEDGER, { ts: Date.now(), kind: "hourly", id: p.id, token: p.token, symbol: launch?.symbol ?? "", tier: p.fee / 1e4, gateOk, launchSource: launch?.source ?? null, hour, swaps: p.swaps.length, volumeUsd: Math.round(p.swaps.reduce((s, x) => s + x.usd, 0)), feesUsd: Math.round(p.swaps.reduce((s, x) => s + x.usd, 0) * (p.fee / 1e6)), senders: Object.keys(p.senders).length, lastHour: last ? { swaps: last.swaps, usd: Math.round(last.usd), L: last.L, px: last.pxClose } : null, sim: p.sim });
        log(`${launch?.symbol || p.token.slice(0, 10)} tier ${p.fee / 1e4}% h${hour}: ${p.swaps.length} swaps, $${Math.round(p.swaps.reduce((s, x) => s + x.usd, 0)).toLocaleString()} vol, sim net $${p.sim.netUsd} (${p.sim.exitReason})`);
      }
    }
    const deadAfter = (p.kind === "hooked" ? DEAD_HOOKED_MIN : DEAD_SIDE_MIN) * 60;
    if ((p.swaps.length === 0 && age > deadAfter) || age > 24 * 3600) {
      p.closed = true;
      if (p.swaps.length > 0) appendLedger(LEDGER, { ts: Date.now(), kind: "closed", id: p.id, token: p.token, symbol: state.launches[p.token]?.symbol ?? "", swaps: p.swaps.length, sim: p.sim });
      p.swaps = p.swaps.slice(-50); // keep the state file small; the ledger has the history
    }
  }
  // Keep the state bounded: closed pools drop out after a day, and launches
  // that never got a trading pool drop out after two hours. The ledger already
  // holds every line they produced.
  const referenced = new Set(Object.values(state.pools).filter((p) => !p.closed).map((p) => p.token));
  for (const [id, p] of Object.entries(state.pools)) if (p.closed && now - p.createdTs > 24 * 3600) delete state.pools[id];
  for (const [token, l] of Object.entries(state.launches)) if (l.ignitionTs == null && !referenced.has(token) && now - l.ts > 2 * 3600) delete state.launches[token];
}

function report(state: State): void {
  const rows = Object.values(state.pools).filter((p) => p.kind === "side" && p.swaps.length > 0);
  // Recompute every sim fresh from the stored tapes so the report always
  // reflects the CURRENT plan and exits, not whatever code stamped p.sim
  // when the row was live (the floor fix would otherwise take a day to show).
  for (const p of rows) {
    const launch = state.launches[p.token];
    const ignitionTs = launch?.ignitionTs ?? ignitionTime(p.swaps[0].t, p.swaps, IGNITION);
    p.sim = simulateSeat(p.swaps, p.fee / 1e6, p.usdgIs0, { ...PLAN, ignitionTs });
  }
  rows.sort((a, b) => (b.sim?.feesUsd ?? 0) - (a.sim?.feesUsd ?? 0));
  console.log(`launch-watch report, ${Object.keys(state.launches).length} launches seen, ${rows.length} side pools with swaps\n`);
  console.log("symbol      tier   age(h) src      gate  first-swap  ignition  swaps    volume      fees(pool)  sim fees  sim net   exit");
  for (const p of rows) {
    const l = state.launches[p.token];
    const vol = p.swaps.reduce((s, x) => s + x.usd, 0);
    const first = p.swaps[0].t - p.createdTs;
    const ign = l?.ignitionTs != null ? `+${Math.round((l.ignitionTs - l.ts) / 60)}m` : "-";
    console.log(`${(l?.symbol || p.token.slice(0, 10)).padEnd(11)} ${(p.fee / 1e4).toFixed(2).padStart(5)}% ${((Date.now() / 1000 - p.createdTs) / 3600).toFixed(1).padStart(6)} ${(l?.source ?? "unknown").padEnd(8)} ${(l?.gate ? (l.gate.ok ? "PASS" : "FAIL") : "-").padEnd(5)} ${`+${Math.round(first)}s`.padStart(10)} ${ign.padStart(9)} ${String(p.swaps.length).padStart(6)} $${Math.round(vol).toLocaleString().padStart(10)} $${Math.round(vol * p.fee / 1e6).toLocaleString().padStart(10)} $${String(p.sim?.feesUsd ?? 0).padStart(8)} $${String(p.sim?.netUsd ?? 0).padStart(8)}   ${p.sim?.exitReason ?? ""}`);
  }
  const fails = Object.values(state.launches).filter((l) => l.gate && !l.gate.ok);
  if (fails.length) console.log(`\ngate failures: ${fails.map((l) => `${l.symbol || l.token.slice(0, 10)} (${l.gate!.reason})`).join("; ")}`);
}

async function main(): Promise<void> {
  const state = loadState();
  if (process.argv.includes("--report")) {
    report(state);
    return;
  }
  log(`armed: rpc ${new URL(RPC).hostname}, poll ${POLL_MS}ms, tier >= ${MIN_TIER / 1e4}%, probe $${PLAN.probeUsd} -> scale $${PLAN.scaleUsd} at ignition (${IGNITION.minSwaps} swaps, ${IGNITION.minSenders} senders, $${IGNITION.minUsd} in ${IGNITION.windowSec / 60}m), band x${PLAN.width}, exits: ${PLAN.maxAgeSec / 3600}h / roll-over ${PLAN.rolloverDropPct}% / crowding ${PLAN.crowdingMultiple}x. READ-ONLY.`);
  const started = Date.now();
  let lastEval = 0;
  let failures = 0;
  for (;;) {
    try {
      await poll(state);
      failures = 0;
    } catch (err) {
      failures++;
      log(`poll failed (${failures}): ${err instanceof Error ? err.message.slice(0, 140) : err}`);
      await sleep(Math.min(60_000, 5_000 * failures));
    }
    if (Date.now() - lastEval > 60_000) {
      const prevEval = lastEval;
      await evaluate(state);
      saveState(state);
      lastEval = Date.now();
      if (Math.floor(lastEval / 600_000) !== Math.floor(prevEval / 600_000)) {
        const live = Object.values(state.pools).filter((p) => !p.closed);
        log(`heartbeat: block ${state.lastBlock}, ${Object.keys(state.launches).length} launches in state, ${live.filter((p) => p.kind === "hooked").length} launch markets + ${live.filter((p) => p.kind === "side").length} side pools tracked, ${live.filter((p) => p.swaps.length > 0).length} with tape`);
      }
    }
    if (RUN_SECONDS > 0 && Date.now() - started > RUN_SECONDS * 1000) {
      await evaluate(state);
      saveState(state);
      log(`stopping after ${RUN_SECONDS}s: ${Object.keys(state.launches).length} launches, ${Object.values(state.pools).filter((p) => p.kind === "side").length} side pools tracked`);
      return;
    }
    await sleep(POLL_MS);
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
main().catch((err) => {
  console.error(`[launchWatch] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
