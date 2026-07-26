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
            abi.encode(IPoolManager(address(pm)), treasury, owner),
            target
        );
        hook = MeridianTreasuryHook(target);

        key = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(target)});
    }

    // ── the promise a trader relies on ───────────────────────────────────────

    function test_shipsDisabled() public view {
        assertEq(hook.feeBps(), 0, "the pool must open with no protocol fee");
    }

    function test_capCannotBeRaised() public {
        // There is no setter for MAX_FEE_BPS. This is the whole trust model:
        // a trader reads one constant and knows the worst case, permanently.
        assertEq(hook.MAX_FEE_BPS(), 100);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MeridianTreasuryHook.FeeAboveCap.selector, uint16(101), uint16(100)));
        hook.setFeeBps(101);
    }

    function test_onlyOwnerMovesTheFee() public {
        vm.prank(stranger);
        vm.expectRevert(MeridianTreasuryHook.NotOwner.selector);
        hook.setFeeBps(50);
    }

    function test_renouncingFreezesTheFeeForever() public {
        vm.startPrank(owner);
        hook.setFeeBps(50);
        hook.renounceOwnership();
        vm.stopPrank();

        vm.prank(owner);
        vm.expectRevert(MeridianTreasuryHook.NotOwner.selector);
        hook.setFeeBps(0);
        assertEq(hook.feeBps(), 50);
    }

    // ── who may call the hook ────────────────────────────────────────────────

    function test_onlyThePoolManagerMayInvokeAfterSwap() public {
        vm.prank(stranger);
        vm.expectRevert(MeridianTreasuryHook.NotPoolManager.selector);
        hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1000, 900), "");
    }

    // ── the fee itself ───────────────────────────────────────────────────────

    function test_takesNothingWhileDisabled() public {
        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1000, 900), "");
        assertEq(d, 0);
        assertEq(pm.lastTakeAmount(), 0, "a disabled hook must not touch the swap");
    }

    function test_exactInputChargesOnTheOutputCurrency() public {
        vm.prank(owner);
        hook.setFeeBps(100); // 1%

        // exactIn, zeroForOne: user pays currency0, receives currency1.
        // Unspecified side is currency1, so the fee comes out of what they get.
        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1_000_000, 900_000), "");

        assertEq(uint128(d), 9_000, "1% of the 900000 received");
        assertEq(pm.lastTakeAmount(), 9_000);
        assertEq(pm.lastTakeTo(), treasury);
        assertEq(Currency.unwrap(pm.lastTakeCurrency()), Currency.unwrap(c1));
    }

    function test_exactOutputIsAlsoCharged() public {
        // Otherwise exact-output swaps would be a free lane around the fee.
        vm.prank(owner);
        hook.setFeeBps(100);

        // exactOut, zeroForOne: specified is the output (currency1), so the
        // unspecified side is currency0 — the input, a negative delta.
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: 900_000, sqrtPriceLimitX96: 0});
        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, p, toBalanceDelta(-1_000_000, 900_000), "");

        assertEq(uint128(d), 10_000, "1% of the 1000000 paid");
        assertEq(Currency.unwrap(pm.lastTakeCurrency()), Currency.unwrap(c0));
    }

    function test_dustRoundsToNothingRatherThanReverting() public {
        vm.prank(owner);
        hook.setFeeBps(1); // 0.01%
        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-100, 90), "");
        assertEq(d, 0, "a swap too small to fee must still succeed");
        assertEq(pm.lastTakeAmount(), 0);
    }

    function test_feeNeverExceedsTheCapEvenOnHugeSwaps() public {
        // Read the cap BEFORE pranking: vm.prank applies to the next call, and
        // a view call in the argument list would consume it.
        uint16 cap = hook.MAX_FEE_BPS();
        vm.prank(owner);
        hook.setFeeBps(cap);
        vm.prank(address(pm));
        (, int128 d) = hook.afterSwap(stranger, key, _exactInZeroForOne(), toBalanceDelta(-1e18, 1e18), "");
        assertLe(uint256(uint128(d)), uint256(1e18) / 100, "never more than 1% of the swap");
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
