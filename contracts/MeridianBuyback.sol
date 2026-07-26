// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MeridianBuyback — 5% of every fee, spent buying PONS and INDEX and burning them.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// WHY THIS IS A SEPARATE CONTRACT AND NOT PART OF THE HOOK:
//   The obvious implementation buys and burns inside afterSwap, during the fee
//   split. That would be a serious mistake. Both target pools belong to other
//   people — INDEX's liquidity sits behind a third-party hook that takes its own
//   3% — so putting their swap in our swap path means their pool running dry,
//   their hook reverting, or their team migrating liquidity BREAKS EVERY MERD
//   TRADE, permanently, with no upgrade path.
//
//   So the hook does the one thing it can do safely: take() 5% to this address,
//   mechanically identical to paying a referrer. No new failure mode in the swap
//   path. The buying happens here, later, out of band. If a buyback reverts,
//   nothing else notices and it is retried.
//
// WHAT IS IMMUTABLE:
//   PONS, INDEX, the pools they trade in, the split between them, and the burn
//   address. None of them have setters and this contract is not upgradeable.
//
//   The one exception is bind(), which records MERD's own pool key and can be
//   called exactly once, by the deployer, and never again. It exists because of
//   a genuine circular dependency: this contract must sell MERD through our
//   pool, that pool's identity contains the hook's address, and the hook's
//   constructor in turn needs THIS address. Something has to be filled in
//   second. Everything the buyback actually points AT is fixed at construction;
//   bind only says which pool sells MERD, it is validated against the immutable
//   MERD address, and after it runs the contract is immutable for good.
//
// BURNING:
//   Neither token has a burn() function, so burning means the address nobody
//   holds the key to. Both projects already do this: 215M PONS and 19M INDEX are
//   sitting at 0xdEaD today, so this follows their own convention rather than
//   inventing one. Bought tokens are take()n straight there — they never touch
//   this contract's balance, so there is no window in which they could be moved.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

contract MeridianBuyback is IUnlockCallback {
    /// Where burned supply goes. Both target projects already burn here.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable POOL_MANAGER;
    address public immutable MERD;
    address public immutable PONS;
    address public immutable INDEX;

    /// May call bind(), once. Holds no other authority of any kind.
    address public immutable BINDER;

    /// Share of the ETH spent on PONS; INDEX takes the remainder.
    uint16 public immutable PONS_SHARE_BPS;

    // ── the two target pools, fixed at construction ──────────────────────────
    //
    // Verified live on Robinhood Chain before being written here:
    //   PONS   ETH/PONS  2%, spacing 400, NO hook.       liquidity 2.63e21
    //   INDEX  ETH/INDEX 1%, spacing 200, hook 0x2cD9…   liquidity 5.79e22
    //
    // INDEX has no usable hookless pool — every standard tier is initialized and
    // empty — so its route necessarily depends on a contract we do not control.
    // That is a real, permanent dependency and it is why the buyback lives out
    // here where its failure is survivable.
    uint24 public immutable PONS_FEE;
    int24 public immutable PONS_SPACING;
    address public immutable PONS_HOOK;
    uint24 public immutable INDEX_FEE;
    int24 public immutable INDEX_SPACING;
    address public immutable INDEX_HOOK;

    /// MERD's own pool, recorded once by bind(). Sells the MERD side of the fee.
    PoolKey public merdPool;
    bool public bound;

    /// Stops a griefer grinding the balance away in dust-sized sandwiched buys.
    uint256 public constant COOLDOWN = 1 hours;
    uint256 public lastRunAt;

    event Bound(address indexed hook, uint24 fee, int24 tickSpacing);
    event BoughtAndBurned(uint256 ethSpent, uint256 ponsBurned, uint256 indexBurned, uint256 merdSold);

    error AlreadyBound();
    error NotBinder();
    error NotBound();
    error NotPoolManager();
    error ZeroAddress();
    error ShareTooHigh();
    error WrongPool();
    error NothingToSpend();
    error CooldownActive(uint256 readyAt);
    error SlippageRequired();

    struct Targets {
        uint24 ponsFee;
        int24 ponsSpacing;
        address ponsHook;
        uint24 indexFee;
        int24 indexSpacing;
        address indexHook;
    }

    constructor(
        IPoolManager poolManager,
        address merd,
        address pons,
        address index,
        address binder,
        uint16 ponsShareBps,
        Targets memory t
    ) {
        if (address(poolManager) == address(0) || merd == address(0) || pons == address(0) || index == address(0)) {
            revert ZeroAddress();
        }
        if (binder == address(0)) revert ZeroAddress();
        if (ponsShareBps > 10_000) revert ShareTooHigh();

        POOL_MANAGER = poolManager;
        MERD = merd;
        PONS = pons;
        INDEX = index;
        BINDER = binder;
        PONS_SHARE_BPS = ponsShareBps;

        PONS_FEE = t.ponsFee;
        PONS_SPACING = t.ponsSpacing;
        PONS_HOOK = t.ponsHook;
        INDEX_FEE = t.indexFee;
        INDEX_SPACING = t.indexSpacing;
        INDEX_HOOK = t.indexHook;
    }

    /**
     * Record MERD's pool. Once, by the deployer, then never again.
     *
     * Validated rather than trusted: the key must pair native ETH against the
     * immutable MERD address, so this cannot be pointed at some other token's
     * pool even by the binder. What it does choose is the fee tier and hook —
     * which is exactly the piece that could not be known at construction time.
     */
    function bind(PoolKey calldata key) external {
        if (msg.sender != BINDER) revert NotBinder();
        if (bound) revert AlreadyBound();
        if (Currency.unwrap(key.currency0) != address(0)) revert WrongPool();
        if (Currency.unwrap(key.currency1) != MERD) revert WrongPool();
        merdPool = key;
        bound = true;
        emit Bound(address(key.hooks), key.fee, key.tickSpacing);
    }

    /**
     * Spend everything held here on PONS and INDEX, and burn both. Permissionless.
     *
     * The minimums are the caller's slippage protection and must be non-zero:
     * passing zero would invite a sandwich that burns almost nothing while the
     * ETH still leaves. Combined with the cooldown, the worst a hostile caller
     * can do is waste one hour's accumulation, and they pay the gas to do it.
     */
    function buyAndBurn(uint256 minPons, uint256 minIndex) external {
        if (!bound) revert NotBound();
        if (minPons == 0 || minIndex == 0) revert SlippageRequired();
        if (block.timestamp < lastRunAt + COOLDOWN) revert CooldownActive(lastRunAt + COOLDOWN);
        lastRunAt = block.timestamp;

        uint256 merdHeld = IERC20(MERD).balanceOf(address(this));
        if (address(this).balance == 0 && merdHeld == 0) revert NothingToSpend();

        POOL_MANAGER.unlock(abi.encode(minPons, minIndex, merdHeld));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (uint256 minPons, uint256 minIndex, uint256 merdHeld) = abi.decode(data, (uint256, uint256, uint256));

        // 1. Sell the MERD side of the fee for ETH, through our own pool. Buys
        //    pay the fee in MERD and sells pay it in ETH, so without this step
        //    half the buyback would sit here forever.
        if (merdHeld > 0) {
            BalanceDelta d = POOL_MANAGER.swap(
                merdPool,
                SwapParams({zeroForOne: false, amountSpecified: -int256(merdHeld), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
                ""
            );
            // Pay the MERD we owe, collect the ETH we are owed.
            POOL_MANAGER.sync(merdPool.currency1);
            IERC20Minimal(MERD).transfer(address(POOL_MANAGER), uint256(uint128(-d.amount1())));
            POOL_MANAGER.settle();
            POOL_MANAGER.take(merdPool.currency0, address(this), uint256(uint128(d.amount0())));
        }

        uint256 ethIn = address(this).balance;
        if (ethIn == 0) revert NothingToSpend();

        uint256 forPons = (ethIn * PONS_SHARE_BPS) / 10_000;
        uint256 forIndex = ethIn - forPons;

        uint256 ponsOut = _buyAndBurn(PONS, PONS_FEE, PONS_SPACING, PONS_HOOK, forPons, minPons);
        uint256 indexOut = _buyAndBurn(INDEX, INDEX_FEE, INDEX_SPACING, INDEX_HOOK, forIndex, minIndex);

        emit BoughtAndBurned(ethIn, ponsOut, indexOut, merdHeld);
        return "";
    }

    /// Buy `token` with `ethIn` and take the proceeds straight to the burn
    /// address — they never land in this contract, so there is no moment at
    /// which anything could move them anywhere else.
    function _buyAndBurn(address token, uint24 fee, int24 spacing, address hook, uint256 ethIn, uint256 minOut)
        private
        returns (uint256 out)
    {
        if (ethIn == 0) return 0;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(hook)
        });

        BalanceDelta d = POOL_MANAGER.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );

        out = uint256(uint128(d.amount1()));
        require(out >= minOut, "slippage");

        POOL_MANAGER.sync(key.currency0);
        POOL_MANAGER.settle{value: uint256(uint128(-d.amount0()))}();
        POOL_MANAGER.take(key.currency1, BURN, out);
    }

    /// The hook pays the buyback share in here, in whichever currency the fee
    /// was charged in.
    receive() external payable {}

    /// What is waiting to be spent, for anyone deciding whether to call.
    function pending() external view returns (uint256 ethHeld, uint256 merdHeld, uint256 readyAt) {
        return (address(this).balance, IERC20(MERD).balanceOf(address(this)), lastRunAt + COOLDOWN);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Nothing below. No withdraw, no owner, no rescue, no setter for any target
    // or share. The only address ETH or tokens can leave this contract toward is
    // a pool, and the only address bought tokens can land on is BURN.
    // ─────────────────────────────────────────────────────────────────────────
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
}
