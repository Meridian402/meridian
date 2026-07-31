// Non-custodial trading vaults. Each user gets a Safe they solely own, plus a
// Zodiac Roles module scoping THIS backend's per-user session key to the swap
// router only, proven on-chain in the Phase 0 spike. The backend never holds
// the user's owner key.
//
// NOT YET SAFE TO ENABLE, and this paragraph used to claim otherwise. It said
// the session key "executes trades that provably cannot withdraw". That is not
// true today. The Roles scoping constrains the TARGET and the SELECTOR, so the
// key can only call UniversalRouter.execute, but nothing constrains its
// PARAMETERS. A swap command carries its own output recipient, so a key that
// can call execute freely can swap the vault's balance and send the proceeds
// anywhere. executeForUser passes `trade.data` through as an opaque blob and
// checks only the target, and its amountUsd cap is a number the CALLER supplies
// rather than one read from the calldata, so it bounds an honest caller and
// nothing else.
//
// The gap was always known and noted below as an "audit-phase refinement". The
// problem was that the summary up here stated the strong claim unhedged, which
// is how someone (me, a week from now) turns custody on believing it is done.
// What it needs before CUSTODY_SESSION_MASTER is ever set: parameter scoping on
// the Roles module that pins the swap recipient to the Safe itself, and an
// amount derived from the calldata rather than asserted alongside it.
//
// Two kinds of action:
//   - OWNER actions (deploy, enable, scope, approve, revoke): built here as
//     calldata the USER signs from their wallet (advise-then-approve, same
//     pattern as the earn surface). The backend can move nothing.
//   - SESSION actions (execute a trade): signed here with the derived session
//     key, gated by risk caps. This is the only thing the backend can trigger.
import {
  createWalletClient, http, encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbiItem,
  getAddress, keccak256, encodePacked, stringToHex, type Address, type Hex,
} from "viem";
import { getPublicClient, robinhoodChain } from "../venues/signer.js";
import { sessionAccountFor, sessionAddressFor, custodyEnabled } from "./session.js";
import { guardWalletOp, recordWalletOp } from "../risk.js";

// ---- confirmed-live contracts on Robinhood Chain (see _sessionkey-spike.mjs) --
const SAFE_SINGLETON = getAddress("0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552"); // Safe 1.3.0
const SAFE_FACTORY = getAddress("0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2");   // SafeProxyFactory 1.3.0
const SAFE_FALLBACK = getAddress("0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4");  // CompatibilityFallbackHandler 1.3.0
const MODULE_FACTORY = getAddress("0x000000000000aDdB49795b0f9bA5BC298cDda236"); // Zodiac Module Proxy Factory
const ROLES_MASTERCOPY = getAddress("0x9646fDAD06d3e24444381f44362a3B0eB343D337"); // Roles 2.1.0
const UNIVERSAL_ROUTER = getAddress("0x8876789976dEcBfCbBbe364623C63652db8C0904"); // stock swaps
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const SENTINEL: Address = "0x0000000000000000000000000000000000000001";
const MAX256 = (1n << 256n) - 1n, MAX160 = (1n << 160n) - 1n;

// Scope: the session key may call ONLY UniversalRouter.execute — tighter than
// the spike's allowTarget. (Parameter constraints that also pin the swap output
// recipient to the Safe are the audit-phase refinement; noted in the plan.)
const ROLE_KEY = stringToHex("mrd-trade", { size: 32 });
const EXECUTE_SELECTOR: Hex = "0x3593564c"; // UniversalRouter.execute(bytes,bytes[],uint256)
const OPT_SEND = 1; // ExecutionOptions.Send

const MAX_PER_TRADE_USD = Number(process.env.CUSTODY_MAX_PER_TRADE_USD ?? 100);

// ---- ABIs ----
const factoryAbi = [parseAbiItem("function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)")];
const mpfAbi = [parseAbiItem("function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address)")];
const setUpAbi = [parseAbiItem("function setUp(bytes initParams)")];
const safeAbi = [
  parseAbiItem("function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)"),
  parseAbiItem("function enableModule(address module)"),
  parseAbiItem("function disableModule(address prevModule, address module)"),
  parseAbiItem("function isModuleEnabled(address module) view returns (bool)"),
  parseAbiItem("function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)"),
];
const rolesAbi = [
  parseAbiItem("function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)"),
  parseAbiItem("function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)"),
  parseAbiItem("function scopeTarget(bytes32 roleKey, address targetAddress)"),
  parseAbiItem("function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)"),
  parseAbiItem("function owner() view returns (address)"),
];
const erc20Abi = [parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"), parseAbiItem("function balanceOf(address) view returns (uint256)")];
const permit2Abi = [parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)")];

// ---- deterministic per-user salts, so addresses are known before deploy ----
const salt = (user: Address, tag: string) => BigInt(keccak256(encodePacked(["address", "string"], [user, tag])));

function safeInitializer(owner: Address): Hex {
  return encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [[owner], 1n, ZERO, "0x", SAFE_FALLBACK, ZERO, 0n, ZERO] });
}
function rolesInitializer(owner: Address, safe: Address): Hex {
  const initParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [owner, safe, safe]);
  return encodeFunctionData({ abi: setUpAbi, functionName: "setUp", args: [initParams] });
}

/** The Safe address a user's vault WILL have (CREATE2-deterministic), predicted via eth_call. */
export async function predictVault(userAddress: string): Promise<Address> {
  const owner = getAddress(userAddress);
  const { result } = await getPublicClient().simulateContract({
    account: owner, address: SAFE_FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce",
    args: [SAFE_SINGLETON, safeInitializer(owner), salt(owner, "meridian.vault.v1")],
  });
  return getAddress(result as Address);
}

/** The Roles-module address for a user's vault, predicted the same way. */
export async function predictRoles(userAddress: string, safe: Address): Promise<Address> {
  const owner = getAddress(userAddress);
  const { result } = await getPublicClient().simulateContract({
    account: owner, address: MODULE_FACTORY, abi: mpfAbi, functionName: "deployModule",
    args: [ROLES_MASTERCOPY, rolesInitializer(owner, safe), salt(owner, "meridian.roles.v1")],
  });
  return getAddress(result as Address);
}

export interface VaultStatus {
  enabled: boolean;          // is custody configured on this backend at all?
  owner: string;
  vault: Address;            // the Safe (deployed or predicted)
  rolesModule: Address;
  sessionKey: Address;       // this backend's scoped key for the user
  deployed: boolean;         // is the Safe on-chain yet?
  active: boolean;           // deployed + module enabled (ready to auto-trade)
  usdg: number;
  eth: number;
  maxPerTradeUsd: number;
}

/** Full on-chain picture of a user's vault, for the status endpoint + the UI. */
export async function vaultStatus(userAddress: string): Promise<VaultStatus> {
  const owner = getAddress(userAddress);
  const client = getPublicClient();
  const vault = await predictVault(owner);
  const rolesModule = await predictRoles(owner, vault);
  const sessionKey = sessionAddressFor(owner);

  const code = await client.getCode({ address: vault });
  const deployed = !!code && code !== "0x";
  let active = false, usdg = 0, eth = 0;
  if (deployed) {
    const [enabledOnChain, usdgRaw, ethRaw] = await Promise.all([
      client.readContract({ address: vault, abi: safeAbi, functionName: "isModuleEnabled", args: [rolesModule] }).catch(() => false),
      client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [vault] }).catch(() => 0n),
      client.getBalance({ address: vault }).catch(() => 0n),
    ]);
    active = !!enabledOnChain;
    usdg = Number(usdgRaw) / 1e6;
    eth = Number(ethRaw) / 1e18;
  }
  return { enabled: custodyEnabled(), owner, vault, rolesModule, sessionKey, deployed, active, usdg, eth, maxPerTradeUsd: MAX_PER_TRADE_USD };
}

// ---- owner-signed setup steps (the user signs each from their wallet) --------
export interface PreparedStep { kind: string; description: string; to: Address; data: Hex; value: string; }

/** Wrap an inner call as a Safe execTransaction with the owner's pre-validated
 *  signature — valid because the owner is the one sending the tx (msg.sender). */
function safeExecStep(kind: string, description: string, safe: Address, owner: Address, to: Address, data: Hex): PreparedStep {
  const sig = ("0x" + "000000000000000000000000" + owner.slice(2).toLowerCase() + "0".repeat(64) + "01") as Hex;
  const outer = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
  return { kind, description, to: safe, data: outer, value: "0" };
}

/**
 * Ordered transactions the USER signs to stand up their vault. The backend
 * signs none of these. (Collapsing these into 1–2 signatures via a MultiSend
 * batch is the UX refinement before Phase 2 ships; the calldata is correct
 * either way.)
 */
export async function buildVaultSetup(userAddress: string): Promise<Record<string, unknown>> {
  if (!custodyEnabled()) throw new Error("custody_disabled");
  const owner = getAddress(userAddress);
  const vault = await predictVault(owner);
  const roles = await predictRoles(owner, vault);
  const sessionKey = sessionAddressFor(owner);
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;

  const steps: PreparedStep[] = [
    { kind: "deploy-safe", description: "Create your vault (you are its only owner)", to: SAFE_FACTORY,
      data: encodeFunctionData({ abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON, safeInitializer(owner), salt(owner, "meridian.vault.v1")] }), value: "0" },
    { kind: "deploy-roles", description: "Attach the trade-only permission module", to: MODULE_FACTORY,
      data: encodeFunctionData({ abi: mpfAbi, functionName: "deployModule", args: [ROLES_MASTERCOPY, rolesInitializer(owner, vault), salt(owner, "meridian.roles.v1")] }), value: "0" },
    safeExecStep("enable-module", "Enable the module on your vault", vault, owner, vault, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [roles] })),
    { kind: "assign-role", description: "Grant your agent the trade-only role", to: roles,
      data: encodeFunctionData({ abi: rolesAbi, functionName: "assignRoles", args: [sessionKey, [ROLE_KEY], [true]] }), value: "0" },
    { kind: "scope-target", description: "Restrict the role to the swap router", to: roles,
      data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeTarget", args: [ROLE_KEY, UNIVERSAL_ROUTER] }), value: "0" },
    { kind: "scope-function", description: "Restrict it to the swap function only", to: roles,
      data: encodeFunctionData({ abi: rolesAbi, functionName: "allowFunction", args: [ROLE_KEY, UNIVERSAL_ROUTER, EXECUTE_SELECTOR, OPT_SEND] }), value: "0" },
    safeExecStep("approve-usdg", "Let the vault trade its USDG", vault, owner, USDG, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, MAX256] })),
    safeExecStep("approve-router", "Authorize the swap router (via Permit2)", vault, owner, PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [USDG, UNIVERSAL_ROUTER, MAX160, exp] })),
  ];

  return { ok: true, chainId: 4663, owner, vault, rolesModule: roles, sessionKey, steps,
    note: "You sign each step from your own wallet. The vault is yours; your agent only ever gets a trade-only key that cannot withdraw." };
}

/** Calldata the user signs to revoke: disables the module, killing the session key. */
export async function buildVaultRevoke(userAddress: string): Promise<Record<string, unknown>> {
  const owner = getAddress(userAddress);
  const vault = await predictVault(owner);
  const roles = await predictRoles(owner, vault);
  const step = safeExecStep("revoke", "Turn off auto-trading (disable the module)", vault, owner, vault,
    encodeFunctionData({ abi: safeAbi, functionName: "disableModule", args: [SENTINEL, roles] }));
  return { ok: true, chainId: 4663, owner, vault, steps: [step], note: "One signature turns your agent off. Your funds stay in your vault." };
}

// ---- session-signed execution (the ONLY thing the backend can trigger) -------
/**
 * Execute a prepared trade for a user through their Roles module, signed with
 * the derived session key. Gated by the global circuit breaker + a per-trade
 * USD cap. The session key can reach only the router, so a bad `to`/`data`
 * can't move funds out — but we still fail closed on anything unexpected.
 */
export async function executeForUser(userAddress: string, trade: { to: Address; value: bigint; data: Hex; amountUsd: number }): Promise<{ hash: Hex } | { error: string }> {
  if (!custodyEnabled()) return { error: "custody_disabled" };
  const owner = getAddress(userAddress);
  if (trade.amountUsd > MAX_PER_TRADE_USD) return { error: `trade $${trade.amountUsd} exceeds the $${MAX_PER_TRADE_USD} per-trade cap` };
  if (getAddress(trade.to) !== UNIVERSAL_ROUTER) return { error: "trade target is not the scoped router" };

  const status = await vaultStatus(owner);
  if (!status.active) return { error: "vault not active (deploy + enable first)" };

  guardWalletOp(`custody trade ${owner} $${trade.amountUsd.toFixed(2)}`);

  const session = sessionAccountFor(owner);
  const wallet = createWalletClient({ account: session, chain: robinhoodChain, transport: http() }); // session-key signer
  const client = getPublicClient();
  const roles = status.rolesModule;

  const hash = await wallet.writeContract({
    address: roles, abi: rolesAbi, functionName: "execTransactionWithRole",
    args: [trade.to, trade.value, trade.data, 0, ROLE_KEY, true],
  });
  const rcpt = await client.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") return { error: `trade reverted: ${hash}` };
  recordWalletOp(trade.amountUsd, "custody-trade");
  return { hash };
}
