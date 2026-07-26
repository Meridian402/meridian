// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianTreasuryHook} from "../MeridianTreasuryHook.sol";
import {MeridianToken} from "../MeridianToken.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The test the unit tests cannot be.
//
// Everything else mocks the PoolManager, which proves the fee ARITHMETIC and the
// access rules and nothing about whether the hook's deltas actually settle. This
// runs against the REAL deployed PoolManager on Robinhood Chain: a real pool, a
// real position, a real swap through v4's flash accounting.
//
// The question being answered is narrow and it is the one that matters: the hook
// calls take() and donate() inside afterSwap and returns a delta covering both.
// If that accounting is off by anything, the PoolManager refuses to settle and
// the swap reverts — which in production means a pool nobody can trade, with no
// upgrade path. A mock will never catch that.
//
// Run with:
//   forge test --match-path "contracts/test/*fork*" --fork-url <robinhood-rpc>
// Skips itself when no fork is present, so the ordinary suite stays hermetic.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianTreasuryHookForkTest is Test, IUnlockCallback {
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    MeridianToken token;
    using PoolIdLibrary for PoolKey;

    MeridianTreasuryHook hook;
    PoolKey key;

    address treasury = address(0xBEEF);
    address referrer = address(0xCAFE);
    address owner = address(this);

    /// Whatever the harness is doing inside the current unlock.
    enum Op {
        AddLiquidity,
        Swap
    }

    bool forked;

    function setUp() public {
        // Only meaningful against a fork; the PoolManager has no code otherwise.
        if (address(POOL_MANAGER).code.length == 0) return;
        forked = true;

        token = new MeridianToken("Meridian", "MERD", 1_000_000_000 ether, address(this));

        // v4 reads hook permissions out of the address, so place the code at one
        // carrying exactly AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA.
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        address hookAddr = address(flags | (uint160(0x9999) << 20));
        deployCodeTo(
            "MeridianTreasuryHook.sol:MeridianTreasuryHook",
            abi.encode(
                POOL_MANAGER,
                treasury,
                owner,
                MeridianTreasuryHook.Schedule({
                    buyLaunchBps: 1000,
                    buyPlateauBps: 300,
                    buyFloorBps: 100,
                    sellLaunchBps: 1000,
                    sellPlateauBps: 300,
                    sellFloorBps: 100,
                    rampSeconds: 10 minutes,
                    plateauUntil: 24 hours,
                    taperSeconds: 24 hours,
                    referralShareBps: 1000,
                    lpShareBps: 1000
                })
            ),
            hookAddr
        );
        hook = MeridianTreasuryHook(hookAddr);

        // Native ETH is address(0) and always sorts to currency0, so MERD is
        // currency1 — exactly the real pool's shape.
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(hookAddr)
        });

        vm.deal(address(this), 1_000 ether);
        // 1:1-ish opening price. The exact number does not matter here; what
        // matters is that swaps settle.
        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(0));
        _unlock(abi.encode(Op.AddLiquidity, uint256(0), false));
    }

    // ── the harness ──────────────────────────────────────────────────────────

    function _unlock(bytes memory data) internal returns (bytes memory) {
        return POOL_MANAGER.unlock(data);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(POOL_MANAGER), "only manager");
        (Op op, uint256 amount, bool zeroForOne) = abi.decode(data, (Op, uint256, bool));

        if (op == Op.AddLiquidity) {
            (BalanceDelta delta,) = POOL_MANAGER.modifyLiquidity(
                key,
                // Sized against the ETH this harness holds: over a +/-6000 tick
                // range at tick 0, each unit of liquidity costs ~0.26 of each
                // token, so 100e18 needs ~26 ETH. 5_000e18 needed ~1,300 and
                // reverted on settlement.
                ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100 ether, salt: 0}),
                ""
            );
            _settle(delta);
            return "";
        }

        // A swap. exactInput, so amountSpecified is negative.
        BalanceDelta swapDelta = POOL_MANAGER.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(referrer)
        );
        _settle(swapDelta);
        return abi.encode(swapDelta);
    }

    /// Pay what we owe, collect what we are owed. Any mistake in the hook's
    /// accounting surfaces here as a failure to settle.
    function _settle(BalanceDelta delta) internal {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();

        if (d0 < 0) {
            POOL_MANAGER.sync(key.currency0);
            POOL_MANAGER.settle{value: uint128(-d0)}();
        } else if (d0 > 0) {
            POOL_MANAGER.take(key.currency0, address(this), uint128(d0));
        }

        if (d1 < 0) {
            POOL_MANAGER.sync(key.currency1);
            token.transfer(address(POOL_MANAGER), uint128(-d1));
            POOL_MANAGER.settle();
        } else if (d1 > 0) {
            POOL_MANAGER.take(key.currency1, address(this), uint128(d1));
        }
    }

    receive() external payable {}

    // ── what we are actually here to prove ───────────────────────────────────

    function test_fork_aRealSwapSettlesAndPaysTheFee() public {
        if (!forked) return;

        uint256 treasuryBefore = token.balanceOf(treasury);
        uint256 referrerBefore = token.balanceOf(referrer);

        // Buy MERD with 1 ETH. The hook takes its cut of the MERD received.
        _unlock(abi.encode(Op.Swap, uint256(1 ether), true));

        uint256 treasuryGot = token.balanceOf(treasury) - treasuryBefore;
        uint256 referrerGot = token.balanceOf(referrer) - referrerBefore;

        assertGt(treasuryGot, 0, "treasury received no fee from a real swap");
        assertGt(referrerGot, 0, "referrer named in hookData received nothing");
        // 80/10 split of the same fee.
        assertApproxEqRel(treasuryGot, referrerGot * 8, 0.01e18, "split should be 80:10");
        assertEq(hook.decayStartedAt(key.toId()), uint64(block.timestamp), "first swap starts the clock");
    }

    function test_fork_theOpeningRateIsChargedAtTenPercent() public {
        if (!forked) return;

        uint256 before = token.balanceOf(address(this));
        _unlock(abi.encode(Op.Swap, uint256(1 ether), true));
        uint256 received = token.balanceOf(address(this)) - before;

        // Only 90% of the fee is READABLE as a balance — the other 10% was
        // donated into the pool for in-range LPs, where it is not a balance
        // anyone holds. So the observable slice is 9% of the gross output, and
        // since the trader keeps 90% of gross, that is exactly a tenth of what
        // they received. Getting this wrong is what made the first version of
        // this assertion report 9.09% and look like a contract bug.
        uint256 observableFee = token.balanceOf(treasury) + token.balanceOf(referrer);
        assertApproxEqRel(observableFee, received / 10, 0.01e18, "about a 10 percent opening rate");
    }

    function test_fork_swapsStillWorkOnceDecayed() public {
        if (!forked) return;

        _unlock(abi.encode(Op.Swap, uint256(0.1 ether), true)); // starts the clock
        uint256 mid = token.balanceOf(treasury);

        vm.warp(block.timestamp + 48 hours); // past the taper: 1% floor
        _unlock(abi.encode(Op.Swap, uint256(0.1 ether), true));

        assertGt(token.balanceOf(treasury), mid, "the floor still charges something");
    }

    function test_fork_sellsSettleToo() public {
        if (!forked) return;

        // Buy first so this address holds MERD, then sell some back.
        _unlock(abi.encode(Op.Swap, uint256(1 ether), true));
        uint256 ethBefore = address(this).balance;

        uint256 merdHeld = token.balanceOf(address(this));
        _unlock(abi.encode(Op.Swap, merdHeld / 10, false));

        assertGt(address(this).balance, ethBefore, "a sell must return ETH");
        assertGt(treasury.balance, 0, "sell-side fee is taken in ETH (currency0)");
    }
}
