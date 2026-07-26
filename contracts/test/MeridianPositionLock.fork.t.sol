// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianPositionLock, IPositionManager} from "../MeridianPositionLock.sol";
import {MeridianToken} from "../MeridianToken.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The test the mock cannot be.
//
// The unit suite proves the SHAPE of what the lock sends: decrease-by-zero,
// then take-pair, built from constants. It proves nothing about whether the
// real PositionManager accepts that, and the mock will agree with a mistake
// just as readily as with the truth.
//
// What is actually being asked here:
//   1. Does decrease-by-zero really settle fees on a live v4 position, or does
//      it revert / return nothing?
//   2. Does TAKE_PAIR actually move both currencies to the lock, including
//      NATIVE ETH, which settles differently from an ERC-20?
//   3. Does the _mint-not-_safeMint footgun reproduce on chain — is a position
//      minted straight to the lock genuinely unrecorded until lockExisting?
//
// If any of these is wrong, the lock holds the entire supply and cannot release
// a single wei of fees, with no upgrade path. A mock will never catch that.
//
// Run with:
//   forge test --match-path "contracts/test/MeridianPositionLock.fork.t.sol" --fork-url <rpc>
// Self-skips without a fork so the ordinary suite stays hermetic.
// ─────────────────────────────────────────────────────────────────────────────

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManagerFull {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract MeridianPositionLockForkTest is Test, IUnlockCallback {
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManagerFull constant POSM = IPositionManagerFull(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // v4-periphery action ids.
    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    MeridianToken token;
    MeridianPositionLock lock;
    PoolKey key;
    uint256 positionId;

    address alice = address(0xA11CE); // 80%
    address bob = address(0xB0B); //     20%

    bool forked;

    function setUp() public {
        if (address(POOL_MANAGER).code.length == 0) return;
        forked = true;

        token = new MeridianToken("Meridian", "MERD", 1_000_000_000 ether, address(this));
        lock = new MeridianPositionLock(
            IPositionManager(address(POSM)), address(0), address(token), alice, bob, 8000
        );

        vm.deal(address(this), 1_000 ether);

        // v4 pulls ERC-20s through Permit2, which needs both grants.
        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(address(token), address(POSM), type(uint160).max, uint48(block.timestamp + 1 days));

        // Native ETH is address(0) and sorts to currency0. No hook here: this
        // test is about the lock, not the fee schedule.
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });

        POSM.initializePool(key, TickMath.getSqrtPriceAtTick(0));

        // Mint a full-range position owned by the LOCK, exactly as a launch
        // would. At tick 0 each unit of full-range liquidity costs about one of
        // each token, so 10e18 needs ~10 ETH and ~10 MERD.
        positionId = POSM.nextTokenId();
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            int24(-887200),
            int24(887200),
            uint256(10 ether), // liquidity
            uint128(100 ether), // amount0Max
            uint128(100 ether), // amount1Max
            address(lock), // owner — the position is minted straight to the lock
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSM.modifyLiquidities{value: 50 ether}(abi.encode(actions, params), block.timestamp + 60);
    }

    // ── the harness: swaps, to make fees exist ───────────────────────────────

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
            token.transfer(address(POOL_MANAGER), uint128(-d1));
            POOL_MANAGER.settle();
        } else if (d1 > 0) {
            POOL_MANAGER.take(key.currency1, address(this), uint128(d1));
        }
        return "";
    }

    receive() external payable {}

    // ── what we are here to prove ────────────────────────────────────────────

    function test_fork_theMintFootgunIsRealAndRecoverable() public {
        if (!forked) return;

        // The position is genuinely owned by the lock...
        assertEq(POSM.ownerOf(positionId), address(lock), "the real PositionManager minted to the lock");
        // ...and the lock has NO IDEA, because v4 mints with _mint, not
        // _safeMint, so onERC721Received never fired. Without lockExisting the
        // entire supply would be stranded behind a contract that cannot act.
        assertEq(lock.tokenId(), 0, "the mint did not notify the lock");
        assertFalse(lock.isLocked());

        lock.lockExisting(positionId);
        assertEq(lock.tokenId(), positionId);
        assertTrue(lock.isLocked(), "recovered");
    }

    function test_fork_feesReachTheBeneficiariesThroughARealPosition() public {
        if (!forked) return;
        lock.lockExisting(positionId);

        // Trade both ways so fees accrue in BOTH currencies. The sell needs
        // tokens, which the buy provides.
        _swap(1 ether, true);
        _swap(token.balanceOf(address(this)) / 100, false);
        _swap(1 ether, true);

        uint256 aliceEth = alice.balance;
        uint256 bobEth = bob.balance;

        lock.collectFees();

        uint256 gotEth = (alice.balance - aliceEth) + (bob.balance - bobEth);
        uint256 gotTok = token.balanceOf(alice) + token.balanceOf(bob);

        assertGt(gotEth, 0, "no ETH fees came out of a real v4 position");
        assertGt(gotTok, 0, "no token fees came out of a real v4 position");
        // 80/20, the immutable split.
        assertApproxEqRel(alice.balance - aliceEth, (bob.balance - bobEth) * 4, 0.01e18, "ETH split should be 80:20");
        assertApproxEqRel(token.balanceOf(alice), token.balanceOf(bob) * 4, 0.01e18, "token split should be 80:20");
        assertEq(address(lock).balance, 0, "nothing is left stranded in the lock");
    }

    function test_fork_principalIsNeverTouchedByCollecting() public {
        if (!forked) return;
        lock.lockExisting(positionId);

        _swap(1 ether, true);
        lock.collectFees();

        // The whole contract turns on decrease-by-ZERO. If collecting ever
        // withdrew principal, the position would shrink and this would fail —
        // and a launch would be leaking its own supply on every collection.
        assertEq(POSM.ownerOf(positionId), address(lock), "the position is still held");

        // Collect again with no new trades: a principal-touching implementation
        // would keep paying out here. This must yield nothing.
        uint256 aliceBefore = alice.balance;
        uint256 aliceTokBefore = token.balanceOf(alice);
        lock.collectFees();
        assertEq(alice.balance, aliceBefore, "a second collection with no trades pays no ETH");
        assertEq(token.balanceOf(alice), aliceTokBefore, "and no tokens");
    }

    function test_fork_thePositionStillCannotLeave() public {
        if (!forked) return;
        lock.lockExisting(positionId);

        // Against the real ERC-721 this time, not a mock.
        (bool ok,) = address(lock).call(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(lock), alice, positionId)
        );
        assertFalse(ok, "the lock exposes no way to move the NFT");
        assertEq(POSM.ownerOf(positionId), address(lock));
    }
}
