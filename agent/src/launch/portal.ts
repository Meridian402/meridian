// Token launching on Robinhood Chain, through the launchpad Portal already
// deployed there.
//
// We do NOT deploy a token factory. The Portal is live on chain 4663 (and
// testnet 46630) and battle-tested on other chains; our contribution is making
// it agent-native, which nobody has done here. It is a
// TransparentUpgradeableProxy whose implementation source is NOT verified on
// Blockscout, so every struct shape below is derived from the protocol's
// published docs rather than an audited ABI, and must be proven by simulation
// before anything is signed. Never broadcast a launch that has not simulated
// clean — that rule is the whole safety story.
//
// SIGNING: this module never signs and never holds funds. Both entry points are
// payable and msg.value is the CREATOR's own initial buy, so the transaction can
// only originate from their wallet, and the on-chain TokenCreated event records
// them as creator. That keeps the "moves no funds, self-custody" invariant the
// user-agent system is built on, and keeps us off the hook as deployer of record
// for whatever someone decides to launch.
import {
  createPublicClient,
  http,
  getContractAddress,
  keccak256,
  toHex,
  toBytes,
  encodeFunctionData,
  decodeFunctionData,
  parseEther,
  type Address,
  type Hex,
} from "viem";

/** Chain-specific launchpad deployment. Same addresses on both Robinhood networks. */
export interface LaunchpadDeployment {
  chainId: number;
  rpcUrl: string;
  portal: Address;
  /** Non-tax token implementation; salts must predict an address ending 8888. */
  tokenImplStandard: Address;
  /** Tax-token V3 implementation; salts must predict an address ending 7777. */
  tokenImplTaxedV3: Address;
  explorer: string;
}

export const LAUNCHPAD_ROBINHOOD_MAINNET: LaunchpadDeployment = {
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  portal: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09",
  tokenImplStandard: "0x88882688a067FE97E11C2185b996286e53132222",
  tokenImplTaxedV3: "0x7777C8743C88B3aff3cf262135beF2c8b2e83333",
  explorer: "https://robinhoodchain.blockscout.com",
};

export const LAUNCHPAD_ROBINHOOD_TESTNET: LaunchpadDeployment = {
  chainId: 46630,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  portal: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09",
  tokenImplStandard: "0x88882688a067FE97E11C2185b996286e53132222",
  tokenImplTaxedV3: "0x7777C8743C88B3aff3cf262135beF2c8b2e83333",
  explorer: "https://explorer.testnet.chain.robinhood.com",
};

/** Testnet until a launch has been proven end-to-end there. */
export function launchpadDeployment(): LaunchpadDeployment {
  return process.env.LAUNCH_NETWORK === "mainnet" ? LAUNCHPAD_ROBINHOOD_MAINNET : LAUNCHPAD_ROBINHOOD_TESTNET;
}

// --- enum values, by declaration order in the Portal interface. Encoded as uint8, so
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

/**
 * Which DEX a graduating token's liquidity migrates to. The protocol allows
 * three slots and maps them per chain (on BSC it is PancakeSwap, on Monad it is
 * Uniswap / PancakeSwap / Monday) — but the docs never state the mapping for
 * Robinhood Chain.
 *
 * Probed instead: on BOTH 4663 and 46630, dexId 0 simulates clean and dexId 1
 * and 2 revert 0xead3ad50 (an undocumented error; not one of the 37 the docs
 * name). So there is exactly one venue and no choice to make. Combined with
 * V2_MIGRATOR being the only permitted migrator, every graduating token lands
 * in the same V2-style pair, and Uniswap is the primary AMM on this chain.
 *
 * Worth holding onto: that is NOT where our own market-making book lives. The
 * LP guard works Uniswap v4 pools; graduations land in v2.
 */
export const DEX_ID_ROBINHOOD = 0;

// Robinhood Chain only permits TOKEN_V2_PERMIT and TOKEN_TAXED_V3; every other
// version reverts with FeatureDisabled(). Only V2_MIGRATOR is supported, so a
// graduating token lands in a Uniswap V2 pair (not v4, where our own
// market-making book lives — worth remembering before assuming they connect).
export const ROBINHOOD_SUPPORTED_VERSIONS = [TokenVersion.V2_PERMIT, TokenVersion.TAXED_V3] as const;

/**
 * Struct field ORDER is consensus-critical — these are positional on the wire.
 *
 * Two entry points, and picking the wrong one is not a soft failure. The
 * protocol's general docs call newTokenV6 "the recommended unified entry point
 * for all token types", but Robinhood Chain does not implement it that way:
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
    // NOTHING is indexed. The docs present creator and token as the identifying
    // fields, which reads like they would be — but a real log on chain 4663
    // carries exactly one topic (the signature), so every field lives in data.
    // Declaring them indexed still matches topic0, so getLogs returns rows
    // normally and only the DECODE is wrong: name and symbol come back right
    // while creator and token are silently garbage. Verified against a real
    // launch before this was corrected.
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "timestamp", type: "uint256", indexed: false },
      { name: "creator", type: "address", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "token", type: "address", indexed: false },
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
 * Mine a salt whose predicted address carries the vanity suffix the Portal
 * requires (8888 standard, 7777 tax). A 4-hex suffix is ~65k expected
 * iterations, which measures at well under two seconds — cheap enough to do
 * inline on a request rather than as a background job.
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
  /**
   * IPFS CID from the launchpad's upload API. Optional — the chain accepts an
   * empty string, and the protocol's own Robinhood example passes one — but a
   * token launched without it has no image or description anywhere a trader
   * would look, since the indexer cannot fetch files never pinned to its gateway.
   */
  meta?: string;
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
  const a = process.env.LAUNCH_COMMISSION_RECEIVER;
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
export function buildStandardLaunch(req: LaunchRequest, dep: LaunchpadDeployment = launchpadDeployment()): BuiltLaunch {
  const name = req.name.trim();
  const symbol = req.symbol.trim();
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1-${MAX_NAME} chars`);
  if (!symbol || symbol.length > MAX_SYMBOL) throw new Error(`symbol must be 1-${MAX_SYMBOL} chars`);
  if (req.quoteAmt < 0n) throw new Error("quoteAmt cannot be negative");
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.creator)) throw new Error("creator must be an address");

  const mined = mineVanitySalt("8888", dep.tokenImplStandard, dep.portal);

  const params = {
    name,
    symbol,
    meta: (req.meta ?? "").trim(),
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
    dexId: DEX_ID_ROBINHOOD, // the only enabled slot on this chain (probed)
    lpFeeProfile: V3LPFeeProfile.STANDARD,
    // Tax-only fields, unused at taxRate 0. antiFarmerDuration still applies:
    // it's the post-graduation window during which transfers to pools other
    // than mainPool are blocked. The protocol's own Robinhood example uses 1 day.
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

// --- launch styles -----------------------------------------------------------
//
// Different agents want to launch different SHAPES of token, and the raw struct
// is a bad interface for that: 26 fields, four of which must sum to exactly
// 10000 bps or the Portal reverts InvalidTaxDistribution(). Asking an agent to
// assemble that freehand invites a class of failure where the launch is subtly
// wrong rather than obviously broken — a token whose tax silently all goes to
// the wrong place.
//
// So styles are named, validated bundles. An agent picks one and optionally
// overrides individual knobs; the shape rules are enforced here, once.

export type LaunchStyle = "standard" | "marketing" | "dividend" | "deflationary" | "liquidity";

export interface TaxShape {
  /** Basis points taken on buys / sells. 100 = 1%. */
  buyTaxRate: number;
  sellTaxRate: number;
  /** Where the tax goes. MUST sum to 10000. */
  mktBps: number;
  deflationBps: number;
  dividendBps: number;
  lpBps: number;
  taxDurationSec: bigint;
  antiFarmerDurationSec: bigint;
}

const YEAR = 365n * 24n * 60n * 60n;
const DAY = 24n * 60n * 60n;

/**
 * A ceiling of our own, not the protocol's. Its own interface offers 1/3/5/10%
 * tiers, and a token that taxes a third of every trade is a mechanism for
 * extracting from holders rather than funding anything. An agent acting for a
 * user should not be able to build one by fumbling a number, so 10% is the cap
 * and exceeding it is an error rather than a silent clamp.
 */
export const MAX_TAX_BPS = 1000;
const MAX_TAX_DURATION = 100n * YEAR;
const MAX_ANTIFARMER_DURATION = YEAR;

export const LAUNCH_STYLES: Record<Exclude<LaunchStyle, "standard">, TaxShape> = {
  // The common case: trading tax funds the project, paid to the creator.
  marketing: {
    buyTaxRate: 300,
    sellTaxRate: 300,
    mktBps: 10000,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 0,
    taxDurationSec: YEAR,
    antiFarmerDurationSec: DAY,
  },
  // Tax is redistributed to holders, paid in the quote asset (native ETH here).
  dividend: {
    buyTaxRate: 300,
    sellTaxRate: 300,
    mktBps: 2000,
    deflationBps: 0,
    dividendBps: 8000,
    lpBps: 0,
    taxDurationSec: YEAR,
    antiFarmerDurationSec: DAY,
  },
  // Tax is burned, shrinking supply on every trade.
  deflationary: {
    buyTaxRate: 300,
    sellTaxRate: 300,
    mktBps: 2000,
    deflationBps: 8000,
    dividendBps: 0,
    lpBps: 0,
    taxDurationSec: YEAR,
    antiFarmerDurationSec: DAY,
  },
  // Tax deepens the pool, so the token gets easier to trade as it trades.
  liquidity: {
    buyTaxRate: 300,
    sellTaxRate: 300,
    mktBps: 2000,
    deflationBps: 0,
    dividendBps: 0,
    lpBps: 8000,
    taxDurationSec: YEAR,
    antiFarmerDurationSec: DAY,
  },
};

/** MAGIC_DIVIDEND_SELF — pay dividends in the launching token itself. */
export const DIVIDEND_SELF = "0xfEEDFEEDfeEDFEedFEEdFEEDFeEdfEEdFeEdFEEd" as const;

/**
 * Floor on dividend eligibility, required by the Portal whenever dividendBps > 0
 * — below it the launch reverts MinimumShareBalanceTooLow() (0x6b9099a1), which
 * is how we found it. Supply is fixed at 1e9 tokens for every launch on this protocol, so
 * 10k tokens is 0.001% of supply: a dust filter, not a real barrier.
 */
export const MIN_SHARE_BALANCE = 10_000n * 10n ** 18n;

/**
 * Reject a tax shape the Portal would reject, but with a message that says what
 * is wrong. Every rule here maps to a named custom error on the contract, and
 * hitting them on-chain costs the user gas to learn nothing.
 */
export function validateTaxShape(s: TaxShape): void {
  const sum = s.mktBps + s.deflationBps + s.dividendBps + s.lpBps;
  if (sum !== 10000) {
    throw new Error(`tax distribution must sum to exactly 10000 bps (mkt+deflation+dividend+lp), got ${sum} — Portal reverts InvalidTaxDistribution()`);
  }
  for (const [label, rate] of [["buyTaxRate", s.buyTaxRate], ["sellTaxRate", s.sellTaxRate]] as const) {
    if (rate < 0 || !Number.isInteger(rate)) throw new Error(`${label} must be a non-negative integer in basis points`);
    if (rate > MAX_TAX_BPS) throw new Error(`${label} ${rate}bps exceeds the ${MAX_TAX_BPS}bps (${MAX_TAX_BPS / 100}%) ceiling this tool will build`);
  }
  if (s.buyTaxRate === 0 && s.sellTaxRate === 0) {
    throw new Error("a tax token needs a non-zero buy or sell rate — use the 'standard' style for a plain ERC-20");
  }
  if (s.taxDurationSec <= 0n) throw new Error("taxDuration must be positive — Portal reverts TaxDurationTooShort()");
  if (s.taxDurationSec > MAX_TAX_DURATION) throw new Error("taxDuration exceeds the 100-year maximum — Portal reverts TaxDurationTooLong()");
  if (s.antiFarmerDurationSec > MAX_ANTIFARMER_DURATION) {
    throw new Error("antiFarmerDuration exceeds the 1-year maximum — Portal reverts AntiFarmerDurationTooLong()");
  }
}

export interface TaxLaunchRequest extends LaunchRequest {
  style: Exclude<LaunchStyle, "standard">;
  /** Per-launch overrides on top of the style's defaults. */
  overrides?: Partial<TaxShape>;
  /**
   * Who receives dividends, when the style pays them. Defaults to the quote
   * asset (native ETH), which is the common case and the one holders expect.
   * DIVIDEND_SELF pays in the launching token instead.
   */
  dividendToken?: Address;
  /** Minimum balance to qualify for dividends. */
  minimumShareBalance?: bigint;
}

/**
 * Build an UNSIGNED tax-token launch (tax-token V3 implementation) via newTokenV6.
 *
 * Tax tokens are the only path on this chain where commissionReceiver exists,
 * so this is also the only path that earns us anything — worth being honest
 * about, because it means our incentive and the user's are not automatically
 * aligned here. The tax rates are the user's to choose, capped, and never
 * raised on their behalf.
 */
export function buildTaxLaunch(req: TaxLaunchRequest, dep: LaunchpadDeployment = launchpadDeployment()): BuiltLaunch {
  const name = req.name.trim();
  const symbol = req.symbol.trim();
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1-${MAX_NAME} chars`);
  if (!symbol || symbol.length > MAX_SYMBOL) throw new Error(`symbol must be 1-${MAX_SYMBOL} chars`);
  if (req.quoteAmt < 0n) throw new Error("quoteAmt cannot be negative");
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.creator)) throw new Error("creator must be an address");

  const base = LAUNCH_STYLES[req.style];
  if (!base) throw new Error(`unknown launch style "${req.style}" — one of ${Object.keys(LAUNCH_STYLES).join(", ")}`);
  const shape: TaxShape = { ...base, ...req.overrides };
  validateTaxShape(shape);

  // Dividend-paying tokens need an eligibility floor; the Portal enforces it and
  // zero is not allowed. Default rather than demand it — an agent asking for a
  // dividend token should not have to know the protocol's dust threshold.
  const minShare = req.minimumShareBalance ?? (shape.dividendBps > 0 ? MIN_SHARE_BALANCE : 0n);
  if (shape.dividendBps > 0 && minShare < MIN_SHARE_BALANCE) {
    throw new Error(
      `minimumShareBalance must be at least ${MIN_SHARE_BALANCE / 10n ** 18n} tokens when dividends are on — Portal reverts MinimumShareBalanceTooLow()`,
    );
  }

  // Tax tokens carry the 7777 suffix and clone a different implementation, so
  // the salt must be mined against THAT impl or the address will never match.
  const mined = mineVanitySalt("7777", dep.tokenImplTaxedV3, dep.portal);

  const params = {
    name,
    symbol,
    meta: (req.meta ?? "").trim(),
    dexThresh: DexThresh.FOUR_FIFTHS,
    salt: mined.salt,
    migratorType: MigratorType.V2, // mandatory on Robinhood Chain
    quoteToken: ZERO,
    quoteAmt: req.quoteAmt,
    beneficiary: req.creator, // tax accrues to the creator, never to us
    permitData: "0x" as Hex,
    extensionID: ZERO_BYTES32,
    extensionData: "0x" as Hex,
    dexId: DEX_ID_ROBINHOOD, // the only enabled slot on this chain (probed)
    lpFeeProfile: V3LPFeeProfile.STANDARD,
    buyTaxRate: shape.buyTaxRate,
    sellTaxRate: shape.sellTaxRate,
    taxDuration: shape.taxDurationSec,
    antiFarmerDuration: shape.antiFarmerDurationSec,
    mktBps: shape.mktBps,
    deflationBps: shape.deflationBps,
    dividendBps: shape.dividendBps,
    lpBps: shape.lpBps,
    minimumShareBalance: minShare,
    dividendToken: req.dividendToken ?? ZERO, // zero => quote asset (native ETH)
    commissionReceiver: commissionReceiver(),
    tokenVersion: TokenVersion.TAXED_V3,
  } as const;

  return {
    to: dep.portal,
    data: encodeFunctionData({ abi: PORTAL_ABI, functionName: "newTokenV6", args: [params] }),
    value: req.quoteAmt,
    predictedToken: mined.address,
    salt: mined.salt,
    iterations: mined.iterations,
    chainId: dep.chainId,
  };
}

export interface SimulationResult {
  ok: boolean;
  /** The token address the Portal would actually create. */
  token?: Address;
  /** True when the prediction and the simulated result agree. */
  matchesPrediction?: boolean;
  error?: string;
  /** Set when the only thing wrong is the creator's balance, not the launch. */
  underfunded?: boolean;
  /** What the creator needs on hand, in wei, when underfunded. */
  requiredWei?: bigint;
}

/**
 * Prove a built launch would succeed before anyone signs it.
 *
 * The Portal implementation's source is unverified, so our encoding is derived
 * from docs rather than an audited ABI — this call is the only thing standing
 * between a subtly wrong struct and a failed transaction the user paid gas for.
 * Nothing may be broadcast that has not passed through here.
 *
 * Failure is deliberately split in two. A launch that reverts only because the
 * signer is short on ETH is a fundable problem, not a broken one, and telling
 * someone "your launch is invalid" when they simply need to top up would be a
 * lie. So on failure we re-run with an overridden balance: if it then passes,
 * the calldata is sound and the report says "underfunded" instead.
 */
export async function simulateLaunch(built: BuiltLaunch, creator: Address, dep: LaunchpadDeployment = launchpadDeployment()): Promise<SimulationResult> {
  const client = createPublicClient({ transport: http(dep.rpcUrl) });
  // Dispatch on whichever entry point the build chose — newTokenV5 for standard,
  // newTokenV6 for tax. Hardcoding one silently mis-simulates the other.
  const decoded = decodeFunctionData({ abi: PORTAL_ABI, data: built.data });

  const run = async (overrideBalance?: bigint) =>
    client.simulateContract({
      address: built.to,
      abi: PORTAL_ABI,
      functionName: decoded.functionName as "newTokenV5" | "newTokenV6",
      args: decoded.args as never,
      value: built.value,
      account: creator,
      ...(overrideBalance != null ? { stateOverride: [{ address: creator, balance: overrideBalance }] } : {}),
    });

  try {
    const { result } = await run();
    return {
      ok: true,
      token: result as Address,
      matchesPrediction: String(result).toLowerCase() === built.predictedToken.toLowerCase(),
    };
  } catch (err) {
    const message = describeRevert(err);
    // Distinguish "needs funding" from "genuinely invalid".
    try {
      const { result } = await run(built.value + parseEther("1"));
      return {
        ok: false,
        underfunded: true,
        requiredWei: built.value,
        token: result as Address,
        error: `the launch itself is valid, but ${creator} cannot cover it: ${message}`,
      };
    } catch {
      return { ok: false, error: message };
    }
  }
}

/** Turn a viem revert into something a person (or an agent) can act on. */
function describeRevert(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; cause?: { reason?: string; data?: { errorName?: string } } };
  const named = e?.cause?.data?.errorName ?? e?.cause?.reason;
  const base = e?.shortMessage ?? e?.message ?? String(err);
  // FeatureDisabled() is the one we already walked into: it means this chain
  // does not implement the entry point / token version being asked for.
  if (base.includes("0xac5f6092")) {
    return "Portal reverted FeatureDisabled() — this chain does not support that entry point or token version";
  }
  return named ? `${named}: ${base}` : base;
}
