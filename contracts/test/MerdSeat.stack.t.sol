// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerdSeat} from "../MerdSeat.sol";
import {SeatAccount} from "../SeatAccount.sol";
import {AgentTreasury} from "../AgentTreasury.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The whole product, tested as one stack:
//
//     seat NFT  →  token-bound account  →  AgentTreasury  →  agent works it
//
// The claim a buyer is being asked to believe is a single sentence: SELLING THE
// SEAT SELLS THE DESK UNDER IT. Everything here exists to prove or break that,
// including the cases where it would be most embarrassing to be wrong: after
// the agent has been working, mid-epoch, with fees already accrued.
// ─────────────────────────────────────────────────────────────────────────────

contract MerdSeatStackTest is Test {
    MerdSeat seat;
    SeatAccount account;
    AgentTreasury treasury;

    address deployer = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address agent = address(0xBEEF);
    address contributor = address(0xC0FFEE);
    uint256 constant SEAT_ID = 1;
    uint256 constant EPOCH = 7 days;
    address NATIVE;

    function setUp() public {
        seat = new MerdSeat(12, "https://meridian402.xyz/seat/");
        seat.mint(alice, SEAT_ID, "venue-maker");

        // In production the registry deploys this deterministically; deploying
        // and initializing directly exercises identical logic.
        account = new SeatAccount();
        account.initialize(block.chainid, address(seat), SEAT_ID);

        // The seat's account owns the treasury. Nobody else does, including us.
        treasury = new AgentTreasury(address(account), agent, EPOCH);
        NATIVE = treasury.NATIVE();
        vm.deal(address(treasury), 10 ether);
    }

    // ── the claim ────────────────────────────────────────────────────────────

    function test_the_seat_holder_controls_the_treasury() public {
        assertEq(account.owner(), alice, "the account reads through to the seat holder");
        assertEq(treasury.owner(), address(account), "and the account owns the treasury");

        // Alice moves treasury money by executing through her seat's account.
        bytes memory call_ = abi.encodeCall(AgentTreasury.withdraw, (NATIVE, alice, 3 ether));
        vm.prank(alice);
        account.execute(address(treasury), 0, call_, 0);
        assertEq(alice.balance, 3 ether);
    }

    /// The sentence the whole product rests on.
    function test_selling_the_seat_sells_the_desk() public {
        // Alice's agent has been working: fees accrued, a payee approved, spend made.
        bytes memory approve_ = abi.encodeCall(AgentTreasury.setPayee, (contributor, true));
        bytes memory cap_ = abi.encodeCall(AgentTreasury.setCap, (NATIVE, 1 ether));
        vm.startPrank(alice);
        account.execute(address(treasury), 0, approve_, 0);
        account.execute(address(treasury), 0, cap_, 0);
        vm.stopPrank();
        vm.prank(agent);
        treasury.agentPay(NATIVE, contributor, 0.4 ether);

        uint256 desk = address(treasury).balance;
        assertEq(desk, 9.6 ether);

        // Alice sells the seat.
        vm.prank(alice);
        seat.transferFrom(alice, bob, SEAT_ID);

        // Everything moved with it, with no migration step and no admin action.
        assertEq(account.owner(), bob, "control follows the NFT");
        assertEq(address(treasury).balance, desk, "the balance did not move, the owner did");
        vm.prank(bob);
        account.execute(address(treasury), 0, abi.encodeCall(AgentTreasury.withdraw, (NATIVE, bob, desk)), 0);
        assertEq(bob.balance, desk, "and the new holder can take all of it");
    }

    function test_the_previous_holder_keeps_nothing() public {
        vm.prank(alice);
        seat.transferFrom(alice, bob, SEAT_ID);
        bytes memory call_ = abi.encodeCall(AgentTreasury.withdraw, (NATIVE, alice, 1 ether));
        vm.prank(alice);
        vm.expectRevert(SeatAccount.NotOwner.selector);
        account.execute(address(treasury), 0, call_, 0);
    }

    function test_the_agent_keeps_working_across_a_sale_but_stays_capped() public {
        vm.startPrank(alice);
        account.execute(address(treasury), 0, abi.encodeCall(AgentTreasury.setPayee, (contributor, true)), 0);
        account.execute(address(treasury), 0, abi.encodeCall(AgentTreasury.setCap, (NATIVE, 1 ether)), 0);
        vm.stopPrank();

        vm.prank(agent);
        treasury.agentPay(NATIVE, contributor, 0.6 ether);
        vm.prank(alice);
        seat.transferFrom(alice, bob, SEAT_ID);

        // The meter belongs to the epoch, not to the seat holder: a sale must
        // not hand the agent a fresh budget.
        assertEq(treasury.remainingThisEpoch(NATIVE), 0.4 ether, "the epoch survives the sale");
        vm.prank(agent);
        treasury.agentPay(NATIVE, contributor, 0.4 ether);

        // And the new owner can fire the agent outright.
        vm.prank(bob);
        account.execute(address(treasury), 0, abi.encodeCall(AgentTreasury.setAgent, (address(0))), 0);
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotAgent.selector);
        treasury.agentPay(NATIVE, contributor, 1);
    }

    // ── the account itself ───────────────────────────────────────────────────

    function test_nobody_but_the_holder_can_execute() public {
        bytes memory call_ = abi.encodeCall(AgentTreasury.withdraw, (NATIVE, bob, 1 ether));
        for (uint256 i = 0; i < 3; i++) {
            address who = [bob, agent, deployer][i];
            vm.prank(who);
            vm.expectRevert(SeatAccount.NotOwner.selector);
            account.execute(address(treasury), 0, call_, 0);
        }
    }

    /// DELEGATECALL would let one malicious target rewrite this account's
    /// storage and detach it from its NFT, which would break the only promise
    /// the product makes.
    function test_delegatecall_is_refused() public {
        vm.prank(alice);
        vm.expectRevert(SeatAccount.UnsupportedOperation.selector);
        account.execute(address(treasury), 0, "", 1);
    }

    function test_account_cannot_be_reinitialized_to_another_nft() public {
        vm.expectRevert(SeatAccount.AlreadyInitialized.selector);
        account.initialize(block.chainid, address(seat), 999);
    }

    // ── supply honesty ───────────────────────────────────────────────────────

    function test_supply_can_shrink_but_never_grow() public {
        seat.lowerMaxSupply(3);
        assertEq(seat.maxSupply(), 3);
        vm.expectRevert(MerdSeat.CannotRaiseSupply.selector);
        seat.lowerMaxSupply(50);
        vm.expectRevert(MerdSeat.CannotRaiseSupply.selector);
        seat.lowerMaxSupply(3);
    }

    function test_cannot_lower_supply_below_seats_already_sold() public {
        seat.mint(bob, 2, "scout");
        vm.expectRevert(MerdSeat.CannotRaiseSupply.selector);
        seat.lowerMaxSupply(1);
    }

    function test_seats_carry_their_role() public {
        assertEq(seat.roleOf(SEAT_ID), "venue-maker");
        seat.mint(bob, 7, "scout");
        assertEq(seat.roleOf(7), "scout");
    }

    function test_mint_stops_at_max_supply() public {
        seat.lowerMaxSupply(2);
        seat.mint(bob, 2, "scout");
        vm.expectRevert(MerdSeat.SoldOut.selector);
        seat.mint(bob, 3, "watcher");
    }
}
