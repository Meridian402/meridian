// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianPositionLock — permanent custody for a Uniswap v4 position.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// One job: hold the position NFT forever and let the fees out. That is the
// whole contract, and it is short on purpose — this is the piece a buyer has to
// trust before they buy anything, so it should be readable end to end in a
// minute by someone who is not a Solidity developer.
//
// WHY THIS EXISTS AT ALL:
//   MERD launches with the ENTIRE supply in one full-range position. The NFT
//   that represents it is, for practical purposes, all of MERD. Held by a
//   wallet, that is not a risk to be managed — it is a rug with extra steps,
//   regardless of anyone's intentions, because the holder can withdraw the
//   supply at any moment and nobody can stop them. Locking it is what makes the
//   launch a launch rather than a promise.
//
// WHAT YOU CAN VERIFY BY READING THIS FILE:
//   There is no withdraw, no unlock, no owner, no upgrade, no escape hatch, and
//   no timelock that eventually opens. The NFT arrives once and there is no code
//   path anywhere below that transfers it out. If you are auditing this, the
//   thing to check is that claim, and it should take about a minute.
//
// WHY THERE IS NO RE-RANGING:
//   An earlier design managed the position — moving liquidity to follow the
//   price, bounded by a TWAP guard. It does not belong here for two reasons.
//   The position is FULL RANGE, so it is never out of range and has nothing to
//   follow. And v4 has no oracle: observe() does not exist, so the TWAP guard
//   that made bounded management safe has nothing to read. Management would be
//   unaudited complexity buying a full-range position nothing at all.
//
// HOW FEES COME OUT:
//   v4 has no collect(). Fees are realised by decreasing liquidity by ZERO,
//   which settles what the position has accrued without touching principal, and
//   then taking the pair. Both actions are built inside this contract from
//   constants — no caller supplies calldata, ever. That is the difference
//   between a fee claim and a drain: a contract that forwarded arbitrary
//   actions to the PositionManager would let anyone decrease by everything and
//   take it home.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract MeridianPositionLock {
    // ── v4-periphery action ids. Verified against Actions.sol. ───────────────
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant TAKE_PAIR = 0x11;

    // ── immutable wiring. No owner, no proxy, no setters on any of it. ───────
    IPositionManager public immutable POSITION_MANAGER;

    /// The pool's two currencies. Native ETH is address(0) and sorts first.
    address public immutable CURRENCY0;
    address public immutable CURRENCY1;

    /// Fees are split between these two and nobody else. Set once, forever.
    address public immutable BENEFICIARY_A;
    address public immutable BENEFICIARY_B;
    /// A's share in basis points; B receives the remainder.
    uint16 public immutable SHARE_A_BPS;

    /// The locked position. Zero until one arrives, and it can only arrive once.
    uint256 public tokenId;

    event PositionLocked(uint256 indexed tokenId, address indexed from);
    event FeesCollected(uint256 amount0, uint256 amount1);

    error AlreadyLocked();
    error NotLocked();
    error NotPositionManager();
    error ZeroAddress();
    error ShareAboveOneHundredPercent();
    error EthTransferFailed(address to);
    error TokenTransferFailed(address token, address to);
    error PositionNotHeld(uint256 tokenId);

    constructor(
        IPositionManager positionManager,
        address currency0,
        address currency1,
        address beneficiaryA,
        address beneficiaryB,
        uint16 shareABps
    ) {
        // currency0 is allowed to be address(0): that is how v4 spells native ETH.
        if (address(positionManager) == address(0)) revert ZeroAddress();
        if (currency1 == address(0)) revert ZeroAddress();
        if (beneficiaryA == address(0) || beneficiaryB == address(0)) revert ZeroAddress();
        if (shareABps > 10_000) revert ShareAboveOneHundredPercent();

        POSITION_MANAGER = positionManager;
        CURRENCY0 = currency0;
        CURRENCY1 = currency1;
        BENEFICIARY_A = beneficiaryA;
        BENEFICIARY_B = beneficiaryB;
        SHARE_A_BPS = shareABps;
    }

    /**
     * Accepts the position, once.
     *
     * Locking is done by sending the NFT here with safeTransferFrom, which is
     * deliberate: the transfer and the lock are the same action, so there is no
     * window where the contract holds a position it has not recorded, and no
     * second call anyone has to remember to make.
     *
     * A second position is refused rather than silently orphaned — this
     * contract can release fees for exactly one tokenId, so a second NFT would
     * be stuck here forever with no way to reach it.
     */
    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(POSITION_MANAGER)) revert NotPositionManager();
        if (tokenId != 0) revert AlreadyLocked();
        tokenId = id;
        emit PositionLocked(id, from);
        return this.onERC721Received.selector;
    }

    /**
     * Records a position this contract already holds but never registered.
     *
     * This exists because v4's PositionManager mints with _mint and not
     * _safeMint, so minting a position straight to this address does NOT call
     * onERC721Received. Without this function that position would sit here
     * owned but unrecorded: tokenId stays zero, collectFees reverts forever,
     * and a position holding the entire supply becomes permanently unreachable.
     * Silent and unrecoverable, from one wrong recipient in a mint.
     *
     * Safe to leave open to anyone, because it cannot invent a position. It
     * records only what ownerOf already confirms this contract holds, and
     * recording changes nothing about where the NFT can go — which is nowhere.
     */
    function lockExisting(uint256 id) external {
        if (tokenId != 0) revert AlreadyLocked();
        // nextTokenId starts at 1, so zero is never a real position and stays
        // usable as the "nothing locked yet" sentinel.
        if (id == 0) revert NotLocked();
        if (POSITION_MANAGER.ownerOf(id) != address(this)) revert PositionNotHeld(id);
        tokenId = id;
        emit PositionLocked(id, msg.sender);
    }

    /**
     * Realise the position's fees and pay them out. Callable by anyone.
     *
     * Permissionless on purpose. The money can only ever reach the two
     * immutable beneficiaries, so there is nothing to gain by calling it and
     * nothing to lose by letting a stranger pay the gas — and no key that can
     * be lost or compromised to stop fees flowing.
     */
    function collectFees() external {
        uint256 id = tokenId;
        if (id == 0) revert NotLocked();

        // Decreasing by zero settles accrued fees without touching principal.
        // The mins are zero because there is no principal at risk to protect:
        // this call cannot move liquidity, so it cannot be sandwiched into
        // giving up any.
        bytes memory decreaseParams = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        bytes memory takeParams = abi.encode(CURRENCY0, CURRENCY1, address(this));

        bytes[] memory params = new bytes[](2);
        params[0] = decreaseParams;
        params[1] = takeParams;

        // Built here from constants and never from an argument. This is the
        // line that makes the contract a lock rather than a passthrough.
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);

        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        // Pay out whatever arrived. Reading balances rather than trusting the
        // call's return means any dust left by an earlier partial payout is
        // swept too, instead of accumulating here forever.
        uint256 amount0 = CURRENCY0 == address(0) ? address(this).balance : IERC20(CURRENCY0).balanceOf(address(this));
        uint256 amount1 = IERC20(CURRENCY1).balanceOf(address(this));

        _payOut(CURRENCY0, amount0);
        _payOut(CURRENCY1, amount1);

        emit FeesCollected(amount0, amount1);
    }

    /// Splits one currency between the two beneficiaries by the immutable share.
    function _payOut(address currency, uint256 amount) private {
        if (amount == 0) return;
        uint256 toA = (amount * SHARE_A_BPS) / 10_000;
        uint256 toB = amount - toA;
        if (toA > 0) _send(currency, BENEFICIARY_A, toA);
        if (toB > 0) _send(currency, BENEFICIARY_B, toB);
    }

    function _send(address currency, address to, uint256 amount) private {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed(to);
            return;
        }
        // Tolerates tokens that return nothing as well as those returning bool,
        // and treats an explicit `false` as the failure it is.
        (bool ok, bytes memory ret) = currency.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed(currency, to);
    }

    /// The pool pays the native side of the fees here before it is split.
    receive() external payable {}

    /// True once the position is held by this contract and can never leave it.
    function isLocked() external view returns (bool) {
        uint256 id = tokenId;
        return id != 0 && POSITION_MANAGER.ownerOf(id) == address(this);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // There is intentionally nothing below this line.
    //
    // No withdraw. No emergency exit. No owner, so no onlyOwner anything. No
    // setter for the beneficiaries or the split. No function that calls
    // safeTransferFrom, transferFrom or approve on the PositionManager, so the
    // NFT has no path out of this contract. No function that forwards
    // caller-supplied bytes to modifyLiquidities, so no caller can construct a
    // decrease that touches principal.
    //
    // If a future version of this file has code here, it is not this contract.
    // ─────────────────────────────────────────────────────────────────────────
}
