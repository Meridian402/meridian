// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../AgentTreasury.sol";

// ─────────────────────────────────────────────────────────────────────────────
// This contract would hold a creator's fee stream, so the tests are written
// from the position of a sceptic who assumes the agent key IS compromised and
// asks what it can take. That is the property the whole design exists to bound,
// so it is tested first and hardest; convenience features are tested after.
//
//   1. a fully compromised agent cannot drain the treasury
//   2. it cannot invent a payee, an adapter, or a cap
//   3. it cannot exceed one epoch's cap, and cannot roll the epoch early
//   4. burning is uncapped but can only ever reach the burn address
//   5. the owner is never rate limited and can revoke the agent instantly
// ─────────────────────────────────────────────────────────────────────────────

contract MockToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "balance");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Returns everything it is sent straight back, which is what makes an adapter
/// safe to allowlist: it exposes no recipient to point elsewhere.
contract GoodAdapter {
    function work() external payable {
        (bool ok,) = msg.sender.call{value: msg.value}("");
        require(ok, "return");
    }
}

/// The adapter an auditor must catch: it keeps what it is given. Allowlisting
/// is owner-controlled precisely because THIS is what a bad allowlist entry
/// looks like, and no on-chain check can tell the two apart.
contract ThievingAdapter {
    function work() external payable {}
}

contract AgentTreasuryTest is Test {
    AgentTreasury t;
    MockToken tok;
    address owner = address(0xA11CE);
    address agent = address(0xBEEF);
    address payee = address(0xCAFE);
    address attacker = address(0xBAD);
    uint256 constant EPOCH = 7 days;
    // Cached, not read inline: NATIVE is itself a call, and inline it eats
    // the vm.prank and the expectRevert meant for the call under test.
    address NATIVE;
    address BURN;

    function setUp() public {
        t = new AgentTreasury(owner, agent, EPOCH);
        NATIVE = t.NATIVE();
        BURN = t.BURN();
        tok = new MockToken();
        vm.deal(address(t), 100 ether);
        tok.mint(address(t), 1_000 ether);
        vm.startPrank(owner);
        t.setPayee(payee, true);
        t.setCap(NATIVE, 1 ether);
        t.setCap(address(tok), 100 ether);
        vm.stopPrank();
    }

    // ── 1. the compromised agent ─────────────────────────────────────────────

    function test_agent_cannot_withdraw() public {
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotOwner.selector);
        t.withdraw(NATIVE, agent, 1 ether);
    }

    function test_agent_cannot_pay_itself() public {
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotAllowed.selector);
        t.agentPay(NATIVE, agent, 0.1 ether);
    }

    function test_agent_cannot_allowlist_a_new_payee() public {
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotOwner.selector);
        t.setPayee(attacker, true);
    }

    function test_agent_cannot_raise_its_own_cap() public {
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotOwner.selector);
        t.setCap(NATIVE, 100 ether);
    }

    function test_agent_cannot_allowlist_an_adapter() public {
        address bad = address(new ThievingAdapter()); // deploy first: a CREATE eats the prank
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotOwner.selector);
        t.setAdapter(bad, true);
    }

    function test_agent_cannot_call_an_unlisted_adapter() public {
        GoodAdapter a = new GoodAdapter();
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotAllowed.selector);
        t.agentCall(address(a), 1 ether, abi.encodeWithSignature("work()"));
    }

    /// The headline property, stated as one number: with the agent key fully in
    /// an attacker's hands, the most that can leave in an epoch is the cap the
    /// owner set, and it can only go where the owner already pointed it.
    function test_worst_case_loss_is_one_epoch_cap_to_an_approved_payee() public {
        uint256 before = address(t).balance;
        vm.startPrank(agent);
        t.agentPay(NATIVE, payee, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, 1, 0));
        t.agentPay(NATIVE, payee, 1);
        vm.stopPrank();
        assertEq(before - address(t).balance, 1 ether);
        assertEq(payee.balance, 1 ether);
    }

    // ── 2. caps and epochs ───────────────────────────────────────────────────

    function test_cap_is_enforced_per_token() public {
        vm.startPrank(agent);
        t.agentPay(address(tok), payee, 100 ether);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, 1, 0));
        t.agentPay(address(tok), payee, 1);
        // a different token has its own budget, untouched
        t.agentPay(NATIVE, payee, 1 ether);
        vm.stopPrank();
        assertEq(tok.balanceOf(payee), 100 ether);
    }

    function test_cap_resets_only_after_a_full_epoch() public {
        vm.prank(agent);
        t.agentPay(NATIVE, payee, 1 ether);

        vm.warp(block.timestamp + EPOCH - 1);
        assertEq(t.remainingThisEpoch(NATIVE), 0, "epoch must not roll early");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, 1, 0));
        t.agentPay(NATIVE, payee, 1);

        vm.warp(block.timestamp + 1);
        assertEq(t.remainingThisEpoch(NATIVE), 1 ether, "epoch should roll on time");
        vm.prank(agent);
        t.agentPay(NATIVE, payee, 1 ether);
        assertEq(payee.balance, 2 ether);
    }

    /// The first payment must START the epoch. Before this was explicit, an
    /// unset start read as "an epoch beginning at zero, long since elapsed",
    /// so the meter measured from the wrong instant.
    function test_first_payment_starts_the_epoch() public {
        assertEq(t.epochStartedAt(NATIVE), 0);
        vm.prank(agent);
        t.agentPay(NATIVE, payee, 0.5 ether);
        assertEq(t.epochStartedAt(NATIVE), block.timestamp, "the epoch starts when it is first used");
        assertEq(t.remainingThisEpoch(NATIVE), 0.5 ether);
    }

    function test_partial_spend_leaves_the_remainder_available() public {
        vm.startPrank(agent);
        t.agentPay(NATIVE, payee, 0.4 ether);
        assertEq(t.remainingThisEpoch(NATIVE), 0.6 ether);
        t.agentPay(NATIVE, payee, 0.6 ether);
        assertEq(t.remainingThisEpoch(NATIVE), 0);
        vm.stopPrank();
    }

    // ── 3. burning ───────────────────────────────────────────────────────────

    function test_burn_is_uncapped_but_only_reaches_the_burn_address() public {
        vm.prank(agent);
        t.agentBurn(address(tok), 900 ether); // far above the 100 ether pay cap
        assertEq(tok.balanceOf(BURN), 900 ether);
        assertEq(t.remainingThisEpoch(address(tok)), 100 ether, "burning must not consume the pay cap");
    }

    /// Griefing, not theft: a compromised agent must not be able to destroy the
    /// treasury's liquid balance for no gain. Burning ETH is never desirable
    /// (you buy the token back and burn that), so it is refused outright.
    function test_agent_cannot_burn_native() public {
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotAllowed.selector);
        t.agentBurn(NATIVE, 50 ether);
        assertEq(address(t).balance, 100 ether, "the balance must be untouched");
    }

    // ── 4. the owner ─────────────────────────────────────────────────────────

    function test_owner_is_never_rate_limited() public {
        vm.startPrank(owner);
        t.withdraw(NATIVE, owner, 50 ether);
        t.withdraw(address(tok), owner, 1_000 ether);
        vm.stopPrank();
        assertEq(owner.balance, 50 ether);
        assertEq(tok.balanceOf(owner), 1_000 ether);
    }

    function test_revoking_the_agent_stops_everything_immediately() public {
        vm.prank(owner);
        t.setAgent(address(0));
        vm.startPrank(agent);
        vm.expectRevert(AgentTreasury.NotAgent.selector);
        t.agentPay(NATIVE, payee, 0.1 ether);
        vm.expectRevert(AgentTreasury.NotAgent.selector);
        t.agentBurn(address(tok), 1 ether);
        vm.stopPrank();
    }

    function test_ownership_transfer_is_two_step() public {
        address next = address(0xD00D);
        vm.prank(owner);
        t.transferOwnership(next);
        assertEq(t.owner(), owner, "owner must not change until accepted");
        vm.prank(attacker);
        vm.expectRevert(AgentTreasury.NotOwner.selector);
        t.acceptOwnership();
        vm.prank(next);
        t.acceptOwnership();
        assertEq(t.owner(), next);
    }

    // ── 5. adapters ──────────────────────────────────────────────────────────

    function test_allowlisted_adapter_that_returns_funds_is_value_neutral() public {
        GoodAdapter a = new GoodAdapter();
        vm.prank(owner);
        t.setAdapter(address(a), true);
        uint256 before = address(t).balance;
        vm.prank(agent);
        t.agentCall(address(a), 5 ether, abi.encodeWithSignature("work()"));
        assertEq(address(t).balance, before, "a good adapter returns everything");
    }

    /// Documents the residual risk in plain sight: allowlisting is a trust
    /// decision the owner makes, and a thieving adapter keeps what it is given.
    /// No on-chain check can distinguish it, which is exactly why adapters must
    /// be audited before they are added and why this test exists.
    function test_a_thieving_adapter_is_a_trust_failure_not_a_code_failure() public {
        ThievingAdapter bad = new ThievingAdapter();
        vm.prank(owner);
        t.setAdapter(address(bad), true);
        vm.prank(agent);
        t.agentCall(address(bad), 5 ether, abi.encodeWithSignature("work()"));
        assertEq(address(bad).balance, 5 ether, "the loss is real, and it came from the allowlist");
    }

    function test_treasury_accepts_fee_arrivals() public {
        vm.deal(attacker, 3 ether);
        vm.prank(attacker);
        (bool ok,) = address(t).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(address(t).balance, 103 ether);
    }
}
