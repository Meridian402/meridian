import type { BridgeResult, ChainId, RwaAsset } from "../types.js";

export interface Bridge {
  readonly name: string;
  /** True while moveValue is a no-op. Callers must refuse to charge fees or
   *  record spend against a stub — a fee in front of a no-op is theft-shaped. */
  readonly isStub?: boolean;
  moveValue(params: {
    asset: RwaAsset;
    amountUsd: number;
    destChain: ChainId;
  }): Promise<BridgeResult>;
}

export class WormholeBridge implements Bridge {
  readonly name = "wormhole";
  readonly isStub = true;

  constructor(private rpcUrl: string) {}

  async moveValue(params: {
    asset: RwaAsset;
    amountUsd: number;
    destChain: ChainId;
  }): Promise<BridgeResult> {
    const { asset, destChain } = params;

    console.log(
      `[WormholeBridge:stub] would move $${params.amountUsd} of ${asset.symbol} ` +
        `from ${asset.chain} -> ${destChain} via ${this.rpcUrl || "(no RPC configured)"}`
    );

    return {
      success: true,
      sourceChain: asset.chain,
      destChain,
      txHashSource: "stub-source-tx",
      txHashDest: "stub-dest-tx",
    };
  }
}
