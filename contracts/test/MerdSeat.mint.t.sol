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
// The v2.4 ladder, the raffle, and the royalty signal. Every rule here is a
// promise the mint page will make in public, so every rule gets a test that
// fails loudly if the contract drifts from it.
//   holder rung: free · hold the MERD bar · one per wallet · 250 tranche cap
//   paid 1..3:   entry price, BURNED
//   paid 4:      tier 2, to the treasury
//   paid 5+:     tier 3 each, to the treasury, no wallet cap
//   raffle:      commit before mint, reveal after sellout, twenty seats
//   royalty:     ERC-2981 to the treasury, adjustable under a bytecode ceiling
// ─────────────────────────────────────────────────────────────────────────────
contract MerdSeatMintTest is Test {
    MerdSeat seat;
    MockMerd merd;
    address payout = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant HOLD_BAR = 50_000e18; // ~$30 target at deploy-time peg
    uint256 constant P_ENTRY = 17_000e18; // ~$10
    uint256 constant P_TIER2 = 50_000e18; // ~$30
    uint256 constant P_TIER3 = 170_000e18; // ~$100
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        merd = new MockMerd();
        seat = new MerdSeat(1000, "https://meridian402.xyz/seat/", address(merd), payout);
        seat.setPrices(HOLD_BAR, P_ENTRY, P_TIER2, P_TIER3);
        seat.setMintOpen(true);
        merd.mint(alice, 10_000_000e18);
        vm.prank(alice);
        merd.approve(address(seat), type(uint256).max);
    }

    // ── the holder rung ──────────────────────────────────────────────────────

    function test_holder_rung_requires_the_hold_bar() public {
        vm.prank(bob); // bob holds no MERD
        vm.expectRevert(MerdSeat.InsufficientHold.selector);
        seat.mintHolder();

        merd.mint(bob, HOLD_BAR);
        vm.prank(bob);
        uint256 id = seat.mintHolder();
        assertEq(seat.ownerOf(id), bob);
        // holding, not spending: the bar stays in bob's wallet
        assertEq(merd.balanceOf(bob), HOLD_BAR);
    }

    function test_holder_rung_is_once_per_wallet() public {
        vm.startPrank(alice);
        seat.mintHolder();
        vm.expectRevert(MerdSeat.HolderRungUsed.selector);
        seat.mintHolder();
        vm.stopPrank();
    }

    function test_holder_rung_tranche_cap_bounds_the_farm() public {
        // 250 wallets mint free; the 251st holder is refused even with the bar.
        for (uint256 i = 1; i <= 250; i++) {
            address w = address(uint160(0x10000 + i));
            merd.mint(w, HOLD_BAR);
            vm.prank(w);
            seat.mintHolder();
        }
        assertEq(seat.freeMinted(), 250);
        address late = address(0x99999);
        merd.mint(late, HOLD_BAR);
        vm.prank(late);
        vm.expectRevert(MerdSeat.HolderRungExhausted.selector);
        seat.mintHolder();
    }

    function test_holder_rung_does_not_consume_a_paid_slot() public {
        vm.startPrank(alice);
        seat.mintHolder();
        seat.mintPaid();
        vm.stopPrank();
        // the paid mint was #1 paid: entry price burned
        assertEq(merd.balanceOf(DEAD), P_ENTRY);
        assertEq(seat.paidMintedBy(alice), 1);
    }

    // ── the paid ladder ──────────────────────────────────────────────────────

    function test_first_three_paid_seats_burn_the_entry_price() public {
        vm.startPrank(alice);
        seat.mintPaid();
        seat.mintPaid();
        seat.mintPaid();
        vm.stopPrank();
        assertEq(merd.balanceOf(DEAD), 3 * P_ENTRY, "entry tier burns");
        assertEq(merd.balanceOf(payout), 0, "treasury gets nothing at entry");
        assertEq(seat.totalBurnedForMints(), 3 * P_ENTRY);
    }

    function test_fourth_seat_pays_tier2_to_the_treasury() public {
        vm.startPrank(alice);
        for (uint256 i = 0; i < 3; i++) seat.mintPaid();
        seat.mintPaid(); // #4
        vm.stopPrank();
        assertEq(merd.balanceOf(payout), P_TIER2, "tier 2 pays the treasury");
        assertEq(merd.balanceOf(DEAD), 3 * P_ENTRY, "burn total unchanged");
        assertEq(seat.totalPaidToTreasury(), P_TIER2);
    }

    function test_every_seat_after_the_fifth_costs_tier3_with_no_cap() public {
        vm.startPrank(alice);
        for (uint256 i = 0; i < 4; i++) seat.mintPaid(); // 3 entry + tier2
        for (uint256 i = 0; i < 5; i++) seat.mintPaid(); // five tier3 seats
        vm.stopPrank();
        assertEq(seat.paidMintedBy(alice), 9, "no wallet cap beyond pricing");
        assertEq(merd.balanceOf(payout), P_TIER2 + 5 * P_TIER3);
    }

    function test_unset_prices_refuse_rather_than_mint_free() public {
        MerdSeat fresh = new MerdSeat(10, "u/", address(merd), payout);
        fresh.setMintOpen(true);
        vm.prank(alice);
        vm.expectRevert(MerdSeat.PriceNotSet.selector);
        fresh.mintPaid();
        vm.prank(alice);
        vm.expectRevert(MerdSeat.PriceNotSet.selector);
        fresh.mintHolder();
    }

    function test_mint_closed_refuses_everyone() public {
        seat.setMintOpen(false);
        vm.prank(alice);
        vm.expectRevert(MerdSeat.MintClosed.selector);
        seat.mintPaid();
    }

    function test_sellout_is_final() public {
        MerdSeat tiny = new MerdSeat(2, "u/", address(merd), payout);
        tiny.setPrices(HOLD_BAR, P_ENTRY, P_TIER2, P_TIER3);
        tiny.setMintOpen(true);
        vm.startPrank(alice);
        merd.approve(address(tiny), type(uint256).max);
        tiny.mintPaid();
        tiny.mintPaid();
        vm.expectRevert(MerdSeat.SoldOut.selector);
        tiny.mintPaid();
        vm.stopPrank();
    }

    // ── the raffle ───────────────────────────────────────────────────────────

    function _selloutTiny(uint256 supply) internal returns (MerdSeat tiny) {
        tiny = new MerdSeat(supply, "u/", address(merd), payout);
        tiny.setPrices(HOLD_BAR, P_ENTRY, P_TIER2, P_TIER3);
        tiny.commitRaffle(keccak256(abi.encodePacked(bytes32("salt"))));
        tiny.setMintOpen(true);
        vm.startPrank(alice);
        merd.approve(address(tiny), type(uint256).max);
        for (uint256 i = 0; i < supply; i++) tiny.mintPaid();
        vm.stopPrank();
    }

    /// Arm the raffle and roll past the entropy block so a reveal is valid.
    function _armAndRoll(MerdSeat tiny) internal {
        tiny.armRaffle();
        vm.roll(block.number + tiny.REVEAL_DELAY() + 1);
    }

    function test_raffle_commit_is_one_shot() public {
        seat.commitRaffle(keccak256("c"));
        vm.expectRevert(MerdSeat.RaffleAlreadyCommitted.selector);
        seat.commitRaffle(keccak256("c2"));
    }

    function test_raffle_cannot_arm_before_mint_is_done() public {
        seat.commitRaffle(keccak256(abi.encodePacked(bytes32("salt"))));
        seat.setMintOpen(true); // open, not sold out
        vm.expectRevert(MerdSeat.RaffleMintNotDone.selector);
        seat.armRaffle();
    }

    function test_raffle_cannot_arm_without_enough_public_seats() public {
        seat.commitRaffle(keccak256(abi.encodePacked(bytes32("salt"))));
        seat.setMintOpen(true);
        vm.startPrank(alice);
        for (uint256 i = 0; i < 5; i++) seat.mintPaid();
        vm.stopPrank();
        seat.setMintOpen(false); // mint done, but only 5 eligible < 20
        vm.expectRevert(MerdSeat.NotEnoughEligible.selector);
        seat.armRaffle();
    }

    function test_raffle_cannot_reveal_before_armed() public {
        seat.commitRaffle(keccak256(abi.encodePacked(bytes32("salt"))));
        vm.expectRevert(MerdSeat.RaffleNotArmed.selector);
        seat.revealRaffle(bytes32("salt"));
    }

    function test_raffle_cannot_reveal_before_the_armed_block() public {
        MerdSeat tiny = _selloutTiny(25);
        tiny.armRaffle(); // revealBlock is in the future
        vm.expectRevert(MerdSeat.RaffleNotReady.selector);
        tiny.revealRaffle(bytes32("salt"));
    }

    function test_raffle_rejects_a_wrong_salt() public {
        MerdSeat tiny = _selloutTiny(25);
        _armAndRoll(tiny);
        vm.expectRevert(MerdSeat.BadSalt.selector);
        tiny.revealRaffle(bytes32("wrong"));
    }

    function test_raffle_draws_twenty_unique_engine_seats() public {
        MerdSeat tiny = _selloutTiny(25);
        _armAndRoll(tiny);
        tiny.revealRaffle(bytes32("salt"));
        assertTrue(tiny.raffleRevealed());
        uint256 count;
        for (uint256 id = 1; id <= 25; id++) {
            if (tiny.isEngineSeat(id)) count++;
        }
        assertEq(count, 20, "exactly twenty seats carry the engine");
        assertTrue(tiny.hasEngineSeat(alice), "the holder of drawn seats passes the gate");
        assertEq(tiny.engineSeatsOf(alice), 20);
    }

    function test_raffle_reveals_once() public {
        MerdSeat tiny = _selloutTiny(25);
        _armAndRoll(tiny);
        tiny.revealRaffle(bytes32("salt"));
        vm.expectRevert(MerdSeat.RaffleAlreadyRevealed.selector);
        tiny.revealRaffle(bytes32("salt"));
    }

    function test_owner_mints_are_never_raffle_eligible() public {
        // The pool-stuffing exploit (audit finding 1): the owner free-mints
        // seats to itself, then genuine public mints happen, and the draw must
        // NEVER land on the owner's stuffed ids.
        MerdSeat tiny = new MerdSeat(60, "u/", address(merd), payout);
        tiny.setPrices(HOLD_BAR, P_ENTRY, P_TIER2, P_TIER3);
        tiny.commitRaffle(keccak256(abi.encodePacked(bytes32("salt"))));
        for (uint256 i = 0; i < 30; i++) tiny.mint(bob, 900 + i, "meridian"); // owner stuffs 30
        tiny.setMintOpen(true);
        vm.startPrank(alice);
        merd.approve(address(tiny), type(uint256).max);
        for (uint256 i = 0; i < 25; i++) tiny.mintPaid(); // 25 genuine public
        vm.stopPrank();
        tiny.setMintOpen(false);
        _armAndRoll(tiny);
        tiny.revealRaffle(bytes32("salt"));
        assertEq(tiny.engineSeatsOf(bob), 0, "owner self-mints won nothing");
        assertEq(tiny.engineSeatsOf(alice), 20, "all twenty went to public minters");
        for (uint256 id = 900; id < 930; id++) {
            assertFalse(tiny.isEngineSeat(id), "a stuffed id is never an engine seat");
        }
    }

    function test_engine_seat_trait_travels_on_transfer() public {
        MerdSeat tiny = _selloutTiny(25);
        _armAndRoll(tiny);
        tiny.revealRaffle(bytes32("salt"));
        // find one engine seat and one plain seat
        uint256 engineId;
        uint256 plainId;
        for (uint256 id = 1; id <= 25; id++) {
            if (tiny.isEngineSeat(id) && engineId == 0) engineId = id;
            if (!tiny.isEngineSeat(id) && plainId == 0) plainId = id;
        }
        vm.startPrank(alice);
        tiny.transferFrom(alice, bob, plainId);
        assertFalse(tiny.hasEngineSeat(bob), "a plain seat moves no engine access");
        tiny.transferFrom(alice, bob, engineId);
        vm.stopPrank();
        assertTrue(tiny.hasEngineSeat(bob), "the trait travels with the seat");
        assertEq(tiny.engineSeatsOf(alice), 19);
        assertEq(tiny.engineSeatsOf(bob), 1);
    }

    // ── royalties ────────────────────────────────────────────────────────────

    function test_royalty_signals_the_treasury_at_the_default_rate() public view {
        (address receiver, uint256 amount) = seat.royaltyInfo(1, 10_000e18);
        assertEq(receiver, payout);
        assertEq(amount, 500e18, "5% default");
    }

    function test_royalty_ceiling_is_bytecode() public {
        seat.setRoyaltyBps(1000); // the ceiling itself is fine
        vm.expectRevert(MerdSeat.RoyaltyAboveCeiling.selector);
        seat.setRoyaltyBps(1001);
    }

    function test_royalty_interface_is_declared() public view {
        assertTrue(seat.supportsInterface(0x2a55205a), "ERC-2981");
    }
}
