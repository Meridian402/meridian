// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MerdSeat — a seat on Merd's desk, as an NFT.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// An entry is not a share of Merd's desk and pays no dividend. Its token-bound
// account owns an AgentTreasury of its own, an agent works that treasury under
// capped, revocable authority, and the holder is that treasury's owner.
//
// What fills the treasury is deliberately NOT this contract's business. A PONS
// launch pointing its fee wallet here is one way; a token launched elsewhere,
// or capital the holder simply deposits, work just as well. Making one
// launchpad mandatory would be a dependency dressed up as a feature.
//
// Selling the seat sells the desk under it, atomically, because the treasury's
// owner is the seat's token-bound account and that account's owner is read
// through to whoever holds this NFT.
//
// SUPPLY IS DELIBERATELY SMALL AND HONEST, AND CAN ONLY EVER SHRINK. The
// strategy saturates: entries all quoting the same thin pool would compete for
// one fee stream and earn each other less.
//
// A LATER BATCH IS A DIFFERENT CONTRACT, NOT MORE OF THIS ONE. That is the
// point of having no way to raise maxSupply. A holder here can verify, from
// bytecode rather than from a promise, that their collection's cap is final.
// Shipping a v2 with different mechanics stays perfectly possible; diluting v1
// to do it does not.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MerdSeat {
    string public constant name = "The Meridians";
    string public constant symbol = "MERIDIAN";

    address public owner;
    uint256 public totalSupply;
    uint256 public maxSupply;
    string public baseURI;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    /// What this entry is for, set at mint and immutable after.
    mapping(uint256 => string) public roleOf;

    /// THE REGISTRY. Each entry records a treasury an agent works, and
    /// OPTIONALLY a token whose fees flow into it. Written ONCE, by the holder;
    /// never rewritable, including by us. Enumerable from chain alone, so
    /// Meridian being the frontend is a convenience, not a dependency.
    ///
    /// LAUNCHPAD-AGNOSTIC BY DESIGN. The token field takes any address, or none
    /// at all. Launching through PONS is one way to fill a treasury, not a
    /// requirement: a holder may bring a token that launched elsewhere, or run
    /// a treasury with no token behind it. Welding this registry to one
    /// launchpad's interface would date it the moment a better one exists.
    ///
    /// An entry is a CLAIM whose truth is independently checkable: where a
    /// token is named, its fee wallet should be the treasury recorded here, and
    /// anyone can read both without asking us.
    struct Entry {
        address token;
        address treasury;
        uint64 registeredAt;
    }

    mapping(uint256 => Entry) public entryOf;

    /// ACTIVATION. An entry only gets the engine while it is active, and
    /// activation is bought by BURNING MERD. Transferring clears it, so every
    /// secondary sale burns again: trading the asset shrinks the token supply
    /// rather than merely moving the asset around.
    ///
    /// This is a fee for a service, not a subscription to a yield. An inactive
    /// entry still owns its treasury outright and can withdraw everything at
    /// any time; what it loses is Merd's engine working the position.
    IERC20 public immutable merd;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public activationFee;
    mapping(uint256 => uint64) public activatedAt;
    uint256 public totalBurnedForActivation;
    /// Every id that has been registered, in order, so the registry can be walked.
    uint256[] public registeredIds;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event SeatMinted(uint256 indexed id, address indexed to, string role);
    event Registered(uint256 indexed id, address indexed treasury, address indexed token, address holder);
    event Activated(uint256 indexed id, address indexed holder, uint256 merdBurned);
    event DeactivatedByTransfer(uint256 indexed id, address indexed from, address indexed to);
    event ActivationFeeSet(uint256 fee);
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
    error AlreadyRegistered();
    error NotHolder();
    error AlreadyActive();
    error BurnFailed();
    error MintClosed();
    error WalletCapReached();
    error FreeMintUsed();
    error WrongPayment();
    error PayFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 maxSupply_, string memory baseURI_, address merd_, uint256 activationFee_, address payout_) {
        if (payout_ == address(0)) revert ToZero();
        owner = msg.sender;
        maxSupply = maxSupply_;
        baseURI = baseURI_;
        merd = IERC20(merd_);
        activationFee = activationFee_;
        payout = payout_;
        emit ActivationFeeSet(activationFee_);
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
        // Activation does not travel. The buyer re-activates, and burns again.
        if (activatedAt[id] != 0) {
            activatedAt[id] = 0;
            emit DeactivatedByTransfer(id, from, to);
        }
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

    // ── the public mint ──────────────────────────────────────────────────────
    // Two per wallet, and the wallet chooses how it pays for the second:
    //   mint #1  free
    //   mint #2  priceMerd in MERD (burned), or priceWei in ETH (to treasury)
    //
    // Prices are OWNER-SET AMOUNTS pegged to a dollar target off-chain, not
    // oracle-derived: this chain has no hardened price feed, and a mint that
    // reads a thin pool's spot invites paying with a flash-moved price. A
    // re-peg is a public, evented transaction; manipulation of it would have
    // to happen in front of everyone.
    //
    // MERD payments BURN, deliberately: the same shape as activation, so every
    // paid mint shrinks the token supply rather than funding a wallet. ETH
    // payments go to the immutable payout address set at deploy.

    uint256 public constant WALLET_CAP = 2;
    bool public mintOpen;
    uint256 public priceWei;
    uint256 public priceMerd;
    address public immutable payout;
    uint256 public nextId = 1;
    mapping(address => uint256) public mintedBy;
    uint256 public totalBurnedForMints;

    event PublicMint(uint256 indexed id, address indexed to, bool paid, bool inMerd);
    event MintOpenSet(bool open);
    event PricesSet(uint256 priceWei, uint256 priceMerd);

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    function setPrices(uint256 priceWei_, uint256 priceMerd_) external onlyOwner {
        priceWei = priceWei_;
        priceMerd = priceMerd_;
        emit PricesSet(priceWei_, priceMerd_);
    }

    /// Mint #1 for the caller: free, once per wallet.
    function mintFree() external returns (uint256 id) {
        if (mintedBy[msg.sender] >= 1) revert FreeMintUsed();
        return _publicMint(false, false);
    }

    /// Mint #2 for the caller, paid in ETH. Exact price, no overpay kept.
    function mintPaidEth() external payable returns (uint256 id) {
        if (msg.value != priceWei) revert WrongPayment();
        (bool ok,) = payout.call{value: msg.value}("");
        if (!ok) revert PayFailed();
        return _publicMint(true, false);
    }

    /// Mint #2 for the caller, paid in MERD. The payment burns.
    function mintPaidMerd() external returns (uint256 id) {
        if (!merd.transferFrom(msg.sender, BURN_ADDRESS, priceMerd)) revert BurnFailed();
        totalBurnedForMints += priceMerd;
        return _publicMint(true, true);
    }

    function _publicMint(bool paid, bool inMerd) private returns (uint256 id) {
        if (!mintOpen) revert MintClosed();
        uint256 already = mintedBy[msg.sender];
        if (already >= WALLET_CAP) revert WalletCapReached();
        // The free mint must come first: a wallet's paid mint is its SECOND.
        // Paying for the first would be a worse deal offered to the confused.
        if (paid == (already == 0)) revert WrongPayment();
        if (totalSupply + 1 > maxSupply) revert SoldOut();
        // The cursor skips any id the owner minted by hand pre-launch.
        id = nextId;
        while (_ownerOf[id] != address(0)) id++;
        nextId = id + 1;
        mintedBy[msg.sender] = already + 1;
        unchecked {
            totalSupply++;
            _balanceOf[msg.sender]++;
        }
        _ownerOf[id] = msg.sender;
        roleOf[id] = "meridian";
        emit Transfer(address(0), msg.sender, id);
        emit SeatMinted(id, msg.sender, "meridian");
        emit PublicMint(id, msg.sender, paid, inMerd);
        _checkReceiver(address(0), msg.sender, id, "");
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
        // Minting is where a seat is most likely to be sent somewhere that
        // cannot hold it, because the destination is typed once by us rather
        // than chosen by a wallet. A contract that cannot acknowledge an ERC-721
        // would swallow the seat with no revert and no way back, so the check
        // belongs here as much as it does on transfer.
        _checkReceiver(address(0), to, id, "");
    }

    /// Record what this entry governs: the treasury an agent works, and
    /// optionally a token whose fees flow into it. Callable once, by the
    /// holder, and frozen forever after. Write-once is the whole point: a
    /// registry whose history can be edited is a marketing page with extra
    /// steps.
    ///
    /// `token` may be the zero address. A treasury with no token is a perfectly
    /// good entry, and requiring one would make a launchpad mandatory by the
    /// back door.
    function register(uint256 id, address treasury, address token) external {
        if (msg.sender != _ownerOf[id]) revert NotHolder();
        if (treasury == address(0)) revert ToZero();
        if (entryOf[id].treasury != address(0)) revert AlreadyRegistered();
        entryOf[id] = Entry({token: token, treasury: treasury, registeredAt: uint64(block.timestamp)});
        registeredIds.push(id);
        emit Registered(id, treasury, token, msg.sender);
    }

    /// Burn MERD to put this entry back to work. The fee is pulled from the
    /// caller and sent to the dead address in the same transaction, so the burn
    /// is a fact of the activation rather than a promise about it.
    function activate(uint256 id) external {
        if (msg.sender != _ownerOf[id]) revert NotHolder();
        if (activatedAt[id] != 0) revert AlreadyActive();
        uint256 fee = activationFee;
        if (fee > 0) {
            if (!merd.transferFrom(msg.sender, BURN_ADDRESS, fee)) revert BurnFailed();
            totalBurnedForActivation += fee;
        }
        activatedAt[id] = uint64(block.timestamp);
        emit Activated(id, msg.sender, fee);
    }

    /// What Merd's engine reads to decide whether to work an entry's treasury.
    function isActive(uint256 id) external view returns (bool) {
        return activatedAt[id] != 0;
    }

    function setActivationFee(uint256 fee) external onlyOwner {
        activationFee = fee;
        emit ActivationFeeSet(fee);
    }

    /// How many launches this registry knows about.
    function registeredCount() external view returns (uint256) {
        return registeredIds.length;
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
        if (!ok) {
            // Surface the recipient's OWN reason rather than flattening every
            // refusal into UnsafeRecipient. A token-bound account rejecting the
            // seat that owns it is refusing for a specific, actionable reason,
            // and hiding that behind a generic error costs a debugging session
            // every time it fires.
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert UnsafeRecipient();
        }
        // Compared as raw bytes rather than abi.decode: a recipient returning a
        // malformed word should be rejected as unsafe, not panic the decoder
        // and revert with something unrelated.
        if (ret.length < 32) revert UnsafeRecipient();
        bytes4 got;
        assembly {
            got := mload(add(ret, 0x20))
        }
        if (got != bytes4(0x150b7a02)) revert UnsafeRecipient();
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
