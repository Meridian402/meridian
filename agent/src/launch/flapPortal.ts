// Token launching on Robinhood Chain via Flap's Portal.
//
// We do NOT deploy a token factory. Flap's launchpad is already live on chain
// 4663 (and testnet 46630) and is battle-tested elsewhere; our contribution is
// making it agent-native, which nobody has done on this chain. Portal is a
// TransparentUpgradeableProxy whose implementation source is NOT verified on
// Blockscout, so every shape here is taken from Flap's published docs and must
// be proven by simulation before anything is signed. Never broadcast a launch
// that has not simulated clean — that rule is the whole safety story.
//
// SIGNING: this module never signs and never holds funds. newTokenV6 is payable
// and msg.value is the CREATOR's own initial buy, so the user signs from their
// own wallet and the on-chain TokenCreated event records them as creator. That
// keeps the "moves no funds, self-custody" invariant the user-agent system is
// built on, and keeps us off the hook as deployer of record for whatever
// someone decides to launch.
import { getContractAddress, keccak256, toHex, toBytes, encodeFunctionData, type Address, type Hex } from "viem";

/** Chain-specific Flap deployment. Same addresses on both Robinhood networks. */
export interface FlapDeployment {
  chainId: number;
  rpcUrl: string;
  portal: Address;
  /** Non-tax token implementation; salts must predict an address ending 8888. */
  tokenImplStandard: Address;
  /** Tax-token V3 implementation; salts must predict an address ending 7777. */
  tokenImplTaxedV3: Address;
  explorer: string;
}

export const FLAP_ROBINHOOD_MAINNET: FlapDeployment = {
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  portal: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09",
  tokenImplStandard: "0x88882688a067FE97E11C2185b996286e53132222",
  tokenImplTaxedV3: "0x7777C8743C88B3aff3cf262135beF2c8b2e83333",
  explorer: "https://robinhoodchain.blockscout.com",
};

export const FLAP_ROBINHOOD_TESTNET: FlapDeployment = {
  chainId: 46630,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  portal: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09",
  tokenImplStandard: "0x88882688a067FE97E11C2185b996286e53132222",
  tokenImplTaxedV3: "0x7777C8743C88B3aff3cf262135beF2c8b2e83333",
  explorer: "https://explorer.testnet.chain.robinhood.com",
};

/** Testnet until a launch has been proven end-to-end there. */
export function flapDeployment(): FlapDeployment {
  return process.env.FLAP_NETWORK === "mainnet" ? FLAP_ROBINHOOD_MAINNET : FLAP_ROBINHOOD_TESTNET;
}

// --- enum values, by declaration order in Flap's IPortal. Encoded as uint8, so
// an off-by-one here silently launches something other than what was asked for
// (a different curve threshold, or worse, a different migrator). Kept as named
// constants precisely so a reader can check them against the docs.
export const DexThresh = { TWO_THIRDS: 0, FOUR_FIFTHS: 1, HALF: 2, P95: 3, P81: 4, P1: 5 } as const;
export const MigratorType = { V3: 0, V2: 1, V4_UNI: 2, PCS_INFINITY_CL: 3 } as const;
export const TokenVersion = {
  LEGACY_MINT_NO_PERMIT: 0,
  LEGACY_MINT_NO_PERMIT_DUP: 1,
  V2_PERMIT: 2,
  GOPLUS: 3,
  TAXED: 4,
  TAXED_V2: 5,
  TAXED_V3: 6,
  V3_PERMIT: 7,
} as const;
export const V3LPFeeProfile = { STANDARD: 0, LOW: 1, HIGH: 2 } as const;

// Robinhood Chain only permits TOKEN_V2_PERMIT and TOKEN_TAXED_V3; every other
// version reverts with FeatureDisabled(). Only V2_MIGRATOR is supported, so a
// graduating token lands in a Uniswap V2 pair (not v4, where our own
// market-making book lives — worth remembering before assuming they connect).
export const ROBINHOOD_SUPPORTED_VERSIONS = [TokenVersion.V2_PERMIT, TokenVersion.TAXED_V3] as const;

/**
 * Struct field ORDER is consensus-critical — these are positional on the wire.
 *
 * Two entry points, and picking the wrong one is not a soft failure. Flap's
 * general docs call newTokenV6 "the recommended unified entry point for all
 * token types", but Robinhood Chain does not implement the non-tax path there:
 * newTokenV6 with tokenVersion=TOKEN_V2_PERMIT reverts with FeatureDisabled()
 * (0xac5f6092). Verified by simulation on testnet 46630, which is the only
 * reason we know. On this chain:
 *   - non-tax  -> newTokenV5 (taxRate = 0), 22 fields
 *   - tax V3   -> newTokenV6 (tokenVersion = TOKEN_TAXED_V3), 26 fields
 */
export const PORTAL_ABI = [
  {
    type: "function",
    name: "newTokenV5",
    stateMutability: "payable",
    outputs: [{ name: "token", type: "address" }],
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "meta", type: "string" },
          { name: "dexThresh", type: "uint8" },
          { name: "salt", type: "bytes32" },
          { name: "taxRate", type: "uint16" },
          { name: "migratorType", type: "uint8" },
          { name: "quoteToken", type: "address" },
          { name: "quoteAmt", type: "uint256" },
          { name: "beneficiary", type: "address" },
          { name: "permitData", type: "bytes" },
          { name: "extensionID", type: "bytes32" },
          { name: "extensionData", type: "bytes" },
          { name: "dexId", type: "uint8" },
          { name: "lpFeeProfile", type: "uint8" },
          { name: "taxDuration", type: "uint64" },
          { name: "antiFarmerDuration", type: "uint64" },
          { name: "mktBps", type: "uint16" },
          { name: "deflationBps", type: "uint16" },
          { name: "dividendBps", type: "uint16" },
          { name: "lpBps", type: "uint16" },
          { name: "minimumShareBalance", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "newTokenV6",
    stateMutability: "payable",
    outputs: [{ name: "token", type: "address" }],
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "meta", type: "string" },
          { name: "dexThresh", type: "uint8" },
          { name: "salt", type: "bytes32" },
          { name: "migratorType", type: "uint8" },
          { name: "quoteToken", type: "address" },
          { name: "quoteAmt", type: "uint256" },
          { name: "beneficiary", type: "address" },
          { name: "permitData", type: "bytes" },
          { name: "extensionID", type: "bytes32" },
          { name: "extensionData", type: "bytes" },
          { name: "dexId", type: "uint8" },
          { name: "lpFeeProfile", type: "uint8" },
          { name: "buyTaxRate", type: "uint16" },
          { name: "sellTaxRate", type: "uint16" },
          { name: "taxDuration", type: "uint64" },
          { name: "antiFarmerDuration", type: "uint64" },
          { name: "mktBps", type: "uint16" },
          { name: "deflationBps", type: "uint16" },
          { name: "dividendBps", type: "uint16" },
          { name: "lpBps", type: "uint16" },
          { name: "minimumShareBalance", type: "uint256" },
          { name: "dividendToken", type: "address" },
          { name: "commissionReceiver", type: "address" },
          { name: "tokenVersion", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getQuoteTokenConfiguration",
    stateMutability: "view",
    inputs: [{ name: "quoteToken", type: "address" }],
    outputs: [{ name: "enabled", type: "bool" }, { name: "curveType", type: "uint8" }, { name: "dexThresh", type: "uint256" }],
  },
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "timestamp", type: "uint256", indexed: false },
      { name: "creator", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "token", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "meta", type: "string", indexed: false },
    ],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Predict the CREATE2 address for a salt. Portal clones the implementation with
 * an EIP-1167 minimal proxy, so the hashed initcode is the proxy stub wrapping
 * the impl address — NOT the implementation's own bytecode. Getting this wrong
 * yields addresses that never match the suffix and an infinite mining loop.
 */
export function predictTokenAddress(salt: Hex, tokenImpl: Address, portal: Address): Address {
  const bytecode = ("0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    tokenImpl.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3") as Hex;
  return getContractAddress({ from: portal, salt: toBytes(salt), bytecode, opcode: "CREATE2" });
}

export interface MinedSalt {
  salt: Hex;
  address: Address;
  iterations: number;
  ms: number;
}

/**
 * Mine a salt whose predicted address carries Flap's required vanity suffix
 * (8888 standard, 7777 tax). A 4-hex suffix is ~65k expected iterations, which
 * measures at well under two seconds — cheap enough to do inline on a request
 * rather than as a background job.
 *
 * maxIterations is a guard, not a tuning knob: if the predicted addresses never
 * match, the bytecode or impl address is wrong and we want a clear error rather
 * than a hung request.
 */
export function mineVanitySalt(suffix: string, tokenImpl: Address, portal: Address, maxIterations = 5_000_000): MinedSalt {
  if (!/^[0-9a-fA-F]{4}$/.test(suffix)) throw new Error(`vanity suffix must be exactly 4 hex chars, got "${suffix}"`);
  const want = suffix.toLowerCase();
  const started = Date.now();
  // Any unique 32-byte seed works; the chain only sees the final salt.
  let salt = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  let iterations = 0;
  while (!predictTokenAddress(salt, tokenImpl, portal).toLowerCase().endsWith(want)) {
    if (++iterations > maxIterations) {
      throw new Error(`no vanity salt for suffix ${suffix} after ${maxIterations} iterations — check tokenImpl/portal addresses`);
    }
    salt = keccak256(salt);
  }
  return { salt, address: predictTokenAddress(salt, tokenImpl, portal), iterations, ms: Date.now() - started };
}

export interface LaunchRequest {
  name: string;
  symbol: string;
  /** IPFS CID from Flap's upload API. Their indexer cannot see unpinned files. */
  meta: string;
  /** The creator's initial buy, in wei. Must equal msg.value. 0n is allowed. */
  quoteAmt: bigint;
  /** Who signs and funds — recorded on-chain as creator. */
  creator: Address;
}

export interface BuiltLaunch {
  to: Address;
  data: Hex;
  value: bigint;
  predictedToken: Address;
  salt: Hex;
  iterations: number;
  chainId: number;
}

/**
 * Where our launcher commission accrues. Unset = no commission taken.
 *
 * Note this only ever reaches the chain on the TAX-token path: commissionReceiver
 * is a V6-only field and Robinhood forces non-tax launches through newTokenV5,
 * which has no such field. Standard launches therefore earn us nothing here, and
 * any revenue story built on this must say "tax tokens" out loud.
 */
function commissionReceiver(): Address {
  const a = process.env.FLAP_COMMISSION_RECEIVER;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : ZERO;
}

const MAX_NAME = 64;
const MAX_SYMBOL = 16;

/**
 * Build an UNSIGNED standard (non-tax) token launch. Returns calldata for the
 * user to sign in their own wallet — this function deliberately has no access
 * to a signer.
 *
 * Non-tax is the only shape exposed for now: tax tokens carry buy/sell rates,
 * dividend routing and anti-farmer windows, all of which are levers to extract
 * value from holders. Those deserve an explicit, informed decision rather than
 * an agent picking defaults on someone's behalf.
 */
export function buildStandardLaunch(req: LaunchRequest, dep: FlapDeployment = flapDeployment()): BuiltLaunch {
  const name = req.name.trim();
  const symbol = req.symbol.trim();
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1-${MAX_NAME} chars`);
  if (!symbol || symbol.length > MAX_SYMBOL) throw new Error(`symbol must be 1-${MAX_SYMBOL} chars`);
  if (!req.meta.trim()) throw new Error("meta (IPFS CID) is required — Flap's indexer cannot show an unpinned token");
  if (req.quoteAmt < 0n) throw new Error("quoteAmt cannot be negative");
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.creator)) throw new Error("creator must be an address");

  const mined = mineVanitySalt("8888", dep.tokenImplStandard, dep.portal);

  const params = {
    name,
    symbol,
    meta: req.meta.trim(),
    dexThresh: DexThresh.FOUR_FIFTHS, // 80% of supply sold => graduate (~5 ETH on this chain)
    salt: mined.salt,
    taxRate: 0, // zero is what makes this the non-tax implementation
    migratorType: MigratorType.V2, // the only migrator Robinhood Chain permits
    quoteToken: ZERO, // native ETH as the reserve asset
    quoteAmt: req.quoteAmt,
    beneficiary: req.creator,
    permitData: "0x" as Hex,
    extensionID: ZERO_BYTES32,
    extensionData: "0x" as Hex,
    dexId: 0,
    lpFeeProfile: V3LPFeeProfile.STANDARD,
    // Tax-only fields, unused at taxRate 0. antiFarmerDuration still applies:
    // it's the post-graduation window during which transfers to pools other
    // than mainPool are blocked. Flap's own Robinhood example uses 1 day.
    taxDuration: 0n,
    antiFarmerDuration: BigInt(24 * 60 * 60),
    mktBps: 0,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    minimumShareBalance: 0n,
  } as const;

  return {
    to: dep.portal,
    data: encodeFunctionData({ abi: PORTAL_ABI, functionName: "newTokenV5", args: [params] }),
    value: req.quoteAmt, // msg.value MUST equal quoteAmt
    predictedToken: mined.address,
    salt: mined.salt,
    iterations: mined.iterations,
    chainId: dep.chainId,
  };
}
