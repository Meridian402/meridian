// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerdSeat} from "../MerdSeat.sol";
import {SeatAccount} from "../SeatAccount.sol";
import {AgentTreasury} from "../AgentTreasury.sol";

interface IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address);
}

// ─────────────────────────────────────────────────────────────────────────────
// The test the unit suite cannot be.
//
// The unit suite deployed SeatAccount directly and asserted our own logic
// against our own assumptions. That proves nothing about the REAL ERC-6551
// registry at 0x000000006551c19487814612e58FE06813775758, which deploys our
// implementation as an ERC-1167 proxy with the NFT binding appended to the
// runtime code. If our footer offsets are wrong by a single byte, every unit
// test still passes and every real account is bound to nothing.
//
// What is actually being asked here:
//   1. Does the live registry deploy our implementation at the address it
//      predicted, and is that address deterministic from the NFT alone?
//   2. Does token() read the binding the REGISTRY wrote, not one we set?
//   3. Does owner() therefore track the live NFT holder through a real sale?
//   4. Does the full stack work: seat -> account -> treasury -> agent?
//
// Run with:  forge test --match-path contracts/test/MerdSeat.fork.t.sol \
//              --fork-url https://rpc.mainnet.chain.robinhood.com
// ─────────────────────────────────────────────────────────────────────────────

contract MerdSeatForkTest is Test {
    IERC6551Registry constant REGISTRY = IERC6551Registry(0x000000006551c19487814612e58FE06813775758);

    MerdSeat seat;
    SeatAccount implementation;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address agent = address(0xBEEF);
    uint256 constant SEAT_ID = 1;

    function setUp() public {
        // Skip cleanly when run without a fork, so the default suite stays green.
        if (address(REGISTRY).code.length == 0) return;
        seat = new MerdSeat(12, "https://meridian402.xyz/seat/");
        seat.mint(alice, SEAT_ID, "venue-maker");
        implementation = new SeatAccount();
    }

    modifier onFork() {
        if (address(REGISTRY).code.length == 0) {
            emit log("skipped: no fork (pass --fork-url to run)");
            return;
        }
        _;
    }

    /// 1. The registry is real, it deploys where it said it would, and the
    ///    address depends only on the NFT, so anyone can derive a seat's wallet
    ///    without asking us.
    function test_registry_deploys_where_it_predicted() public onFork {
        address predicted = REGISTRY.account(address(implementation), bytes32(0), block.chainid, address(seat), SEAT_ID);
        address created = REGISTRY.createAccount(address(implementation), bytes32(0), block.chainid, address(seat), SEAT_ID);
        assertEq(created, predicted, "the account address must be derivable, not assigned");
        assertGt(created.code.length, 0, "and it must actually be deployed");

        // Idempotent: asking twice returns the same account, never a second one.
        address again = REGISTRY.createAccount(address(implementation), bytes32(0), block.chainid, address(seat), SEAT_ID);
        assertEq(again, created, "creating twice must not fork the seat's identity");
    }

    /// 2. THE BYTE-OFFSET TEST. token() must read what the registry appended.
    ///    If the footer offsets are wrong, this is the only place it shows.
    function test_token_reads_the_binding_the_registry_wrote() public onFork {
        address acct = REGISTRY.createAccount(address(implementation), bytes32(0), block.chainid, address(seat), SEAT_ID);
        (uint256 chainId_, address tokenContract_, uint256 tokenId_) = SeatAccount(payable(acct)).token();
        assertEq(chainId_, block.chainid, "chainId must decode from the footer");
        assertEq(tokenContract_, address(seat), "tokenContract must decode from the footer");
        assertEq(tokenId_, SEAT_ID, "tokenId must decode from the footer");
    }

    /// 3. Ownership tracks the real NFT through a real transfer.
    function test_owner_follows_the_nft_through_a_sale() public onFork {
        address acct = REGISTRY.createAccount(address(implementation), bytes32(0), block.chainid, address(seat), SEAT_ID);
        assertEq(SeatAccount(payable(acct)).owner(), alice);
        vm.prank(alice);
        seat.transferFrom(alice, bob, SEAT_ID);
        assertEq(SeatAccount(payable(acct)).owner(), bob, "control follows the token, with no migration step");
    }

    /// 4. The whole product, against live infrastructure: the seat's real
    ///    token-bound account owns a treasury, an agent works it under a cap,
    ///    and selling the seat hands the whole desk to the buyer.
    function test_full_stack_against_the_live_registry() public onFork {
        address acct = REGISTRY.createAccount(address(implementation), bytes32(0), block.chainid, address(seat), SEAT_ID);
        AgentTreasury treasury = new AgentTreasury(acct, agent, 7 days);
        address NATIVE = treasury.NATIVE();
        vm.deal(address(treasury), 5 ether);

        // Alice, holding the seat, configures her desk through her account.
        vm.startPrank(alice);
        SeatAccount(payable(acct)).execute(
            address(treasury), 0, abi.encodeCall(AgentTreasury.setPayee, (bob, true)), 0
        );
        SeatAccount(payable(acct)).execute(
            address(treasury), 0, abi.encodeCall(AgentTreasury.setCap, (NATIVE, 1 ether)), 0
        );
        vm.stopPrank();

        // Her agent works within the cap she set.
        vm.prank(agent);
        treasury.agentPay(NATIVE, bob, 0.5 ether);
        assertEq(treasury.remainingThisEpoch(NATIVE), 0.5 ether);

        // She sells the seat. The desk goes with it, mid-epoch, fees and all.
        vm.prank(alice);
        seat.transferFrom(alice, bob, SEAT_ID);
        assertEq(SeatAccount(payable(acct)).owner(), bob);

        // Alice can no longer touch it.
        vm.prank(alice);
        vm.expectRevert(SeatAccount.NotOwner.selector);
        SeatAccount(payable(acct)).execute(
            address(treasury), 0, abi.encodeCall(AgentTreasury.withdraw, (NATIVE, alice, 1 ether)), 0
        );

        // Bob can take everything, and fire the agent.
        uint256 left = address(treasury).balance;
        vm.startPrank(bob);
        SeatAccount(payable(acct)).execute(
            address(treasury), 0, abi.encodeCall(AgentTreasury.setAgent, (address(0))), 0
        );
        SeatAccount(payable(acct)).execute(
            address(treasury), 0, abi.encodeCall(AgentTreasury.withdraw, (NATIVE, bob, left)), 0
        );
        vm.stopPrank();
        assertEq(address(treasury).balance, 0, "the buyer owns the desk outright");
    }

    /// A seat that has not been created yet still has a derivable address, so a
    /// buyer can inspect where a seat's money WILL live before minting.
    function test_seat_wallets_are_knowable_before_they_exist() public onFork {
        address predicted = REGISTRY.account(address(implementation), bytes32(0), block.chainid, address(seat), 999);
        assertGt(uint160(predicted), 0);
        assertEq(predicted.code.length, 0, "predictable, and not yet deployed");
    }
}
