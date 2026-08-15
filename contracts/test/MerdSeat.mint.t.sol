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
// The Meridians' public mint, as the operator specced it on 2026-08-15:
// two per wallet, the first free, the second $15 paid in MERD (burned) or
// ETH (to the payout address). Every rule here is a promise the mint page
// will make in public, so every rule gets a test that would fail loudly if
// the contract drifted from the promise.
// ─────────────────────────────────────────────────────────────────────────────
contract MerdSeatMintTest is Test {
    MerdSeat seat;
    MockMerd merd;
    address payout = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant PRICE_WEI = 0.008 ether; // ~$15 at deploy-time peg
    uint256 constant PRICE_MERD = 25_000e18; // ~$15 of MERD at deploy-time peg
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

    function test_collection_identity() public view {
        assertEq(seat.name(), "The Meridians");
        assertEq(seat.symbol(), "MERIDIAN");
    }

    // ── the free first mint ──────────────────────────────────────────────────

    function test_first_mint_is_free_and_assigns_sequential_ids() public {
        vm.prank(alice);
        uint256 a = seat.mintFree();
        vm.prank(bob);
        uint256 b = seat.mintFree();
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(seat.ownerOf(1), alice);
        assertEq(seat.ownerOf(2), bob);
        assertEq(seat.totalSupply(), 2);
    }

    function test_one_free_mint_per_wallet_ever() public {
        vm.startPrank(alice);
        seat.mintFree();
        vm.expectRevert(MerdSeat.FreeMintUsed.selector);
        seat.mintFree();
        vm.stopPrank();
    }

    function test_paying_for_the_first_mint_is_refused_not_pocketed() public {
        // The paid path is the SECOND mint. A wallet that tries to pay for its
        // first would be overpaying for what is free; the contract refuses
        // rather than keeping the money.
        vm.prank(alice);
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI}();
    }

    // ── the paid second mint ─────────────────────────────────────────────────

    function test_second_mint_in_eth_pays_the_payout_address_exactly() public {
        vm.startPrank(alice);
        seat.mintFree();
        uint256 before = payout.balance;
        uint256 id = seat.mintPaidEth{value: PRICE_WEI}();
        vm.stopPrank();
        assertEq(payout.balance - before, PRICE_WEI, "the ETH lands at the payout address, all of it");
        assertEq(seat.ownerOf(id), alice);
        assertEq(seat.mintedBy(alice), 2);
    }

    function test_wrong_eth_amount_is_refused_over_and_under() public {
        vm.startPrank(alice);
        seat.mintFree();
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI - 1}();
        vm.expectRevert(MerdSeat.WrongPayment.selector);
        seat.mintPaidEth{value: PRICE_WEI + 1}();
        vm.stopPrank();
    }

    function test_second_mint_in_merd_burns_the_payment() public {
        vm.startPrank(alice);
        seat.mintFree();
        merd.approve(address(seat), PRICE_MERD);
        uint256 supplyBefore = merd.balanceOf(alice);
        seat.mintPaidMerd();
        vm.stopPrank();
        assertEq(merd.balanceOf(DEAD), PRICE_MERD, "the MERD goes to the dead address, not a wallet");
        assertEq(supplyBefore - merd.balanceOf(alice), PRICE_MERD);
        assertEq(seat.totalBurnedForMints(), PRICE_MERD);
    }

    function test_merd_payment_without_approval_fails_cleanly() public {
        vm.startPrank(alice);
        seat.mintFree();
        vm.expectRevert(MerdSeat.BurnFailed.selector);
        seat.mintPaidMerd();
        vm.stopPrank();
    }

    // ── the wall at two ──────────────────────────────────────────────────────

    function test_no_third_mint_at_any_price() public {
        vm.startPrank(alice);
        seat.mintFree();
        seat.mintPaidEth{value: PRICE_WEI}();
        vm.expectRevert(MerdSeat.WalletCapReached.selector);
        seat.mintPaidEth{value: PRICE_WEI}();
        merd.approve(address(seat), PRICE_MERD);
        vm.expectRevert(MerdSeat.WalletCapReached.selector);
        seat.mintPaidMerd();
        vm.expectRevert(MerdSeat.FreeMintUsed.selector);
        seat.mintFree();
        vm.stopPrank();
        assertEq(seat.balanceOf(alice), 2, "two is the wall, no matter the route");
    }

    // ── supply, gating, and coexistence with the owner mint ──────────────────

    function test_mint_respects_the_1000_cap() public {
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
