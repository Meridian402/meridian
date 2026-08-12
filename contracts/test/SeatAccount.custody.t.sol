// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerdSeat} from "../MerdSeat.sol";
import {SeatAccount} from "../SeatAccount.sol";
import {AgentTreasury} from "../AgentTreasury.sol";
import {MockRegistry} from "./MerdSeat.stack.t.sol";

// ─────────────────────────────────────────────────────────────────────────────
// CUSTODY: can a seat's account hold things, and specifically can it hold other
// seats.
//
// This suite exists because of a defect the rest of the tests could not see.
// SeatAccount had receive() for ETH and nothing else, so it accepted ETH and
// ERC-20s while REVERTING on every safeTransferFrom of an NFT. Nothing failed
// at deployment. It would have failed the first time anyone tried to send the
// account a token, which is to say the first time anyone tried to use it.
//
// The nesting tests are the ones that matter for what we are actually building:
//
//     human  →  seat #1  →  its account IS the agent  →  holds seats #2, #3…
//
// The agent gets an address derivable from an NFT a human owns, custodies its
// own positions, and stays recoverable: one execute() through the root seat
// takes everything back, with no cooperation from the agent and no admin key.
// ─────────────────────────────────────────────────────────────────────────────

/// A contract that holds no opinion about NFTs, which is the common case.
/// Sending a seat here with the safe path must revert rather than strand it.
contract Deaf {}

/// Accepts ERC-721 but returns the wrong magic value, the failure mode a naive
/// `to.code.length == 0` check would wave through.
contract Liar {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract SeatAccountCustodyTest is Test {
    address constant MERD_TREASURY = 0x475C1fe4d1e7A703eaca6141978b04010e410Bf4;
    address constant MERD_TOKEN = 0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8;

    MerdSeat seat;
    MockRegistry registry;
    address implementation;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant ROOT = 1; // the seat the human holds
    uint256 constant HELD = 2; // a seat the agent holds inside it

    SeatAccount rootAccount;

    function setUp() public {
        seat = new MerdSeat(1000, "https://meridian402.xyz/seat/", MERD_TOKEN, 1_000_000e18);
        registry = new MockRegistry();
        implementation = address(new SeatAccount());
        seat.mint(alice, ROOT, "root");
        rootAccount = _accountFor(ROOT);
    }

    function _accountFor(uint256 id) internal returns (SeatAccount) {
        return SeatAccount(payable(registry.createAccount(implementation, block.chainid, address(seat), id)));
    }

    // ── the defect ───────────────────────────────────────────────────────────

    /// The regression test. Before the receiver hooks existed this reverted with
    /// UnsafeRecipient, and an account could not be given an NFT at all.
    function test_an_account_can_be_sent_an_nft_safely() public {
        seat.mint(bob, HELD, "held");
        vm.prank(bob);
        seat.safeTransferFrom(bob, address(rootAccount), HELD);
        assertEq(seat.ownerOf(HELD), address(rootAccount), "the account is a real custodian");
    }

    /// Minting straight to an account, which is how a seat would be issued to an
    /// agent rather than handed over afterwards.
    function test_a_seat_can_be_minted_directly_to_an_account() public {
        seat.mint(address(rootAccount), HELD, "agent-issued");
        assertEq(seat.ownerOf(HELD), address(rootAccount));
        assertEq(seat.balanceOf(address(rootAccount)), 1);
    }

    function test_the_receiver_interfaces_are_advertised() public view {
        assertTrue(rootAccount.supportsInterface(0x150b7a02), "IERC721Receiver");
        assertTrue(rootAccount.supportsInterface(0x4e2312e0), "IERC1155Receiver");
        assertTrue(rootAccount.supportsInterface(0x6faff5f1), "IERC6551Account still holds");
        assertTrue(rootAccount.supportsInterface(0x51945447), "IERC6551Executable still holds");
        assertFalse(rootAccount.supportsInterface(0xffffffff));
    }

    function test_erc1155_hooks_answer_correctly() public view {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        assertEq(rootAccount.onERC1155Received(address(0), address(0), 1, 1, ""), bytes4(0xf23a6e61));
        assertEq(rootAccount.onERC1155BatchReceived(address(0), address(0), ids, amounts, ""), bytes4(0xbc197c81));
    }

    // ── minting somewhere that cannot hold a seat ────────────────────────────

    function test_minting_into_a_contract_that_cannot_hold_it_reverts() public {
        address deaf = address(new Deaf()); // hoisted: expectRevert arms the NEXT call, and CREATE would eat it
        vm.expectRevert(MerdSeat.UnsafeRecipient.selector);
        seat.mint(deaf, HELD, "stranded");
    }

    function test_a_wrong_magic_value_is_not_good_enough() public {
        address liar = address(new Liar());
        vm.expectRevert(MerdSeat.UnsafeRecipient.selector);
        seat.mint(liar, HELD, "stranded");
    }

    /// A refusal must arrive with its reason intact. Flattening every failure
    /// into UnsafeRecipient would have made the cycle guard undiagnosable from
    /// outside, which is how a guard ends up quietly removed later.
    function test_a_recipients_own_revert_reason_survives() public {
        vm.prank(alice);
        vm.expectRevert(SeatAccount.OwnershipCycle.selector);
        seat.safeTransferFrom(alice, address(rootAccount), ROOT);
    }

    /// A failed mint must leave no trace, or supply accounting drifts every time
    /// someone fat-fingers a destination.
    function test_a_refused_mint_does_not_consume_supply() public {
        address deaf = address(new Deaf());
        vm.expectRevert(MerdSeat.UnsafeRecipient.selector);
        seat.mint(deaf, HELD, "stranded");
        assertEq(seat.totalSupply(), 1, "supply is unchanged");
        assertEq(seat.balanceOf(deaf), 0);
        // and the id is still free
        seat.mint(alice, HELD, "second try");
        assertEq(seat.ownerOf(HELD), alice);
    }

    function test_minting_to_an_eoa_is_unaffected() public {
        seat.mint(bob, HELD, "plain");
        assertEq(seat.ownerOf(HELD), bob);
    }

    // ── the cycle guard ──────────────────────────────────────────────────────

    /// The one that bricks a seat permanently: an account holding the NFT that
    /// owns it. ownerOf resolves to the account, no key can execute through it,
    /// and there is no admin to unwind it.
    function test_an_account_refuses_the_seat_that_owns_it() public {
        vm.prank(alice);
        vm.expectRevert(SeatAccount.OwnershipCycle.selector);
        seat.safeTransferFrom(alice, address(rootAccount), ROOT);
        assertEq(seat.ownerOf(ROOT), alice, "the seat never left");
    }

    /// The guard must be narrow. Refusing a DIFFERENT id from the same
    /// collection would make nesting impossible, which is the whole feature.
    function test_the_guard_refuses_only_its_own_id() public {
        seat.mint(bob, HELD, "sibling");
        vm.prank(bob);
        seat.safeTransferFrom(bob, address(rootAccount), HELD);
        assertEq(seat.ownerOf(HELD), address(rootAccount), "siblings are fine");
    }

    /// Documenting the limit rather than pretending it does not exist: the
    /// guard lives in a receiver hook, and a plain transferFrom never calls one.
    /// Anyone routing seats with unsafe transfers is outside its reach.
    function test_the_guard_is_documented_as_safe_path_only() public {
        vm.prank(alice);
        seat.transferFrom(alice, address(rootAccount), ROOT); // unsafe path, no hook
        assertEq(seat.ownerOf(ROOT), address(rootAccount));
        // And this is exactly why it matters: the seat is now unreachable.
        assertEq(rootAccount.owner(), address(rootAccount), "owner is itself");
        vm.prank(alice);
        vm.expectRevert(SeatAccount.NotOwner.selector);
        rootAccount.execute(address(seat), 0, "", 0);
    }

    // ── nesting: the agent lives inside a seat the human owns ───────────────

    /// The shape of the product. Alice holds the root seat; the root seat's
    /// account is the agent's identity; the agent holds other seats inside it.
    function test_an_agent_seat_can_hold_other_seats() public {
        seat.mint(address(rootAccount), HELD, "sub-desk");

        // The held seat has its own account, owned by the agent's account.
        SeatAccount heldAccount = _accountFor(HELD);
        assertEq(heldAccount.owner(), address(rootAccount), "the agent owns the sub-desk");
        assertEq(rootAccount.owner(), alice, "and the human owns the agent");
    }

    /// The recovery property, which is the entire reason to nest rather than
    /// hand an agent a hot key. Alice takes a seat out of the agent without the
    /// agent's cooperation, in one transaction, with no admin function.
    function test_the_human_can_reclaim_a_seat_from_the_agent() public {
        seat.mint(address(rootAccount), HELD, "sub-desk");
        vm.prank(alice);
        rootAccount.execute(
            address(seat), 0, abi.encodeCall(MerdSeat.transferFrom, (address(rootAccount), alice, HELD)), 0
        );
        assertEq(seat.ownerOf(HELD), alice, "reclaimed without asking the agent");
    }

    /// And the money under it comes too. This is the thing an agent with its own
    /// EOA cannot offer: the human is never asking for the funds back, they
    /// already control the account holding them.
    function test_reclaiming_the_seat_reclaims_the_treasury_under_it() public {
        seat.mint(address(rootAccount), HELD, "sub-desk");
        SeatAccount heldAccount = _accountFor(HELD);
        AgentTreasury treasury = new AgentTreasury(address(heldAccount), address(0xBEEF), 7 days, 100, MERD_TREASURY);
        address NATIVE = treasury.NATIVE();
        vm.deal(address(treasury), 4 ether);

        // Alice reaches two accounts deep: through the root, through the held
        // seat's account, into its treasury.
        bytes memory withdraw_ = abi.encodeCall(AgentTreasury.withdraw, (NATIVE, alice, 4 ether));
        bytes memory inner = abi.encodeCall(SeatAccount.execute, (address(treasury), 0, withdraw_, uint8(0)));
        vm.prank(alice);
        rootAccount.execute(address(heldAccount), 0, inner, 0);

        assertEq(alice.balance, 4 ether, "control reaches all the way down");
        assertEq(address(treasury).balance, 0);
    }

    /// Selling the root seat sells the agent and everything it custodies,
    /// atomically, because every layer derives its owner from the one above.
    function test_selling_the_root_seat_sells_the_whole_tree() public {
        seat.mint(address(rootAccount), HELD, "sub-desk");
        SeatAccount heldAccount = _accountFor(HELD);

        vm.prank(alice);
        seat.transferFrom(alice, bob, ROOT);

        assertEq(rootAccount.owner(), bob, "the agent changed hands");
        assertEq(seat.ownerOf(HELD), address(rootAccount), "the sub-desk did not move");
        assertEq(heldAccount.owner(), address(rootAccount), "and still answers to the agent");

        // Alice is out entirely, one layer down as well as at the root.
        vm.prank(alice);
        vm.expectRevert(SeatAccount.NotOwner.selector);
        rootAccount.execute(address(seat), 0, "", 0);

        // Bob inherits the reach Alice had.
        vm.prank(bob);
        rootAccount.execute(
            address(seat), 0, abi.encodeCall(MerdSeat.transferFrom, (address(rootAccount), bob, HELD)), 0
        );
        assertEq(seat.ownerOf(HELD), bob);
    }

    /// Nesting deeper must not quietly stop working: three layers, with the
    /// human still at the top of all of them.
    function test_nesting_holds_at_three_levels() public {
        seat.mint(address(rootAccount), HELD, "level-2");
        SeatAccount level2 = _accountFor(HELD);
        seat.mint(address(level2), 3, "level-3");
        SeatAccount level3 = _accountFor(3);

        assertEq(level3.owner(), address(level2));
        assertEq(level2.owner(), address(rootAccount));
        assertEq(rootAccount.owner(), alice);

        // Alice pulls the deepest seat out through both layers.
        bytes memory move = abi.encodeCall(MerdSeat.transferFrom, (address(level2), alice, 3));
        bytes memory inner = abi.encodeCall(SeatAccount.execute, (address(seat), 0, move, uint8(0)));
        vm.prank(alice);
        rootAccount.execute(address(level2), 0, inner, 0);
        assertEq(seat.ownerOf(3), alice);
    }

    /// The agent's account is not a back door into seats it does not hold.
    function test_the_agent_account_cannot_touch_seats_it_does_not_hold() public {
        seat.mint(bob, HELD, "not yours");
        bytes memory steal = abi.encodeCall(MerdSeat.transferFrom, (bob, address(rootAccount), HELD));
        vm.prank(alice);
        vm.expectRevert(); // NotAuthorized, surfaced through CallFailed
        rootAccount.execute(address(seat), 0, steal, 0);
        assertEq(seat.ownerOf(HELD), bob);
    }
}
