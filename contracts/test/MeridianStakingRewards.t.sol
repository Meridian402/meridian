// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {MeridianStakingRewards} from "../MeridianStakingRewards.sol";

// This contract holds staked MERD and distributes USDG revenue. The tests are
// about the properties that make it safe to hold money, not the happy path:
//   - a staker earns EXACTLY their pro-rata share of what was funded while they
//     were staked, and nothing from before they staked;
//   - nobody can ever claim more USDG than was funded (no money is created);
//   - claiming never touches principal, and principal only ever returns to its
//     staker;
//   - a small reward over a large pool still distributes (no precision wipeout).

contract MockToken {
    string public name;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, uint8 d) { name = n; decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal");
        if (allowance[f][msg.sender] != type(uint256).max) { require(allowance[f][msg.sender] >= a, "allw"); allowance[f][msg.sender] -= a; }
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MeridianStakingRewardsTest is Test {
    MockToken merd;
    MockToken usdg;
    MeridianStakingRewards s;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address treasury = makeAddr("treasury");

    uint256 constant E18 = 1e18;
    uint256 constant USD = 1e6; // 1 USDG

    function setUp() public {
        merd = new MockToken("MERD", 18);
        usdg = new MockToken("USDG", 6);
        s = new MeridianStakingRewards(address(merd), address(usdg));
        address[4] memory us = _all();
        for (uint256 i; i < us.length; i++) {
            merd.mint(us[i], 1_000_000 * E18);
            vm.prank(us[i]); merd.approve(address(s), type(uint256).max);
        }
        usdg.mint(treasury, 1_000_000 * USD);
        vm.prank(treasury); usdg.approve(address(s), type(uint256).max);
    }

    function _all() internal view returns (address[4] memory) { return [alice, bob, carol, treasury]; }
    function _stake(address u, uint256 merdAmt) internal { vm.prank(u); s.stake(merdAmt); }
    function _fund(uint256 usdgAmt) internal { vm.prank(treasury); s.fund(usdgAmt); }

    // ── pro-rata correctness ────────────────────────────────────────────────

    function test_twoStakersSplitByShare() public {
        _stake(alice, 300 * E18); // 3/4
        _stake(bob, 100 * E18);   // 1/4
        _fund(100 * USD);
        // Allow 1 unit of rounding dust.
        assertApproxEqAbs(s.earned(alice), 75 * USD, 1, "alice 3/4");
        assertApproxEqAbs(s.earned(bob), 25 * USD, 1, "bob 1/4");
    }

    function test_stakingAfterAFundEarnsNothingFromIt() public {
        _stake(alice, 100 * E18);
        _fund(100 * USD);              // only alice staked
        _stake(bob, 100 * E18);        // bob joins AFTER
        assertApproxEqAbs(s.earned(alice), 100 * USD, 1, "alice got the whole first fund");
        assertEq(s.earned(bob), 0, "bob earns nothing from a fund before he staked");
        _fund(100 * USD);              // now split 50/50
        assertApproxEqAbs(s.earned(alice), 150 * USD, 2, "alice: 100 + 50");
        assertApproxEqAbs(s.earned(bob), 50 * USD, 1, "bob: 50 only");
    }

    function test_earnedIsStablePerStakeAcrossManyFunds() public {
        _stake(alice, 100 * E18);
        _stake(bob, 300 * E18);
        for (uint256 i; i < 20; i++) _fund(37 * USD); // odd number, exercises rounding
        uint256 total = s.earned(alice) + s.earned(bob);
        // No money created: total earned never exceeds total funded.
        assertLe(total, 20 * 37 * USD, "earned must not exceed funded");
        // And bob (3x stake) earns ~3x alice.
        assertApproxEqAbs(s.earned(bob), s.earned(alice) * 3, 20, "3x stake ~ 3x reward");
    }

    // ── conservation: no USDG is ever created ───────────────────────────────

    function test_totalClaimableNeverExceedsTotalFunded() public {
        _stake(alice, 123 * E18);
        _stake(bob, 456 * E18);
        _stake(carol, 789 * E18);
        uint256 funded;
        for (uint256 i; i < 15; i++) { _fund((i + 1) * USD); funded += (i + 1) * USD; }
        uint256 claimable = s.earned(alice) + s.earned(bob) + s.earned(carol);
        assertLe(claimable, funded, "sum of entitlements cannot exceed what was funded");
        // Whatever is left as dust stays IN the contract, never overspent.
        assertGe(usdg.balanceOf(address(s)), claimable, "contract holds at least what it owes");
    }

    // ── claiming ────────────────────────────────────────────────────────────

    function test_claimPaysUsdgAndLeavesPrincipalUntouched() public {
        _stake(alice, 200 * E18);
        _fund(50 * USD);
        uint256 merdBefore = s.stakedOf(alice);
        vm.prank(alice); uint256 owed = s.claim();
        assertApproxEqAbs(owed, 50 * USD, 1, "claimed the fund");
        assertEq(usdg.balanceOf(alice), owed, "usdg arrived");
        assertEq(s.stakedOf(alice), merdBefore, "principal untouched by a claim");
        assertEq(s.earned(alice), 0, "nothing left to claim right after");
    }

    function test_claimingTwiceDoesNotDoublePay() public {
        _stake(alice, 100 * E18);
        _fund(40 * USD);
        vm.prank(alice); s.claim();
        vm.prank(alice); uint256 second = s.claim();
        assertEq(second, 0, "a second claim with no new funding pays nothing");
    }

    function test_exitClaimsAndWithdrawsEverything() public {
        _stake(alice, 100 * E18);
        _fund(30 * USD);
        uint256 merdBefore = merd.balanceOf(alice);
        vm.prank(alice); s.exit();
        assertEq(s.stakedOf(alice), 0, "fully unstaked");
        assertEq(merd.balanceOf(alice), merdBefore + 100 * E18, "MERD returned");
        assertApproxEqAbs(usdg.balanceOf(alice), 30 * USD, 1, "USDG claimed");
    }

    // ── precision: small reward, big pool ───────────────────────────────────

    function test_smallRewardOverLargePoolStillDistributes() public {
        _stake(alice, 500_000 * E18);
        _stake(bob, 500_000 * E18);
        _fund(1 * USD); // one dollar over a million MERD
        // Each should get ~half a dollar; the point is it is NOT zero.
        assertGt(s.earned(alice), 0, "a small reward must not round to zero");
        assertApproxEqAbs(s.earned(alice), s.earned(bob), 1, "and it still splits evenly");
    }

    // ── guards ──────────────────────────────────────────────────────────────

    function test_fundWithNoStakersReverts() public {
        vm.prank(treasury);
        vm.expectRevert(MeridianStakingRewards.NoStakers.selector);
        s.fund(10 * USD);
    }

    function test_belowMinimumStakeReverts() public {
        vm.prank(alice);
        vm.expectRevert(MeridianStakingRewards.BelowMinimum.selector);
        s.stake(E18 / 2); // half a MERD
    }

    function test_cannotLeaveADustPosition() public {
        _stake(alice, 2 * E18);
        vm.prank(alice);
        vm.expectRevert(MeridianStakingRewards.DustLeft.selector);
        s.unstake(15 * (E18 / 10)); // unstake 1.5, leaving 0.5 MERD
    }

    function test_cannotUnstakeMoreThanStaked() public {
        _stake(alice, 10 * E18);
        vm.prank(alice);
        vm.expectRevert(MeridianStakingRewards.InsufficientStake.selector);
        s.unstake(11 * E18);
    }

    function test_unstakeSettlesRewardsFirst() public {
        _stake(alice, 100 * E18);
        _fund(20 * USD);
        vm.prank(alice); s.unstake(100 * E18); // full exit via unstake, no claim
        // The reward accrued while staked must survive the unstake, claimable after.
        assertApproxEqAbs(s.earned(alice), 20 * USD, 1, "reward survives unstaking");
        vm.prank(alice); uint256 owed = s.claim();
        assertApproxEqAbs(owed, 20 * USD, 1, "and can still be claimed");
    }
}
