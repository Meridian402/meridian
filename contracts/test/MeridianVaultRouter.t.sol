// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {MeridianVaultRouter} from "../MeridianVaultRouter.sol";

// The adapter exists for ONE property: a compromised session key must be able to
// churn a vault's assets and never move them out. Everything here tests that
// property rather than the happy path, because the happy path failing is a bug
// and this property failing is a theft.
//
// The router is mocked. The v4 ENCODING is deliberately not asserted here: it
// has to be checked against the live UniversalRouter in a fork test, and the
// adapter is written so a wrong encoding reverts rather than leaks (recipient is
// always address(this)). What these prove is the part that holds regardless of
// how the swap itself is encoded.

contract MockERC20 {
    string public name = "Mock";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "balance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amt, "allowance");
            allowance[from][msg.sender] -= amt;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

contract MockPermit2 {
    function approve(address, address, uint160, uint48) external {}
}

/// Stands in for the UniversalRouter. In reality it pulls tokenIn through
/// Permit2; the test grants it a direct allowance in setUp to model that hop,
/// since Permit2's mechanics are not what is under test here.
///
/// It pays tokenOut back to msg.sender, which is the adapter, because the
/// adapter always passes address(this) as the recipient. That is exactly the
/// property being tested: the caller never gets to name where output lands.
contract MockRouter {
    MockERC20 public tokenIn;
    MockERC20 public tokenOut;
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;
    uint256 public consumeNumerator = 1;
    uint256 public consumeDenominator = 1;

    constructor(MockERC20 _in, MockERC20 _out) { tokenIn = _in; tokenOut = _out; }

    /// How much tokenOut per tokenIn consumed.
    function setRate(uint256 n, uint256 d) external { rateNumerator = n; rateDenominator = d; }
    /// What fraction of the offered input the swap actually uses.
    function setConsume(uint256 n, uint256 d) external { consumeNumerator = n; consumeDenominator = d; }

    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        uint256 offered = tokenIn.balanceOf(msg.sender);
        uint256 pulled = (offered * consumeNumerator) / consumeDenominator;
        if (pulled > 0) tokenIn.transferFrom(msg.sender, address(this), pulled);
        tokenOut.mint(msg.sender, (pulled * rateNumerator) / rateDenominator);
    }
}

contract MeridianVaultRouterTest is Test {
    MockERC20 usdg;
    MockERC20 stock;
    MockRouter router;
    MockPermit2 permit2;
    MeridianVaultRouter adapter;

    address vault = makeAddr("vault");
    address attacker = makeAddr("attacker");

    function setUp() public {
        usdg = new MockERC20();
        stock = new MockERC20();
        router = new MockRouter(usdg, stock);
        permit2 = new MockPermit2();
        adapter = new MeridianVaultRouter(address(router), address(permit2));

        usdg.mint(vault, 1_000e6);
        vm.prank(vault);
        usdg.approve(address(adapter), type(uint256).max);

        // Model the Permit2 hop: in production the adapter approves Permit2 and
        // Permit2 authorises the router. Permit2's own mechanics are not what
        // these tests are about, so the router is granted the allowance directly.
        vm.prank(address(adapter));
        usdg.approve(address(router), type(uint256).max);
    }

    // ── the property ────────────────────────────────────────────────────────

    function test_proceedsAlwaysReturnToTheCaller() public {
        vm.prank(vault);
        adapter.swapExactInSingle(address(usdg), address(stock), 3000, 60, 100e6, 1);

        assertEq(stock.balanceOf(vault), 100e6, "output must land in the vault");
        assertEq(stock.balanceOf(address(adapter)), 0, "adapter must not retain output");
        assertEq(usdg.balanceOf(address(adapter)), 0, "adapter must not retain input");
    }

    function test_theAttackerGetsNothingEvenWhenTheyAreTheCaller() public {
        // The session key IS the caller in the compromise scenario. Even then,
        // "recipient" is msg.sender and msg.sender is whoever called, so an
        // attacker calling directly can only move THEIR OWN funds, never the
        // vault's. The vault's balance is protected by the ERC20 allowance,
        // which only the vault's owner can grant.
        stock.mint(attacker, 0);
        usdg.mint(attacker, 10e6);
        vm.prank(attacker);
        usdg.approve(address(adapter), type(uint256).max);

        uint256 vaultBefore = usdg.balanceOf(vault);
        vm.prank(attacker);
        adapter.swapExactInSingle(address(usdg), address(stock), 3000, 60, 10e6, 1);

        assertEq(usdg.balanceOf(vault), vaultBefore, "the vault must be untouched");
        assertEq(stock.balanceOf(attacker), 10e6, "the attacker only ever moved their own money");
    }

    function test_thereIsNoRecipientParameterToAbuse() public {
        // The guarantee is structural, so assert on the ABI itself: no overload
        // of the entry point may accept an address for the payout. If someone
        // adds one, this fails and they have to justify it.
        bytes4 expected = bytes4(keccak256("swapExactInSingle(address,address,uint24,int24,uint128,uint128)"));
        assertEq(adapter.swapExactInSingle.selector, expected, "signature changed: check no recipient was added");
        // The backend scopes the Roles module to this exact selector
        // (SWAP_SELECTOR in agent/src/custody/vault.ts). If the signature moves,
        // the on-chain scope stops matching and every trade reverts, so the two
        // are pinned to the same literal here.
        assertEq(adapter.swapExactInSingle.selector, bytes4(0x17f784c2), "SWAP_SELECTOR in vault.ts must match");
    }

    function test_unspentInputComesBackToo() public {
        // A router that consumes less than it was offered must not leave the
        // remainder parked in the adapter, where the next caller would sweep it.
        router.setConsume(1, 2); // uses only half the input
        vm.prank(vault);
        adapter.swapExactInSingle(address(usdg), address(stock), 3000, 60, 100e6, 1);
        assertEq(usdg.balanceOf(address(adapter)), 0, "no input may be stranded in the adapter");
    }

    function test_slippageFloorIsEnforced() public {
        // Without this, a compromised key could churn a vault to death through a
        // pool it controls. It is the bound on how much damage churning can do.
        router.setRate(1, 2); // pays out half
        vm.prank(vault);
        vm.expectRevert();
        adapter.swapExactInSingle(address(usdg), address(stock), 3000, 60, 100e6, 100e6);
    }

    function test_aFailedSwapLeavesTheVaultWhole() public {
        uint256 before = usdg.balanceOf(vault);
        router.setRate(0, 1); // pays out nothing
        vm.prank(vault);
        vm.expectRevert();
        adapter.swapExactInSingle(address(usdg), address(stock), 3000, 60, 100e6, 1);
        assertEq(usdg.balanceOf(vault), before, "a reverted swap must not cost the vault anything");
    }

    function test_cannotSpendMoreThanTheVaultApproved() public {
        address stingy = makeAddr("stingy");
        usdg.mint(stingy, 500e6);
        vm.prank(stingy);
        usdg.approve(address(adapter), 10e6); // approves only a little

        vm.prank(stingy);
        vm.expectRevert();
        adapter.swapExactInSingle(address(usdg), address(stock), 3000, 60, 500e6, 1);
    }
}
