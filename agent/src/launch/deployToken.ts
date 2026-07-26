// Deploying MERD — deterministically, and with the mistakes that matter made
// impossible rather than merely unlikely.
//
// The agent signs this. That is fine for the deployment itself (the token has
// no owner, so signing it grants no lasting power) but it makes one failure
// mode very easy to reach by accident: the whole supply going to whatever
// address happened to sign. `treasury` is therefore a required argument with no
// default, and sending the supply to the deployer is refused outright.
//
// CREATE2 rather than a plain deploy so the address is known BEFORE anything is
// broadcast. That means the address can be checked, recorded and even published
// ahead of time, and a re-run cannot quietly produce a second MERD at a
// different address — the second attempt reverts because the address is taken.
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

export interface TokenDeployment {
  name: string;
  symbol: string;
  /** Whole tokens, not wei. 18 decimals are applied here. */
  supply: bigint;
  /** Receives the entire supply. Must not be the deploying key. */
  treasury: Address;
  /** Anything unique; the same salt with the same args yields the same address. */
  salt?: Hex;
}

const ARTIFACT = fileURLToPath(new URL("../../../contracts/out/MeridianToken.sol/MeridianToken.json", import.meta.url));

const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

function creationBytecode(): Hex {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex | undefined;
  if (!bytecode || !bytecode.startsWith("0x") || bytecode.length < 10) {
    throw new Error("MeridianToken artifact missing or empty — run `forge build` first");
  }
  return bytecode;
}

/** Constructor args are part of the address: change one and the address moves. */
export function tokenInitCode(d: TokenDeployment): Hex {
  const args = encodeAbiParameters(parseAbiParameters("string, string, uint256, address"), [
    d.name,
    d.symbol,
    d.supply * 10n ** 18n,
    d.treasury,
  ]);
  return concat([creationBytecode(), args]);
}

/** Where this exact deployment will land, computable before broadcasting. */
export function predictTokenAddress(d: TokenDeployment): Address {
  const salt = d.salt ?? keccak256(toHex(`meridian:${d.symbol}`));
  return create2Address(CREATE2_DEPLOYER, salt, keccak256(tokenInitCode(d)));
}

export interface DeployResult {
  address: Address;
  txHash: Hex;
  predicted: Address;
  verified: { name: string; symbol: string; decimals: number; totalSupply: bigint; treasuryBalance: bigint };
}

/**
 * Deploy MERD and prove afterwards that the chain says what we intended.
 *
 * Refusing to deploy is the cheap outcome here; a token deployed with a typo in
 * its symbol or its supply in the wrong account is permanent and public, so
 * every check below runs before the transaction and the read-back runs after.
 */
export async function deployToken(
  d: TokenDeployment,
  opts: { rpcUrl: string; privateKey: Hex; chainId: number; dryRun?: boolean },
): Promise<DeployResult> {
  if (!d.name.trim() || d.name !== d.name.trim()) throw new Error("name has leading or trailing whitespace");
  if (!d.symbol.trim() || d.symbol !== d.symbol.trim()) throw new Error("symbol has leading or trailing whitespace");
  if (!/^[A-Za-z0-9 .'-]+$/.test(d.name)) throw new Error(`name contains unexpected characters: ${JSON.stringify(d.name)}`);
  if (!/^[A-Z0-9]{2,11}$/.test(d.symbol)) throw new Error(`symbol must be 2-11 uppercase alphanumerics, got ${JSON.stringify(d.symbol)}`);
  if (d.supply <= 0n) throw new Error("supply must be positive");
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.treasury)) throw new Error("treasury must be an address");

  const account = privateKeyToAccount(opts.privateKey);
  // The mistake this exists to prevent: the signing key is hot, rotates, and
  // has no business holding the entire supply. If the treasury is the deployer
  // it is almost certainly an oversight rather than an intention.
  if (account.address.toLowerCase() === d.treasury.toLowerCase()) {
    throw new Error(
      `treasury must not be the deploying key (${account.address}) — the whole supply would land in the hot wallet that signs transactions`,
    );
  }

  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  const salt = d.salt ?? keccak256(toHex(`meridian:${d.symbol}`));
  const initCode = tokenInitCode(d);
  const predicted = create2Address(CREATE2_DEPLOYER, salt, keccak256(initCode));

  // Already deployed? CREATE2 makes a second attempt revert, so say so clearly
  // rather than letting the caller read a confusing on-chain failure.
  const existing = await publicClient.getBytecode({ address: predicted });
  if (existing && existing !== "0x") {
    throw new Error(`${d.symbol} already exists at ${predicted} — CREATE2 addresses are one-shot`);
  }

  const deployer = CREATE2_DEPLOYER;
  const data = concat([salt, initCode]); // the proxy takes salt ++ initCode

  // Prove it would succeed before spending anything.
  await publicClient.call({ account: account.address, to: deployer, data });
  if (opts.dryRun) {
    return {
      address: predicted,
      txHash: "0x" as Hex,
      predicted,
      verified: { name: d.name, symbol: d.symbol, decimals: 18, totalSupply: d.supply * 10n ** 18n, treasuryBalance: d.supply * 10n ** 18n },
    };
  }

  const wallet = createWalletClient({ account, transport: http(opts.rpcUrl) });
  const txHash = await wallet.sendTransaction({ to: deployer, data, chain: null });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Read the truth back off the chain rather than trusting what we sent.
  const [name, symbol, decimals, totalSupply, treasuryBalance] = await Promise.all([
    publicClient.readContract({ address: predicted, abi: TOKEN_ABI, functionName: "name" }),
    publicClient.readContract({ address: predicted, abi: TOKEN_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: predicted, abi: TOKEN_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: predicted, abi: TOKEN_ABI, functionName: "totalSupply" }),
    publicClient.readContract({ address: predicted, abi: TOKEN_ABI, functionName: "balanceOf", args: [d.treasury] }),
  ]);

  if (name !== d.name || symbol !== d.symbol) {
    throw new Error(`deployed token reports ${symbol}/${name}, expected ${d.symbol}/${d.name} — do NOT announce this address`);
  }
  if (totalSupply !== d.supply * 10n ** 18n || treasuryBalance !== totalSupply) {
    throw new Error(`supply mismatch: chain says ${totalSupply}, treasury holds ${treasuryBalance}`);
  }

  return { address: predicted, txHash, predicted, verified: { name, symbol, decimals, totalSupply, treasuryBalance } };
}
