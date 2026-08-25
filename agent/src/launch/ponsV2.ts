// The PONS v2 rails, as Meridian's router sees them. Addresses and ABIs are
// copied from the VERIFIED factory source on Blockscout (fetched 2026-08-26),
// never guessed from docs. Everything here is pure or read-only: the router
// builds unsigned transactions the TEAM signs. Meridian never launches on
// anyone's behalf and never holds a key in this flow.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

export const PONS_V2 = {
  chainId: 4663,
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as Address,
} as const;

/** USDG on Robinhood Chain: the pair token for routed launches, verified as an
 *  approved pair token on-chain 2026-08-26. Graduated pools land in the same
 *  USDG shape the engine already trades. */
export const USDG_PAIR: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const factoryAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function canLaunch(address launcher) view returns (bool)",
  "function approvedPairTokens(address pairToken) view returns (bool approved)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);

export const splitterFactoryAbi = parseAbi([
  "function create(address team, bytes32 salt) returns (address splitter)",
  "function predict(address team, bytes32 salt) view returns (address)",
]);

export const splitterAbi = parseAbi([
  "function team() view returns (address)",
  "function treasury() view returns (address)",
  "function ROUTER_BPS() view returns (uint16)",
]);

export interface LaunchSocials {
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
}

export interface LaunchInput {
  name: string;
  symbol: string;
  description: string;
  logo?: string;
  socials?: LaunchSocials;
  creatorTaxBps?: number;
  buybackEnabled?: boolean;
}

const URLISH = /^https?:\/\/\S{1,240}$/;

/** The validated, fully-populated shape the builders consume: every social is
 *  a concrete string because the ABI tuple requires all five fields. */
export interface CleanLaunchInput {
  name: string;
  symbol: string;
  description: string;
  logo: string;
  socials: Required<LaunchSocials>;
  creatorTaxBps: number;
  buybackEnabled: boolean;
}

/** PURE: validate and normalize a team's configure form. Mirrors the on-chain
 *  cap on creator tax (10%); the route re-checks the live cap before building.
 *  Errors are written to be shown to the team as-is. */
export function validateLaunchInput(input: LaunchInput): { ok: true; clean: CleanLaunchInput } | { ok: false; error: string } {
  const name = (input.name ?? "").trim();
  const symbol = (input.symbol ?? "").trim().toUpperCase();
  const description = (input.description ?? "").trim();
  const logo = (input.logo ?? "").trim();
  if (name.length < 1 || name.length > 48) return { ok: false, error: "name must be 1 to 48 characters" };
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return { ok: false, error: "symbol must be 1 to 12 letters or digits" };
  if (description.length < 1 || description.length > 500) return { ok: false, error: "description must be 1 to 500 characters" };
  if (logo && !URLISH.test(logo)) return { ok: false, error: "logo must be an http(s) URL" };
  const socials: Required<LaunchSocials> = { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
  for (const k of Object.keys(socials) as (keyof LaunchSocials)[]) {
    const v = (input.socials?.[k] ?? "").trim();
    if (v && v.length > 200) return { ok: false, error: `${k} link is too long` };
    socials[k] = v;
  }
  const tax = input.creatorTaxBps ?? 0;
  if (!Number.isInteger(tax) || tax < 0 || tax > 1000) return { ok: false, error: "creator tax must be 0 to 1000 bps (10% max)" };
  return {
    ok: true,
    clean: { name, symbol, description, logo, socials, creatorTaxBps: tax, buybackEnabled: input.buybackEnabled === true },
  };
}

/**
 * PURE: the unsigned launchToken transaction the team signs. The splitter is
 * the creatorFeeRecipient, which is the whole router-share mechanism; the team
 * and the splitter ride the snipe-tax exemption list (the factory auto-exempts
 * them anyway, listing them is explicit belt-and-braces). expectedEconomics is
 * read live from previewLaunchEconomics by the route and pinned here so the
 * launch reverts rather than executing under changed economics.
 */
export function buildLaunchTokenTx(args: {
  clean: CleanLaunchInput;
  team: Address;
  splitter: Address;
  launchFeeWei: bigint;
  expectedEconomics: Hex;
  salt: Hex;
  launchConfigId?: bigint;
  pairToken?: Address;
}): { to: Address; data: Hex; value: bigint } {
  const { clean, team, splitter } = args;
  return {
    to: PONS_V2.factory,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: "launchToken",
      args: [
        {
          name: clean.name,
          symbol: clean.symbol,
          logo: clean.logo,
          description: clean.description,
          socials: clean.socials,
          creatorFeeRecipient: splitter,
          creatorTaxBps: clean.creatorTaxBps,
          buybackEnabled: clean.buybackEnabled,
          expectedEconomics: args.expectedEconomics,
          salt: args.salt,
        },
        args.launchConfigId ?? 0n,
        args.pairToken ?? USDG_PAIR,
        [team, splitter],
      ],
    }),
    value: args.launchFeeWei,
  };
}

/** PURE: has this launch graduated? sweptAt is stamped when the curve's
 *  collected quote is swept to build the locked pool, which only happens at
 *  graduation. Unambiguous, unlike interpreting the phase enum. */
export function isGraduated(launched: { sweptAt: bigint; exists: boolean }): boolean {
  return launched.exists && launched.sweptAt > 0n;
}
