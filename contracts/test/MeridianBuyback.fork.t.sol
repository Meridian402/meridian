// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianBuyback} from "../MeridianBuyback.sol";
import {MeridianToken} from "../MeridianToken.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Can we actually buy these, and does the supply actually go to the burn address?
//
// Everything about this contract depends on two pools that belong to other
// people. PONS trades in a hookless 2% pool; INDEX has NO usable hookless pool
// at all — every standard tier is initialized and empty — so its liquidity sits
// behind a third-party hook that takes its own 3%. Neither is something we can
// assert into existence, so the only honest test buys from them for real.
//
// Run:
//   forge test --match-path "contracts/test/MeridianBuyback.fork.t.sol" --fork-url <rpc>
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

contract MeridianBuybackForkTest is Test {
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address constant INDEX = 0x56910D4409F3a0C78C64DD8D0545FF0705389870;
    address constant INDEX_HOOK = 0x2cD91bD228ff4c537031d6b8204782090c84c0cC;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    MeridianBuyback buyback;
    MeridianToken merd;
    address binder = address(0xB19DE2);

    bool forked;

    function setUp() public {
        if (address(POOL_MANAGER).code.length == 0) return;
        forked = true;

        merd = new MeridianToken("Meridian", "MERD", 1_000_000_000 ether, address(this));
        buyback = new MeridianBuyback(
            POOL_MANAGER,
            address(merd),
            PONS,
            INDEX,
            binder,
            5000, // half the ETH to each
            MeridianBuyback.Targets({
                ponsFee: 20_000,
                ponsSpacing: 400,
                ponsHook: address(0),
                indexFee: 10_000,
                indexSpacing: 200,
                indexHook: INDEX_HOOK
            })
        );
    }

    function _bind() internal {
        vm.prank(binder);
        buyback.bind(
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(merd)),
                fee: 10_000,
                tickSpacing: 200,
                hooks: IHooks(address(0))
            })
        );
    }

    // ── the question the mock cannot answer ──────────────────────────────────

    function test_fork_ethActuallyBuysBothTokensAndBurnsThem() public {
        if (!forked) return;
        _bind();

        uint256 ponsBurnedBefore = IERC20(PONS).balanceOf(BURN);
        uint256 indexBurnedBefore = IERC20(INDEX).balanceOf(BURN);

        // A realistic accumulation: this is what 5% of fees looks like after a
        // while, not a dust amount that would round to nothing.
        vm.deal(address(buyback), 0.2 ether);
        buyback.buyAndBurn(1, 1);

        uint256 ponsBurned = IERC20(PONS).balanceOf(BURN) - ponsBurnedBefore;
        uint256 indexBurned = IERC20(INDEX).balanceOf(BURN) - indexBurnedBefore;

        assertGt(ponsBurned, 0, "no PONS was bought from the live pool");
        assertGt(indexBurned, 0, "no INDEX was bought from the live pool");

        // The supply must be GONE, not parked here waiting for someone to move it.
        assertEq(IERC20(PONS).balanceOf(address(buyback)), 0, "PONS must never rest in this contract");
        assertEq(IERC20(INDEX).balanceOf(address(buyback)), 0, "INDEX must never rest in this contract");
        assertEq(address(buyback).balance, 0, "all the ETH was spent");
    }

    function test_fork_slippageBoundsAreEnforcedAgainstTheRealPool() public {
        if (!forked) return;
        _bind();
        vm.deal(address(buyback), 0.05 ether);
        // An impossible minimum must revert rather than buy at any price.
        vm.expectRevert();
        buyback.buyAndBurn(type(uint128).max, 1);
    }

    function test_fork_theCooldownStopsGrinding() public {
        if (!forked) return;
        _bind();
        vm.deal(address(buyback), 0.1 ether);
        buyback.buyAndBurn(1, 1);

        vm.deal(address(buyback), 0.1 ether);
        vm.expectRevert();
        buyback.buyAndBurn(1, 1); // still inside the hour

        vm.warp(block.timestamp + 1 hours + 1);
        buyback.buyAndBurn(1, 1); // and fine once it has passed
    }

    // ── binding ──────────────────────────────────────────────────────────────

    function test_fork_bindIsOneShotAndOnlyTheBinder() public {
        if (!forked) return;
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(merd)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });

        vm.expectRevert(MeridianBuyback.NotBinder.selector);
        buyback.bind(k);

        _bind();
        assertTrue(buyback.bound());

        vm.prank(binder);
        vm.expectRevert(MeridianBuyback.AlreadyBound.selector);
        buyback.bind(k);
    }

    function test_fork_bindCannotBePointedAtAnotherTokensPool() public {
        if (!forked) return;
        // Validated against the immutable MERD address, so even the binder
        // cannot aim this at a pool selling something else.
        vm.prank(binder);
        vm.expectRevert(MeridianBuyback.WrongPool.selector);
        buyback.bind(
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(PONS),
                fee: 20_000,
                tickSpacing: 400,
                hooks: IHooks(address(0))
            })
        );
    }

    function test_fork_nothingCanBeSpentBeforeBinding() public {
        if (!forked) return;
        vm.deal(address(buyback), 1 ether);
        vm.expectRevert(MeridianBuyback.NotBound.selector);
        buyback.buyAndBurn(1, 1);
    }

    function test_fork_thereIsNoWayToTakeTheMoneyOut() public {
        if (!forked) return;
        _bind();
        vm.deal(address(buyback), 1 ether);

        string[6] memory escapes = [
            "withdraw()",
            "withdraw(uint256)",
            "emergencyWithdraw()",
            "sweep(address)",
            "transferOwnership(address)",
            "execute(address,bytes)"
        ];
        for (uint256 i = 0; i < escapes.length; i++) {
            (bool ok,) = address(buyback).call(abi.encodeWithSignature(escapes[i]));
            assertFalse(ok, escapes[i]);
        }
        assertEq(address(buyback).balance, 1 ether, "still here, and only a pool can take it");
    }
}
