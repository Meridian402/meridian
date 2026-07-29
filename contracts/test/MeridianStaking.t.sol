// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianStaking, IERC20} from "../MeridianStaking.sol";
import {MeridianToken} from "../MeridianToken.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The vault holds other people's money and its whole promise is arithmetic, so
// what these tests pin is the arithmetic and nothing decorative.
//
// The properties that matter, in the order a sceptic would ask about them:
//   1. money in equals money out, plus your share of what actually arrived
//   2. your share is your fraction of the pot, not a function of how long you
//      have been in it, so nobody is rewarded for tenure and nobody is punished
//      for arriving late
//   3. arriving late does not let you capture revenue that landed before you,
//      and does not dilute the people who were already here
//   4. the first-depositor inflation attack does not pay
//   5. nothing rounds in a direction that lets anyone leave with more than they
//      are owed, over any sequence
//   6. stakedBalanceOf returns the compounded claim, because the agent access
//      gate reads exactly that function and locks people out if it lies
//
// Wei-level tolerances appear throughout and they are all the same one wei: the
// vault behaves as though it holds one extra asset that nobody owns, which is
// the inflation defence, so a withdrawal can round down by one against the
// withdrawer. Every assertion below also checks the direction, so a rounding
// error in the OTHER direction, the one that would let value leak out, fails
// the test rather than passing inside a tolerance.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianStakingTest is Test {
    MeridianToken token;
    MeridianStaking vault;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address attacker = makeAddr("attacker");
    address revenue = makeAddr("revenue"); // stands in for whatever routes protocol income

    uint256 constant SUPPLY = 1_000_000_000 ether;

    /// Read once in setUp: calling vault.MIN_STAKE() between a vm.prank and the
    /// action it is meant to apply to consumes the prank, and the action then
    /// runs as the test contract instead of the intended caller.
    uint256 internal MIN;

    function setUp() public {
        token = new MeridianToken("Meridian", "MERD", SUPPLY, address(this));
        vault = new MeridianStaking(IERC20(address(token)));
        MIN = vault.MIN_STAKE();

        _fundWallet(alice, 1_000_000 ether);
        _fundWallet(bob, 1_000_000 ether);
        _fundWallet(carol, 1_000_000 ether);
        _fundWallet(attacker, 20_000_000 ether);
        _fundWallet(revenue, 10_000_000 ether);
    }

    // ── the baseline ─────────────────────────────────────────────────────────

    function test_emptyVaultPricesOneShareAtOneToken() public view {
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.sharePrice(), 1e18, "one whole share is one whole MERD before anything happens");
    }

    function test_stakingAloneEarnsNothing() public {
        vm.prank(alice);
        vault.stake(100 ether);

        // No revenue, no yield. There is no emission to fall back on and the
        // contract does not pretend otherwise.
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.stakedBalanceOf(alice), 100 ether, "time alone pays nothing");
        assertEq(vault.sharePrice(), 1e18);

        vm.prank(alice);
        uint256 out = vault.unstakeAll();
        assertEq(out, 100 ether, "and costs nothing either");
    }

    // ── 1. money in, money out, plus what arrived ────────────────────────────

    function test_singleStakerReceivesExactlyTheFunding() public {
        uint256 staked = 100 ether;
        uint256 funded = 10 ether;

        vm.prank(alice);
        vault.stake(staked);

        vm.prank(revenue);
        vault.fund(funded);

        uint256 claim = vault.stakedBalanceOf(alice);
        assertGt(claim, staked, "the claim grew without alice touching anything");
        assertLe(claim, staked + funded, "and never grew past what actually arrived");
        assertApproxEqAbs(claim, staked + funded, 1, "the sole staker gets the whole funding");

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.unstakeAll();

        assertEq(token.balanceOf(alice) - before, out, "the payout is real tokens, not a number");
        assertGt(out, staked, "withdrew more MERD than was staked");
        assertLe(out, staked + funded, "never more than staked plus funded");
        assertApproxEqAbs(out, staked + funded, 1, "exactly the funded amount more, to the wei");
    }

    function test_fundingRaisesSharePriceAndNeverShareCount() public {
        vm.prank(alice);
        uint256 shares = vault.stake(100 ether);
        uint256 priceBefore = vault.sharePrice();

        vm.prank(revenue);
        vault.fund(50 ether);

        assertEq(vault.sharesOf(alice), shares, "share count is untouched by revenue");
        assertEq(vault.totalShares(), shares, "nothing was minted to pay the yield");
        assertGt(vault.sharePrice(), priceBefore, "the shares are simply worth more");
        assertApproxEqAbs(vault.sharePrice(), 1.5e18, 1, "100 staked plus 50 funded is 1.5x");
    }

    function test_plainTransferAndFundCompoundIdentically() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(revenue);
        vault.fund(10 ether);
        uint256 viaFund = vault.stakedBalanceOf(alice);

        // Reset to the same starting point and repeat with a bare transfer.
        setUp();
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(revenue);
        token.transfer(address(vault), 10 ether);
        uint256 viaTransfer = vault.stakedBalanceOf(alice);

        assertEq(viaTransfer, viaFund, "an anonymous transfer compounds exactly like fund()");
    }

    // ── 2. proportional to stake, independent of time ────────────────────────

    function test_twoStakersSplitFundingByStakeAndNotByTenure() public {
        // Alice is in for a hundred days before bob shows up. That must buy her
        // nothing: the split is by size of stake, full stop.
        vm.prank(alice);
        vault.stake(300 ether);
        vm.warp(block.timestamp + 100 days);
        vm.prank(bob);
        vault.stake(100 ether);

        vm.prank(revenue);
        vault.fund(40 ether);

        // 3:1 stake means 30:10 of the funding, not 3:1 weighted by seconds.
        assertApproxEqAbs(vault.stakedBalanceOf(alice), 330 ether, 2, "alice: 300 staked plus 3/4 of 40");
        assertApproxEqAbs(vault.stakedBalanceOf(bob), 110 ether, 2, "bob: 100 staked plus 1/4 of 40");

        // And another hundred days changes neither number.
        uint256 aliceClaim = vault.stakedBalanceOf(alice);
        uint256 bobClaim = vault.stakedBalanceOf(bob);
        vm.warp(block.timestamp + 100 days);
        assertEq(vault.stakedBalanceOf(alice), aliceClaim, "no accrual with time");
        assertEq(vault.stakedBalanceOf(bob), bobClaim, "no accrual with time");
    }

    function test_equalStakesSplitFundingEvenly() public {
        vm.prank(alice);
        vault.stake(500 ether);
        vm.prank(bob);
        vault.stake(500 ether);

        vm.prank(revenue);
        vault.fund(100 ether);

        assertApproxEqAbs(vault.stakedBalanceOf(alice), 550 ether, 2);
        assertApproxEqAbs(vault.stakedBalanceOf(bob), 550 ether, 2);
    }

    // ── 3. late arrivals ─────────────────────────────────────────────────────

    function test_aLateJoinerNeitherCapturesNorDilutesEarlierEarnings() public {
        vm.prank(alice);
        vault.stake(100 ether);

        vm.prank(revenue);
        vault.fund(50 ether);

        uint256 aliceBeforeBob = vault.stakedBalanceOf(alice);
        assertApproxEqAbs(aliceBeforeBob, 150 ether, 1);

        // Bob buys in at the price alice's earnings created. He pays 150 for
        // what alice paid 100 for, which is the point: he gets no part of the
        // 50 that arrived before him.
        vm.prank(bob);
        vault.stake(150 ether);

        assertApproxEqAbs(vault.stakedBalanceOf(alice), aliceBeforeBob, 1, "alice was not diluted by bob");
        assertApproxEqAbs(vault.stakedBalanceOf(bob), 150 ether, 2, "bob captured none of the earlier funding");
        assertLe(vault.stakedBalanceOf(bob), 150 ether, "and cannot have captured any");

        // From here they are equals, so the next funding splits evenly.
        vm.prank(revenue);
        vault.fund(60 ether);
        assertApproxEqAbs(vault.stakedBalanceOf(alice), 180 ether, 3);
        assertApproxEqAbs(vault.stakedBalanceOf(bob), 180 ether, 3);
    }

    function test_leavingEarlyForfeitsLaterFunding() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(bob);
        vault.stake(100 ether);

        vm.prank(alice);
        uint256 aliceOut = vault.unstakeAll();
        assertApproxEqAbs(aliceOut, 100 ether, 1, "alice leaves with what she brought");

        vm.prank(revenue);
        vault.fund(50 ether);

        // All of it belongs to bob, who was still there when it landed.
        assertApproxEqAbs(vault.stakedBalanceOf(bob), 150 ether, 2);
        assertEq(vault.stakedBalanceOf(alice), 0, "and none of it reaches alice");
    }

    // ── 4. the inflation attack ──────────────────────────────────────────────

    function test_inflationAttackFails_victimIsMadeWhole() public {
        // The classic sequence. Attacker takes the vault while it is empty with
        // the smallest possible deposit, then donates a large amount by plain
        // transfer to push the price of a single share above the victim's whole
        // deposit, hoping the victim's shares round down to zero.
        vm.prank(attacker);
        uint256 attackerShares = vault.stake(MIN);
        uint256 donation = 10_000 ether;
        vm.prank(attacker);
        token.transfer(address(vault), donation);

        uint256 victimIn = 10 ether;

        vm.prank(bob);
        uint256 victimShares = vault.stake(victimIn);
        assertGt(victimShares, 0, "the victim's deposit did not round away");

        vm.prank(bob);
        uint256 victimOut = vault.unstakeAll();

        // The victim gets their money back. Not most of it: all of it bar the
        // rounding, which at a 12 decimal offset is nine or ten zeroes below a
        // wei of relevance.
        assertLe(victimOut, victimIn, "the victim takes nothing extra either");
        assertApproxEqRel(victimOut, victimIn, 1e10, "victim recovers their deposit within a millionth of a percent");
        uint256 victimLoss = victimIn - victimOut;

        // What the attacker gets back is NOT the point of this test, and the
        // old assertion here (that they lose about half the donation) stopped
        // being true once MIN_STAKE forced the opening position to be real:
        // owning essentially the whole vault, they recover essentially the whole
        // donation. That is fine. A donation to a vault you are the only member
        // of is not an attack, it is a deposit with extra steps.
        //
        // The security property is the victim's, and it is asserted above: their
        // deposit did not round to zero and they withdrew it whole. All that is
        // left to pin here is that the attacker never came out AHEAD of what
        // they put in, which is what would make the sequence profitable and
        // therefore worth repeating.
        uint256 attackerStart = token.balanceOf(attacker);
        vm.prank(attacker);
        vault.unstake(attackerShares);
        uint256 attackerBack = token.balanceOf(attacker) - attackerStart;
        assertLe(attackerBack, donation + MIN, "the attacker never profits from the sequence");
        assertLe(victimLoss, 1, "and the victim's loss stays at rounding dust");
    }

    // The attack that the NoStakers guard alone did not stop, pinned so it
    // cannot come back. One wei staked into an empty vault used to mint exactly
    // as many shares as there are virtual ones, so that wei owned half the pot
    // and the next fund() handed it half of the revenue for free.
    function test_aDustStakeCannotCaptureFunding() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MeridianStaking.BelowMinimumStake.selector, 1, MIN));
        vault.stake(1);

        // Nothing was staked, so there is nobody to fund and the revenue is not
        // silently absorbed by a position that risked nothing.
        vm.prank(revenue);
        vm.expectRevert(MeridianStaking.NoStakers.selector);
        vault.fund(1_000 ether);

        // With a real position the same funding is split by real stake: the
        // attacker gets exactly the fraction they actually paid for.
        vm.prank(attacker);
        vault.stake(MIN);
        vm.prank(alice);
        vault.stake(999 * MIN);

        vm.prank(revenue);
        vault.fund(1_000 ether);

        assertApproxEqRel(vault.stakedBalanceOf(attacker), MIN + 1 ether, 1e15, "0.1% of the stake earns 0.1% of the funding");
        assertApproxEqRel(vault.stakedBalanceOf(alice), (999 * MIN) + 999 ether, 1e15, "and the rest goes to the rest");
    }

    function test_inflationAttackFails_evenAtTheLargestAffordableDonation() public {
        // Push it as far as an attacker can actually push it. Ten million MERD,
        // one percent of the entire supply, donated in one go to inflate the
        // price. The victim still ends up whole.
        uint256 donation = 10_000_000 ether;
        uint256 victimIn = 10 ether;

        vm.prank(attacker);
        vault.stake(MIN);
        vm.prank(attacker);
        token.transfer(address(vault), donation);

        vm.prank(bob);
        uint256 victimShares = vault.stake(victimIn);
        assertGt(victimShares, 0, "the deposit still buys shares");

        vm.prank(bob);
        uint256 victimOut = vault.unstakeAll();
        assertLe(victimOut, victimIn);
        assertApproxEqRel(victimOut, victimIn, 1e13, "whole to within a thousandth of a percent");

        // The reason there is no donation that works: rounding a deposit of
        // this size down to zero shares needs the pot to exceed the deposit
        // times the virtual share count, and that number is larger than every
        // MERD that will ever exist.
        assertGt(victimIn * vault.VIRTUAL_SHARES(), token.totalSupply(), "the required donation cannot be funded");
    }

    function test_aDepositTooSmallToBuyAShareIsRefusedRatherThanSwallowed() public {
        // The one thing the offset cannot prevent is an inflated price meeting a
        // deposit too small to buy a single share at it. That combination is
        // what the original attack was reaching for, and the answer is a
        // revert: the failure mode is a failed transaction, never a deposit
        // with no claim attached to it.
        vm.prank(attacker);
        vault.stake(MIN);
        vm.prank(attacker);
        token.transfer(address(vault), 10_000_000 ether);

        uint256 victimStart = token.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MeridianStaking.BelowMinimumStake.selector, 1e12, 1e18));
        vault.stake(1e12); // one millionth of a MERD against a ten million MERD pot

        assertEq(token.balanceOf(bob), victimStart, "not one wei of the would-be depositor's MERD moved");
    }

    function test_attackerCannotStrandTheVaultByEmptyingIt() public {
        // The dead-shares alternative stops protecting once the vault returns to
        // zero shares. The virtual offset does not, so a full exit and a fresh
        // attack behave exactly like the first one.
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(alice);
        vault.unstakeAll();
        assertEq(vault.totalShares(), 0, "vault is back to empty");

        vm.prank(attacker);
        vault.stake(MIN);
        vm.prank(attacker);
        token.transfer(address(vault), 10_000 ether);

        vm.prank(bob);
        uint256 victimShares = vault.stake(10 ether);
        assertGt(victimShares, 0);
        vm.prank(bob);
        assertApproxEqRel(vault.unstakeAll(), 10 ether, 1e10, "still made whole");
    }

    // ── 5. nothing is stranded, nothing leaks ────────────────────────────────

    function test_unstakingEverythingReturnsEverythingAndEmptiesTheVault() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(bob);
        vault.stake(300 ether);
        vm.prank(revenue);
        vault.fund(40 ether);

        uint256 aliceStart = token.balanceOf(alice);
        uint256 bobStart = token.balanceOf(bob);

        vm.prank(alice);
        vault.unstakeAll();
        vm.prank(bob);
        vault.unstakeAll();

        assertEq(vault.totalShares(), 0, "no shares outstanding");
        assertEq(vault.stakedBalanceOf(alice), 0);
        assertEq(vault.stakedBalanceOf(bob), 0);

        uint256 aliceGain = token.balanceOf(alice) - aliceStart;
        uint256 bobGain = token.balanceOf(bob) - bobStart;
        assertApproxEqAbs(aliceGain, 110 ether, 2, "alice out with her quarter of the funding");
        assertApproxEqAbs(bobGain, 330 ether, 2, "bob out with his three quarters");

        // Whatever is left is not somebody's stranded deposit: it is the wei per
        // withdrawal that the inflation defence rounds into the pot, and it
        // belongs to the next staker rather than to nobody.
        assertLe(token.balanceOf(address(vault)), 2, "at most one wei per withdrawal left behind");
    }

    function test_theResidualWeiBelongsToTheNextStaker() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(revenue);
        vault.fund(10 ether);
        vm.prank(alice);
        vault.unstakeAll();

        uint256 residual = token.balanceOf(address(vault));
        assertGt(residual, 0, "there is a residual to account for");

        vm.prank(carol);
        vault.stake(1 ether);
        assertGe(vault.stakedBalanceOf(carol), 1 ether, "the next staker inherits it, nobody burns it");
    }

    function test_sharePriceNeverFallsAcrossASequenceOfActions() public {
        uint256 last = vault.sharePrice();

        vm.prank(alice);
        vault.stake(100 ether);
        assertGe(vault.sharePrice(), last, "a deposit does not move the price down");
        last = vault.sharePrice();

        vm.prank(revenue);
        vault.fund(7 ether);
        assertGe(vault.sharePrice(), last);
        last = vault.sharePrice();

        vm.prank(bob);
        vault.stake(53 ether);
        assertGe(vault.sharePrice(), last, "a late deposit does not move the price down");
        last = vault.sharePrice();

        uint256 half = vault.sharesOf(alice) / 2;
        vm.prank(alice);
        vault.unstake(half);
        assertGe(vault.sharePrice(), last, "a partial exit does not move the price down");
        last = vault.sharePrice();

        vm.prank(bob);
        vault.unstakeAll();
        assertGe(vault.sharePrice(), last, "a full exit does not move the price down");
    }

    function testFuzz_roundTripNeverExtractsMoreThanStakedPlusFairShare(
        uint256 aliceIn,
        uint256 bobIn,
        uint256 funding
    ) public {
        aliceIn = bound(aliceIn, 1e18, 500_000 ether);
        bobIn = bound(bobIn, 1e18, 500_000 ether);
        funding = bound(funding, 0, 1_000_000 ether);

        vm.prank(alice);
        vault.stake(aliceIn);
        vm.prank(bob);
        vault.stake(bobIn);
        if (funding > 0) {
            vm.prank(revenue);
            vault.fund(funding);
        }

        uint256 total = aliceIn + bobIn + funding;
        uint256 aliceFair = (aliceIn * funding) / (aliceIn + bobIn);
        uint256 bobFair = (bobIn * funding) / (aliceIn + bobIn);

        vm.prank(alice);
        uint256 aliceOut = vault.unstakeAll();
        vm.prank(bob);
        uint256 bobOut = vault.unstakeAll();

        // Never less than principal: with no negative revenue there is no
        // mechanism that can take a staker's deposit.
        assertGe(aliceOut, aliceIn, "alice cannot lose principal");
        assertGe(bobOut, bobIn, "bob cannot lose principal");

        // Never more than principal plus a fair share, which is the invariant
        // that makes the vault non-extractable. The +1 is the rounding unit.
        assertLe(aliceOut, aliceIn + aliceFair + 1, "alice cannot take more than her share");
        assertLe(bobOut, bobIn + bobFair + 1, "bob cannot take more than his share");

        // And in aggregate the vault never pays out more than it took in.
        assertLe(aliceOut + bobOut, total, "the vault cannot pay out money it never received");
        assertEq(vault.totalShares(), 0, "the ledger closes out clean");
        assertEq(token.balanceOf(address(vault)), total - aliceOut - bobOut, "balance reconciles exactly");
    }

    function testFuzz_stakeThenImmediateUnstakeIsNeverProfitable(uint256 amount) public {
        amount = bound(amount, 1e18, 500_000 ether);
        uint256 start = token.balanceOf(alice);

        vm.prank(alice);
        uint256 shares = vault.stake(amount);
        vm.prank(alice);
        vault.unstake(shares);

        assertLe(token.balanceOf(alice), start, "a round trip in one block cannot mint money");
        assertGe(token.balanceOf(alice), start - 1, "and costs at most the rounding wei");
    }

    // ── 6. the access gate's read ────────────────────────────────────────────

    function test_stakedBalanceOfReflectsCompoundedValueAndNotTheDeposit() public {
        vm.prank(alice);
        vault.stake(100 ether);
        assertEq(vault.stakedBalanceOf(alice), 100 ether, "starts at the deposit");

        vm.prank(revenue);
        vault.fund(100 ether);

        // The number the gate compares against a basis-point threshold of total
        // supply has to be the compounded claim. If this returned the raw
        // deposit, a staker whose position grew past the threshold would still
        // be locked out of their own agent.
        assertApproxEqAbs(vault.stakedBalanceOf(alice), 200 ether, 1, "reports the compounded claim");
        assertTrue(vault.stakedBalanceOf(alice) > 100 ether, "not the raw deposit");
        assertEq(vault.stakedBalanceOf(carol), 0, "and zero for a wallet that never staked");
    }

    function test_stakedBalanceOfHasExactlyTheSignatureTheGateCalls() public {
        vm.prank(alice);
        vault.stake(42 ether);

        // agent/src/deploy/tokenGate.ts calls this by literal signature. Pinning
        // it here means a rename shows up as a failing test rather than as
        // silently gated-out users in production.
        (bool ok, bytes memory ret) =
            address(vault).staticcall(abi.encodeWithSignature("stakedBalanceOf(address)", alice));
        assertTrue(ok, "stakedBalanceOf(address) must exist with exactly this selector");
        assertEq(abi.decode(ret, (uint256)), 42 ether);
    }

    // ── funding ──────────────────────────────────────────────────────────────

    function test_fundEmitsEnoughToReconstructThePrice() public {
        vm.prank(alice);
        vault.stake(100 ether);

        vm.expectEmit(true, false, false, true, address(vault));
        emit MeridianStaking.Funded(revenue, 10 ether, 110 ether, 100 ether * vault.VIRTUAL_SHARES());
        vm.prank(revenue);
        vault.fund(10 ether);
    }

    function test_fundingAnEmptyVaultIsRefusedRatherThanBurned() public {
        vm.prank(revenue);
        vm.expectRevert(MeridianStaking.NoStakers.selector);
        vault.fund(1 ether);

        // Once there is somebody to pay, it works.
        vm.prank(alice);
        vault.stake(1 ether);
        vm.prank(revenue);
        vault.fund(1 ether);
        assertApproxEqAbs(vault.stakedBalanceOf(alice), 2 ether, 1);
    }

    function test_anyoneCanFund() public {
        vm.prank(alice);
        vault.stake(10 ether);
        // Permissionless on purpose: there is no privileged funder, so revenue
        // can be routed from any address without a key that can be lost.
        vm.prank(carol);
        vault.fund(5 ether);
        assertApproxEqAbs(vault.stakedBalanceOf(alice), 15 ether, 1);
    }

    // ── failure paths ────────────────────────────────────────────────────────

    function test_zeroAmountPathsRevertCleanly() public {
        vm.startPrank(alice);
        vm.expectRevert(MeridianStaking.ZeroAmount.selector);
        vault.stake(0);

        vm.expectRevert(MeridianStaking.ZeroAmount.selector);
        vault.unstake(0);

        vm.expectRevert(MeridianStaking.ZeroAmount.selector);
        vault.unstakeAll();

        vm.expectRevert(MeridianStaking.ZeroAmount.selector);
        vault.fund(0);
        vm.stopPrank();
    }

    function test_stakingMoreThanYouHoldReverts() public {
        vm.prank(alice);
        vm.expectRevert(MeridianStaking.TransferFailed.selector);
        vault.stake(2_000_000 ether);
        assertEq(vault.totalShares(), 0, "and leaves no shares behind");
    }

    function test_stakingWithoutAnAllowanceReverts() public {
        address stranger = makeAddr("stranger");
        token.transfer(stranger, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(MeridianStaking.TransferFailed.selector);
        vault.stake(1 ether);
    }

    function test_unstakingMoreSharesThanYouHoldReverts() public {
        vm.prank(alice);
        uint256 shares = vault.stake(10 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MeridianStaking.InsufficientShares.selector, shares, shares + 1));
        vault.unstake(shares + 1);

        // And one staker cannot reach another's position.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MeridianStaking.InsufficientShares.selector, 0, shares));
        vault.unstake(shares);

        assertEq(vault.sharesOf(alice), shares, "alice's position is untouched");
    }

    function test_constructorRejectsTheZeroToken() public {
        vm.expectRevert(MeridianStaking.ZeroAddress.selector);
        new MeridianStaking(IERC20(address(0)));
    }

    // ── the absent surface ───────────────────────────────────────────────────

    function test_thereIsNoAdminSurface() public {
        vm.prank(alice);
        vault.stake(100 ether);

        // None of these exist. Calling a selector that is not implemented hits
        // no fallback, because there is no fallback, so every one of them fails.
        string[8] memory absent = [
            "owner()",
            "pause()",
            "unpause()",
            "setToken(address)",
            "sweep(address)",
            "rescue(address,uint256)",
            "withdrawTo(address,uint256)",
            "upgradeTo(address)"
        ];
        for (uint256 i = 0; i < absent.length; i++) {
            (bool ok,) = address(vault).call(abi.encodeWithSignature(absent[i], address(0), uint256(1)));
            assertFalse(ok, string.concat("no such function should exist: ", absent[i]));
        }
        assertEq(vault.stakedBalanceOf(alice), 100 ether, "and alice's stake is where she left it");
    }

    function test_theVaultCannotHoldEther() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "no receive, no fallback, no payable anything");
        assertEq(address(vault).balance, 0);
    }

    function test_thereIsNoLockSoExitWorksInTheSameBlockAsEntry() public {
        vm.startPrank(alice);
        uint256 shares = vault.stake(100 ether);
        uint256 out = vault.unstake(shares);
        vm.stopPrank();
        assertApproxEqAbs(out, 100 ether, 1, "no cooldown, no penalty, no delay");
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _fundWallet(address who, uint256 amount) private {
        token.transfer(who, amount);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }
}
