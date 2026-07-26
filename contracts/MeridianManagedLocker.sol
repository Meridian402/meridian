// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianManagedLocker — a launch LP that is locked from withdrawal but still
// actively managed.
//
// DRAFT · UNAUDITED · NOT DEPLOYED. Needs a Foundry suite (fork tests against a
// live Sushi/Uniswap V3 pool, plus the adversarial cases in THREAT MODEL below)
// and an external audit before it holds a single real launch.
//
// WHY THIS EXISTS:
//   Every launchpad on this chain locks a FULL-RANGE LP position forever. That
//   buys the one thing buyers actually need — the deployer cannot pull the
//   liquidity — but it pays for it with capital efficiency. Full-range liquidity
//   on a 1% pool earns a fraction of what a concentrated position earns on the
//   same capital, and that gap is permanent because nobody can ever move it.
//
//   This contract keeps the lock and drops the inefficiency. The position NFT
//   can never leave, and principal can never be withdrawn by anyone, ever — but
//   an agent may re-range it around the market so the liquidity sits where the
//   trading is. Same anti-rug promise, materially more fees.
//
// SECURITY MODEL (the whole point of this contract):
//   One invariant carries everything: PRINCIPAL CANNOT LEAVE. The only value
//   that ever exits is trading fees, and they exit only to the two addresses
//   fixed at construction, split by immutable bps.
//
//   Re-ranging is therefore built to be value-preserving by construction, not
//   by good behaviour:
//     1. NO SWAPS, ever. Re-ranging withdraws liquidity and re-mints it at new
//        ticks with whatever token ratio it already holds. Leftovers stay in
//        the contract, locked, and fold into the next re-range. A contract that
//        cannot swap cannot be sandwiched, cannot slip, and cannot be used to
//        route value out through a DEX.
//     2. The new range MUST bracket the live tick. A range entirely on one side
//        of the price is not liquidity, it is a resting order to sell the whole
//        supply — the exact shape a malicious manager would want.
//     3. The live tick must sit near a TWAP. Otherwise an attacker flash-moves
//        the pool, triggers a re-range onto the manipulated price, and takes
//        the difference back when it reverts.
//     4. A width floor and a cooldown. Narrow ranges get picked off by arb and
//        bleed the position; rapid re-ranging grinds it out in rounding dust.
//
//   The manager is bounded, not trusted. A fully compromised agent key can only
//   move liquidity to a sane range near the true price, no more than once per
//   cooldown. It cannot withdraw, cannot swap, cannot transfer the NFT, and
//   cannot redirect fees.
//
//   And the floor of the product is the competition's product: the creator can
//   call renounceManagement() at any time, permanently. What remains is an
//   ordinary locked LP, which is exactly what every other launchpad ships.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Uniswap V3 NonfungiblePositionManager. Sushi V3 is a V3 fork and exposes the
/// same surface, so one implementation serves both venues.
interface INonfungiblePositionManager {
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

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable;

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

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function tickSpacing() external view returns (int24);
}

contract MeridianManagedLocker {
    // ── immutable wiring. No owner, no proxy, no setters on any of it. ────────
    INonfungiblePositionManager public immutable POSITION_MANAGER;
    IUniswapV3Pool public immutable POOL;
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    uint24 public immutable FEE;
    int24 public immutable TICK_SPACING;

    /// Fees split between these two and nobody else. Set once, forever.
    address public immutable CREATOR;
    address public immutable PLATFORM;
    uint16 public immutable CREATOR_FEE_BPS;

    // ── management bounds. Chosen to make a compromised agent boring. ─────────

    /// Minimum range width, in tick spacings. A position narrower than this is
    /// arbitrage bait: it spends most of its life out of range and gets run
    /// over on the way through.
    int24 public constant MIN_WIDTH_SPACINGS = 4;

    /// Shortest gap between re-ranges. Each one crosses the spread and rounds
    /// down; without a floor, a manager could grind the position away in dust
    /// while never once breaking a rule.
    uint256 public constant RERANGE_COOLDOWN = 1 hours;

    /// TWAP window and the furthest the spot tick may sit from it. This is what
    /// stops a flash-manipulated price from being written into the position.
    uint32 public constant TWAP_WINDOW = 30 minutes;
    int24 public constant MAX_TWAP_DEVIATION_TICKS = 600; // ~6.2%

    // ── state. Deliberately tiny. ────────────────────────────────────────────
    uint256 public tokenId;
    address public agent;
    uint256 public lastRerangeAt;
    bool public managementRenounced;

    event Seeded(uint256 indexed tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event Reranged(uint256 indexed tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event FeesCollected(uint256 amount0, uint256 amount1, uint256 creator0, uint256 creator1);
    event AgentChanged(address indexed previous, address indexed next);
    event ManagementRenounced();

    error AlreadySeeded();
    error NotSeeded();
    error NotAgent();
    error NotCreator();
    error ManagementIsRenounced();
    error CooldownActive(uint256 readyAt);
    error RangeTooNarrow(int24 width, int24 minimum);
    error RangeMustBracketPrice(int24 tickLower, int24 tick, int24 tickUpper);
    error TicksMisaligned();
    error PriceDeviatesFromTwap(int24 spot, int24 twap);
    error NoLiquidityMinted();
    error ZeroAddress();
    error FeeSplitTooHigh();
    error TransferFailed(address token, address to, uint256 amount);
    error ApprovalFailed(address token, address spender);

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        if (managementRenounced) revert ManagementIsRenounced();
        _;
    }

    modifier onlyCreator() {
        if (msg.sender != CREATOR) revert NotCreator();
        _;
    }

    constructor(
        INonfungiblePositionManager positionManager,
        IUniswapV3Pool pool,
        address token0,
        address token1,
        uint24 fee,
        address creator,
        address platform,
        uint16 creatorFeeBps,
        address agent_
    ) {
        if (
            address(positionManager) == address(0) || address(pool) == address(0) || token0 == address(0)
                || token1 == address(0) || creator == address(0) || platform == address(0)
        ) revert ZeroAddress();
        if (creatorFeeBps > 10_000) revert FeeSplitTooHigh();

        POSITION_MANAGER = positionManager;
        POOL = pool;
        TOKEN0 = token0;
        TOKEN1 = token1;
        FEE = fee;
        TICK_SPACING = pool.tickSpacing();
        CREATOR = creator;
        PLATFORM = platform;
        CREATOR_FEE_BPS = creatorFeeBps;
        agent = agent_; // may be address(0): an unmanaged, ordinary locked LP
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Seeding. Called once, by the creator, after the launch has sent this
    // contract the token supply and the paired asset. The NFT is minted to
    // address(this) and there is no code path anywhere below that transfers it.
    // ─────────────────────────────────────────────────────────────────────────
    function seed(int24 tickLower, int24 tickUpper, uint256 deadline) external onlyCreator returns (uint256 id) {
        if (tokenId != 0) revert AlreadySeeded();
        _validateRange(tickLower, tickUpper);

        uint256 amount0 = IERC20(TOKEN0).balanceOf(address(this));
        uint256 amount1 = IERC20(TOKEN1).balanceOf(address(this));
        _safeApprove(TOKEN0, address(POSITION_MANAGER), amount0);
        _safeApprove(TOKEN1, address(POSITION_MANAGER), amount1);

        uint128 liquidity;
        (id, liquidity,,) = POSITION_MANAGER.mint(
            INonfungiblePositionManager.MintParams({
                token0: TOKEN0,
                token1: TOKEN1,
                fee: FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                // Zero minimums are safe HERE and only here: this is the first
                // mint, there is no pre-existing position to be sandwiched out
                // of, and the contract cannot spend what it does not hold.
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: deadline
            })
        );
        if (liquidity == 0) revert NoLiquidityMinted();

        tokenId = id;
        lastRerangeAt = block.timestamp;
        emit Seeded(id, tickLower, tickUpper, liquidity);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Re-ranging — the entire reason this contract is not just a locker.
    //
    // Withdraw all liquidity, then immediately re-mint at new ticks using the
    // exact tokens that came back out. No swap happens at any point, so there
    // is no price to be manipulated against us and no route by which value can
    // leave. Whatever the ratio cannot absorb stays here, locked, and is picked
    // up by the next call.
    //
    // The old NFT is burned and a new one minted because a V3 position's ticks
    // are immutable. Burning is only possible once liquidity and owed tokens
    // are zero, which is itself a check that nothing was left behind.
    // ─────────────────────────────────────────────────────────────────────────
    function rerange(int24 tickLower, int24 tickUpper, uint256 deadline) external onlyAgent {
        uint256 id = tokenId;
        if (id == 0) revert NotSeeded();
        // block.timestamp is fine as a cooldown clock here. The bound being
        // enforced is an hour; the drift a sequencer could introduce is seconds.
        // Nothing about this contract's safety rests on the exact second, only
        // on re-ranging being infrequent enough that dust cannot be ground out.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < lastRerangeAt + RERANGE_COOLDOWN) {
            revert CooldownActive(lastRerangeAt + RERANGE_COOLDOWN);
        }
        _validateRange(tickLower, tickUpper);

        // Pay out fees first. Doing it before the principal comes back makes the
        // accounting unambiguous: everything collected here is fee income, and
        // everything collected after is principal. Mixing them would let fee
        // maths silently pay out principal.
        _collectFees(id);

        (,,,,,,, uint128 liquidity,,,,) = POSITION_MANAGER.positions(id);
        if (liquidity > 0) {
            POSITION_MANAGER.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: id,
                    liquidity: liquidity,
                    // Slippage bounds are unnecessary: removing liquidity is not
                    // a trade and returns whatever the position is worth at the
                    // current tick. The TWAP guard above is what ensures that
                    // tick is honest.
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: deadline
                })
            );
        }
        // Sweep principal into this contract.
        POSITION_MANAGER.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: id,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        POSITION_MANAGER.burn(id);

        uint256 amount0 = IERC20(TOKEN0).balanceOf(address(this));
        uint256 amount1 = IERC20(TOKEN1).balanceOf(address(this));
        _safeApprove(TOKEN0, address(POSITION_MANAGER), amount0);
        _safeApprove(TOKEN1, address(POSITION_MANAGER), amount1);

        (uint256 newId, uint128 newLiquidity,,) = POSITION_MANAGER.mint(
            INonfungiblePositionManager.MintParams({
                token0: TOKEN0,
                token1: TOKEN1,
                fee: FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: deadline
            })
        );
        // A re-range that ends with no liquidity has effectively withdrawn the
        // position. Revert rather than leave the contract holding loose tokens
        // with no NFT.
        if (newLiquidity == 0) revert NoLiquidityMinted();

        tokenId = newId;
        lastRerangeAt = block.timestamp;
        emit Reranged(newId, tickLower, tickUpper, newLiquidity);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fees. Permissionless on purpose — the split is immutable, so there is no
    // reason to gate who pushes the button, and a creator should never need our
    // cooperation to get paid.
    // ─────────────────────────────────────────────────────────────────────────
    function collectFees() external {
        uint256 id = tokenId;
        if (id == 0) revert NotSeeded();
        _collectFees(id);
    }

    function _collectFees(uint256 id) internal {
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

    // ─────────────────────────────────────────────────────────────────────────
    // ERC-20 calls that tolerate the tokens that actually exist.
    //
    // TOKEN0 is whatever someone launched — this contract does not get to
    // assume it is well behaved. Plenty of live tokens return nothing at all
    // from transfer/approve (the pre-EIP-20-finalisation shape), and a bare
    // IERC20(t).transfer() reverts on those because the ABI decoder expects a
    // bool. Others return false instead of reverting, which an unchecked call
    // would read as success and silently skip a fee payout.
    // ─────────────────────────────────────────────────────────────────────────
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token, to, amount);
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApprovalFailed(token, spender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Creator controls. The creator may replace the agent (key rotation is a
    // real operational need, and the agent's powers are bounded anyway) or shut
    // management off permanently. They can never withdraw.
    // ─────────────────────────────────────────────────────────────────────────
    function setAgent(address next) external onlyCreator {
        if (managementRenounced) revert ManagementIsRenounced();
        emit AgentChanged(agent, next);
        agent = next;
    }

    /// One-way. After this the position is an ordinary permanently-locked LP.
    function renounceManagement() external onlyCreator {
        managementRenounced = true;
        emit AgentChanged(agent, address(0));
        agent = address(0);
        emit ManagementRenounced();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The guard rails, in one place so they can be read as a set.
    // ─────────────────────────────────────────────────────────────────────────
    function _validateRange(int24 tickLower, int24 tickUpper) internal view {
        if (tickLower % TICK_SPACING != 0 || tickUpper % TICK_SPACING != 0) revert TicksMisaligned();

        int24 width = tickUpper - tickLower;
        int24 minimum = TICK_SPACING * MIN_WIDTH_SPACINGS;
        if (width < minimum) revert RangeTooNarrow(width, minimum);

        (, int24 spot,,,,,) = POOL.slot0();
        // Strictly bracketing, not merely touching. A range whose edge sits
        // exactly on the tick is one block away from being one-sided.
        if (tickLower >= spot || spot >= tickUpper) revert RangeMustBracketPrice(tickLower, spot, tickUpper);

        int24 twap = _twapTick();
        int24 deviation = spot > twap ? spot - twap : twap - spot;
        if (deviation > MAX_TWAP_DEVIATION_TICKS) revert PriceDeviatesFromTwap(spot, twap);
    }

    function _twapTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory cumulatives,) = POOL.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        // The cast cannot truncate. tickCumulative accumulates tick*seconds, so
        // delta/WINDOW is a time-weighted average of ticks, and every tick the
        // pool can hold is bounded by V3's own ±887272 — comfortably inside
        // int24's ±8388607. A value outside that range is not reachable without
        // the pool itself already being broken.
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 twap = int24(delta / int56(uint56(TWAP_WINDOW)));
        // Solidity truncates toward zero; V3's own TickMath rounds down. Match
        // it so a negative tick is not silently reported one tick high.
        if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) twap--;
        return twap;
    }

    /// Current position, for the UI and the off-chain guard.
    function position() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity, bool inRange) {
        uint256 id = tokenId;
        if (id == 0) return (0, 0, 0, false);
        (,,,,, tickLower, tickUpper, liquidity,,,,) = POSITION_MANAGER.positions(id);
        (, int24 spot,,,,,) = POOL.slot0();
        inRange = tickLower <= spot && spot < tickUpper;
    }
}
