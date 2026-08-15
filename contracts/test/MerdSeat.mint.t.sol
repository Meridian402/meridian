// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerdSeat} from "../MerdSeat.sol";

contract MockMerd {
    string public constant symbol = "MERD";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (balanceOf[from] < amt || allowance[from][msg.sender] < amt) return false;
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The Meridians' public mint LADDER, as the operator specced it on 2026-08-15:
// three per wallet, each rung with exactly one price and one payment route.
//   #1 free  ·  #2 discounted, in MERD, burned  ·  #3 outright, in ETH.
// Every rule here is a promise the mint page will make in public, so every
// rule gets a test that would fail loudly if the contract drifted from it.
// ─────────────────────────────────────────────────────────────────────────────
contract MerdSeatMintTest is Test {
    MerdSeat seat;
    MockMerd merd;
    address payout = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant PRICE_WEI = 0.008 ether; // the outright rung, ~$15 at deploy-time peg
    uint256 constant PRICE_MERD = 17_000e18; // the discounted rung, ~$10 at deploy-time peg
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        merd = new MockMerd();
        seat = new MerdSeat(1000, "https://meridian402.xyz/seat/", address(merd), 1_000_000e18, payout);
        seat.setPrices(PRICE_WEI, PRICE_MERD);
        seat.setMintOpen(true);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        merd.mint(alice, 1_000_000e18);
    }

    /// Climb alice through the full ladder. Reused so ladder-order tests stay terse.
    function _climb(uint256 rungs) internal {
        vm.startPrank(alice);
        if (rungs >= 1) seat.mintFree();
        if (rungs >= 2) {
            merd.approve(address(seat), PRICE_MERD);
            seat.mintPaidMerd();
        }
        if (rungs >= 3) seat.mintPaidEth{value: PRICE_WEI}();
        vm.stopPrank();
    }

    function test_collection_identity() public view {
        assertEq(seat.name(), "The Meridians");
        assertEq(seat.symbol(), "MERIDIAN");
        assertEq(seat.WALLET_CAP(), 3);
    }

    // ── rung 1: free ─────────────────────────────────────────────────────────

    function test_first_mint_is_free_and_assigns_sequential_ids() public {
        vm.prank(alice);
        uint256 a = seat.mintFree();
        vm.prank(bob);
        uint256 b = seat.mintFree();
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(seat.ownerOf(1), alice);
        assertEq(seat.ownerOf(2), bob);
    }

    function test_one_free_mint_per_wallet_ever() public {
        _climb(1);
        vm.prank(alice);
        vm.expectRevert(MerdSeat.FreeMintUsed.selector);
        seat.mintFree();
    }

    // ── the ladder is strict: each route only at its rung ────────────────────

    function test_eth_cannot_buy_the_second_seat() public {
        _climb(1);
        // The second seat is the DISCOUNTED one and it is paid in MERD. ETH
        // out of order is refused, not repriced.
        vm.prank(alice);
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI}();
    }

    function test_merd_cannot_buy_the_third_seat() public {
        _climb(2);
        vm.startPrank(alice);
        merd.approve(address(seat), PRICE_MERD);
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidMerd();
        vm.stopPrank();
    }

    function test_paying_for_the_first_mint_is_refused_not_pocketed() public {
        vm.startPrank(alice);
        merd.approve(address(seat), PRICE_MERD);
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidMerd();
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI}();
        vm.stopPrank();
        assertEq(payout.balance, 0, "no money was kept for a refused mint");
    }

    // ── rung 2: the MERD discount, burned ────────────────────────────────────

    function test_second_mint_burns_the_merd_payment() public {
        uint256 before = merd.balanceOf(alice);
        _climb(2);
        assertEq(merd.balanceOf(DEAD), PRICE_MERD, "the MERD goes to the dead address, not a wallet");
        assertEq(before - merd.balanceOf(alice), PRICE_MERD);
        assertEq(seat.totalBurnedForMints(), PRICE_MERD);
        assertEq(seat.balanceOf(alice), 2);
    }

    function test_merd_payment_without_approval_fails_cleanly() public {
        _climb(1);
        vm.prank(alice);
        vm.expectRevert(MerdSeat.BurnFailed.selector);
        seat.mintPaidMerd();
    }

    // ── rung 3: outright ETH to the payout address ───────────────────────────

    function test_third_mint_pays_the_payout_address_exactly() public {
        uint256 before = payout.balance;
        _climb(3);
        assertEq(payout.balance - before, PRICE_WEI, "the ETH lands at the payout address, all of it");
        assertEq(seat.balanceOf(alice), 3);
        assertEq(seat.mintedBy(alice), 3);
    }

    function test_wrong_eth_amount_is_refused_over_and_under() public {
        _climb(2);
        vm.startPrank(alice);
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI - 1}();
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI + 1}();
        vm.stopPrank();
    }

    // ── the wall at three ────────────────────────────────────────────────────

    function test_no_fourth_mint_at_any_price() public {
        _climb(3);
        vm.startPrank(alice);
        vm.expectRevert(MerdSeat.FreeMintUsed.selector);
        seat.mintFree();
        merd.approve(address(seat), PRICE_MERD);
        vm.expectRevert(MerdSeat.WalletCapReached.selector);
        seat.mintPaidMerd();
        vm.expectRevert(MerdSeat.WalletCapReached.selector);
        seat.mintPaidEth{value: PRICE_WEI}();
        vm.stopPrank();
        assertEq(seat.balanceOf(alice), 3, "three is the wall, no matter the route");
    }

    // ── supply, gating, and coexistence with the owner mint ──────────────────

    function test_mint_respects_the_supply_cap() public {
        seat.lowerMaxSupply(2);
        vm.prank(alice);
        seat.mintFree();
        vm.prank(bob);
        seat.mintFree();
        address carol = address(0xCA401);
        vm.prank(carol);
        vm.expectRevert(MerdSeat.SoldOut.selector);
        seat.mintFree();
    }

    function test_mint_is_closed_until_opened() public {
        seat.setMintOpen(false);
        vm.prank(alice);
        vm.expectRevert(MerdSeat.MintClosed.selector);
        seat.mintFree();
    }

    function test_public_cursor_skips_ids_the_owner_minted_by_hand() public {
        seat.mint(address(0xD00D), 1, "team");
        vm.prank(alice);
        uint256 id = seat.mintFree();
        assertEq(id, 2, "the cursor walks past hand-minted ids instead of reverting on them");
    }

    function test_only_owner_moves_prices_and_the_gate() public {
        vm.startPrank(alice);
        vm.expectRevert(MerdSeat.NotOwner.selector);
        seat.setPrices(1, 1);
        vm.expectRevert(MerdSeat.NotOwner.selector);
        seat.setMintOpen(false);
        vm.stopPrank();
    }
}
