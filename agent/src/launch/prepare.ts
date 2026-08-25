// Build the unsigned two-step launch flow for a team: create their splitter
// (CREATE2, skipped when it already exists), then launchToken on the PONS v2
// factory with the splitter as creatorFeeRecipient. Every number that guards
// the launch (fee, tax cap, economics hash, whitelist) is read live from the
// factory at prepare time, and the team signs both steps from their own
// wallet. DORMANT until the operator arms it: MERIDIAN_LAUNCH_ROUTER=on and a
// deployed splitter factory in SPLITTER_FACTORY_ADDRESS.
import { encodeFunctionData, keccak256, encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { PONS_V2, USDG_PAIR, factoryAbi, splitterFactoryAbi, validateLaunchInput, buildLaunchTokenTx, type LaunchInput } from "./ponsV2.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function splitterFactoryAddress(): Address | null {
  const raw = (process.env.SPLITTER_FACTORY_ADDRESS ?? "").trim();
  return ADDRESS_RE.test(raw) ? (raw as Address) : null;
}

export function routerOpen(): boolean {
  return process.env.MERIDIAN_LAUNCH_ROUTER === "on" && splitterFactoryAddress() !== null;
}

/** PURE: a stable per-launch salt. Deterministic within one prepare response
 *  (both steps reference it), distinct across attempts via the timestamp. */
export function launchSalt(team: Address, symbol: string, nowMs: number): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address, string, uint256"), [team, symbol, BigInt(nowMs)]));
}

export async function prepareLaunchSteps(team: Address, input: LaunchInput, nowMs: number): Promise<Record<string, unknown> | { error: string; status: number }> {
  const v = validateLaunchInput(input);
  if (!v.ok) return { error: v.error, status: 400 };
  if (!routerOpen()) {
    return { error: "the router isn't open yet; agent launches go live with the Launch page", status: 503 };
  }
  const factory = splitterFactoryAddress()!;
  const client = getPublicClient();

  const [can, feeWei, maxTax, economics] = await Promise.all([
    client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "canLaunch", args: [team] }),
    client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "launchFee" }),
    client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
    client.readContract({ address: PONS_V2.factory, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [0n, USDG_PAIR] }),
  ]);
  if (!can) return { error: "PONS v2 is not accepting launches from this wallet right now", status: 403 };
  if (BigInt(v.clean.creatorTaxBps) > maxTax) return { error: `creator tax is capped at ${maxTax} bps on-chain`, status: 400 };

  const salt = launchSalt(team, v.clean.symbol, nowMs);
  const splitter = await client.readContract({ address: factory, abi: splitterFactoryAbi, functionName: "predict", args: [team, salt] });
  const splitterCode = await client.getCode({ address: splitter }).catch(() => undefined);

  const steps: { kind: string; description: string; to: Address; data: Hex; value: string }[] = [];
  if (!splitterCode || splitterCode === "0x") {
    steps.push({
      kind: "create-splitter",
      description: "Deploy your fee splitter (80% you, 20% Meridian, immutable)",
      to: factory,
      data: encodeFunctionData({ abi: splitterFactoryAbi, functionName: "create", args: [team, salt] }),
      value: "0",
    });
  }
  const launch = buildLaunchTokenTx({ clean: v.clean, team, splitter, launchFeeWei: feeWei, expectedEconomics: economics, salt });
  steps.push({
    kind: "launch",
    description: `Launch ${v.clean.symbol} on PONS v2, paired in USDG`,
    to: launch.to,
    data: launch.data,
    value: launch.value.toString(),
  });

  return {
    ok: true,
    kind: "agent-launch",
    chainId: PONS_V2.chainId,
    splitter,
    launchFeeWei: feeWei.toString(),
    steps,
    note: "You sign both steps from your own wallet; Meridian never holds keys or funds. The splitter is immutable: 80% of the launch's fee stream forwards to you, 20% is the router share. Engine access switches on for your wallet when the launch graduates. After the launch transaction confirms, register it with its transaction hash to start graduation tracking.",
  };
}
