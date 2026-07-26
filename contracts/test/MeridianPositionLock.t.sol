// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianPositionLock, IPositionManager} from "../MeridianPositionLock.sol";
import {MeridianToken} from "../MeridianToken.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The property under test is an ABSENCE: that nothing can get the position out.
//
// Most of what follows therefore checks that calls FAIL, and one test checks
// the ABI surface directly — because a withdraw function added later would slip
// past every behavioural test that only exercises the functions it knows about.
// ─────────────────────────────────────────────────────────────────────────────

/// Enough of the v4 PositionManager to drive the lock: it holds ownership, and
/// on a decrease-by-zero it pays out whatever fees the test has staged.
contract MockPositionManager {
    mapping(uint256 => address) public ownerOf;
    address public currency1;
    uint256 public stagedEth;
    uint256 public stagedToken;
    bytes public lastUnlockData;
    uint256 public modifyCalls;

    function setCurrency1(address c) external {
        currency1 = c;
    }

    function setOwner(uint256 id, address to) external {
        ownerOf[id] = to;
    }

    function mintTo(address to, uint256 id) external {
        ownerOf[id] = to;
        MeridianPositionLock(payable(to)).onERC721Received(address(this), msg.sender, id, "");
    }

    function stage(uint256 eth, uint256 tokenAmount) external payable {
        stagedEth = eth;
        stagedToken = tokenAmount;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        lastUnlockData = unlockData;
        modifyCalls++;
        if (stagedEth > 0) {
            (bool ok,) = msg.sender.call{value: stagedEth}("");
            require(ok, "eth");
            stagedEth = 0;
        }
        if (stagedToken > 0) {
            MeridianToken(currency1).transfer(msg.sender, stagedToken);
            stagedToken = 0;
        }
    }

    receive() external payable {}
}

contract MeridianPositionLockTest is Test {
    MeridianPositionLock lock;
    MockPositionManager pm;
    MeridianToken merd;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address stranger = address(0x5747);

    uint256 constant TOKEN_ID = 42;

    function setUp() public {
        pm = new MockPositionManager();
        merd = new MeridianToken("Meridian", "MERD", 1_000_000_000 ether, address(this));
        pm.setCurrency1(address(merd));
        // 80/20 between two beneficiaries, native ETH as currency0.
        lock = new MeridianPositionLock(IPositionManager(address(pm)), address(0), address(merd), alice, bob, 8000);
    }

    function _lockPosition() internal {
        pm.mintTo(address(lock), TOKEN_ID);
    }

    // ── the absence, which is the whole product ──────────────────────────────

    function test_thereIsNoWayToGetThePositionOut() public {
        _lockPosition();
        assertTrue(lock.isLocked());

        // Every escape hatch a locker is normally asked for, by selector. None
        // of these exist, so each call hits the fallback and reverts.
        string[8] memory escapes = [
            "withdraw()",
            "withdraw(uint256)",
            "emergencyWithdraw()",
            "unlock()",
            "transferOwnership(address)",
            "setBeneficiary(address)",
            "sweep(address)",
            "execute(address,bytes)"
        ];
        for (uint256 i = 0; i < escapes.length; i++) {
            (bool ok,) = address(lock).call(abi.encodeWithSignature(escapes[i]));
            assertFalse(ok, escapes[i]);
        }
    }

    function test_theContractNeverCallsTransferOnThePositionManager() public {
        // A behavioural test cannot prove absence, so check the bytecode: if the
        // contract cannot even encode a transfer selector, it cannot send the
        // NFT anywhere.
        bytes memory code = address(lock).code;
        bytes4[3] memory forbidden = [
            bytes4(keccak256("safeTransferFrom(address,address,uint256)")),
            bytes4(keccak256("transferFrom(address,address,uint256)")),
            bytes4(keccak256("approve(address,uint256)"))
        ];
        for (uint256 f = 0; f < forbidden.length; f++) {
            for (uint256 i = 0; i + 4 <= code.length; i++) {
                bytes4 window = bytes4(bytes.concat(code[i], code[i + 1], code[i + 2], code[i + 3]));
                assertTrue(window != forbidden[f], "bytecode contains an NFT-moving selector");
            }
        }
    }

    function test_nobodyCanSupplyTheirOwnActions() public {
        _lockPosition();
        // There is no function that forwards caller bytes to modifyLiquidities.
        (bool ok,) = address(lock).call(
            abi.encodeWithSignature("modifyLiquidities(bytes,uint256)", abi.encode(bytes(hex"01"), new bytes[](1)), block.timestamp)
        );
        assertFalse(ok, "a passthrough would let anyone decrease by everything");
    }

    // ── locking ──────────────────────────────────────────────────────────────

    function test_theFirstPositionLocksAndASecondIsRefused() public {
        _lockPosition();
        assertEq(lock.tokenId(), TOKEN_ID);
        // A second NFT would be unreachable forever, so it is refused outright.
        vm.expectRevert(MeridianPositionLock.AlreadyLocked.selector);
        pm.mintTo(address(lock), 43);
    }

    function test_onlyThePositionManagerCanLockSomething() public {
        // Otherwise anyone could set tokenId to a position this contract does
        // not hold, permanently bricking the real one.
        vm.prank(stranger);
        vm.expectRevert(MeridianPositionLock.NotPositionManager.selector);
        lock.onERC721Received(stranger, stranger, 99, "");
    }

    function test_feesCannotBeCollectedBeforeAnythingIsLocked() public {
        vm.expectRevert(MeridianPositionLock.NotLocked.selector);
        lock.collectFees();
    }

    // ── fees ─────────────────────────────────────────────────────────────────

    function test_anyoneMayTriggerCollectionAndOnlyBeneficiariesGetPaid() public {
        _lockPosition();
        vm.deal(address(pm), 10 ether);
        merd.transfer(address(pm), 1_000 ether);
        pm.stage(10 ether, 1_000 ether);

        uint256 strangerBefore = stranger.balance;
        vm.prank(stranger); // permissionless: a stranger pays the gas
        lock.collectFees();

        assertEq(alice.balance, 8 ether, "80% of the ETH fees");
        assertEq(bob.balance, 2 ether, "20% of the ETH fees");
        assertEq(merd.balanceOf(alice), 800 ether);
        assertEq(merd.balanceOf(bob), 200 ether);
        assertEq(stranger.balance, strangerBefore, "the caller receives nothing");
        assertEq(address(lock).balance, 0, "nothing is left behind");
    }

    function test_theSplitIsExactAndLeavesNoDust() public {
        _lockPosition();
        // An amount that does not divide cleanly: B takes the remainder, so the
        // two payouts always sum to the whole.
        uint256 odd = 1_000_000_000_000_000_001;
        vm.deal(address(pm), odd);
        pm.stage(odd, 0);

        lock.collectFees();
        assertEq(alice.balance + bob.balance, odd, "every wei is paid out");
        assertEq(address(lock).balance, 0);
    }

    function test_collectionUsesDecreaseByZeroThenTakePair() public {
        _lockPosition();
        lock.collectFees();

        (bytes memory actions, bytes[] memory params) = abi.decode(pm.lastUnlockData(), (bytes, bytes[]));
        assertEq(actions.length, 2, "exactly two actions");
        assertEq(uint8(actions[0]), 0x01, "DECREASE_LIQUIDITY");
        assertEq(uint8(actions[1]), 0x11, "TAKE_PAIR");

        (uint256 id, uint256 liquidity,,,) = abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
        assertEq(id, TOKEN_ID);
        // The number this whole contract turns on. Anything other than zero
        // here is withdrawing principal, not collecting fees.
        assertEq(liquidity, 0, "liquidity must never be decreased");

        (,, address recipient) = abi.decode(params[1], (address, address, address));
        assertEq(recipient, address(lock), "fees land here to be split, not anywhere else");
    }

    function test_collectingTwiceIsHarmlessWhenThereAreNoFees() public {
        _lockPosition();
        lock.collectFees();
        lock.collectFees();
        assertEq(pm.modifyCalls(), 2);
        assertEq(alice.balance, 0);
    }

    function test_leftoverDustIsSweptByTheNextCollection() public {
        _lockPosition();
        // Simulate dust arriving outside a collection, as a donation would.
        vm.deal(address(lock), 5 ether);
        lock.collectFees();
        assertEq(alice.balance + bob.balance, 5 ether, "balances are read, not the call's return");
        assertEq(address(lock).balance, 0);
    }

    // ── construction ─────────────────────────────────────────────────────────

    function test_constructorRefusesNonsense() public {
        vm.expectRevert(MeridianPositionLock.ZeroAddress.selector);
        new MeridianPositionLock(IPositionManager(address(0)), address(0), address(merd), alice, bob, 8000);

        vm.expectRevert(MeridianPositionLock.ZeroAddress.selector);
        new MeridianPositionLock(IPositionManager(address(pm)), address(0), address(merd), address(0), bob, 8000);

        vm.expectRevert(MeridianPositionLock.ShareAboveOneHundredPercent.selector);
        new MeridianPositionLock(IPositionManager(address(pm)), address(0), address(merd), alice, bob, 10_001);
    }

    function test_nativeEthIsAllowedAsCurrency0ButNotCurrency1() public {
        // v4 spells native ETH as address(0) and always sorts it first, so a
        // zero currency1 is a malformed pool rather than an ETH pair.
        vm.expectRevert(MeridianPositionLock.ZeroAddress.selector);
        new MeridianPositionLock(IPositionManager(address(pm)), address(0), address(0), alice, bob, 8000);
    }

    function test_aHundredPercentToOneBeneficiaryIsAllowed() public {
        // MERD's own case: creator and platform are the same treasury.
        MeridianPositionLock solo =
            new MeridianPositionLock(IPositionManager(address(pm)), address(0), address(merd), alice, bob, 10_000);
        assertEq(solo.SHARE_A_BPS(), 10_000);
    }

    // ── the direct-mint footgun ──────────────────────────────────────────────

    function test_aPositionMintedStraightHereCanStillBeRecorded() public {
        // v4 mints with _mint, not _safeMint, so onERC721Received never fires.
        // Without lockExisting this position would be owned but unrecorded, and
        // the entire supply would be unreachable forever.
        pm.setOwner(TOKEN_ID, address(lock));
        assertEq(lock.tokenId(), 0, "the mint did not notify the contract");

        lock.lockExisting(TOKEN_ID); // permissionless
        assertEq(lock.tokenId(), TOKEN_ID);
        assertTrue(lock.isLocked());
    }

    function test_lockExistingCannotInventAPositionWeDoNotHold() public {
        pm.setOwner(7, stranger);
        vm.expectRevert(abi.encodeWithSelector(MeridianPositionLock.PositionNotHeld.selector, uint256(7)));
        lock.lockExisting(7);
        assertEq(lock.tokenId(), 0);
    }

    function test_lockExistingCannotOverwriteALockedPosition() public {
        _lockPosition();
        pm.setOwner(99, address(lock));
        vm.expectRevert(MeridianPositionLock.AlreadyLocked.selector);
        lock.lockExisting(99);
        assertEq(lock.tokenId(), TOKEN_ID, "the original stays");
    }

    function test_tokenIdZeroIsRefusedAsASentinel() public {
        pm.setOwner(0, address(lock));
        vm.expectRevert(MeridianPositionLock.NotLocked.selector);
        lock.lockExisting(0);
    }
}
