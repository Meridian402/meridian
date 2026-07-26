// Mining a CREATE2 salt for a Uniswap v4 hook address.
//
// v4 does not store which callbacks a hook implements. It reads them out of the
// low 14 bits of the hook's own ADDRESS. So a hook cannot be deployed anywhere
// convenient — it has to land on an address whose bits spell out exactly the
// permissions it claims, which means CREATE2 and a mined salt.
//
// The failure this prevents is quiet. Deploy MeridianTreasuryHook to an ordinary
// address and nothing reverts: the pool is created, swaps work, and afterSwap is
// simply never called. The fee would read as configured on our side and collect
// nothing forever. The constructor's validateHookPermissions turns that into a
// failed deployment, and this module is what finds an address that passes it.
import { keccak256, encodePacked, getAddress, concat, type Address, type Hex } from "viem";

/** Permission bits, mirroring v4-core's Hooks.sol. Order is consensus-critical. */
export const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 13,
  AFTER_INITIALIZE: 1 << 12,
  BEFORE_ADD_LIQUIDITY: 1 << 11,
  AFTER_ADD_LIQUIDITY: 1 << 10,
  BEFORE_REMOVE_LIQUIDITY: 1 << 9,
  AFTER_REMOVE_LIQUIDITY: 1 << 8,
  BEFORE_SWAP: 1 << 7,
  AFTER_SWAP: 1 << 6,
  BEFORE_DONATE: 1 << 5,
  AFTER_DONATE: 1 << 4,
  BEFORE_SWAP_RETURNS_DELTA: 1 << 3,
  AFTER_SWAP_RETURNS_DELTA: 1 << 2,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0,
} as const;

/** All 14 permission bits. The mined address must match the target EXACTLY
 *  across this mask — a stray extra bit claims a callback we never wrote. */
export const ALL_HOOK_MASK = (1 << 14) - 1;

/**
 * What MeridianTreasuryHook declares: it takes a cut in afterSwap, and returns
 * a delta to do it. Nothing else. Keep this in lockstep with the Permissions
 * struct in the contract's constructor; if they drift, deployment fails, which
 * is the correct direction to fail in.
 */
export const TREASURY_HOOK_FLAGS = HOOK_FLAGS.AFTER_SWAP | HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA;

/**
 * Canonical deterministic-deployment proxy, verified live on Robinhood Chain
 * (chain 4663) at 69 bytes. It prepends the 32-byte salt to the calldata and
 * CREATE2s the remainder, which is why the salt below is a plain bytes32.
 */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** CREATE2: keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:] */
export function create2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  const packed = keccak256(encodePacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", deployer, salt, initCodeHash]));
  return getAddress(`0x${packed.slice(-40)}`);
}

export interface MinedHook {
  salt: Hex;
  address: Address;
  iterations: number;
  ms: number;
}

/**
 * Find a salt whose CREATE2 address carries exactly `flags` in its low 14 bits.
 *
 * One in 16,384 addresses qualifies, so this lands in well under a second —
 * cheap enough to re-run at deploy time rather than committing a salt that
 * would silently go stale the moment the contract or its constructor arguments
 * change (the init code hash covers both).
 */
export function mineHookSalt(
  initCode: Hex,
  flags: number = TREASURY_HOOK_FLAGS,
  deployer: Address = CREATE2_DEPLOYER,
  maxIterations = 5_000_000,
): MinedHook {
  if ((flags & ALL_HOOK_MASK) !== flags) throw new Error(`flags 0x${flags.toString(16)} set bits outside the 14-bit permission mask`);
  const initCodeHash = keccak256(initCode);
  const started = Date.now();

  for (let i = 0; i < maxIterations; i++) {
    const salt = `0x${i.toString(16).padStart(64, "0")}` as Hex;
    const address = create2Address(deployer, salt, initCodeHash);
    // Compare the whole mask, not just the bits we want: an address that also
    // happens to set BEFORE_SWAP would make the pool call a function we never
    // implemented, and every swap in the pool would revert.
    if ((Number(BigInt(address) & BigInt(ALL_HOOK_MASK))) === flags) {
      return { salt, address, iterations: i, ms: Date.now() - started };
    }
  }
  throw new Error(`no hook salt found for flags 0x${flags.toString(16)} after ${maxIterations} iterations`);
}

/** Build init code: creation bytecode followed by ABI-encoded constructor args. */
export function initCodeFor(creationBytecode: Hex, encodedConstructorArgs: Hex): Hex {
  return concat([creationBytecode, encodedConstructorArgs]);
}

/** Does an address already claim the right permissions? Used to sanity-check
 *  a deployment after the fact, and to catch a hook deployed to a bad address. */
export function hookAddressClaims(address: Address, flags: number = TREASURY_HOOK_FLAGS): boolean {
  return Number(BigInt(address) & BigInt(ALL_HOOK_MASK)) === flags;
}
