// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianLaunchLocker — permanent custody for a launch's LP position.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// One job: hold the position NFT forever and let the fees out. That is the
// whole contract, and it is short on purpose — this is the piece a buyer has to
// trust before they buy anything, so it should be readable end to end in a
// minute by someone who is not a Solidity developer.
//
// There is no withdraw, no unlock, no owner, no upgrade, no escape hatch, and
// no timelock that eventually opens. The NFT is minted here and there is no
// code path in this file that transfers it out. If you are auditing this, the
// only question that matters is whether that sentence is true.
//
// Fee collection is permissionless: the split is fixed at construction, so
// there is nothing to gain by gating who presses the button, and a creator
// should never need our cooperation to get paid.
//
// The managed variant (MeridianManagedLocker) adds re-ranging on top of these
// same guarantees. This one deliberately does not, so that step one of the
// product carries the smallest possible surface.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

contract MeridianLaunchLocker {
    INonfungiblePositionManager public immutable POSITION_MANAGER;
    address public immutable TOKEN0;
    address public immutable TOKEN1;

    /// Fees go to these two and nowhere else, in this proportion, forever.
    address public immutable CREATOR;
    address public immutable PLATFORM;
    uint16 public immutable CREATOR_FEE_BPS;

    /// Set once by the factory, in the same transaction that mints it.
    uint256 public tokenId;

    event Locked(uint256 indexed tokenId);
    event FeesCollected(uint256 amount0, uint256 amount1, uint256 creator0, uint256 creator1);

    error AlreadyLocked();
    error NotLocked();
    error NotFactory();
    error ZeroAddress();
    error FeeSplitTooHigh();
    error TransferFailed(address token, address to, uint256 amount);

    address public immutable FACTORY;

    constructor(
        INonfungiblePositionManager positionManager,
        address token0,
        address token1,
        address creator,
        address platform,
        uint16 creatorFeeBps
    ) {
        if (
            address(positionManager) == address(0) || token0 == address(0) || token1 == address(0)
                || creator == address(0) || platform == address(0)
        ) revert ZeroAddress();
        if (creatorFeeBps > 10_000) revert FeeSplitTooHigh();

        POSITION_MANAGER = positionManager;
        TOKEN0 = token0;
        TOKEN1 = token1;
        CREATOR = creator;
        PLATFORM = platform;
        CREATOR_FEE_BPS = creatorFeeBps;
        FACTORY = msg.sender;
    }

    /// Called by the factory once, immediately after minting the position to
    /// this address. Records which NFT is ours; grants no power over it.
    function lock(uint256 id) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (tokenId != 0) revert AlreadyLocked();
        tokenId = id;
        emit Locked(id);
    }

    /// Anyone may trigger. Fees only — this call cannot reach principal, because
    /// collect() on a position returns accrued fees and nothing else unless
    /// liquidity has first been decreased, which no code here does.
    function collectFees() external {
        uint256 id = tokenId;
        if (id == 0) revert NotLocked();

        (uint256 amount0, uint256 amount1) = POSITION_MANAGER.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: id,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        if (amount0 == 0 && amount1 == 0) return;

        uint256 creator0 = (amount0 * CREATOR_FEE_BPS) / 10_000;
        uint256 creator1 = (amount1 * CREATOR_FEE_BPS) / 10_000;
        if (creator0 > 0) _safeTransfer(TOKEN0, CREATOR, creator0);
        if (creator1 > 0) _safeTransfer(TOKEN1, CREATOR, creator1);
        if (amount0 - creator0 > 0) _safeTransfer(TOKEN0, PLATFORM, amount0 - creator0);
        if (amount1 - creator1 > 0) _safeTransfer(TOKEN1, PLATFORM, amount1 - creator1);

        emit FeesCollected(amount0, amount1, creator0, creator1);
    }

    /// Current position, for the UI.
    function position() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity) {
        uint256 id = tokenId;
        if (id == 0) return (0, 0, 0);
        (,,,,, tickLower, tickUpper, liquidity,,,,) = POSITION_MANAGER.positions(id);
    }

    /// Accept the position NFT. Uniswap's manager mints without invoking this,
    /// but a safeTransferFrom path exists on other managers and silently
    /// rejecting the NFT would strand a launch.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // TOKEN0 is whatever was just launched, so its ERC-20 return convention
    // cannot be assumed. Tolerate both the bool-returning and the
    // nothing-returning shapes, and treat an explicit false as failure.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token, to, amount);
    }
}
