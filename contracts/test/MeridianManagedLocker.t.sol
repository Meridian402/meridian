// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MeridianManagedLocker, INonfungiblePositionManager, IUniswapV3Pool, IERC20} from "../MeridianManagedLocker.sol";

// ─────────────────────────────────────────────────────────────────────────────
// These test the guard rails, not the arithmetic of Uniswap. The contract's
// entire safety claim is "a compromised agent key is boring", and every test
// below is one way someone would try to make it interesting.
//
// Mocked rather than forked on purpose: the properties here are about what the
// contract REFUSES to do, and a mock lets us put the pool in states a live pool
// would not sit still for (a flash-manipulated tick, say). Fork tests against a
// real Sushi V3 pool are still required before this is deployed — they cover
// the arithmetic these do not.
// ─────────────────────────────────────────────────────────────────────────────

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

contract MockPool {
    int24 public tick;
    int24 public tickSpacingValue = 200;
    int56 public cumulativeDelta; // tickCumulative[1] - tickCumulative[0]

    function setTick(int24 t) external {
        tick = t;
    }

    function setTwapTick(int24 t, uint32 window) external {
        cumulativeDelta = int56(t) * int56(uint56(window));
    }

    function tickSpacing() external view returns (int24) {
        return tickSpacingValue;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, 0, 0, 0, 0, true);
    }

    function observe(uint32[] calldata) external view returns (int56[] memory tc, uint160[] memory sl) {
        tc = new int56[](2);
        tc[0] = 0;
        tc[1] = cumulativeDelta;
        sl = new uint160[](2);
    }
}

contract MockPositionManager {
    struct Pos {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Pos) public pos;
    uint128 public owed0;
    uint128 public owed1;
    MockERC20 public t0;
    MockERC20 public t1;

    constructor(MockERC20 a, MockERC20 b) {
        t0 = a;
        t1 = b;
    }

    /// Simulate fees accruing to the position.
    function setOwed(uint128 a, uint128 b) external {
        owed0 = a;
        owed1 = b;
    }

    function mint(INonfungiblePositionManager.MintParams calldata p)
        external
        returns (uint256 id, uint128 liq, uint256, uint256)
    {
        id = nextId++;
        // Liquidity stands in for "the position holds value"; the real curve
        // maths is Uniswap's problem, not this contract's.
        liq = uint128(p.amount0Desired + p.amount1Desired);
        if (liq == 0) liq = 1;
        pos[id] = Pos(p.tickLower, p.tickUpper, liq);
        return (id, liq, p.amount0Desired, p.amount1Desired);
    }

    function decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams calldata p)
        external
        returns (uint256, uint256)
    {
        pos[p.tokenId].liquidity -= p.liquidity;
        return (0, 0);
    }

    function collect(INonfungiblePositionManager.CollectParams calldata p) external returns (uint256, uint256) {
        uint256 a = owed0;
        uint256 b = owed1;
        owed0 = 0;
        owed1 = 0;
        if (a > 0) t0.mint(p.recipient, a);
        if (b > 0) t1.mint(p.recipient, b);
        return (a, b);
    }

    function burn(uint256 id) external {
        delete pos[id];
    }

    function positions(uint256 id)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Pos memory p = pos[id];
        return (0, address(0), address(t0), address(t1), 10000, p.lower, p.upper, p.liquidity, 0, 0, 0, 0);
    }
}

contract MeridianManagedLockerTest is Test {
    MeridianManagedLocker locker;
    MockPool pool;
    MockPositionManager npm;
    MockERC20 token0;
    MockERC20 token1;

    address creator = address(0xC0FFEE);
    address platform = address(0xBEEF);
    address agent = address(0xA6E17);
    address stranger = address(0xBAD);

    int24 constant SPOT = 200_000; // aligned to spacing 200

    function setUp() public {
        token0 = new MockERC20();
        token1 = new MockERC20();
        pool = new MockPool();
        npm = new MockPositionManager(token0, token1);

        pool.setTick(SPOT);
        pool.setTwapTick(SPOT, 30 minutes);

        locker = new MeridianManagedLocker(
            INonfungiblePositionManager(address(npm)),
            IUniswapV3Pool(address(pool)),
            address(token0),
            address(token1),
            10000,
            creator,
            platform,
            7000, // 70% to creator
            agent
        );

        token0.mint(address(locker), 1_000_000 ether);
        token1.mint(address(locker), 10 ether);
        vm.prank(creator);
        locker.seed(SPOT - 2000, SPOT + 2000, block.timestamp + 1);
    }

    // ── the lock itself ──────────────────────────────────────────────────────

    function test_thereIsNoWithdrawFunction() public {
        // The claim buyers rely on. If a withdraw/sweep/rescue ever appears,
        // this is the test that should have to be deleted first.
        bytes4[3] memory forbidden = [
            bytes4(keccak256("withdraw()")),
            bytes4(keccak256("sweep(address)")),
            bytes4(keccak256("rescue(address,uint256)"))
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok,) = address(locker).call(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok, "a withdrawal path exists");
        }
    }

    function test_seedIsOneShot() public {
        vm.prank(creator);
        vm.expectRevert(MeridianManagedLocker.AlreadySeeded.selector);
        locker.seed(SPOT - 2000, SPOT + 2000, block.timestamp + 1);
    }

    // ── who may do what ──────────────────────────────────────────────────────

    function test_onlyAgentCanRerange() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(stranger);
        vm.expectRevert(MeridianManagedLocker.NotAgent.selector);
        locker.rerange(SPOT - 1000, SPOT + 1000, block.timestamp + 1);
    }

    function test_creatorCannotRerange() public {
        // The creator owns the token, not the strategy. Letting them re-range
        // would hand the launcher a lever over their own buyers' liquidity.
        vm.warp(block.timestamp + 2 hours);
        vm.prank(creator);
        vm.expectRevert(MeridianManagedLocker.NotAgent.selector);
        locker.rerange(SPOT - 1000, SPOT + 1000, block.timestamp + 1);
    }

    function test_renounceIsPermanentAndLeavesAnOrdinaryLockedLp() public {
        vm.prank(creator);
        locker.renounceManagement();
        assertEq(locker.agent(), address(0));

        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(MeridianManagedLocker.NotAgent.selector);
        locker.rerange(SPOT - 1000, SPOT + 1000, block.timestamp + 1);

        // And it cannot be switched back on.
        vm.prank(creator);
        vm.expectRevert(MeridianManagedLocker.ManagementIsRenounced.selector);
        locker.setAgent(agent);
    }

    // ── the range guard rails ────────────────────────────────────────────────

    function test_rejectsRangeThatDoesNotBracketPrice() public {
        // The dangerous shape: liquidity entirely below the price is a standing
        // order to sell the whole supply into the first bid.
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(MeridianManagedLocker.RangeMustBracketPrice.selector, SPOT - 4000, SPOT, SPOT - 1000)
        );
        locker.rerange(SPOT - 4000, SPOT - 1000, block.timestamp + 1);
    }

    function test_rejectsRangeTouchingTheTickExactly() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert();
        locker.rerange(SPOT, SPOT + 2000, block.timestamp + 1);
    }

    function test_rejectsTooNarrowRange() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MeridianManagedLocker.RangeTooNarrow.selector, int24(400), int24(800)));
        locker.rerange(SPOT - 200, SPOT + 200, block.timestamp + 1);
    }

    function test_rejectsMisalignedTicks() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(MeridianManagedLocker.TicksMisaligned.selector);
        locker.rerange(SPOT - 1001, SPOT + 1000, block.timestamp + 1);
    }

    function test_rejectsPriceManipulatedAwayFromTwap() public {
        // The flash-loan shape: shove the pool, re-range onto the fake price,
        // let it snap back. The TWAP is what makes this unprofitable.
        vm.warp(block.timestamp + 2 hours);
        pool.setTick(SPOT + 5000); // spot moved, TWAP did not
        vm.prank(agent);
        vm.expectRevert();
        locker.rerange(SPOT + 4000, SPOT + 6000, block.timestamp + 1);
    }

    function test_acceptsAnHonestRerange() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        locker.rerange(SPOT - 1000, SPOT + 1000, block.timestamp + 1);
        (int24 lower, int24 upper, uint128 liq, bool inRange) = locker.position();
        assertEq(lower, SPOT - 1000);
        assertEq(upper, SPOT + 1000);
        assertGt(liq, 0);
        assertTrue(inRange);
    }

    function test_cooldownStopsGrinding() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        locker.rerange(SPOT - 1000, SPOT + 1000, block.timestamp + 1);

        vm.prank(agent);
        vm.expectRevert();
        locker.rerange(SPOT - 1200, SPOT + 1200, block.timestamp + 1);

        vm.warp(block.timestamp + 61 minutes);
        vm.prank(agent);
        locker.rerange(SPOT - 1200, SPOT + 1200, block.timestamp + 1);
    }

    // ── fees ─────────────────────────────────────────────────────────────────

    function test_feesSplitByImmutableBpsAndAnyoneMayTrigger() public {
        npm.setOwed(1000, 500);
        vm.prank(stranger); // permissionless on purpose
        locker.collectFees();

        assertEq(token0.balanceOf(creator), 700, "creator token0");
        assertEq(token0.balanceOf(platform), 300, "platform token0");
        assertEq(token1.balanceOf(creator), 350, "creator token1");
        assertEq(token1.balanceOf(platform), 150, "platform token1");
    }

    function test_rerangeDoesNotPayPrincipalOutAsFees() public {
        // Fees are collected before principal is unwound precisely so the two
        // can never be confused. With no fees accrued, a re-range must move
        // nothing to the creator or the platform.
        vm.warp(block.timestamp + 2 hours);
        npm.setOwed(0, 0);
        vm.prank(agent);
        locker.rerange(SPOT - 1000, SPOT + 1000, block.timestamp + 1);

        assertEq(token0.balanceOf(creator), 0, "principal leaked to creator");
        assertEq(token0.balanceOf(platform), 0, "principal leaked to platform");
        assertEq(token1.balanceOf(creator), 0);
        assertEq(token1.balanceOf(platform), 0);
    }
}
