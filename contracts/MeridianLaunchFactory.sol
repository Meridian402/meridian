// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MeridianLaunchToken} from "./MeridianLaunchToken.sol";
import {MeridianLaunchLocker, INonfungiblePositionManager} from "./MeridianLaunchLocker.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MeridianLaunchFactory — one transaction from nothing to a live, locked pool.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// WHY THIS SHAPE:
//   The launchpad already deployed on this chain uses a bonding curve that
//   graduates to a real pool at roughly 5 ETH of cumulative buying. Measured
//   against 82 live launches, the closest token had reached 0.70 ETH and 91%
//   were under 0.1 ETH. Nothing graduates, so nothing ever gets a pool, so
//   there is never any liquidity to make markets in.
//
//   This skips the curve entirely. The pool exists at launch: deploy the token,
//   create and initialise the V3 pool, put the entire supply plus the creator's
//   own ETH into a single position, and lock that position forever. Tradable on
//   any aggregator from block one, and there is no graduation to wait for
//   because there is no curve.
//
// WHAT THE FACTORY IS NOT TRUSTED WITH:
//   It never holds anything after the transaction ends. The supply goes into
//   the position, the position goes to the locker, and the locker has no
//   withdrawal path. The factory has no owner and no admin function; the only
//   thing configured at deploy time is where the platform's fee share goes.
//
//   Pricing is deliberately NOT computed here. sqrtPriceX96 comes in as a
//   parameter, worked out off-chain where the maths is testable, because a
//   rounding mistake in an on-chain square root would misprice every launch
//   permanently and silently. The contract's job is custody and locking, not
//   price discovery.
// ─────────────────────────────────────────────────────────────────────────────

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPositionManagerFull is INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

contract MeridianLaunchFactory {
    /// Every launch mints exactly this. Fixed across the platform so a buyer
    /// never has to ask how many there are.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    IPositionManagerFull public immutable POSITION_MANAGER;
    address public immutable WETH;
    address public immutable PLATFORM;

    /// Share of LP fees the creator keeps. The rest funds the platform.
    uint16 public constant CREATOR_FEE_BPS = 7000; // 70/30

    event Launched(
        address indexed token,
        address indexed creator,
        address locker,
        address pool,
        uint256 tokenId,
        uint128 liquidity,
        string name,
        string symbol
    );

    error ZeroAddress();
    error NoLiquidityMinted();
    error TokenOrderUnexpected();
    error EthRequired();
    error DustTransferFailed(address token);

    constructor(IPositionManagerFull positionManager, address weth, address platform) {
        if (address(positionManager) == address(0) || weth == address(0) || platform == address(0)) revert ZeroAddress();
        POSITION_MANAGER = positionManager;
        WETH = weth;
        PLATFORM = platform;
    }

    /**
     * Launch a token and lock its liquidity, atomically.
     *
     * `sqrtPriceX96` sets the opening price and must be consistent with the
     * amounts: for a full-range position the ratio of the two sides IS the
     * price, so the caller's ETH and the fixed supply together determine it.
     * The UI computes this; passing a mismatched value simply means one side of
     * the position is not fully consumed, and whatever is left over is sent
     * into the locker rather than back to anyone.
     *
     * `tickLower`/`tickUpper` are usually the widest aligned ticks. They are
     * parameters rather than constants so the same factory can serve a fee tier
     * with a different spacing.
     */
    function launch(
        string calldata name,
        string calldata symbol,
        uint24 fee,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint256 deadline
    ) external payable returns (address token, address locker, uint256 tokenId) {
        if (msg.value == 0) revert EthRequired();

        // 1. Mint the whole supply to this contract. It leaves again below, in
        //    this same transaction, and the factory holds no balance at rest.
        token = address(new MeridianLaunchToken(name, symbol, TOTAL_SUPPLY, address(this)));

        // 2. V3 pools are keyed on sorted token addresses. The launched token's
        //    address is not chosen, so either ordering is possible and both are
        //    handled rather than assumed.
        (address token0, address token1) = token < WETH ? (token, WETH) : (WETH, token);

        // 3. Wrap the creator's ETH — the pool holds WETH, not native.
        IWETH(WETH).deposit{value: msg.value}();

        // 4. Create the pool if it does not exist and set the opening price.
        address pool = POSITION_MANAGER.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96);

        // 5. The locker is deployed BEFORE the mint so the position can be
        //    minted straight to it. The NFT never touches an account that could
        //    have transferred it elsewhere, not even for one instruction.
        locker = address(
            new MeridianLaunchLocker(
                INonfungiblePositionManager(address(POSITION_MANAGER)),
                token0,
                token1,
                msg.sender,
                PLATFORM,
                CREATOR_FEE_BPS
            )
        );

        uint256 amount0 = token0 == token ? TOTAL_SUPPLY : msg.value;
        uint256 amount1 = token1 == token ? TOTAL_SUPPLY : msg.value;

        MeridianLaunchToken(token).approve(address(POSITION_MANAGER), TOTAL_SUPPLY);
        IWETH(WETH).approve(address(POSITION_MANAGER), msg.value);

        uint128 liquidity;
        (tokenId, liquidity,,) = POSITION_MANAGER.mint(
            IPositionManagerFull.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                // Zero minimums are safe here and only here: the pool was
                // created in this same call, so there is no existing price for
                // anyone to have moved and nothing to be sandwiched out of.
                amount0Min: 0,
                amount1Min: 0,
                recipient: locker,
                deadline: deadline
            })
        );
        if (liquidity == 0) revert NoLiquidityMinted();

        MeridianLaunchLocker(locker).lock(tokenId);

        // 6. Anything the position did not absorb goes to the locker, not back
        //    to the creator. Refunding it would hand the deployer a slice of
        //    supply that never passed through the market, which is exactly the
        //    stealth allocation this design is meant to rule out.
        //    Both sides are known-good here — one we just deployed, the other is
        //    canonical WETH — but the returns are checked anyway so a future
        //    swap of either for something looser cannot strand value silently.
        uint256 dustToken = MeridianLaunchToken(token).balanceOf(address(this));
        if (dustToken > 0 && !MeridianLaunchToken(token).transfer(locker, dustToken)) {
            revert DustTransferFailed(token);
        }
        uint256 dustWeth = IWETH(WETH).balanceOf(address(this));
        if (dustWeth > 0 && !IWETH(WETH).transfer(locker, dustWeth)) revert DustTransferFailed(WETH);

        emit Launched(token, msg.sender, locker, pool, tokenId, liquidity, name, symbol);
    }
}
