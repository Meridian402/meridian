// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianToken} from "../MeridianToken.sol";
import {MeridianTreasuryHook} from "../MeridianTreasuryHook.sol";
import {MeridianPositionLock, IPositionManager} from "../MeridianPositionLock.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

// ─────────────────────────────────────────────────────────────────────────────
// THE DRESS REHEARSAL.
//
// Every other test proves one piece. This runs the ENTIRE launch, in order,
// against forked mainnet state with the real deterministic deployer and the real
// salts: deploy the token, deploy the hook, deploy the lock, create and seed the
// pool with the whole supply, record the position, trade against it, and collect
// the fees.
//
// Two things only this can establish.
//
//   THE PINNED ADDRESSES ARE REAL. The token, hook and lock addresses recorded
//   in agent/src/launch are computed off-chain from init code hashes. Here they
//   are produced by the actual CREATE2 proxy on the actual chain. If the pinned
//   values and the produced values disagree, every one of them is wrong and the
//   launch would deploy to addresses nobody has checked.
//
//   THE HOOK AND THE LOCK WORK TOGETHER. They have only ever been tested apart:
//   the hook against a pool with no lock, the lock against a pool with no hook.
//   On the real pool the hook takes its cut in afterSwap BEFORE the LP fee
//   accrues to the position the lock holds, and those two paths have never run
//   in the same swap.
//
// This is a rehearsal, not a launch. A CREATE2 address is one-shot, so running
// these parameters against mainnet for real would BE the launch — irreversibly.
// The fork gives identical code and identical chain state with none of that.
//
// Run:
//   forge test --match-path "contracts/test/MerdLaunch.fork.t.sol" --fork-url <rpc> -vv
// ─────────────────────────────────────────────────────────────────────────────

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManagerFull {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract MerdLaunchForkTest is Test, IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    // ── live infrastructure ──────────────────────────────────────────────────
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManagerFull constant POSM = IPositionManagerFull(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ── exactly what agent/src/launch pins ───────────────────────────────────
    address constant TREASURY = 0x475C1fe4d1e7A703eaca6141978b04010e410Bf4;

    bytes32 constant MERD_SALT = bytes32(uint256(0x051c4d));
    address constant EXPECTED_MERD = 0x4663b8F879484A671B98320808142a722FC7e703;

    bytes32 constant HOOK_SALT = bytes32(uint256(0x9fca));
    address constant EXPECTED_HOOK = 0x9f67875975D518AD71864A7164A1a788411F0044;

    address constant EXPECTED_LOCK = 0x184948C404573e2E3940302be9c43FB586193cbd;

    // MERD_SEED: one ETH against the entire supply.
    uint256 constant SEED_ETH = 1 ether;
    uint256 constant SEED_MERD = 1_000_000_000 ether;
    uint160 constant SEED_SQRT_PRICE = 2505414483750479311864138015696063;
    uint256 constant SEED_LIQUIDITY = 31306548835666955386788;

    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    MeridianToken merd;
    MeridianTreasuryHook hook;
    MeridianPositionLock lock;
    PoolKey key;
    uint256 positionId;

    bool forked;

    function setUp() public {
        if (address(POOL_MANAGER).code.length == 0) return;
        forked = true;
        vm.deal(TREASURY, 10 ether);
        vm.deal(address(this), 1_000 ether);
    }

    /// The real proxy: it takes salt ++ initCode and CREATE2s the remainder.
    function _create2(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "CREATE2 deploy failed");
        deployed = address(uint160(bytes20(ret)));
    }

    // ── the launch, in order ─────────────────────────────────────────────────

    function _deployAll() internal {
        merd = MeridianToken(
            _create2(MERD_SALT, abi.encodePacked(type(MeridianToken).creationCode, abi.encode("Meridian", "MERD", SEED_MERD, TREASURY)))
        );

        hook = MeridianTreasuryHook(
            _create2(
                HOOK_SALT,
                abi.encodePacked(
                    type(MeridianTreasuryHook).creationCode,
                    abi.encode(
                        POOL_MANAGER,
                        TREASURY,
                        TREASURY,
                        MeridianTreasuryHook.Schedule({
                            buyLaunchBps: 1000,
                            buyPlateauBps: 300,
                            buyFloorBps: 100,
                            sellLaunchBps: 1000,
                            sellPlateauBps: 300,
                            sellFloorBps: 100,
                            rampSeconds: 600,
                            plateauUntil: 86_400,
                            taperSeconds: 86_400,
                            referralShareBps: 1000,
                            lpShareBps: 1000
                        })
                    )
                )
            )
        );

        lock = MeridianPositionLock(
            payable(
                _create2(
                    keccak256("meridian:position-lock:v1"),
                    abi.encodePacked(
                        type(MeridianPositionLock).creationCode,
                        abi.encode(IPositionManager(address(POSM)), address(0), address(merd), TREASURY, TREASURY, uint16(10_000))
                    )
                )
            )
        );

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(merd)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
    }

    function _seed() internal {
        vm.startPrank(TREASURY);
        merd.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(merd), address(POSM), type(uint160).max, uint48(block.timestamp + 1 days));

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, int24(-887200), int24(887200), SEED_LIQUIDITY, uint128(SEED_ETH), uint128(SEED_MERD), address(lock), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        // Creation and seeding in one transaction, as the launch does.
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IPositionManagerFull.initializePool, (key, SEED_SQRT_PRICE));
        calls[1] = abi.encodeCall(
            IPositionManagerFull.modifyLiquidities,
            (abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), block.timestamp + 60)
        );
        positionId = POSM.nextTokenId();
        POSM.multicall{value: SEED_ETH}(calls);
        vm.stopPrank();
    }

    // ── swap harness ─────────────────────────────────────────────────────────

    function _swap(uint256 amount, bool zeroForOne) internal {
        POOL_MANAGER.unlock(abi.encode(amount, zeroForOne));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(POOL_MANAGER), "only manager");
        (uint256 amount, bool zeroForOne) = abi.decode(data, (uint256, bool));
        BalanceDelta d = POOL_MANAGER.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 d0 = d.amount0();
        int128 d1 = d.amount1();
        if (d0 < 0) {
            POOL_MANAGER.sync(key.currency0);
            POOL_MANAGER.settle{value: uint128(-d0)}();
        } else if (d0 > 0) {
            POOL_MANAGER.take(key.currency0, address(this), uint128(d0));
        }
        if (d1 < 0) {
            POOL_MANAGER.sync(key.currency1);
            merd.transfer(address(POOL_MANAGER), uint128(-d1));
            POOL_MANAGER.settle();
        } else if (d1 > 0) {
            POOL_MANAGER.take(key.currency1, address(this), uint128(d1));
        }
        return "";
    }

    receive() external payable {}

    // ── 1. the addresses we published are the addresses we get ───────────────

    function test_launch_everyPinnedAddressReproducesOnChain() public {
        if (!forked) return;
        _deployAll();

        assertEq(address(merd), EXPECTED_MERD, "MERD_ADDRESS does not match what the real deployer produced");
        assertEq(address(hook), EXPECTED_HOOK, "MERD_HOOK_ADDRESS does not match");
        assertEq(address(lock), EXPECTED_LOCK, "MERD_LOCK_ADDRESS does not match");

        // The hook's address must spell its own permissions, or v4 never calls it.
        assertEq(uint160(address(hook)) & 0x3FFF, 0x044, "hook address must claim AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA");

        // The whole supply, in the treasury, before any of it moves.
        assertEq(merd.totalSupply(), SEED_MERD);
        assertEq(merd.balanceOf(TREASURY), SEED_MERD, "the treasury holds every token");
    }

    // ── 2. the launch transaction itself ─────────────────────────────────────

    function test_launch_theWholeSupplyEndsUpInsideTheLock() public {
        if (!forked) return;
        _deployAll();
        _seed();

        assertEq(POSM.ownerOf(positionId), address(lock), "the position is owned by the lock, not a wallet");
        // v4 mints with _mint, so the lock has not been told yet.
        assertEq(lock.tokenId(), 0, "the mint does not notify");
        lock.lockExisting(positionId);
        assertTrue(lock.isLocked(), "recorded");

        // Nothing meaningful left behind: the haircut keeps ~1%, and the
        // treasury holds no position NFT at all.
        assertLt(merd.balanceOf(TREASURY), SEED_MERD / 50, "essentially the whole supply went into the pool");
        assertEq(merd.balanceOf(address(lock)), 0, "the lock holds the position, not loose tokens");
    }

    // ── 3. the hook and the lock in the same swap ────────────────────────────

    function test_launch_hookFeeAndLpFeeBothLandFromOneSwap() public {
        if (!forked) return;
        _deployAll();
        _seed();
        lock.lockExisting(positionId);

        uint256 treasuryMerdBefore = merd.balanceOf(TREASURY);

        // A buy. The hook takes its cut of the MERD out; the pool's own 1% fee
        // accrues to the locked position.
        _swap(0.1 ether, true);

        // The hook fired: the clock started, and the treasury was paid in MERD.
        assertEq(hook.decayStartedAt(key.toId()), uint64(block.timestamp), "the first swap starts the decay clock");
        assertGt(merd.balanceOf(TREASURY) - treasuryMerdBefore, 0, "the hook paid the treasury");

        // And the LP side accrued to the position — collected through the lock.
        uint256 ethBefore = TREASURY.balance;
        uint256 merdBefore = merd.balanceOf(TREASURY);
        lock.collectFees();
        assertGt(merd.balanceOf(TREASURY) - merdBefore, 0, "LP fees reached the treasury through the lock");
        assertGe(TREASURY.balance, ethBefore, "ETH side is non-negative");
        assertEq(address(lock).balance, 0, "nothing stranded in the lock");
    }

    function test_launch_theOpeningTaxIsTenPercentAndDecays() public {
        if (!forked) return;
        _deployAll();
        _seed();
        lock.lockExisting(positionId);

        uint256 before = merd.balanceOf(address(this));
        // The treasury does NOT start at zero: the 1% liquidity haircut leaves
        // roughly 10M MERD behind after seeding. Measuring the absolute balance
        // here reads that leftover as fee income and reports a 1,100% tax rate.
        uint256 treasuryBefore = merd.balanceOf(TREASURY);

        _swap(0.01 ether, true);

        uint256 received = merd.balanceOf(address(this)) - before;
        // 90% of the fee is readable as a balance; the other 10% was donated
        // into the pool for in-range LPs and is not a balance anyone holds.
        uint256 observable = merd.balanceOf(TREASURY) - treasuryBefore;
        assertApproxEqRel(observable, received / 10, 0.02e18, "about a 10% opening rate");

        // Two days later the floor applies, and trading still works.
        vm.warp(block.timestamp + 48 hours);
        uint256 mid = merd.balanceOf(TREASURY);
        _swap(0.01 ether, true);
        assertGt(merd.balanceOf(TREASURY), mid, "the 1% floor still charges");
    }

    function test_launch_sellsWorkAndPayTheTreasuryInEth() public {
        if (!forked) return;
        _deployAll();
        _seed();
        lock.lockExisting(positionId);

        _swap(0.1 ether, true); // buy, so this contract holds MERD
        uint256 ethBefore = TREASURY.balance;
        _swap(merd.balanceOf(address(this)) / 10, false); // sell

        assertGt(TREASURY.balance, ethBefore, "the sell-side fee is taken in ETH");
    }

    // ── 4. the supply cannot come back out ───────────────────────────────────

    function test_launch_nobodyCanRetrieveTheSupply() public {
        if (!forked) return;
        _deployAll();
        _seed();
        lock.lockExisting(positionId);

        // Not the treasury, which signed the launch.
        vm.startPrank(TREASURY);
        (bool a,) = address(lock).call(abi.encodeWithSignature("withdraw()"));
        (bool b,) = address(lock).call(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(lock), TREASURY, positionId)
        );
        vm.stopPrank();
        assertFalse(a, "no withdraw");
        assertFalse(b, "no transfer");

        // Not by asking the PositionManager directly either — the lock owns it.
        vm.prank(TREASURY);
        (bool c,) = address(POSM).call(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(lock), TREASURY, positionId)
        );
        assertFalse(c, "the treasury is not the owner and cannot move it");

        assertEq(POSM.ownerOf(positionId), address(lock), "still locked");
    }
}
