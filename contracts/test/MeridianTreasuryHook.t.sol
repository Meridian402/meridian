// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianTreasuryHook} from "../MeridianTreasuryHook.sol";
import {MeridianToken} from "../MeridianToken.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The hook sits in the swap path of a live pool, so the failures that matter
// are "trading breaks" and "the fee is bigger than advertised". These pin both,
// plus the promise the whole design rests on: the cap cannot be raised.
//
// The PoolManager is mocked. That is enough to prove the fee ARITHMETIC and the
// access rules, and not enough to prove the delta accounting settles correctly
// inside a real swap — that needs a fork test against a deployed PoolManager,
// which is listed as required work and is not done here.
// ─────────────────────────────────────────────────────────────────────────────

contract MockPoolManager {
    address public lastTakeTo;
    uint256 public lastTakeAmount;
    Currency public lastTakeCurrency;

    function take(Currency currency, address to, uint256 amount) external {
        lastTakeCurrency = currency;
        lastTakeTo = to;
        lastTakeAmount = amount;
    }
}

contract MeridianTreasuryHookTest is Test {
    MeridianTreasuryHook hook;
    MockPoolManager pm;
    address treasury = address(0x7);
    address owner = address(0x0117E);
    address stranger = address(0xBAD);

    Currency c0 = Currency.wrap(address(0x1111));
    Currency c1 = Currency.wrap(address(0x2222));
    PoolKey key;

    function setUp() public {
        pm = new MockPoolManager();

        // v4 reads a hook's permissions from its ADDRESS, so the contract only
        // works when deployed somewhere with the right low bits set. Mirror the
        // real CREATE2 mining by planting the code at a valid address.
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        address target = address(flags | (uint160(0x4444) << 20));
        deployCodeTo(
            "MeridianTreasuryHook.sol:MeridianTreasuryHook",
            abi.encode(IPoolManager(address(pm)), treasury, owner, _schedule()),
            target
        );
        hook = MeridianTreasuryHook(target);

        key = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(target)});
    }

    // ── the promise a trader relies on ───────────────────────────────────────




    // ── who may call the hook ────────────────────────────────────────────────

    function test_onlyThePoolManagerMayInvokeAfterSwap() public {
        vm.prank(stranger);
        vm.expectRevert(MeridianTreasuryHook.NotPoolManager.selector);
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1000, 900), "");
    }

    // ── the fee itself ───────────────────────────────────────────────────────







    // ── the buy / sell split ─────────────────────────────────────────────────





    // ── the decay curve ──────────────────────────────────────────────────────

    function test_opensAtTenPercentBothWays() public view {
        (uint16 buy, uint16 sell) = hook.currentFeeBps();
        assertEq(buy, 1000, "10% on the first buy");
        assertEq(sell, 1000, "10% on the first sell");
    }

    function test_theClockStartsOnTheFirstSwapNotAtDeploy() public {
        // The sniper window is measured from the first trade. If the clock ran
        // from deployment, a delay between deploying and opening the pool would
        // burn the protection before anyone could trade.
        assertEq(hook.decayStartedAt(), 0);
        assertEq(hook.decayEndsAt(), 0);

        vm.warp(5_000_000); // a long, irrelevant delay before the pool opens
        vm.prank(address(pm));
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");

        assertEq(hook.decayStartedAt(), uint64(5_000_000));
        (uint16 buy,) = hook.currentFeeBps();
        assertEq(buy, 1000, "still the full opening rate at the first trade");
    }

    function test_theThreePhases() public {
        // Absolute timestamps, never a cached `block.timestamp`. Under the
        // optimizer a local holding block.timestamp gets rematerialized at each
        // use — legal, because in real execution the value cannot change inside
        // a transaction — so vm.warp silently invalidates it and every later
        // comparison reads the wrong time.
        uint256 t0 = 1_000_000;
        vm.warp(t0);
        vm.prank(address(pm));
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(hook.decayStartedAt(), uint64(t0), "clock starts on the first swap");

        // Phase 1 — the ramp. Halfway through ten minutes is halfway to 3%.
        vm.warp(t0 + 5 minutes);
        (uint16 mid,) = hook.currentFeeBps();
        assertEq(mid, 650, "halfway down the opening ramp");

        // Phase 2 — the plateau, flat for the rest of the first day.
        vm.warp(t0 + 10 minutes);
        (uint16 atPlateau,) = hook.currentFeeBps();
        assertEq(atPlateau, 300, "the ramp lands on the plateau");

        vm.warp(t0 + 12 hours);
        (uint16 midDay,) = hook.currentFeeBps();
        assertEq(midDay, 300, "still 3% twelve hours in");

        vm.warp(t0 + 24 hours - 1);
        (uint16 endOfDay,) = hook.currentFeeBps();
        assertEq(endOfDay, 300, "3% right up to the 24h mark");

        // Phase 3 — the taper to the permanent floor.
        vm.warp(t0 + 36 hours);
        (uint16 midTaper,) = hook.currentFeeBps();
        assertEq(midTaper, 200, "halfway between 3% and 1%");

        vm.warp(t0 + 48 hours);
        (uint16 floorBuy, uint16 floorSell) = hook.currentFeeBps();
        assertEq(floorBuy, 100, "1% floor");
        assertEq(floorSell, 100);
    }

    function test_neverDecaysBelowTheFloor() public {
        vm.prank(address(pm));
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        vm.warp(3650 days); // ten years later
        (uint16 buy, uint16 sell) = hook.currentFeeBps();
        assertEq(buy, 100, "1% is the permanent floor");
        assertEq(sell, 100);
    }

    function test_theRateChargedMatchesTheCurve() public {
        // Opening trade: 10% of the 1,000,000 received.
        vm.prank(address(pm));
        (, int128 first) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(uint128(first), 100_000, "10% at launch");

        vm.warp(10 minutes + 1);
        vm.prank(address(pm));
        (, int128 onPlateau) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(uint128(onPlateau), 30_000, "3% on the plateau");

        vm.warp(48 hours + 1);
        vm.prank(address(pm));
        (, int128 atFloor) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(uint128(atFloor), 10_000, "1% at the floor");
    }

    function test_sellsAreChargedOnTheirOwnSchedule() public {
        SwapParams memory sell = SwapParams({zeroForOne: false, amountSpecified: -1_000_000, sqrtPriceLimitX96: 0});
        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, sell, toBalanceDelta(1_000_000, -1_000_000), "");
        assertEq(uint128(d), 100_000, "10% on an opening sell");
        assertEq(Currency.unwrap(pm.lastTakeCurrency()), Currency.unwrap(c0), "sell fee taken in currency0");
    }

    // ── what nobody can do ───────────────────────────────────────────────────

    function test_nobodyCanChangeTheSchedule() public {
        // The whole trust model: there is no setter. If one is ever added, this
        // is the test that has to be deleted first.
        bytes4[3] memory forbidden = [
            bytes4(keccak256("setFees(uint16,uint16)")),
            bytes4(keccak256("setFeeBps(uint16)")),
            bytes4(keccak256("setDecaySeconds(uint64)"))
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            vm.prank(owner);
            (bool ok,) = address(hook).call(abi.encodeWithSelector(forbidden[i], uint16(1000), uint16(1000)));
            assertFalse(ok, "a fee setter exists");
        }
    }

    function test_aRisingScheduleCannotBeDeployed() public {
        // A rate that goes UP on holders after they buy is the most hostile
        // thing this contract could be configured to do.
        vm.expectRevert(MeridianTreasuryHook.EndAboveStart.selector);
        MeridianTreasuryHook.Schedule memory bad = _schedule();
        bad.buyPlateauBps = 5000; // plateau ABOVE the launch rate
        new MeridianTreasuryHook(IPoolManager(address(pm)), treasury, owner, bad);
    }

    function test_anOpeningRateAboveTheCapCannotBeDeployed() public {
        vm.expectRevert(abi.encodeWithSelector(MeridianTreasuryHook.FeeAboveCap.selector, uint16(1001), uint16(1000)));
        MeridianTreasuryHook.Schedule memory bad = _schedule();
        bad.buyLaunchBps = 1001;
        new MeridianTreasuryHook(IPoolManager(address(pm)), treasury, owner, bad);
    }

    function test_theOnlyLeverMakesTradingCheaper() public {
        vm.prank(owner);
        hook.disableFeesForever();
        (uint16 buy, uint16 sell) = hook.currentFeeBps();
        assertEq(buy, 0);
        assertEq(sell, 0);

        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(d, 0, "disabled means genuinely free, not merely lower");
    }

    function test_onlyOwnerCanDisable() public {
        vm.prank(stranger);
        vm.expectRevert(MeridianTreasuryHook.NotOwner.selector);
        hook.disableFeesForever();
    }


    /// The launch config: 10% -> 3% over 10 min, flat 3% to 24h, then 3% -> 1%.
    function _schedule() internal pure returns (MeridianTreasuryHook.Schedule memory) {
        return MeridianTreasuryHook.Schedule({
            buyLaunchBps: 1000,
            buyPlateauBps: 300,
            buyFloorBps: 100,
            sellLaunchBps: 1000,
            sellPlateauBps: 300,
            sellFloorBps: 100,
            rampSeconds: 10 minutes,
            plateauUntil: 24 hours,
            taperSeconds: 24 hours
        });
    }

    function _exactInZeroForOne() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: -1_000_000, sqrtPriceLimitX96: 0});
    }
}

contract MeridianTokenTest is Test {
    MeridianToken token;
    address treasury = address(0x7);
    address alice = address(0xA1);

    function setUp() public {
        token = new MeridianToken("Meridian", "MERD", 1_000_000_000 ether, treasury);
    }

    function test_supplyIsFixedAndFullyIssued() public view {
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(treasury), token.totalSupply());
    }

    function test_thereIsNoMintOrOwner() public {
        // The claim the token makes about itself, asserted rather than trusted.
        bytes4[4] memory forbidden = [
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("burn(uint256)")),
            bytes4(keccak256("owner()")),
            bytes4(keccak256("setFee(uint256)"))
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok,) = address(token).call(abi.encodeWithSelector(forbidden[i], alice, uint256(1)));
            assertFalse(ok, "token exposes a lever it should not have");
        }
    }

    function test_transfersMoveExactlyTheAmountWithNoTax() public {
        vm.prank(treasury);
        token.transfer(alice, 100 ether);
        assertEq(token.balanceOf(alice), 100 ether, "a tax would show up here");
    }


    function test_rejectsAZeroTreasury() public {
        // Minting the supply to address(0) burns it on creation. Unrecoverable.
        vm.expectRevert(MeridianToken.MintToZero.selector);
        new MeridianToken("Meridian", "MERD", 1_000_000_000 ether, address(0));
    }

    function test_rejectsAZeroSupply() public {
        vm.expectRevert(MeridianToken.ZeroSupply.selector);
        new MeridianToken("Meridian", "MERD", 0, treasury);
    }

    function test_infiniteApprovalDoesNotDecay() public {
        vm.prank(treasury);
        token.approve(alice, type(uint256).max);
        vm.prank(alice);
        token.transferFrom(treasury, alice, 1 ether);
        assertEq(token.allowance(treasury, alice), type(uint256).max);
    }
}
