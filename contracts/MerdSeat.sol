// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MerdSeat · a seat on Merd's desk, as an NFT. Spec v2.4.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// Every seat is an agent: its token-bound account owns an AgentTreasury, and
// every seat carries the LP engine SKILL (the engine plans, the holder's own
// agent signs). Twenty seats, drawn by commit-reveal raffle after mint-out,
// additionally carry a DIRECT SEAT at Meridian402: the engine's hands.
//
// THE MINT LADDER (v2.1/v2.4, all prices owner-set MERD amounts re-pegged to
// dollar targets off-chain; no oracle exists on this chain worth trusting):
//   holder rung   free, one per wallet, requires holding freeMintHoldMerd
//                 (~$30 target), globally capped at FREE_TRANCHE seats so the
//                 wallet-splitting farm is bounded.
//   paid 1..3     priceEntryMerd each (~$10), BURNED to the dead address.
//   paid 4        priceTier2Merd (~$30), paid to the treasury.
//   paid 5+       priceTier3Merd each (~$100), paid to the treasury. No cap
//                 but maxSupply: whales pay for every inch.
//
// There is NO activation mechanic (v2 removed it): the mint priced the seat.
// SECONDARY ROYALTIES (v2.4): ERC-2981 signals royaltyBps to the immutable
// treasury, owner-adjustable under an IMMUTABLE ceiling so buyers know the
// worst case from bytecode. Peer-to-peer transfers are never taxed or
// blocked here: royalties are a marketplace settlement concern.
//
// THE RAFFLE (v2.4 hardened): three steps, trustless within the chain's own
// block-production assumption.
//   1. commit  — the operator publishes a salt hash BEFORE mint opens.
//   2. arm     — once the mint is DONE (sold out or deliberately closed) and
//                at least ENGINE_SEATS PUBLIC seats exist, anyone locks a
//                FUTURE block (block.number + REVEAL_DELAY) whose hash will
//                seed the draw. The entropy block is fixed before the salt is
//                known, so it cannot be chosen to favor an outcome.
//   3. reveal  — after the armed block is mined (and within blockhash's 256-
//                block window), the salt is revealed and the seed is
//                keccak(salt, blockhash(armedBlock), poolSize). The outcome is
//                fixed the moment the armed block is mined, so the revealer
//                cannot grind it by retrying blocks.
// The draw runs ONLY over publicly-minted seats: owner hand-mints are recorded
// for supply but are NOT eligible, so the operator cannot stuff the pool with
// free self-mints. Only the producer of the armed block (the sequencer) could
// bias the hash, which is the chain's trust assumption, not the operator's.
//
// SUPPLY IS SMALL, HONEST, AND CAN ONLY EVER SHRINK (lowerMaxSupply only).
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address holder) external view returns (uint256);
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
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    /// What this entry is for, set at mint and immutable after.
    mapping(uint256 => string) public roleOf;

    /// THE REGISTRY. Each entry records a treasury an agent works, and
    /// OPTIONALLY a token whose fees flow into it. Written ONCE, by the holder;
    /// never rewritable, including by us. Launchpad-agnostic by design.
    struct Entry {
        address token;
        address treasury;
        uint64 registeredAt;
    }

    mapping(uint256 => Entry) public entryOf;
    uint256[] public registeredIds;

    IERC20 public immutable merd;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// The treasury: receives the upper mint tiers and the royalty signal.
    address public immutable payout;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event SeatMinted(uint256 indexed id, address indexed to, string role);
    event Registered(uint256 indexed id, address indexed treasury, address indexed token, address holder);
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
    error BurnFailed();
    error PayFailed();
    error MintClosed();
    error PriceNotSet();
    error HolderRungUsed();
    error HolderRungExhausted();
    error InsufficientHold();
    error BelowFreeTranche();
    error RoyaltyAboveCeiling();
    error RaffleAlreadyCommitted();
    error RaffleNotCommitted();
    error RaffleAlreadyRevealed();
    error RaffleMintNotDone();
    error NotEnoughEligible();
    error RaffleAlreadyArmed();
    error RaffleNotArmed();
    error RaffleNotReady();
    error RaffleExpired();
    error BadSalt();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 maxSupply_, string memory baseURI_, address merd_, address payout_) {
        if (payout_ == address(0)) revert ToZero();
        owner = msg.sender;
        maxSupply = maxSupply_;
        baseURI = baseURI_;
        merd = IERC20(merd_);
        payout = payout_;
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

    /// ERC-721 requires this to throw for a nonexistent token; ownerOf does.
    function getApproved(uint256 id) public view returns (address) {
        ownerOf(id);
        return _approved[id];
    }

    function approve(address spender, uint256 id) external {
        address holder = _ownerOf[id];
        if (msg.sender != holder && !isApprovedForAll[holder][msg.sender]) revert NotAuthorized();
        _approved[id] = spender;
        emit Approval(holder, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        if (from != _ownerOf[id]) revert WrongFrom();
        if (to == address(0)) revert ToZero();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender] && msg.sender != _approved[id]) {
            revert NotAuthorized();
        }
        unchecked {
            _balanceOf[from]--;
            _balanceOf[to]++;
        }
        _ownerOf[id] = to;
        delete _approved[id];
        // The engine-seat trait travels WITH the seat: the per-owner counter
        // that the access gate reads moves on every transfer.
        if (isEngineSeat[id]) {
            unchecked {
                engineSeatsOf[from]--;
                engineSeatsOf[to]++;
            }
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
        return iid == 0x01ffc9a7 || iid == 0x80ac58cd || iid == 0x5b5e139f || iid == 0x2a55205a;
    }

    // ── the public mint: the v2.4 ladder ─────────────────────────────────────

    uint256 public constant FREE_TRANCHE = 250;
    uint256 public constant ENTRY_SEATS = 3;

    bool public mintOpen;
    /// Hold-to-mint bar for the holder rung, in MERD (~$30 target, repegged).
    uint256 public freeMintHoldMerd;
    /// Paid rung prices in MERD (~$10 / ~$30 / ~$100 targets, repegged).
    uint256 public priceEntryMerd;
    uint256 public priceTier2Merd;
    uint256 public priceTier3Merd;

    uint256 public freeMinted;
    mapping(address => bool) public holderMintUsed;
    mapping(address => uint256) public paidMintedBy;
    uint256 public totalBurnedForMints;
    uint256 public totalPaidToTreasury;
    uint256 public nextId = 1;
    /// Every minted id, in order (owner hand-mints included): supply bookkeeping
    /// and mintedCount() read this.
    uint256[] private _allIds;
    /// PUBLIC mints only (holder rung + paid ladder). The raffle draws over
    /// THIS, never _allIds, so owner hand-mints can never be stuffed into the
    /// draw to capture engine seats.
    uint256[] private _raffleEligible;

    event PublicMint(uint256 indexed id, address indexed to, uint256 rung, uint256 pricePaid, bool burned);
    event MintOpenSet(bool open);
    event PricesSet(uint256 holdBar, uint256 entry, uint256 tier2, uint256 tier3);

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    function setPrices(uint256 holdBar, uint256 entry, uint256 tier2, uint256 tier3) external onlyOwner {
        freeMintHoldMerd = holdBar;
        priceEntryMerd = entry;
        priceTier2Merd = tier2;
        priceTier3Merd = tier3;
        emit PricesSet(holdBar, entry, tier2, tier3);
    }

    /// The holder rung: free, once per wallet, for wallets holding the MERD
    /// bar, and only while the free tranche lasts. The hold check is
    /// point-in-time and MERD is movable, which is exactly why the global
    /// tranche cap exists: the wallet-splitting farm is bounded at
    /// FREE_TRANCHE seats and can never starve the paid ladder.
    function mintHolder() external returns (uint256 id) {
        if (freeMintHoldMerd == 0) revert PriceNotSet();
        if (holderMintUsed[msg.sender]) revert HolderRungUsed();
        if (freeMinted >= FREE_TRANCHE) revert HolderRungExhausted();
        if (merd.balanceOf(msg.sender) < freeMintHoldMerd) revert InsufficientHold();
        holderMintUsed[msg.sender] = true;
        unchecked {
            freeMinted++;
        }
        id = _publicMint(0, 0, false);
    }

    /// The paid ladder, one function, priced by how deep this wallet already
    /// is: seats 1..3 burn the entry price, seat 4 pays tier 2 to the
    /// treasury, every seat after pays tier 3 to the treasury. The free seat
    /// does not consume a paid slot.
    function mintPaid() external returns (uint256 id) {
        uint256 already = paidMintedBy[msg.sender];
        uint256 price;
        bool burned;
        if (already < ENTRY_SEATS) {
            price = priceEntryMerd;
            burned = true;
        } else if (already == ENTRY_SEATS) {
            price = priceTier2Merd;
        } else {
            price = priceTier3Merd;
        }
        if (price == 0) revert PriceNotSet();
        // Checks-effects-interactions: advance the ladder counter BEFORE the
        // external MERD transfer, so even a hooked payment token could not
        // re-enter and buy several seats all at the cheapest tier (audit
        // finding 12). MERD has no transfer hook today; this is defense in
        // depth. A reverting transfer rolls the increment back with the tx.
        paidMintedBy[msg.sender] = already + 1;
        address to = burned ? BURN_ADDRESS : payout;
        if (!merd.transferFrom(msg.sender, to, price)) {
            if (burned) revert BurnFailed();
            revert PayFailed();
        }
        if (burned) totalBurnedForMints += price;
        else totalPaidToTreasury += price;
        id = _publicMint(already + 1, price, burned);
    }

    function _publicMint(uint256 rung, uint256 price, bool burned) private returns (uint256 id) {
        if (!mintOpen) revert MintClosed();
        if (totalSupply + 1 > maxSupply) revert SoldOut();
        // The cursor skips any id the owner minted by hand pre-launch.
        id = nextId;
        while (_ownerOf[id] != address(0)) id++;
        nextId = id + 1;
        unchecked {
            totalSupply++;
            _balanceOf[msg.sender]++;
        }
        _ownerOf[id] = msg.sender;
        _allIds.push(id);
        _raffleEligible.push(id); // public mints are the ONLY raffle-eligible ids
        roleOf[id] = "meridian";
        emit Transfer(address(0), msg.sender, id);
        emit SeatMinted(id, msg.sender, "meridian");
        emit PublicMint(id, msg.sender, rung, price, burned);
        _checkReceiver(address(0), msg.sender, id, "");
    }

    // ── the raffle: twenty direct seats, provably blind ──────────────────────

    uint256 public constant ENGINE_SEATS = 20;
    /// Blocks between arming and the earliest reveal: the entropy block sits in
    /// the future at arm time, so its hash cannot be known when it is chosen.
    uint256 public constant REVEAL_DELAY = 5;
    bytes32 public raffleCommit;
    bool public raffleRevealed;
    /// The armed future block whose hash seeds the draw (0 = not armed).
    uint256 public revealBlock;
    mapping(uint256 => bool) public isEngineSeat;
    mapping(address => uint256) public engineSeatsOf;

    event RaffleCommitted(bytes32 commit);
    event RaffleArmed(uint256 revealBlock);
    event RaffleRevealed(bytes32 salt, bytes32 seed);
    event EngineSeatDrawn(uint256 indexed id, address indexed holder);

    /// Publish the salt hash before anyone mints. One shot, no do-overs.
    function commitRaffle(bytes32 commit) external onlyOwner {
        if (raffleCommit != bytes32(0)) revert RaffleAlreadyCommitted();
        if (commit == bytes32(0)) revert BadSalt();
        raffleCommit = commit;
        emit RaffleCommitted(commit);
    }

    /// Step 2: lock the entropy block. Callable by anyone (the reveal still
    /// needs the salt) once the mint is DONE — sold out or deliberately closed
    /// — and enough PUBLIC seats exist to draw from. Fixes revealBlock to a
    /// future block so its hash is unknowable now; re-armable only if a prior
    /// arming's reveal window fully lapsed unrevealed (liveness safeguard).
    function armRaffle() external {
        if (raffleCommit == bytes32(0)) revert RaffleNotCommitted();
        if (raffleRevealed) revert RaffleAlreadyRevealed();
        if (mintOpen && totalSupply < maxSupply) revert RaffleMintNotDone();
        if (_raffleEligible.length < ENGINE_SEATS) revert NotEnoughEligible();
        if (revealBlock != 0 && block.number <= revealBlock + 256) revert RaffleAlreadyArmed();
        revealBlock = block.number + REVEAL_DELAY;
        emit RaffleArmed(revealBlock);
    }

    /// Step 3: after the armed block is mined (within blockhash's 256-block
    /// window), reveal the salt and draw the twenty over the PUBLIC pool. The
    /// seed is fixed by the armed block's hash, so the outcome does not depend
    /// on who reveals or when — no per-block grinding. If the window lapsed,
    /// re-arm and try again.
    function revealRaffle(bytes32 salt) external {
        if (raffleCommit == bytes32(0)) revert RaffleNotCommitted();
        if (raffleRevealed) revert RaffleAlreadyRevealed();
        if (revealBlock == 0) revert RaffleNotArmed();
        if (block.number <= revealBlock) revert RaffleNotReady();
        if (block.number > revealBlock + 256) revert RaffleExpired();
        if (keccak256(abi.encodePacked(salt)) != raffleCommit) revert BadSalt();
        raffleRevealed = true;
        uint256 pool = _raffleEligible.length;
        bytes32 seed = keccak256(abi.encodePacked(salt, blockhash(revealBlock), pool));
        emit RaffleRevealed(salt, seed);
        uint256 drawn;
        uint256 k;
        while (drawn < ENGINE_SEATS && drawn < pool) {
            uint256 id = _raffleEligible[uint256(keccak256(abi.encodePacked(seed, k))) % pool];
            k++;
            if (isEngineSeat[id]) continue;
            isEngineSeat[id] = true;
            address holder = _ownerOf[id];
            unchecked {
                engineSeatsOf[holder]++;
                drawn++;
            }
            emit EngineSeatDrawn(id, holder);
        }
    }

    /// What the access gate reads: does this wallet hold a direct seat?
    function hasEngineSeat(address holder) external view returns (bool) {
        return engineSeatsOf[holder] > 0;
    }

    // ── ERC-2981 royalties ───────────────────────────────────────────────────

    uint96 public constant ROYALTY_CEILING_BPS = 1000;
    uint96 public royaltyBps = 500;

    event RoyaltySet(uint96 bps);

    /// Adjustable under the immutable ceiling; the receiver is the immutable
    /// treasury. Buyers can read the worst case from bytecode forever.
    function setRoyaltyBps(uint96 bps) external onlyOwner {
        if (bps > ROYALTY_CEILING_BPS) revert RoyaltyAboveCeiling();
        royaltyBps = bps;
        emit RoyaltySet(bps);
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 amount) {
        return (payout, (salePrice * royaltyBps) / 10_000);
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
        _allIds.push(id);
        roleOf[id] = role;
        emit Transfer(address(0), to, id);
        emit SeatMinted(id, to, role);
        _checkReceiver(address(0), to, id, "");
    }

    /// Record what this entry governs. Callable once, by the holder, frozen
    /// forever after. `token` may be zero: a treasury with no token is a
    /// perfectly good entry.
    function register(uint256 id, address treasury, address token) external {
        if (msg.sender != _ownerOf[id]) revert NotHolder();
        if (treasury == address(0)) revert ToZero();
        if (entryOf[id].treasury != address(0)) revert AlreadyRegistered();
        entryOf[id] = Entry({token: token, treasury: treasury, registeredAt: uint64(block.timestamp)});
        registeredIds.push(id);
        emit Registered(id, treasury, token, msg.sender);
    }

    function registeredCount() external view returns (uint256) {
        return registeredIds.length;
    }

    function mintedCount() external view returns (uint256) {
        return _allIds.length;
    }

    /// Supply can only ever shrink, and never below the free tranche: dropping
    /// maxSupply under FREE_TRANCHE would let free holder-rung mints consume the
    /// whole supply and starve the paid ladder (audit finding 11).
    function lowerMaxSupply(uint256 next) external onlyOwner {
        if (next >= maxSupply) revert CannotRaiseSupply();
        if (next < totalSupply) revert CannotRaiseSupply();
        if (next < FREE_TRANCHE) revert BelowFreeTranche();
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
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert UnsafeRecipient();
        }
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
