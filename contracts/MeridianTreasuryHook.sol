// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MeridianTreasuryHook — a capped, adjustable protocol fee on every swap.
//
// DRAFT · UNAUDITED · NOT DEPLOYED. This is the highest-risk contract in the
// repo: it sits in the swap path of a live pool, and a mistake here breaks
// trading rather than merely losing our own fee. It needs fork tests against a
// real v4 PoolManager and an external audit before it goes near mainnet.
//
// WHY A HOOK AT ALL:
//   Seeding our own pool already earns us the LP fee on every swap, because we
//   hold the position. That works right up until anyone else provides liquidity
//   — LP fees are shared pro-rata, so our cut dilutes toward zero as the pool
//   grows. A hook takes its share off the top regardless of who supplied the
//   liquidity, which is the only version that survives the pool succeeding.
//
//   A v4 pool's hook is fixed at creation and cannot be added later, so this
//   has to exist at launch or never. It therefore ships DISABLED: feeBps starts
//   at 0 and the pool behaves exactly as if there were no hook until someone
//   deliberately turns it on.
//
// THE CAP IS THE POINT:
//   MAX_FEE_BPS is a constant. No owner, no governance, no upgrade path can
//   raise it, because there is no code that writes to it. The owner may move
//   the fee anywhere between 0 and that ceiling and nowhere else. A trader can
//   read one constant and know the worst case for as long as the pool exists.
//
//   This is deliberately not a "trust us" fee. Anything the owner key can do is
//   bounded by a number compiled into the bytecode.
//
// ADDRESS MINING:
//   v4 encodes hook permissions in the low bits of the hook's own address, so
//   this must be deployed via CREATE2 at a salt whose result has AFTER_SWAP and
//   AFTER_SWAP_RETURNS_DELTA set. Deploying to an unmined address does not fail
//   loudly — the pool simply never calls the hook. validateHookAddress() in the
//   constructor turns that silent misconfiguration into a failed deployment.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianTreasuryHook is IHooks {
    /// Hard ceiling on the protocol fee, in basis points. Compiled in, forever.
    uint16 public constant MAX_FEE_BPS = 100; // 1.00%

    IPoolManager public immutable POOL_MANAGER;
    address public immutable TREASURY;

    /// Starts at zero: the pool opens with no protocol fee at all.
    uint16 public feeBps;
    address public owner;

    event FeeChanged(uint16 previousBps, uint16 newBps);
    event OwnerChanged(address indexed previous, address indexed next);
    event FeeTaken(Currency indexed currency, uint256 amount);

    error NotPoolManager();
    error NotOwner();
    error FeeAboveCap(uint16 requested, uint16 cap);
    error ZeroAddress();
    error HookNotImplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager poolManager, address treasury, address owner_) {
        if (address(poolManager) == address(0) || treasury == address(0) || owner_ == address(0)) revert ZeroAddress();
        POOL_MANAGER = poolManager;
        TREASURY = treasury;
        owner = owner_;
        // Fails the deployment if the mined address does not carry the exact
        // permission bits below. Without this, a bad salt yields a hook that is
        // simply never called and a pool that quietly earns nothing.
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The only hook we implement.
    //
    // Core adds our returned int128 to the UNSPECIFIED side of the swap and
    // then does `swapDelta = swapDelta - hookDelta`, so a positive return means
    // the swapper covers it: they receive less when the unspecified currency is
    // the output, or pay more when it is the input. Taking the absolute value
    // therefore charges the same rate in both directions, and exact-output
    // swaps cannot be used to dodge the fee.
    // ─────────────────────────────────────────────────────────────────────────
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        uint16 bps = feeBps;
        if (bps == 0) return (IHooks.afterSwap.selector, 0);

        // Which side is "unspecified" is the same expression core uses to map
        // our delta back onto currency0/currency1. Kept identical on purpose:
        // if these two ever disagree, the fee is taken in the wrong token.
        bool unspecifiedIsCurrency1 = (params.amountSpecified < 0) == params.zeroForOne;
        Currency currency = unspecifiedIsCurrency1 ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = unspecifiedIsCurrency1 ? delta.amount1() : delta.amount0();
        if (unspecifiedAmount == 0) return (IHooks.afterSwap.selector, 0);

        uint256 magnitude = unspecifiedAmount < 0 ? uint256(uint128(-unspecifiedAmount)) : uint256(uint128(unspecifiedAmount));
        uint256 fee = (magnitude * bps) / 10_000;
        if (fee == 0) return (IHooks.afterSwap.selector, 0); // dust: not worth a transfer

        // Claim the credit core just created for us and move it out in the same
        // call, so the hook never carries a balance between transactions.
        POOL_MANAGER.take(currency, TREASURY, fee);
        emit FeeTaken(currency, fee);

        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fee control. Bounded by a constant, so the worst case is readable.
    // ─────────────────────────────────────────────────────────────────────────
    function setFeeBps(uint16 next) external onlyOwner {
        if (next > MAX_FEE_BPS) revert FeeAboveCap(next, MAX_FEE_BPS);
        emit FeeChanged(feeBps, next);
        feeBps = next;
    }

    function transferOwnership(address next) external onlyOwner {
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// One-way. Freezes the fee at its current value for the life of the pool.
    function renounceOwnership() external onlyOwner {
        emit OwnerChanged(owner, address(0));
        owner = address(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Everything else is unimplemented. The permission bits mean core will
    // never call these, so reverting is unreachable in practice — it exists so
    // that a future pool created against this hook with different flags fails
    // immediately instead of silently skipping logic that was never written.
    // ─────────────────────────────────────────────────────────────────────────
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
