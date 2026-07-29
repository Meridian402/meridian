// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianAgentRegistry} from "../MeridianAgentRegistry.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

// Unit tests for the minimal agent identity NFT. The properties that matter are
// not the ERC-721 mechanics (those are OpenZeppelin's, tested upstream) but the
// Meridian-specific surface: an identity can only be minted for its own wallet,
// exactly once, at a precomputable id; it holds no value and has no admin lever;
// and its metadata is on-chain and immutable. Those are what an auditor and a
// user care about, so those are what this pins.
contract MeridianAgentRegistryTest is Test {
    MeridianAgentRegistry reg;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        reg = new MeridianAgentRegistry();
    }

    function test_mint_bindsIdentityToTheCaller() public {
        vm.prank(alice);
        uint256 id = reg.mint();

        assertEq(id, reg.tokenIdOf(alice), "id must be the deterministic id for the caller");
        assertEq(reg.ownerOf(id), alice, "owner is the minter");
        assertEq(reg.balanceOf(alice), 1);
        assertEq(reg.birthWallet(id), alice, "birth wallet recorded");
        assertEq(reg.mintedAt(id), uint64(block.timestamp), "creation time recorded");
        assertTrue(reg.isMinted(alice));
        assertFalse(reg.isMinted(bob));
    }

    function test_tokenId_isDeterministicPureAndDomainSeparated() public view {
        uint256 expected = uint256(keccak256(abi.encodePacked("meridian.agent.identity.v1", alice)));
        assertEq(reg.tokenIdOf(alice), expected);
        // pure and stable: same input, same id, no state needed
        assertEq(reg.tokenIdOf(alice), reg.tokenIdOf(alice));
        assertTrue(reg.tokenIdOf(alice) != reg.tokenIdOf(bob), "different wallets, different ids");
    }

    function test_cannotMintTwice() public {
        vm.prank(alice);
        reg.mint();
        vm.prank(alice);
        vm.expectRevert(MeridianAgentRegistry.AlreadyMinted.selector);
        reg.mint();
    }

    function test_squattingIsImpossible_mintOnlyBindsMsgSender() public {
        // Bob cannot mint Alice's identity: mint() takes no argument and derives
        // the id from msg.sender, so bob's mint produces bob's id, and alice's
        // id is still unminted and available only to alice.
        vm.prank(bob);
        uint256 bobId = reg.mint();
        assertEq(bobId, reg.tokenIdOf(bob));
        assertFalse(reg.isMinted(alice), "bob cannot have taken alice's identity");

        vm.prank(alice);
        uint256 aliceId = reg.mint();
        assertEq(aliceId, reg.tokenIdOf(alice));
        assertTrue(aliceId != bobId);
    }

    function test_identityIsTransferable_butBirthWalletIsPermanent() public {
        vm.prank(alice);
        uint256 id = reg.mint();

        vm.prank(alice);
        reg.transferFrom(alice, bob, id);

        assertEq(reg.ownerOf(id), bob, "control follows the transfer");
        assertEq(reg.birthWallet(id), alice, "birth wallet is immutable, not the current owner");
        // The token id itself is unchanged, which is what keeps a future
        // token-bound account bound to the same identity across a transfer.
        assertEq(id, reg.tokenIdOf(alice));
    }

    function test_tokenURI_isOnChainImmutableAndReverts_onNonexistent() public {
        vm.prank(alice);
        uint256 id = reg.mint();

        string memory uri = reg.tokenURI(id);
        // Fully on-chain data URI, no server pointer for the metadata itself.
        assertEq(_prefix(uri, 29), "data:application/json;base64,", "on-chain data URI");
        // Immutable: same token, same bytes, every call.
        assertEq(reg.tokenURI(id), uri);

        uint256 unmintedId = reg.tokenIdOf(bob);
        vm.expectRevert(MeridianAgentRegistry.NonexistentToken.selector);
        reg.tokenURI(unmintedId);
    }

    function test_holdsNoValue_rejectsEther() public {
        // No receive, no fallback, no payable anything: a plain value send must
        // fail, so the contract can never custody funds.
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(reg).call{value: 1 ether}("");
        assertFalse(ok, "the registry must refuse ether");
        assertEq(address(reg).balance, 0);
    }

    function test_noBurn_identityCannotBeDestroyed() public {
        vm.prank(alice);
        uint256 id = reg.mint();
        // There is no burn selector on the contract; the identity, once minted,
        // persists. A low-level call to a burn signature must not exist / not
        // succeed in removing ownership.
        (bool ok,) = address(reg).call(abi.encodeWithSignature("burn(uint256)", id));
        assertFalse(ok, "no burn function should exist");
        assertEq(reg.ownerOf(id), alice);
    }

    function test_safeMint_worksToAContractThatReceives() public {
        Receiver r = new Receiver();
        vm.prank(address(r));
        uint256 id = reg.mint();
        assertEq(reg.ownerOf(id), address(r));
        assertEq(reg.birthWallet(id), address(r));
    }

    function _prefix(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = b[i];
        return string(out);
    }
}

contract Receiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
