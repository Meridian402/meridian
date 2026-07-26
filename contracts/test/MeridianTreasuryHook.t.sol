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
            abi.encode(IPoolManager(address(pm)), treasury, owner, uint16(1000), uint16(300), uint16(1000), uint16(300), uint64(15)),
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

        vm.warp(block.timestamp + 30 days); // a long, irrelevant delay
        vm.prank(address(pm));
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");

        assertEq(hook.decayStartedAt(), uint64(block.timestamp));
        (uint16 buy,) = hook.currentFeeBps();
        assertEq(buy, 1000, "still the full opening rate at the first trade");
    }

    function test_decaysToThreePercentInFifteenSeconds() public {
        vm.prank(address(pm));
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 7); // roughly halfway through the 15s window
        (uint16 mid,) = hook.currentFeeBps();
        // 1000 - (700 * 7) / 15 with integer division: 4900/15 = 326, so 674.
        assertEq(mid, 674, "on the straight line between 10% and 3%");

        vm.warp(t0 + 15); // the floor
        (uint16 endBuy, uint16 endSell) = hook.currentFeeBps();
        assertEq(endBuy, 300);
        assertEq(endSell, 300);
    }

    function test_neverDecaysBelowTheFloor() public {
        vm.prank(address(pm));
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        vm.warp(block.timestamp + 3650 days); // ten years later
        (uint16 buy, uint16 sell) = hook.currentFeeBps();
        assertEq(buy, 300, "3% is the floor, forever");
        assertEq(sell, 300);
    }

    function test_theRateChargedMatchesTheCurve() public {
        // Opening trade: 10% of the 1,000,000 received.
        vm.prank(address(pm));
        (, int128 first) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(uint128(first), 100_000, "10% at launch");

        vm.warp(block.timestamp + 15);
        vm.prank(address(pm));
        (, int128 later) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 1_000_000), "");
        assertEq(uint128(later), 30_000, "3% once decayed");
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
        new MeridianTreasuryHook(IPoolManager(address(pm)), treasury, owner, 300, 1000, 300, 300, 15);
    }

    function test_anOpeningRateAboveTheCapCannotBeDeployed() public {
        vm.expectRevert(abi.encodeWithSelector(MeridianTreasuryHook.FeeAboveCap.selector, uint16(1001), uint16(1000)));
        new MeridianTreasuryHook(IPoolManager(address(pm)), treasury, owner, 1001, 300, 300, 300, 15);
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
