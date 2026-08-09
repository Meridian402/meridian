// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MerdSeat — a seat on Merd's desk, as an NFT.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// A seat is not a share of Merd's desk and pays no dividend. It is a SEAT: its
// token-bound account owns an AgentTreasury of its own, an agent works that
// treasury under capped, revocable authority, and the seat holder is that
// treasury's owner. Merd pays seats for work delivered, the way his desk
// already pays scout bounties today.
//
// Selling the seat sells the desk under it, atomically, because the treasury's
// owner is the seat's token-bound account and that account's owner is read
// through to whoever holds this NFT.
//
// SUPPLY IS DELIBERATELY SMALL AND HONEST. The strategy saturates: a hundred
// seats all quoting the same thin pool would compete for one fee stream and
// earn each other less. Seats are minted against work that actually exists, so
// maxSupply is set to the number of distinct roles the desk can genuinely use
// and is LOWERABLE but never raisable.
// ─────────────────────────────────────────────────────────────────────────────

contract MerdSeat {
    string public constant name = "Merd Desk Seat";
    string public constant symbol = "SEAT";

    address public owner;
    uint256 public totalSupply;
    uint256 public maxSupply;
    string public baseURI;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    /// What this seat is for, set at mint and immutable after: "venue-maker",
    /// "scout", "watcher". A seat's job is part of what you buy.
    mapping(uint256 => string) public roleOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event SeatMinted(uint256 indexed id, address indexed to, string role);
    event MaxSupplyLowered(uint256 from, uint256 to);
    event BaseURISet(string uri);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAuthorized();
    error WrongFrom();
    error ToZero();
    error AlreadyMinted();
    error SoldOut();
    error CannotRaiseSupply();
    error UnsafeRecipient();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 maxSupply_, string memory baseURI_) {
        owner = msg.sender;
        maxSupply = maxSupply_;
        baseURI = baseURI_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ── ERC-721 ──────────────────────────────────────────────────────────────

    function ownerOf(uint256 id) public view returns (address holder) {
        holder = _ownerOf[id];
        if (holder == address(0)) revert NotAuthorized();
    }

    function balanceOf(address holder) public view returns (uint256) {
        if (holder == address(0)) revert ToZero();
        return _balanceOf[holder];
    }

    function tokenURI(uint256 id) public view returns (string memory) {
        ownerOf(id); // reverts for unminted ids
        return string.concat(baseURI, _toString(id));
    }

    function approve(address spender, uint256 id) external {
        address holder = _ownerOf[id];
        if (msg.sender != holder && !isApprovedForAll[holder][msg.sender]) revert NotAuthorized();
        getApproved[id] = spender;
        emit Approval(holder, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        if (from != _ownerOf[id]) revert WrongFrom();
        if (to == address(0)) revert ToZero();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender] && msg.sender != getApproved[id]) {
            revert NotAuthorized();
        }
        unchecked {
            _balanceOf[from]--;
            _balanceOf[to]++;
        }
        _ownerOf[id] = to;
        delete getApproved[id];
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        _checkReceiver(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external {
        transferFrom(from, to, id);
        _checkReceiver(from, to, id, data);
    }

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x01ffc9a7 || iid == 0x80ac58cd || iid == 0x5b5e139f;
    }

    // ── seats ────────────────────────────────────────────────────────────────

    function mint(address to, uint256 id, string calldata role) external onlyOwner {
        if (to == address(0)) revert ToZero();
        if (_ownerOf[id] != address(0)) revert AlreadyMinted();
        if (totalSupply + 1 > maxSupply) revert SoldOut();
        unchecked {
            totalSupply++;
            _balanceOf[to]++;
        }
        _ownerOf[id] = to;
        roleOf[id] = role;
        emit Transfer(address(0), to, id);
        emit SeatMinted(id, to, role);
    }

    /// Supply can only ever shrink. A seat's worth depends on how few of them
    /// compete for the same flow, so the ability to print more later is exactly
    /// the promise a buyer cannot verify. Removing it is the point.
    function lowerMaxSupply(uint256 next) external onlyOwner {
        if (next >= maxSupply) revert CannotRaiseSupply();
        if (next < totalSupply) revert CannotRaiseSupply();
        emit MaxSupplyLowered(maxSupply, next);
        maxSupply = next;
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        baseURI = uri;
        emit BaseURISet(uri);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ToZero();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _checkReceiver(address from, address to, uint256 id, bytes memory data) private {
        if (to.code.length == 0) return;
        (bool ok, bytes memory ret) = to.call(
            abi.encodeWithSelector(0x150b7a02, msg.sender, from, id, data)
        );
        if (!ok || ret.length < 32 || abi.decode(ret, (bytes4)) != bytes4(0x150b7a02)) revert UnsafeRecipient();
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) digits++;
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
