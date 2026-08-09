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

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x6faff5f1 || id == 0x51945447;
    }

    receive() external payable {}
}
