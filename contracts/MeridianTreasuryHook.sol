// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MeridianTreasuryHook — a launch tax that decays on a fixed schedule.
//
// DRAFT · UNAUDITED · NOT DEPLOYED. This is the highest-risk contract in the
// repo: it sits in the swap path of a live pool, and a mistake here breaks
// trading rather than merely losing our own fee. It needs fork tests against a
// real v4 PoolManager and an external audit before it goes near mainnet.
//
// WHY A HOOK AT ALL:
//   Seeding our own pool already earns us the LP fee on every swap, because we
//   hold the position. That works right up until anyone else provides liquidity
//   — LP fees are shared pro-rata, so our cut dilutes toward zero as the pool
//   grows. A hook takes its share off the top regardless of who supplied the
//   liquidity, which is the only version that survives the pool succeeding.
//
//   A v4 pool's hook is fixed at creation and cannot be added later, so this
//   has to exist at launch or never.
//
// THE SCHEDULE — THREE PHASES:
//   1. RAMP     10% each way, falling to 3% over the first ten minutes. This
//               window exists to make the open unprofitable for snipers: the
//               bots that buy the first block and dump into the first real
//               buyers. It costs an ordinary buyer little, because ordinary
//               buyers are not round-tripping a position inside ten minutes.
//   2. PLATEAU  a flat 3% for the rest of the first day, so the token has one
//               settled, quotable number through the period everybody is
//               actually looking at it, rather than a rate sliding all week.
//   3. TAPER    3% down to a permanent 1% over the following day, and 1% for
//               the life of the pool thereafter.
//
//   The floor matters more than the opening rate. It is the number a trader
//   compares against every other token forever, long after the launch window is
//   a memory, so it settles at 1% rather than staying where the launch left it.
//
// WHY NOT A TRANSFER TAX IN THE TOKEN:
//   Because it would not work. Every v4 swap settles through the PoolManager
//   singleton, and a token that delivers less than the amount recorded in the
//   delta desyncs that settlement — the classic fee-on-transfer failure, which
//   also breaks the PositionManager and would stop us seeding our own pool. A
//   plain ERC-20 also cannot tell a buy from a sell; it sees only from and to,
//   so charging 3% one way and something else the other needs the token to know
//   the pool, which needs a setter, which needs an owner. Doing it here instead
//   keeps the token ownerless and leaves wallet-to-wallet transfers untaxed.
//
// NOBODY CAN CHANGE IT:
//   The schedule is nine immutables set at construction. There is no setter for
//   any of them — not for the owner, not for governance, not through an upgrade,
//   because the contract is not upgradeable and the storage does not exist. The
//   fee is a pure function of how long the pool has been trading.
//
//   The single authority anyone holds is disableFeesForever(), which zeroes the
//   fee permanently and can never raise it. Every lever in this contract points
//   the same way: cheaper for traders, never dearer.
//
// ADDRESS MINING:
//   v4 encodes hook permissions in the low bits of the hook's own address, so
//   this must be deployed via CREATE2 at a salt whose result has AFTER_SWAP and
//   AFTER_SWAP_RETURNS_DELTA set. Deploying to an unmined address does not fail
//   loudly — the pool simply never calls the hook. validateHookAddress() in the
//   constructor turns that silent misconfiguration into a failed deployment.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianTreasuryHook is IHooks {
    /// Hard ceiling on either side, compiled in with no setter anywhere. The
    /// opening rate is validated against it at construction, so no deployment
    /// of this contract can ever charge more than this.
    uint16 public constant MAX_FEE_BPS = 1000; // 10.00%

    IPoolManager public immutable POOL_MANAGER;
    address public immutable TREASURY;

    // ── the schedule. Three phases, all immutable: the fee is a pure function
    //    of time, and no code anywhere can change its shape. ─────────────────
    //
    //    1. LAUNCH RAMP   opening rate falls to the plateau over RAMP_SECONDS.
    //                     This is the anti-sniper window.
    //    2. PLATEAU       flat at the plateau rate until PLATEAU_UNTIL, giving
    //                     the token a settled, predictable cost through its
    //                     first day rather than a number that moves all week.
    //    3. TAPER         plateau falls to the permanent floor over
    //                     TAPER_SECONDS, and stays there for good.
    //
    //    Monotonically non-increasing throughout, enforced at construction: the
    //    rate a holder faces can only ever get cheaper than the one they bought
    //    into.
    uint16 public immutable BUY_LAUNCH_BPS;
    uint16 public immutable BUY_PLATEAU_BPS;
    uint16 public immutable BUY_FLOOR_BPS;
    uint16 public immutable SELL_LAUNCH_BPS;
    uint16 public immutable SELL_PLATEAU_BPS;
    uint16 public immutable SELL_FLOOR_BPS;

    /// Seconds from the first swap for the opening ramp to reach the plateau.
    uint64 public immutable RAMP_SECONDS;
    /// Seconds from the first swap at which the plateau ends and the taper begins.
    uint64 public immutable PLATEAU_UNTIL;
    /// Seconds the taper takes to fall from the plateau to the floor.
    uint64 public immutable TAPER_SECONDS;

    /**
     * When the clock started. Set by the FIRST swap this hook ever sees, then
     * never again.
     *
     * Deliberately not a constructor argument. Pinning the start at deploy time
     * means any delay between deploying and opening the pool burns decay before
     * a single trade happens — and the sniper window the high opening rate
     * exists to tax is measured from the first trade, not from whenever we got
     * around to deploying.
     */
    uint64 public decayStartedAt;

    /**
     * One-way kill switch. The owner may permanently zero the fee and can never
     * raise it — the only authority anyone holds over this contract makes
     * trading CHEAPER, and only once. It exists so a bug here does not mean a
     * pool nobody can afford to trade, not so the rate can be managed.
     */
    bool public feesDisabledForever;
    address public owner;

    event DecayStarted(uint64 startedAt, uint64 endsAt);
    event FeesDisabledForever();
    event OwnerChanged(address indexed previous, address indexed next);
    event FeeTaken(Currency indexed currency, uint256 amount);

    error NotPoolManager();
    error NotOwner();
    error FeeAboveCap(uint16 requested, uint16 cap);
    error ZeroAddress();
    error HookNotImplemented();
    error EndAboveStart();
    error ZeroDecayWindow();
    error PlateauBeforeRamp();

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    struct Schedule {
        uint16 buyLaunchBps;
        uint16 buyPlateauBps;
        uint16 buyFloorBps;
        uint16 sellLaunchBps;
        uint16 sellPlateauBps;
        uint16 sellFloorBps;
        uint64 rampSeconds;
        uint64 plateauUntil;
        uint64 taperSeconds;
    }

    constructor(IPoolManager poolManager, address treasury, address owner_, Schedule memory s) {
        if (address(poolManager) == address(0) || treasury == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (s.buyLaunchBps > MAX_FEE_BPS || s.sellLaunchBps > MAX_FEE_BPS) {
            revert FeeAboveCap(s.buyLaunchBps > s.sellLaunchBps ? s.buyLaunchBps : s.sellLaunchBps, MAX_FEE_BPS);
        }
        // Monotonically non-increasing, both sides. A rate that RISES on holders
        // after they have bought in is the single most hostile thing this
        // contract could be configured to do, so it is rejected outright rather
        // than left to whoever fills in the deploy script.
        if (s.buyPlateauBps > s.buyLaunchBps || s.buyFloorBps > s.buyPlateauBps) revert EndAboveStart();
        if (s.sellPlateauBps > s.sellLaunchBps || s.sellFloorBps > s.sellPlateauBps) revert EndAboveStart();
        if (s.rampSeconds == 0 || s.taperSeconds == 0) revert ZeroDecayWindow();
        // The plateau cannot end before the ramp that feeds it has finished.
        if (s.plateauUntil < s.rampSeconds) revert PlateauBeforeRamp();

        POOL_MANAGER = poolManager;
        TREASURY = treasury;
        owner = owner_;
        BUY_LAUNCH_BPS = s.buyLaunchBps;
        BUY_PLATEAU_BPS = s.buyPlateauBps;
        BUY_FLOOR_BPS = s.buyFloorBps;
        SELL_LAUNCH_BPS = s.sellLaunchBps;
        SELL_PLATEAU_BPS = s.sellPlateauBps;
        SELL_FLOOR_BPS = s.sellFloorBps;
        RAMP_SECONDS = s.rampSeconds;
        PLATEAU_UNTIL = s.plateauUntil;
        TAPER_SECONDS = s.taperSeconds;
        // Fails the deployment if the mined address does not carry the exact
        // permission bits below. Without this, a bad salt yields a hook that is
        // simply never called and a pool that quietly earns nothing.
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The only hook we implement.
    //
    // Core adds our returned int128 to the UNSPECIFIED side of the swap and
    // then does `swapDelta = swapDelta - hookDelta`, so a positive return means
    // the swapper covers it: they receive less when the unspecified currency is
    // the output, or pay more when it is the input. Taking the absolute value
    // therefore charges the same rate in both directions, and exact-output
    // swaps cannot be used to dodge the fee.
    // ─────────────────────────────────────────────────────────────────────────
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // Direction. Our pool is native ETH / MERD, and native ETH is
        // address(0), which always sorts to currency0 — so swapping currency0
        // for currency1 is buying MERD, and the reverse is selling it. That
        // holds for any ETH-paired pool, which is the only kind this hook is
        // deployed for. Attach it to some other pool and the two labels swap
        // over; the fee still reaches the treasury, it is just named backwards.
        // Start the clock on the first swap, once, then never again.
        uint64 startedAt = decayStartedAt;
        if (startedAt == 0) {
            startedAt = uint64(block.timestamp);
            decayStartedAt = startedAt;
            emit DecayStarted(startedAt, startedAt + PLATEAU_UNTIL + TAPER_SECONDS);
        }

        uint16 bps = _feeBpsAt(params.zeroForOne, startedAt, block.timestamp);
        if (bps == 0) return (IHooks.afterSwap.selector, 0);

        // Which side is "unspecified" is the same expression core uses to map
        // our delta back onto currency0/currency1. Kept identical on purpose:
        // if these two ever disagree, the fee is taken in the wrong token.
        bool unspecifiedIsCurrency1 = (params.amountSpecified < 0) == params.zeroForOne;
        Currency currency = unspecifiedIsCurrency1 ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = unspecifiedIsCurrency1 ? delta.amount1() : delta.amount0();
        if (unspecifiedAmount == 0) return (IHooks.afterSwap.selector, 0);

        // Negating int128.min overflows and would revert under checked
        // arithmetic — inside the swap path, so it would take the whole swap
        // down with it rather than just costing us a fee. Unreachable at any
        // realistic size, but "unreachable" is not a reason to leave a revert
        // in a hot path when the guard is one comparison.
        if (unspecifiedAmount == type(int128).min) return (IHooks.afterSwap.selector, 0);
        // Cannot truncate: int128.min is rejected on the line above, so the
        // negation stays inside int128 and both branches widen rather than narrow.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 magnitude = unspecifiedAmount < 0 ? uint256(uint128(-unspecifiedAmount)) : uint256(uint128(unspecifiedAmount));
        uint256 fee = (magnitude * bps) / 10_000;
        if (fee == 0) return (IHooks.afterSwap.selector, 0); // dust: not worth a transfer

        // Claim the credit core just created for us and move it out in the same
        // call, so the hook never carries a balance between transactions.
        POOL_MANAGER.take(currency, TREASURY, fee);
        emit FeeTaken(currency, fee);

        // Cannot truncate: fee is magnitude * bps / 10000 with bps capped at
        // MAX_FEE_BPS (1000), so fee <= magnitude / 10, and magnitude is at most
        // int128.max. A tenth of int128.max is comfortably inside int128.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fee control. Bounded by a constant, so the worst case is readable.
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * The rate at a moment in time. Linear from START to END across
     * DECAY_SECONDS, measured from the first swap.
     *
     * Before any swap has happened the answer is the opening rate — which is
     * also what the very first buyer pays, since the clock starts on their
     * trade rather than before it.
     */
    function _feeBpsAt(bool isBuy, uint64 startedAt, uint256 nowTs) internal view returns (uint16) {
        if (feesDisabledForever) return 0;
        uint16 launchBps = isBuy ? BUY_LAUNCH_BPS : SELL_LAUNCH_BPS;
        uint16 plateauBps = isBuy ? BUY_PLATEAU_BPS : SELL_PLATEAU_BPS;
        uint16 floorBps = isBuy ? BUY_FLOOR_BPS : SELL_FLOOR_BPS;
        if (startedAt == 0) return launchBps;

        uint256 elapsed = nowTs - startedAt;

        // Phase 1 — the anti-sniper ramp.
        if (elapsed < RAMP_SECONDS) {
            uint256 drop = uint256(launchBps - plateauBps);
            // forge-lint: disable-next-line(unsafe-typecast)
            return uint16(launchBps - (drop * elapsed) / RAMP_SECONDS);
        }

        // Phase 2 — flat, so the token has one settled number through its first
        // day instead of a rate that moves under everyone all week.
        if (elapsed < PLATEAU_UNTIL) return plateauBps;

        // Phase 3 — the long taper to the permanent floor.
        uint256 intoTaper = elapsed - PLATEAU_UNTIL;
        if (intoTaper >= TAPER_SECONDS) return floorBps;
        uint256 taperDrop = uint256(plateauBps - floorBps);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(plateauBps - (taperDrop * intoTaper) / TAPER_SECONDS);
    }

    /// What a trade costs right now, for the UI and for anyone checking.
    function currentFeeBps() external view returns (uint16 buyBps, uint16 sellBps) {
        uint64 startedAt = decayStartedAt;
        buyBps = _feeBpsAt(true, startedAt, block.timestamp);
        sellBps = _feeBpsAt(false, startedAt, block.timestamp);
    }

    /// When the rate reaches its floor. Zero until the first swap starts the clock.
    /// When the rate reaches its permanent floor. Zero until the first swap.
    function decayEndsAt() external view returns (uint64) {
        uint64 startedAt = decayStartedAt;
        return startedAt == 0 ? 0 : startedAt + PLATEAU_UNTIL + TAPER_SECONDS;
    }

    /**
     * One-way, and the only authority anyone has over the rate. It can make
     * trading free and can never make it cost more.
     */
    function disableFeesForever() external onlyOwner {
        feesDisabledForever = true;
        emit FeesDisabledForever();
    }

    function transferOwnership(address next) external onlyOwner {
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// Removes even the ability to zero the fee. After this the schedule runs
    /// to completion untouched by anyone, forever.
    function renounceOwnership() external onlyOwner {
        emit OwnerChanged(owner, address(0));
        owner = address(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Everything else is unimplemented. The permission bits mean core will
    // never call these, so reverting is unreachable in practice — it exists so
    // that a future pool created against this hook with different flags fails
    // immediately instead of silently skipping logic that was never written.
    // ─────────────────────────────────────────────────────────────────────────
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
