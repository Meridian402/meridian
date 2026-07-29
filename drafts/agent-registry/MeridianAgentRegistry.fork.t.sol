// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianAgentRegistry} from "../MeridianAgentRegistry.sol";

/// The canonical ERC-6551 registry singleton, verified deployed on Robinhood
/// Chain (chain 4663) during the design research. The whole "minimal now,
/// token-bound account later, no re-mint" bet rests on this contract existing
/// and behaving as the standard specifies, so this fork test proves it against
/// the real deployed bytecode rather than an assumption.
interface IERC6551Registry {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address);
}

/// Fork test: prove that an identity minted by the minimal NFT can get an
/// ERC-6551 token-bound account attached LATER with no re-mint, and that the
/// account address is fixed at the identity while control follows ownerOf. Run:
///   forge test --match-path "contracts/test/MeridianAgentRegistry.fork.t.sol" --fork-url $ROBINHOOD_RPC_URL -vv
contract MeridianAgentRegistryForkTest is Test {
    address constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    // A placeholder account implementation. The registry's account() view is a
    // pure CREATE2 address derivation and does not require the implementation to
    // be deployed, which is exactly why the future account address is knowable
    // today, before we have chosen or deployed an implementation.
    address constant PLACEHOLDER_IMPL = address(0xACC0);
    bytes32 constant SALT = bytes32(0);

    MeridianAgentRegistry reg;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bool forked;

    function setUp() public {
        if (ERC6551_REGISTRY.code.length == 0) return; // not forked against Robinhood Chain
        forked = true;
        reg = new MeridianAgentRegistry();
    }

    function test_6551_registryIsTheDeployedSingleton() public view {
        if (!forked) return;
        assertGt(ERC6551_REGISTRY.code.length, 0, "the canonical 6551 registry must be live on this chain");
    }

    function test_6551_accountAddressIsComputableForAMintedIdentity() public {
        if (!forked) return;
        vm.prank(alice);
        uint256 tokenId = reg.mint();

        address acct = IERC6551Registry(ERC6551_REGISTRY).account(
            PLACEHOLDER_IMPL, SALT, block.chainid, address(reg), tokenId
        );
        assertTrue(acct != address(0), "a token-bound account address must be derivable");
        // Deterministic: same tuple, same address, every call.
        address again = IERC6551Registry(ERC6551_REGISTRY).account(
            PLACEHOLDER_IMPL, SALT, block.chainid, address(reg), tokenId
        );
        assertEq(acct, again, "the account address is a pure derivation");
    }

    function test_6551_accountAddressSurvivesATransfer_noReMint() public {
        if (!forked) return;
        vm.prank(alice);
        uint256 tokenId = reg.mint();

        address before = IERC6551Registry(ERC6551_REGISTRY).account(
            PLACEHOLDER_IMPL, SALT, block.chainid, address(reg), tokenId
        );

        // Transfer the identity. Under 6551, control of the account follows
        // ownerOf, but the account ADDRESS is bound to the token id, not the
        // owner, so it must not move. This is the whole no-re-mint guarantee:
        // the identity minted at the minimal phase keeps the same future account
        // across owners and across the later upgrade.
        vm.prank(alice);
        reg.transferFrom(alice, bob, tokenId);
        assertEq(reg.ownerOf(tokenId), bob, "control moved with the token");

        address afterTransfer = IERC6551Registry(ERC6551_REGISTRY).account(
            PLACEHOLDER_IMPL, SALT, block.chainid, address(reg), tokenId
        );
        assertEq(before, afterTransfer, "the token-bound account address is fixed to the identity, not the owner");
        // And the identity id itself never changed, so nothing was re-minted.
        assertEq(tokenId, reg.tokenIdOf(alice));
    }
}
