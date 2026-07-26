// Deploying MeridianPositionLock — and knowing its address before the launch.
//
// CREATE2, because the address has to exist as a VALUE before the position that
// lands in it exists at all. The launch transaction names the lock as the mint
// recipient, so the lock's address is an input to the very transaction that
// creates the thing it will hold. A plain deploy would mean seeding first and
// hoping, which is the ordering this whole module exists to avoid.
//
// No address mining here, unlike the hook. v4 reads hook permissions out of a
// hook's address; it reads nothing out of a position owner's. Any address will
// do, so the salt is a fixed label and the address falls out of the arguments.
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
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { create2Address, CREATE2_DEPLOYER } from "./hookMiner.js";
import { V4_POSITION_MANAGER, NATIVE_ETH } from "./v4Pool.js";

const ARTIFACT = fileURLToPath(
  new URL("../../../contracts/out/MeridianPositionLock.sol/MeridianPositionLock.json", import.meta.url),
);

export interface LockDeployment {
  /** The v4 PositionManager whose NFT this will hold. */
  positionManager: Address;
  /** The pool's currencies. Native ETH is address(0) and sorts first. */
  currency0: Address;
  currency1: Address;
  /** Fees go to these two and nowhere else, forever. */
  beneficiaryA: Address;
  beneficiaryB: Address;
  /** A's share in basis points; B takes the remainder. */
  shareABps: number;
  salt?: Hex;
}

const LOCK_ABI = parseAbi([
  "function POSITION_MANAGER() view returns (address)",
  "function CURRENCY0() view returns (address)",
  "function CURRENCY1() view returns (address)",
  "function BENEFICIARY_A() view returns (address)",
  "function BENEFICIARY_B() view returns (address)",
  "function SHARE_A_BPS() view returns (uint16)",
  "function tokenId() view returns (uint256)",
  "function isLocked() view returns (bool)",
  "function lockExisting(uint256 id)",
  "function collectFees()",
]);

function creationBytecode(): Hex {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex | undefined;
  if (!bytecode || !bytecode.startsWith("0x") || bytecode.length < 10) {
    throw new Error("MeridianPositionLock artifact missing or empty — run `forge build` first");
  }
  return bytecode;
}

export function lockInitCode(d: LockDeployment): Hex {
  const args = encodeAbiParameters(parseAbiParameters("address, address, address, address, address, uint16"), [
    d.positionManager,
    d.currency0,
    d.currency1,
    d.beneficiaryA,
    d.beneficiaryB,
    d.shareABps,
  ]);
  return concat([creationBytecode(), args]);
}

export function lockSalt(d: LockDeployment): Hex {
  return d.salt ?? keccak256(toHex("meridian:position-lock:v1"));
}

/** Where this lock lands. Known before anything is broadcast, which is the point. */
export function predictLockAddress(d: LockDeployment): Address {
  return create2Address(CREATE2_DEPLOYER, lockSalt(d), keccak256(lockInitCode(d)));
}

export function assertDeployable(d: LockDeployment): void {
  // currency0 may be address(0): that is how v4 spells native ETH.
  for (const [label, value] of [
    ["positionManager", d.positionManager],
    ["currency1", d.currency1],
    ["beneficiaryA", d.beneficiaryA],
    ["beneficiaryB", d.beneficiaryB],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an address`);
    if (/^0x0{40}$/i.test(value)) throw new Error(`${label} must not be the zero address`);
  }
  if (d.shareABps > 10_000) throw new Error("shareABps cannot exceed the whole fee");
  if (d.positionManager.toLowerCase() !== V4_POSITION_MANAGER.toLowerCase()) {
    throw new Error(
      `positionManager is ${d.positionManager}, expected ${V4_POSITION_MANAGER} — ` +
        "a lock built against the wrong manager can never collect the position's fees",
    );
  }
  if (d.currency0 !== NATIVE_ETH) {
    throw new Error(`currency0 is ${d.currency0}; MERD's pool pairs native ETH, which v4 spells as the zero address`);
  }
}

export interface LockDeployResult {
  address: Address;
  salt: Hex;
  txHash: Hex;
  verified: {
    positionManager: Address;
    currency0: Address;
    currency1: Address;
    beneficiaryA: Address;
    beneficiaryB: Address;
    shareABps: number;
    tokenId: bigint;
  };
}

/**
 * Deploy the lock, then read every immutable back off the chain.
 *
 * Worth the round trip: a lock built against the wrong PositionManager or the
 * wrong currency pair deploys and looks fine, then fails at the only moment it
 * is ever asked to do anything — collecting fees on a position holding the
 * entire supply, with no way to move that position to a working lock.
 */
export async function deployLock(
  d: LockDeployment,
  opts: { rpcUrl: string; privateKey: Hex; expectedAddress?: Address; dryRun?: boolean },
): Promise<LockDeployResult> {
  assertDeployable(d);

  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) });

  const salt = lockSalt(d);
  const initCode = lockInitCode(d);
  const address = create2Address(CREATE2_DEPLOYER, salt, keccak256(initCode));

  if (opts.expectedAddress && address.toLowerCase() !== opts.expectedAddress.toLowerCase()) {
    throw new Error(
      `lock would deploy to ${address}, but ${opts.expectedAddress} was recorded — ` +
        "the contract or its constructor arguments have changed since that address was written down",
    );
  }

  const existing = await publicClient.getBytecode({ address });
  if (existing && existing !== "0x") throw new Error(`a lock already exists at ${address} — CREATE2 addresses are one-shot`);

  const data = concat([salt, initCode]);
  await publicClient.call({ account: account.address, to: CREATE2_DEPLOYER, data });

  if (opts.dryRun) {
    return {
      address,
      salt,
      txHash: "0x" as Hex,
      verified: { ...d, tokenId: 0n },
    };
  }

  const wallet = createWalletClient({ account, transport: http(opts.rpcUrl) });
  const txHash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data, chain: null });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Only the view functions: readContract rejects the state-changing ones, and
  // narrowing here means a typo reaches the compiler rather than the chain.
  type View = Extract<(typeof LOCK_ABI)[number], { type: "function"; stateMutability: "view" }>["name"];
  const read = <T>(functionName: View) => publicClient.readContract({ address, abi: LOCK_ABI, functionName }) as Promise<T>;

  const [positionManager, currency0, currency1, beneficiaryA, beneficiaryB, shareABps, tokenId] = await Promise.all([
    read<Address>("POSITION_MANAGER"),
    read<Address>("CURRENCY0"),
    read<Address>("CURRENCY1"),
    read<Address>("BENEFICIARY_A"),
    read<Address>("BENEFICIARY_B"),
    read<number>("SHARE_A_BPS"),
    read<bigint>("tokenId"),
  ]);

  const mismatches: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(positionManager, d.positionManager)) mismatches.push(`positionManager ${positionManager}`);
  if (!same(currency0, d.currency0)) mismatches.push(`currency0 ${currency0}`);
  if (!same(currency1, d.currency1)) mismatches.push(`currency1 ${currency1}`);
  if (!same(beneficiaryA, d.beneficiaryA)) mismatches.push(`beneficiaryA ${beneficiaryA}`);
  if (!same(beneficiaryB, d.beneficiaryB)) mismatches.push(`beneficiaryB ${beneficiaryB}`);
  if (shareABps !== d.shareABps) mismatches.push(`shareABps ${shareABps}`);
  if (mismatches.length > 0) {
    throw new Error(`deployed lock does not match what was intended — do NOT seed into ${address}: ${mismatches.join("; ")}`);
  }

  return { address, salt, txHash, verified: { positionManager, currency0, currency1, beneficiaryA, beneficiaryB, shareABps, tokenId } };
}

/**
 * The call that makes a position the lock already holds collectable.
 *
 * Needed because v4's PositionManager mints with _mint rather than _safeMint,
 * so onERC721Received never fires and the lock does not learn its own tokenId.
 * Deliberately NOT part of the launch transaction: the id does not exist until
 * the mint has landed, so this is read off the chain afterwards.
 *
 * Nothing is at risk in the gap. The NFT is already inside a contract with no
 * transfer function, so it cannot go anywhere — only fee collection is waiting
 * on this, and anyone may send it.
 */
export function buildLockExistingTransaction(lock: Address, tokenId: bigint): { to: Address; data: Hex; value: string; description: string } {
  if (tokenId <= 0n) throw new Error("tokenId must be positive — v4 starts at 1, and 0 is the lock's 'nothing yet' sentinel");
  return {
    to: lock,
    data: encodeFunctionDataLockExisting(tokenId),
    value: "0",
    description: `record position #${tokenId} in the lock so its fees can be collected (callable by anyone)`,
  };
}

function encodeFunctionDataLockExisting(tokenId: bigint): Hex {
  const selector = keccak256(toHex("lockExisting(uint256)")).slice(0, 10) as Hex;
  return concat([selector, encodeAbiParameters(parseAbiParameters("uint256"), [tokenId])]);
}

/** Reads the tokenId the launch actually minted, straight off the lock's owner. */
export async function findLockedTokenId(lock: Address, rpcUrl: string): Promise<bigint> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return client.readContract({ address: lock, abi: LOCK_ABI, functionName: "tokenId" }) as Promise<bigint>;
}
