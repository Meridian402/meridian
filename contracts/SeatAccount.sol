// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// SeatAccount — the ERC-6551 token-bound account behind a Merd desk seat.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// The registry (0x000000006551c19487814612e58FE06813775758) is live on
// Robinhood Chain, but the two account implementations already in use there are
// UNVERIFIED on the explorer. A wallet whose source nobody can read is not a
// wallet we will put a treasury behind, so this is ours: small enough to read
// in one sitting, and doing exactly one thing.
//
// WHAT IT IS
//   Every NFT gets a deterministic address that acts as a wallet. Whoever holds
//   the NFT controls that wallet. Sell the NFT and the wallet, its balance and
//   everything it owns go with it, atomically, because ownership is DERIVED
//   from the NFT rather than recorded separately.
//
// WHY THAT MATTERS HERE
//   The seat's wallet is what owns an AgentTreasury. So a seat is not a claim
//   on Merd's desk, it IS a desk: its own treasury, its own agent authority,
//   its own record. Transferring the seat transfers the desk.
//
// THE ONE PROPERTY TO CHECK WHEN READING THIS
//   `owner()` reads through to the NFT's current holder on every call. There is
//   no stored owner to go stale, no admin, no upgrade path, and no way for the
//   deployer to move funds. If the NFT moves, control moved with it. The NFT
//   binding itself lives in immutable bytecode, not storage, so not even a
//   reinitialization bug can point this account at a different NFT.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract SeatAccount {
    /// Bumped on every state-changing execution, per ERC-6551, so integrations
    /// can detect that the account acted.
    uint256 public state;

    event Executed(address indexed to, uint256 value, bytes data);

    error NotOwner();
    error UnsupportedOperation();
    error CallFailed(bytes reason);
    error OwnershipCycle();

    /// ERC-6551 v0.3.1: the registry deploys this as an ERC-1167 proxy with
    /// salt, chainId, tokenContract and tokenId APPENDED to the runtime code.
    /// There is no initializer to call and no storage to set, so the binding
    /// cannot be changed after deployment by anyone, including us. The 45-byte
    /// proxy is followed by the salt at 0x2d, so the three fields we want begin
    /// at 0x4d and run 0x60 bytes.
    function token() public view returns (uint256, address, uint256) {
        bytes memory footer = new bytes(0x60);
        assembly {
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// Derived on every call, never stored. This is the whole security model:
    /// there is no separate owner record that could disagree with the NFT.
    function owner() public view returns (address) {
        (uint256 chainId_, address tokenContract_, uint256 tokenId_) = token();
        if (chainId_ != block.chainid) return address(0); // a foreign binding controls nothing here
        return IERC721(tokenContract_).ownerOf(tokenId_);
    }

    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        return signer == owner() ? bytes4(0x523e3260) : bytes4(0);
    }

    /// The only way value leaves. Operation 0 (CALL) only: DELEGATECALL would
    /// let a single malicious target rewrite this account's storage, which is
    /// the one thing that must never be possible.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory)
    {
        if (msg.sender != owner()) revert NotOwner();
        if (operation != 0) revert UnsupportedOperation();
        ++state;
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(to, value, data);
        return ret;
    }

    // ── custody ──────────────────────────────────────────────────────────────
    //
    // A wallet that cannot accept an NFT is not a wallet. Without these hooks
    // every safeTransferFrom into this account REVERTS, which means no
    // marketplace, bridge, or mint can deliver a token here at all. Holding ETH
    // and ERC-20s while silently refusing NFTs is the worst of both, because it
    // fails at the moment someone tries to fund the account rather than at
    // deployment where we would have noticed.
    //
    // It is also what makes an account a legitimate HOLDER of another seat. A
    // seat whose account holds further seats is how an agent gets a real
    // on-chain identity: its address is derivable from an NFT a human owns, it
    // custodies its own positions, and if it ever misbehaves the human executes
    // through the root seat and takes everything back in one transaction.

    /// THE CYCLE GUARD. An account must never hold the NFT that owns it. If it
    /// did, ownerOf would resolve to this account, no key on earth could call
    /// execute, and everything inside would be frozen permanently with no admin
    /// to undo it.
    ///
    /// Honest about its reach: this fires on the safe path only, because a
    /// plain transferFrom never calls a receiver. It also cannot see LONGER
    /// cycles (this account holds seat B, and B's account holds this seat), as
    /// detecting those would mean walking an unbounded chain of registry
    /// lookups on every transfer. It catches the mistake anyone is actually
    /// likely to make; it is not a proof that no cycle can exist.
    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external view returns (bytes4) {
        (, address tokenContract_, uint256 tokenId_) = token();
        if (msg.sender == tokenContract_ && tokenId == tokenId_) revert OwnershipCycle();
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x6faff5f1 // IERC6551Account
            || id == 0x51945447 // IERC6551Executable
            || id == 0x150b7a02 // IERC721Receiver
            || id == 0x4e2312e0; // IERC1155Receiver
    }

    receive() external payable {}
}
