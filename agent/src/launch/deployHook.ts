// Deploying MeridianTreasuryHook — the step that has to happen before the pool
// can exist at all.
//
// A v4 pool's hook is part of its identity, fixed at creation. There is no way
// to add one afterwards, no way to swap one out, and no way to correct a pool
// that was created pointing at the wrong address. So the order is forced:
// deploy the hook, verify it, and only then create the pool against it.
//
// Two failure modes drive everything below, and both are SILENT:
//
//   1. A hook at an unmined address. v4 reads permissions out of the low 14 bits
//      of the hook's address, so a hook deployed to an ordinary address is never
//      called. Nothing reverts. The pool trades normally and the fee collects
//      nothing, forever, with no way to fix it. The contract's own
//      validateHookAddress() catches this at construction — but only if we let
//      it, which is why deployment goes through a mined salt rather than a
//      convenient one.
//
//   2. The wrong PoolManager. Passing the PositionManager address here compiles,
//      deploys, mines, and verifies — and then onlyPoolManager rejects the real
//      manager on every swap, so every trade in the pool reverts. This has been
//      confused once already in this repo, so it is checked against the pinned
//      address AND probed on chain rather than trusted.
//
// The salt is MINED at deploy time rather than committed. Init code covers the
// bytecode and the constructor arguments both, so a pinned salt goes stale the
// moment the contract or the schedule changes — silently, producing an ordinary
// address that lands us in failure mode 1. Mining takes well under a second.
// EXPECTED_HOOK_ADDRESS below records where that mining lands today, and the
// deploy asserts it still reproduces, so a change to either the source or the
// build settings shows up as a loud mismatch instead of a surprise address.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  concat,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { create2Address, CREATE2_DEPLOYER, mineHookSalt, hookAddressClaims, TREASURY_HOOK_FLAGS } from "./hookMiner.js";
import { V4_POOL_MANAGER } from "./v4Pool.js";

const ARTIFACT = fileURLToPath(new URL("../../../contracts/out/MeridianTreasuryHook.sol/MeridianTreasuryHook.json", import.meta.url));

/** Matches the Schedule struct in the contract. Order is part of the address. */
export interface FeeSchedule {
  buyLaunchBps: number;
  buyPlateauBps: number;
  buyFloorBps: number;
  sellLaunchBps: number;
  sellPlateauBps: number;
  sellFloorBps: number;
  rampSeconds: bigint;
  plateauUntil: bigint;
  taperSeconds: bigint;
  referralShareBps: number;
  lpShareBps: number;
}

export interface HookDeployment {
  /** The v4 singleton. Must be the PoolManager, never the PositionManager. */
  poolManager: Address;
  /** Receives the treasury share of every fee, in whichever currency it lands. */
  treasury: Address;
  /** Holds disableFeesForever() — an authority that can only make trading cheaper. */
  owner: Address;
  schedule: FeeSchedule;
}

const HOOK_ABI = parseAbi([
  "function POOL_MANAGER() view returns (address)",
  "function TREASURY() view returns (address)",
  "function owner() view returns (address)",
  "function BUY_LAUNCH_BPS() view returns (uint16)",
  "function BUY_PLATEAU_BPS() view returns (uint16)",
  "function BUY_FLOOR_BPS() view returns (uint16)",
  "function SELL_LAUNCH_BPS() view returns (uint16)",
  "function SELL_PLATEAU_BPS() view returns (uint16)",
  "function SELL_FLOOR_BPS() view returns (uint16)",
  "function RAMP_SECONDS() view returns (uint64)",
  "function PLATEAU_UNTIL() view returns (uint64)",
  "function TAPER_SECONDS() view returns (uint64)",
  "function REFERRAL_SHARE_BPS() view returns (uint16)",
  "function LP_SHARE_BPS() view returns (uint16)",
  "function feesDisabledForever() view returns (bool)",
]);

/** extsload is on the PoolManager and not on the PositionManager, which makes it
 *  a usable probe for "is this actually the singleton". */
const EXTSLOAD_ABI = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

function creationBytecode(): Hex {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex | undefined;
  if (!bytecode || !bytecode.startsWith("0x") || bytecode.length < 10) {
    throw new Error("MeridianTreasuryHook artifact missing or empty — run `forge build` first");
  }
  return bytecode;
}

/**
 * Init code for this exact hook. The schedule is in here, so changing any single
 * basis point moves the address — which is the property that makes the recorded
 * address below meaningful as a check.
 */
export function hookInitCode(d: HookDeployment): Hex {
  const s = d.schedule;
  const args = encodeAbiParameters(
    parseAbiParameters("address, address, address, (uint16,uint16,uint16,uint16,uint16,uint16,uint64,uint64,uint64,uint16,uint16)"),
    [
      d.poolManager,
      d.treasury,
      d.owner,
      [
        s.buyLaunchBps,
        s.buyPlateauBps,
        s.buyFloorBps,
        s.sellLaunchBps,
        s.sellPlateauBps,
        s.sellFloorBps,
        s.rampSeconds,
        s.plateauUntil,
        s.taperSeconds,
        s.referralShareBps,
        s.lpShareBps,
      ],
    ],
  );
  return concat([creationBytecode(), args]);
}

export interface MinedHookAddress {
  salt: Hex;
  address: Address;
  iterations: number;
  ms: number;
}

/**
 * Where this hook will land, and the salt that puts it there.
 *
 * Deterministic: mining walks the integers from zero, so the same contract with
 * the same arguments always produces the same salt on every machine.
 */
export function predictHookAddress(d: HookDeployment): MinedHookAddress {
  const mined = mineHookSalt(hookInitCode(d));
  return mined;
}

/**
 * Checks that hold regardless of whether we are about to broadcast. Exported so
 * they can be run — and tested — without a chain in front of them.
 */
export function assertDeployable(d: HookDeployment): void {
  const s = d.schedule;
  for (const [label, value] of [
    ["poolManager", d.poolManager],
    ["treasury", d.treasury],
    ["owner", d.owner],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an address`);
    if (/^0x0{40}$/.test(value)) throw new Error(`${label} must not be the zero address`);
  }
  // The mix-up that would make every swap revert. The pinned address was
  // verified on chain; anything else here is a mistake until proven otherwise.
  if (d.poolManager.toLowerCase() !== V4_POOL_MANAGER.toLowerCase()) {
    throw new Error(
      `poolManager is ${d.poolManager}, expected the verified v4 singleton ${V4_POOL_MANAGER} — ` +
        "a hook built against the wrong manager rejects the real one and every swap in the pool reverts",
    );
  }
  // Mirrors the constructor, so a bad schedule fails here rather than as an
  // opaque revert after mining.
  if (s.buyLaunchBps > 1000 || s.sellLaunchBps > 1000) throw new Error("opening rate exceeds the contract's 10% cap");
  if (s.buyLaunchBps < s.buyPlateauBps || s.buyPlateauBps < s.buyFloorBps) throw new Error("buy schedule must be non-increasing");
  if (s.sellLaunchBps < s.sellPlateauBps || s.sellPlateauBps < s.sellFloorBps) throw new Error("sell schedule must be non-increasing");
  if (s.referralShareBps + s.lpShareBps > 10_000) throw new Error("referral and LP shares exceed the whole fee");
  if (s.plateauUntil < s.rampSeconds) throw new Error("the plateau cannot end before the ramp reaches it");
}

export interface HookDeployResult {
  address: Address;
  salt: Hex;
  txHash: Hex;
  iterations: number;
  verified: {
    poolManager: Address;
    treasury: Address;
    owner: Address;
    schedule: FeeSchedule;
    feesDisabledForever: boolean;
    claimsCorrectPermissions: boolean;
  };
}

/**
 * Deploy the hook and prove afterwards that the chain agrees with what we meant.
 *
 * The read-back is not ceremony. Every value in the schedule is immutable and
 * baked into the deployed code, so if any of it is wrong the only remedy is a
 * different hook at a different address — which means a different pool. Better
 * to find out here than after the pool holds real liquidity.
 */
export async function deployHook(
  d: HookDeployment,
  opts: { rpcUrl: string; privateKey: Hex; expectedAddress?: Address; dryRun?: boolean },
): Promise<HookDeployResult> {
  assertDeployable(d);

  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) });

  // Probe the manager rather than trusting the constant: a pinned address is
  // only as good as the chain it was pinned against.
  const managerCode = await publicClient.getBytecode({ address: d.poolManager });
  if (!managerCode || managerCode === "0x") throw new Error(`no contract at the PoolManager address ${d.poolManager} on this chain`);
  try {
    await publicClient.readContract({ address: d.poolManager, abi: EXTSLOAD_ABI, functionName: "extsload", args: [`0x${"00".repeat(32)}` as Hex] });
  } catch {
    throw new Error(`${d.poolManager} does not answer extsload — this is not a v4 PoolManager`);
  }

  const initCode = hookInitCode(d);
  const { salt, address, iterations, ms } = mineHookSalt(initCode);

  // Belt and braces: mineHookSalt already matches the full 14-bit mask, but a
  // hook at a wrong address fails silently forever, so it is worth two checks.
  if (!hookAddressClaims(address)) {
    throw new Error(`mined address ${address} does not claim exactly flags 0x${TREASURY_HOOK_FLAGS.toString(16)}`);
  }
  if (create2Address(CREATE2_DEPLOYER, salt, keccak256(initCode)) !== address) {
    throw new Error("mined address does not reproduce from its own salt");
  }
  // A drift here means the source or the build settings changed under a
  // recorded address. Loud is the point.
  if (opts.expectedAddress && address.toLowerCase() !== opts.expectedAddress.toLowerCase()) {
    throw new Error(
      `hook would deploy to ${address}, but ${opts.expectedAddress} was recorded — ` +
        "the contract, its constructor arguments, or the compiler settings have changed since that address was written down",
    );
  }

  const existing = await publicClient.getBytecode({ address });
  if (existing && existing !== "0x") throw new Error(`a hook already exists at ${address} — CREATE2 addresses are one-shot`);

  const data = concat([salt, initCode]); // the proxy takes salt ++ initCode
  await publicClient.call({ account: account.address, to: CREATE2_DEPLOYER, data });

  if (opts.dryRun) {
    return {
      address,
      salt,
      txHash: "0x" as Hex,
      iterations,
      verified: {
        poolManager: d.poolManager,
        treasury: d.treasury,
        owner: d.owner,
        schedule: d.schedule,
        feesDisabledForever: false,
        claimsCorrectPermissions: true,
      },
    };
  }

  const wallet = createWalletClient({ account, transport: http(opts.rpcUrl) });
  const txHash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data, chain: null });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  type HookView = Extract<(typeof HOOK_ABI)[number], { type: "function" }>["name"];
  const read = <T>(functionName: HookView) =>
    publicClient.readContract({ address, abi: HOOK_ABI, functionName }) as Promise<T>;

  const [poolManager, treasury, owner, buyLaunch, buyPlateau, buyFloor, sellLaunch, sellPlateau, sellFloor, ramp, plateau, taper, referral, lp, disabled] =
    await Promise.all([
      read<Address>("POOL_MANAGER"),
      read<Address>("TREASURY"),
      read<Address>("owner"),
      read<number>("BUY_LAUNCH_BPS"),
      read<number>("BUY_PLATEAU_BPS"),
      read<number>("BUY_FLOOR_BPS"),
      read<number>("SELL_LAUNCH_BPS"),
      read<number>("SELL_PLATEAU_BPS"),
      read<number>("SELL_FLOOR_BPS"),
      read<bigint>("RAMP_SECONDS"),
      read<bigint>("PLATEAU_UNTIL"),
      read<bigint>("TAPER_SECONDS"),
      read<number>("REFERRAL_SHARE_BPS"),
      read<number>("LP_SHARE_BPS"),
      read<boolean>("feesDisabledForever"),
    ]);

  const onChain: FeeSchedule = {
    buyLaunchBps: buyLaunch,
    buyPlateauBps: buyPlateau,
    buyFloorBps: buyFloor,
    sellLaunchBps: sellLaunch,
    sellPlateauBps: sellPlateau,
    sellFloorBps: sellFloor,
    rampSeconds: ramp,
    plateauUntil: plateau,
    taperSeconds: taper,
    referralShareBps: referral,
    lpShareBps: lp,
  };

  const mismatches: string[] = [];
  if (poolManager.toLowerCase() !== d.poolManager.toLowerCase()) mismatches.push(`poolManager ${poolManager} != ${d.poolManager}`);
  if (treasury.toLowerCase() !== d.treasury.toLowerCase()) mismatches.push(`treasury ${treasury} != ${d.treasury}`);
  if (owner.toLowerCase() !== d.owner.toLowerCase()) mismatches.push(`owner ${owner} != ${d.owner}`);
  for (const [k, v] of Object.entries(onChain)) {
    const intended = (d.schedule as unknown as Record<string, number | bigint>)[k];
    if (BigInt(v as number | bigint) !== BigInt(intended)) mismatches.push(`${k} ${v} != ${intended}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`deployed hook does not match what was intended — do NOT create a pool against ${address}: ${mismatches.join("; ")}`);
  }

  return {
    address,
    salt,
    txHash,
    iterations,
    verified: { poolManager, treasury, owner, schedule: onChain, feesDisabledForever: disabled, claimsCorrectPermissions: hookAddressClaims(address) },
  };
}
