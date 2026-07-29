// Token launching on Robinhood Chain through PONS, the second venue.
//
// Unlike the Flap portal in ./portal.ts, this factory's source IS verified and
// published on Blockscout, so every ABI shape below is read off that source
// rather than inferred from docs. That changes what simulation is FOR: on the
// portal it is the only proof the encoding is right at all, here it is proof
// that this creator, with this balance, at this block, would actually land the
// launch. Both paths still refuse to hand over a transaction that has not
// simulated clean.
//
// SIGNING: this module never signs and never holds funds. launchToken is
// payable and msg.value is launchFee plus the creator's own initial buy, so the
// transaction can only originate from their wallet, and the token's fee wallet
// and initial-buy recipient are the creator's to choose.
//
// A v2 factory is described in the PONS docs (a different launchToken signature
// carrying creator tax and buyback flags, plus a previewLaunchEconomics call).
// Its addresses are not published and its audits are still running, so nothing
// here targets it. When v2 ships it needs its own builder, not a version flag.
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionData,
  formatEther,
  formatUnits,
  parseEther,
  type Address,
  type Hex,
} from "viem";

/** The PONS deployment. Mainnet only: there is no testnet factory to fall back to. */
export interface PonsDeployment {
  chainId: number;
  rpcUrl: string;
  factory: Address;
  /**
   * Where every launch's Uniswap v3 position ends up. The factory transfers the
   * position NFT here and calls lockPosition, so nobody, including the creator,
   * can withdraw the liquidity afterwards.
   */
  locker: Address;
  explorer: string;
}

export const PONS_ROBINHOOD: PonsDeployment = {
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  factory: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB",
  locker: "0x736D76699C26D0d966744cAe304C000d471f7F35",
  explorer: "https://robinhoodchain.blockscout.com",
};

/**
 * Env overrides exist for one reason: PONS can redeploy the factory faster than
 * we can ship. The default is the verified live address, so an unset env is the
 * correct configuration, not a missing one.
 */
export function ponsDeployment(): PonsDeployment {
  const factory = process.env.PONS_FACTORY_ADDRESS;
  const locker = process.env.PONS_LOCKER_ADDRESS;
  const rpc = process.env.ROBINHOOD_RPC_URL;
  return {
    ...PONS_ROBINHOOD,
    ...(factory && /^0x[0-9a-fA-F]{40}$/.test(factory) ? { factory: factory as Address } : {}),
    ...(locker && /^0x[0-9a-fA-F]{40}$/.test(locker) ? { locker: locker as Address } : {}),
    ...(rpc ? { rpcUrl: rpc } : {}),
  };
}

/**
 * Pinned from the VERIFIED source of PonsLaunchFactory, not reconstructed from
 * documentation. The two LaunchConfig tail fields (reservedFee,
 * routerRequiresDeadline) are absent from the docs and present on chain, which
 * is exactly the kind of drift that makes a hand-written struct decode garbage.
 *
 * The custom errors are carried too, so a revert comes back as NotWhitelisted
 * or PoolAlreadyExists instead of a bare selector.
 */
const TOKEN_PARAMS = {
  name: "params",
  type: "tuple",
  components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "logo", type: "string" },
    { name: "description", type: "string" },
    {
      name: "socials",
      type: "tuple",
      components: [
        { name: "twitter", type: "string" },
        { name: "telegram", type: "string" },
        { name: "discord", type: "string" },
        { name: "website", type: "string" },
        { name: "farcaster", type: "string" },
      ],
    },
    { name: "feeWallet", type: "address" },
  ],
} as const;

/** Only what we read from the locker: its cut of every fee claim. */
export const PONS_LOCKER_ABI = [
  { type: "function", name: "protocolFeeShare", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

export const PONS_FACTORY_ABI = [
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      TOKEN_PARAMS,
      { name: "launchConfigId", type: "uint256" },
      { name: "dexId", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "predictTokenAddress",
    stateMutability: "view",
    inputs: [
      TOKEN_PARAMS,
      { name: "launchConfigId", type: "uint256" },
      { name: "dexId", type: "uint256" },
      { name: "salt", type: "bytes32" },
      { name: "tokenDeployer", type: "address" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "launchEnabled", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function",
    name: "whitelistedLaunchers",
    stateMutability: "view",
    inputs: [{ name: "launcher", type: "address" }],
    outputs: [{ name: "enabled", type: "bool" }],
  },
  { type: "function", name: "launchConfigCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "dexConfigCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "getLaunchConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "initialTick", type: "int24" },
          { name: "supply", type: "uint256" },
          { name: "maxWalletBps", type: "uint16" },
          { name: "maxTxBps", type: "uint16" },
          { name: "restrictionBlocks", type: "uint32" },
          { name: "reservedFee", type: "uint24" },
          { name: "enabled", type: "bool" },
          { name: "routerRequiresDeadline", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDexConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "factory", type: "address" },
          { name: "positionManager", type: "address" },
          { name: "swapRouter", type: "address" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
  },
  { type: "function", name: "locker", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "error", name: "NotWhitelisted", inputs: [] },
  { type: "error", name: "InvalidBasisPoints", inputs: [] },
  { type: "error", name: "InvalidMaxTxBasisPoints", inputs: [] },
  { type: "error", name: "InvalidDexConfig", inputs: [] },
  { type: "error", name: "TokenNotFound", inputs: [] },
  { type: "error", name: "PoolAlreadyExists", inputs: [] },
  { type: "error", name: "LaunchFeeNotPaid", inputs: [] },
  { type: "error", name: "InvalidTokenParams", inputs: [] },
  { type: "error", name: "LaunchConfigDisabled", inputs: [] },
  { type: "error", name: "InvalidLaunchConfigId", inputs: [] },
  { type: "error", name: "DexDisabled", inputs: [] },
  { type: "error", name: "InvalidDexId", inputs: [] },
  { type: "error", name: "TokenDeploymentFailed", inputs: [] },
  { type: "error", name: "RouterNotSet", inputs: [] },
  { type: "error", name: "SupplyTooLow", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "FeeTransferFailed", inputs: [] },
] as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** All five are optional to a caller and mandatory on the wire. */
export interface PonsSocials {
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
}

export interface PonsSocialsStruct {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

/**
 * The Socials struct has no optional members: a missing field is the empty
 * string, and passing undefined through to the encoder is an encoding error,
 * not an omission.
 */
export function normalizeSocials(s: PonsSocials = {}): PonsSocialsStruct {
  return {
    twitter: (s.twitter ?? "").trim(),
    telegram: (s.telegram ?? "").trim(),
    discord: (s.discord ?? "").trim(),
    website: (s.website ?? "").trim(),
    farcaster: (s.farcaster ?? "").trim(),
  };
}

export const MAX_NAME = 64;
export const MAX_SYMBOL = 16;

/** Trim and bound the two fields that end up in the token forever. */
export function validateTokenIdentity(rawName: string, rawSymbol: string): { name: string; symbol: string } {
  const name = (rawName ?? "").trim();
  const symbol = (rawSymbol ?? "").trim();
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1-${MAX_NAME} chars`);
  if (!symbol || symbol.length > MAX_SYMBOL) throw new Error(`symbol must be 1-${MAX_SYMBOL} chars`);
  return { name, symbol };
}

/**
 * PONS puts no vanity requirement on the deployed address, so unlike Flap's
 * 8888 / 7777 suffixes there is nothing to mine: any salt is as good as any
 * other and the build is instant. Deriving it from the creator, the identity
 * and a caller-supplied nonce keeps the address reproducible, so the same
 * request twice predicts the same token and a caller who wants a different one
 * bumps the nonce rather than hunting for randomness.
 */
export function ponsSalt(creator: Address, name: string, symbol: string, nonce = ""): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "string" }, { type: "string" }, { type: "string" }],
      [creator, name, symbol, nonce],
    ),
  );
}

export interface PonsLaunchConfig {
  pairToken: Address;
  graduationThreshold: bigint;
  initialTick: number;
  supply: bigint;
  maxWalletBps: number;
  maxTxBps: number;
  restrictionBlocks: number;
  reservedFee: number;
  enabled: boolean;
  routerRequiresDeadline: boolean;
}

export interface PonsDexConfig {
  name: string;
  factory: Address;
  positionManager: Address;
  swapRouter: Address;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}

export interface PonsLaunchRequest {
  name: string;
  symbol: string;
  /** Who signs and funds. Also the default fee wallet and initial-buy recipient. */
  creator: Address;
  logo?: string;
  description?: string;
  socials?: PonsSocials;
  /**
   * Receives the token's trading fees AND, because the factory uses this same
   * address as initialBuyRecipient, the creator's initial buy. Setting it to
   * someone else sends both away. Unset means the creator gets both.
   */
  feeWallet?: Address;
  /**
   * The creator's own first buy, in WEI, on top of the launch fee. Kept in wei
   * rather than an ETH float so nothing is ever rounded on the way to msg.value;
   * the tool layer does the parseEther.
   */
  initialBuyWei?: bigint;
  launchConfigId?: bigint;
  dexId?: bigint;
  /** Explicit salt. Omit to derive one; saltNonce varies the derived address. */
  salt?: Hex;
  saltNonce?: string;
}

export interface BuiltPonsLaunch {
  to: Address;
  data: Hex;
  value: bigint;
  predictedToken: Address;
  salt: Hex;
  chainId: number;
  launchFeeWei: bigint;
  initialBuyWei: bigint;
  launchConfigId: bigint;
  dexId: bigint;
  feeWallet: Address;
  /** Where the initial buy lands, resolved the way the factory resolves it. */
  initialBuyRecipient: Address;
  economics: PonsEconomics;
}

const clients = new Map<string, ReturnType<typeof createPublicClient>>();
function clientFor(dep: PonsDeployment) {
  let c = clients.get(dep.rpcUrl);
  if (!c) {
    c = createPublicClient({ transport: http(dep.rpcUrl) });
    clients.set(dep.rpcUrl, c);
  }
  return c;
}

/**
 * msg.value is launchFee plus the initial buy, and the factory keeps the fee
 * and swaps the REMAINDER. Overpaying is therefore not a rounding error, it is
 * a buy the creator did not ask for, and underpaying reverts LaunchFeeNotPaid.
 * The fee is a live owner-settable number, so it is always read, never assumed.
 */
export function ponsLaunchValue(launchFeeWei: bigint, initialBuyWei: bigint): bigint {
  if (launchFeeWei < 0n) throw new Error("launchFee cannot be negative");
  if (initialBuyWei < 0n) throw new Error("initialBuy cannot be negative");
  return launchFeeWei + initialBuyWei;
}

export interface PonsState {
  launchFee: bigint;
  launchEnabled: boolean;
  /** PONS's percentage cut of collected trading fees, read from the locker. */
  protocolFeeSharePct: number;
  launchConfigCount: bigint;
  dexConfigCount: bigint;
  locker: Address;
}

export async function ponsLaunchState(dep: PonsDeployment = ponsDeployment()): Promise<PonsState> {
  const client = clientFor(dep);
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: dep.factory, abi: PONS_FACTORY_ABI, functionName, args } as never) as Promise<T>;
  const [launchFee, launchEnabled, launchConfigCount, dexConfigCount, locker] = await Promise.all([
    read<bigint>("launchFee"),
    read<boolean>("launchEnabled"),
    read<bigint>("launchConfigCount"),
    read<bigint>("dexConfigCount"),
    read<Address>("locker"),
  ]);
  // The locker keeps a cut of every fee claim, and the creator sees only the
  // rest. Read live: it is an owner-settable number on a contract that is not
  // ours, so hardcoding today's value would eventually mislead a creator about
  // their own economics.
  let protocolFeeSharePct = 30;
  try {
    const share = await client.readContract({
      address: locker,
      abi: PONS_LOCKER_ABI,
      functionName: "protocolFeeShare",
    } as never) as bigint;
    protocolFeeSharePct = Number(share);
  } catch {
    // Fall back to the value observed on chain (30) rather than failing a
    // launch build over a description field.
  }
  return { launchFee, launchEnabled, launchConfigCount, dexConfigCount, locker, protocolFeeSharePct };
}

export interface PonsLaunchPermission {
  allowed: boolean;
  launchEnabled: boolean;
  whitelisted: boolean;
  reason?: string;
}

/**
 * The factory's rule is exactly: revert unless launchEnabled OR the sender is
 * whitelisted. Restating it here lets a refusal name the real cause instead of
 * making someone read a bare NotWhitelisted() out of a failed simulation.
 */
export async function ponsCanLaunch(launcher: Address, dep: PonsDeployment = ponsDeployment()): Promise<PonsLaunchPermission> {
  const client = clientFor(dep);
  const [launchEnabled, whitelisted] = (await Promise.all([
    client.readContract({ address: dep.factory, abi: PONS_FACTORY_ABI, functionName: "launchEnabled" } as never),
    client.readContract({ address: dep.factory, abi: PONS_FACTORY_ABI, functionName: "whitelistedLaunchers", args: [launcher] } as never),
  ])) as [boolean, boolean];
  const allowed = launchEnabled || whitelisted;
  return {
    allowed,
    launchEnabled,
    whitelisted,
    ...(allowed
      ? {}
      : {
          reason:
            `PONS launches are paused right now (launchEnabled is false) and ${launcher} is not on the launcher whitelist, ` +
            "so the factory would revert NotWhitelisted(). Either wait for launches to reopen or ask PONS to whitelist this wallet.",
        }),
  };
}

export async function ponsLaunchConfig(id: bigint, dep: PonsDeployment = ponsDeployment()): Promise<PonsLaunchConfig> {
  const client = clientFor(dep);
  return (await client.readContract({
    address: dep.factory,
    abi: PONS_FACTORY_ABI,
    functionName: "getLaunchConfig",
    args: [id],
  } as never)) as PonsLaunchConfig;
}

export async function ponsDexConfig(id: bigint, dep: PonsDeployment = ponsDeployment()): Promise<PonsDexConfig> {
  const client = clientFor(dep);
  return (await client.readContract({
    address: dep.factory,
    abi: PONS_FACTORY_ABI,
    functionName: "getDexConfig",
    args: [id],
  } as never)) as PonsDexConfig;
}

interface TokenParamsStruct {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: PonsSocialsStruct;
  feeWallet: Address;
}

/**
 * Ask the factory where the token will land. Done on chain rather than
 * recomputed locally: the factory hashes the params into the CREATE2 salt in a
 * way only its own source defines, so a local guess that drifts would quietly
 * publish the wrong address to the user before they sign.
 */
export async function predictPonsToken(
  params: TokenParamsStruct,
  launchConfigId: bigint,
  dexId: bigint,
  salt: Hex,
  tokenDeployer: Address,
  dep: PonsDeployment = ponsDeployment(),
): Promise<Address> {
  const client = clientFor(dep);
  return (await client.readContract({
    address: dep.factory,
    abi: PONS_FACTORY_ABI,
    functionName: "predictTokenAddress",
    args: [params, launchConfigId, dexId, salt, tokenDeployer],
  } as never)) as Address;
}

/**
 * Build an UNSIGNED PONS launch. Async because two of its inputs are live
 * chain state (the launch fee, and the address the factory itself predicts) and
 * guessing either would hand the user a transaction that reverts or a token
 * address that is not theirs.
 */
export async function buildPonsLaunch(req: PonsLaunchRequest, dep: PonsDeployment = ponsDeployment()): Promise<BuiltPonsLaunch> {
  const { name, symbol } = validateTokenIdentity(req.name, req.symbol);
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.creator ?? "")) throw new Error("creator must be an address");
  if (req.feeWallet && !/^0x[0-9a-fA-F]{40}$/.test(req.feeWallet)) throw new Error("feeWallet must be an address");
  const initialBuyWei = req.initialBuyWei ?? 0n;
  if (initialBuyWei < 0n) throw new Error("initialBuy cannot be negative");

  const launchConfigId = req.launchConfigId ?? 0n;
  const dexId = req.dexId ?? 0n;
  const feeWallet = (req.feeWallet ?? ZERO_ADDRESS) as Address;
  const salt = req.salt ?? ponsSalt(req.creator, name, symbol, req.saltNonce ?? "");

  const params: TokenParamsStruct = {
    name,
    symbol,
    logo: (req.logo ?? "").trim(),
    description: (req.description ?? "").trim(),
    socials: normalizeSocials(req.socials),
    feeWallet,
  };

  const [state, config, dex, predictedToken] = await Promise.all([
    ponsLaunchState(dep),
    ponsLaunchConfig(launchConfigId, dep),
    ponsDexConfig(dexId, dep),
    predictPonsToken(params, launchConfigId, dexId, salt, req.creator, dep),
  ]);

  // Disabled config or dex reverts on chain. Failing here names which one.
  if (!config.enabled) throw new Error(`PONS launch config ${launchConfigId} is disabled on chain`);
  if (!dex.enabled) throw new Error(`PONS dex config ${dexId} ("${dex.name}") is disabled on chain`);

  return {
    to: dep.factory,
    data: encodeFunctionData({ abi: PONS_FACTORY_ABI, functionName: "launchToken", args: [params, launchConfigId, dexId, salt] }),
    value: ponsLaunchValue(state.launchFee, initialBuyWei),
    predictedToken,
    salt,
    chainId: dep.chainId,
    launchFeeWei: state.launchFee,
    initialBuyWei,
    launchConfigId,
    dexId,
    feeWallet,
    initialBuyRecipient: initialBuyRecipient(req.creator, feeWallet),
    economics: describePonsEconomics({
      symbol,
      creator: req.creator,
      feeWallet,
      initialBuyWei,
      launchFeeWei: state.launchFee,
      config,
      dex,
      locker: state.locker,
      protocolFeeSharePct: state.protocolFeeSharePct,
    }),
  };
}

/**
 * The factory's own rule: initialBuyRecipient = feeWallet == 0 ? msg.sender :
 * feeWallet. One field doing two jobs is the footgun of this launchpad, so it
 * is resolved in one place and surfaced everywhere the user can see it.
 */
export function initialBuyRecipient(creator: Address, feeWallet: Address = ZERO_ADDRESS): Address {
  return feeWallet && feeWallet !== ZERO_ADDRESS ? feeWallet : creator;
}

export interface PonsEconomics {
  venue: "pons";
  supply: string;
  liquidity: string;
  liquidityLockedIn: Address;
  /** The anti-sniper window, stated as a window and not as a permanent limit. */
  launchWindow: string;
  poolFee: string;
  pairedAgainst: string;
  pairToken: Address;
  launchFee: string;
  initialBuy: string;
  initialBuyGoesTo: Address;
  initialBuyNote: string;
  /** Who really receives trading fees, after the locker's cut, and how. */
  tradingFees: string;
}

const bpsPct = (bps: number) => `${bps / 100}%`;

/**
 * What the user is actually agreeing to, in words, from the config that was
 * read off the chain for THIS launch rather than from a snapshot that can go
 * stale. Pure, so the wording is testable without a network.
 *
 * Token decimals are 18, which is what makes the config's 1e27 supply read as
 * one billion tokens.
 */
export function describePonsEconomics(args: {
  symbol: string;
  creator: Address;
  feeWallet?: Address;
  initialBuyWei: bigint;
  launchFeeWei: bigint;
  config: PonsLaunchConfig;
  dex: PonsDexConfig;
  locker: Address;
  /** PONS's cut of collected trading fees, read live from the locker. */
  protocolFeeSharePct: number;
}): PonsEconomics {
  const { config, dex } = args;
  const feeWallet = (args.feeWallet ?? ZERO_ADDRESS) as Address;
  const recipient = initialBuyRecipient(args.creator, feeWallet);
  const buyingSomething = args.initialBuyWei > 0n;
  const supplyTokens = formatUnits(config.supply, 18);

  return {
    venue: "pons",
    supply: `${supplyTokens} ${args.symbol}, fixed at launch, nothing minted afterwards`,
    liquidity:
      `The entire supply goes into a single ${dex.name} position, which the factory transfers to the PONS locker and locks ` +
      "permanently. Nobody can pull the liquidity, including the creator and including us.",
    liquidityLockedIn: args.locker,
    // The limits are an anti-sniper window, NOT permanent token properties, and
    // saying otherwise would sell a safety feature the token does not have.
    // PonsLauncherToken._update gates the whole limit block on
    // `block.number <= restrictionEndBlock` AND on the transfer coming FROM the
    // pair pool, so it is buys only, for restrictionBlocks blocks, and then the
    // token trades with no limits at all.
    launchWindow:
      `For the first ${config.restrictionBlocks} block(s) after launch, buys from the pool are capped at ` +
      `${bpsPct(config.maxWalletBps)} of supply per wallet and ${bpsPct(config.maxTxBps)} of supply cumulatively per buyer, ` +
      "and buying in the launch block itself is blocked entirely. After that window the token trades with no limits: " +
      "no maximum wallet, no maximum transaction. Treat this as anti-sniper protection at launch, not as an ongoing restriction.",
    poolFee: `${dex.poolFee / 10_000}% of every trade goes to the pool as the swap fee`,
    pairedAgainst: `paired against ${config.pairToken} on ${dex.name}`,
    pairToken: config.pairToken,
    launchFee: `${formatEther(args.launchFeeWei)} ETH launch fee, paid to PONS`,
    initialBuy: buyingSomething ? `${formatEther(args.initialBuyWei)} ETH is swapped for tokens at launch` : "none",
    initialBuyGoesTo: recipient,
    initialBuyNote: buyingSomething
      ? feeWallet === ZERO_ADDRESS
        ? `Those tokens go to the creator wallet ${recipient}, because no separate fee wallet was set.`
        : `Those tokens go to the fee wallet ${recipient}, NOT to the creator wallet ${args.creator}, because the factory sends the initial buy to the fee wallet.`
      : "No initial buy, so no tokens are received at launch.",
    // Read from the locker's verified source and its live state rather than
    // assumed: collectFees sends protocolFeeShare percent of everything
    // collected to PONS and only the remainder onward, and it has to be called
    // by hand. "Fees accrue to you" would be wrong twice over.
    tradingFees:
      `The pool's ${dex.poolFee / 10_000}% swap fee collects into the locked position. PONS keeps ` +
      `${args.protocolFeeSharePct}% of whatever is collected; the remaining ${100 - args.protocolFeeSharePct}% goes to ` +
      `${feeWallet === ZERO_ADDRESS ? `the creator wallet ${args.creator}` : feeWallet}. ` +
      "Fees are not streamed automatically: someone has to call collectFees on the locker to claim them.",
  };
}

export interface PonsSimulationResult {
  ok: boolean;
  /** The token address the factory would actually create. */
  token?: Address;
  matchesPrediction?: boolean;
  error?: string;
  /** Set when the only thing wrong is the creator's balance, not the launch. */
  underfunded?: boolean;
  requiredWei?: bigint;
}

/**
 * Prove the launch would land before anyone signs it.
 *
 * Failure is split in two, same as the portal path: a launch that reverts only
 * because the signer is short on ETH is a fundable problem, not a broken one.
 * So on failure we re-run with an overridden balance, and if it then passes the
 * report says underfunded instead of calling the user's launch invalid.
 */
export async function simulatePonsLaunch(
  built: BuiltPonsLaunch,
  creator: Address,
  dep: PonsDeployment = ponsDeployment(),
): Promise<PonsSimulationResult> {
  const client = clientFor(dep);
  // Simulate the BUILT calldata, decoded back out, rather than re-encoding from
  // the request: that way what is proven is the exact bytes the user will sign.
  const decoded = decodeFunctionData({ abi: PONS_FACTORY_ABI, data: built.data });
  const run = async (overrideBalance?: bigint) =>
    client.simulateContract({
      address: built.to,
      abi: PONS_FACTORY_ABI,
      functionName: "launchToken",
      args: decoded.args as never,
      value: built.value,
      account: creator,
      ...(overrideBalance != null ? { stateOverride: [{ address: creator, balance: overrideBalance }] } : {}),
    });

  try {
    const { result } = (await run()) as { result: Address };
    return {
      ok: true,
      token: result,
      matchesPrediction: String(result).toLowerCase() === built.predictedToken.toLowerCase(),
    };
  } catch (err) {
    const message = describeRevert(err);
    try {
      const { result } = (await run(built.value + parseEther("1"))) as { result: Address };
      return {
        ok: false,
        underfunded: true,
        requiredWei: built.value,
        token: result,
        // Still worth reporting: it says the calldata and the address we showed
        // the user are right, and only the balance is missing.
        matchesPrediction: String(result).toLowerCase() === built.predictedToken.toLowerCase(),
        error: `the launch itself is valid, but ${creator} cannot cover it: ${message}`,
      };
    } catch (retryErr) {
      // The retry is the better diagnosis precisely because funding was no
      // longer the problem. Reporting the first error here would send a creator
      // off to top up a wallet and hit the exact same wall again.
      const retryMessage = describeRevert(retryErr);
      return {
        ok: false,
        error: retryMessage === message ? message : `${retryMessage} (funding the wallet does not fix this)`,
      };
    }
  }
}

/** Turn a viem revert into something a person (or an agent) can act on. */
function describeRevert(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; cause?: { reason?: string; data?: { errorName?: string } } };
  const named = e?.cause?.data?.errorName ?? e?.cause?.reason;
  const base = e?.shortMessage ?? e?.message ?? String(err);
  if (named === "NotWhitelisted") {
    return "PONS reverted NotWhitelisted(): launches are paused and this wallet is not on the whitelist";
  }
  if (named === "PoolAlreadyExists") {
    return "PONS reverted PoolAlreadyExists(): a pool for this exact token already exists, change the name, symbol or salt nonce";
  }
  if (named === "LaunchFeeNotPaid") {
    return "PONS reverted LaunchFeeNotPaid(): msg.value is below the current launch fee, which moved between build and send";
  }
  return named ? `${named}: ${base}` : base;
}
