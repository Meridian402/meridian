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
//   deployer to move funds. If the NFT moves, control moved with it.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract SeatAccount {
    /// Set once by the registry-deployed proxy pattern's initializer OR by
    /// constructor when deployed directly. Immutable in spirit: initialize
    /// reverts if called twice.
    uint256 public chainId;
    address public tokenContract;
    uint256 public tokenId;
    bool private initialized;

    /// Bumped on every state-changing execution, per ERC-6551, so signatures
    /// and integrations can detect that the account acted.
    uint256 public state;

    event Initialized(uint256 chainId, address tokenContract, uint256 tokenId);
    event Executed(address indexed to, uint256 value, bytes data);

    error AlreadyInitialized();
    error NotOwner();
    error UnsupportedOperation();
    error WrongChain();
    error CallFailed(bytes reason);

    function initialize(uint256 chainId_, address tokenContract_, uint256 tokenId_) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        chainId = chainId_;
        tokenContract = tokenContract_;
        tokenId = tokenId_;
        emit Initialized(chainId_, tokenContract_, tokenId_);
    }

    /// ERC-6551: the NFT this account is bound to.
    function token() external view returns (uint256, address, uint256) {
        return (chainId, tokenContract, tokenId);
    }

    /// Derived on every call, never stored. This is the whole security model:
    /// there is no separate owner record that could disagree with the NFT.
    function owner() public view returns (address) {
        if (chainId != block.chainid) return address(0); // a foreign-chain binding controls nothing here
        return IERC721(tokenContract).ownerOf(tokenId);
    }

    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        return signer == owner() ? bytes4(0x523e3260) : bytes4(0);
    }

    /// The only way value leaves. Operation 0 (CALL) only: DELEGATECALL would
    /// let a single malicious target rewrite this account's storage and detach
    /// it from its NFT, which is the one thing that must never be possible.
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
        // IERC165, IERC6551Account, IERC6551Executable
        return id == 0x01ffc9a7 || id == 0x6faff5f1 || id == 0x51945447;
    }

    receive() external payable {}
}
