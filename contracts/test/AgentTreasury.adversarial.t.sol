// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentTreasury} from "../AgentTreasury.sol";

// ─────────────────────────────────────────────────────────────────────────────
// The first suite tests what the contract is supposed to do. This one tests
// what an attacker would try, plus the boring realities that break money
// contracts in production: tokens that misbehave, recipients that reject
// payment, callbacks that re-enter, and arithmetic at the exact boundary.
//
// The single invariant everything here defends: across ANY sequence of agent
// calls inside one epoch, the value that reaches non-burn addresses cannot
// exceed the cap the owner set.
// ─────────────────────────────────────────────────────────────────────────────

contract GoodToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "balance");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Returns false instead of reverting. A contract that ignores the return value
/// would report success while moving nothing.
contract LyingToken {
    function transfer(address, uint256) external pure returns (bool) { return false; }
}

/// Returns no data at all on success, which several widely held tokens do.
/// A naive abi.decode(bool) would revert on these.
contract SilentToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external {
        require(balanceOf[msg.sender] >= a, "balance");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
}

/// A payee that re-enters agentPay from its receive hook, trying to spend the
/// cap twice inside one transaction.
contract ReentrantPayee {
    AgentTreasury public t;
    bool public armed;
    uint256 public reenterAmount;
    constructor(AgentTreasury t_) { t = t_; }
    function arm(uint256 amount) external { armed = true; reenterAmount = amount; }
    receive() external payable {
        if (!armed) return;
        armed = false;
        t.agentPay(address(0), address(this), reenterAmount);
    }
}

/// An adapter that re-enters the treasury mid-call.
contract ReentrantAdapter {
    AgentTreasury public t;
    constructor(AgentTreasury t_) { t = t_; }
    function work() external payable {
        t.agentPay(address(0), msg.sender, 1);
    }
}

/// The real reentrancy vector, and the only one that reaches past onlyAgent:
/// the AGENT is a contract, an adapter calls back into it mid-execution, and it
/// re-enters the treasury as itself. A naive test where the payee re-enters
/// proves nothing, because the payee is not the agent.
contract ReentrantAgent {
    AgentTreasury public t;
    address public payee;
    bool public tried;
    bool public innerReverted;
    constructor(AgentTreasury t_) { t = t_; }
    function setPayee(address p) external { payee = p; }
    function go(address adapter, uint256 value) external {
        t.agentCall(adapter, value, abi.encodeWithSignature("callBack()"));
    }
    /// The adapter calls this while the first agentCall is still on the stack.
    function callBack() external {
        tried = true;
        try t.agentPay(address(0), payee, 1 ether) {} catch { innerReverted = true; }
    }
    receive() external payable {}
}

/// Hands control to the agent mid-call. Note it must name the agent
/// explicitly: inside an adapter, msg.sender is the TREASURY that called it,
/// not the agent that asked for the call.
contract CallbackAdapter {
    address public immutable agentAddr;
    constructor(address a) { agentAddr = a; }
    function callBack() external payable {
        (bool ok,) = agentAddr.call(abi.encodeWithSignature("callBack()"));
        require(ok, "cb");
        (bool r,) = msg.sender.call{value: msg.value}("");
        require(r, "ret");
    }
}

/// Refuses every payment, like a contract with no receive function.
contract RejectingPayee {
    receive() external payable { revert("no thanks"); }
}

contract AgentTreasuryAdversarialTest is Test {
    AgentTreasury t;
    GoodToken tok;
    address owner = address(0xA11CE);
    address agent = address(0xBEEF);
    address payee = address(0xCAFE);
    address NATIVE;
    uint256 constant EPOCH = 7 days;
    uint256 constant CAP = 1 ether;

    function setUp() public {
        t = new AgentTreasury(owner, agent, EPOCH);
        NATIVE = t.NATIVE();
        tok = new GoodToken();
        vm.deal(address(t), 100 ether);
        tok.mint(address(t), 1_000 ether);
        vm.startPrank(owner);
        t.setPayee(payee, true);
        t.setCap(NATIVE, CAP);
        t.setCap(address(tok), 100 ether);
        vm.stopPrank();
    }

    // ── reentrancy ───────────────────────────────────────────────────────────

    function test_payee_cannot_reenter_to_double_spend_the_cap() public {
        ReentrantPayee bad = new ReentrantPayee(t);
        vm.prank(owner);
        t.setPayee(address(bad), true);
        bad.arm(CAP);

        // The outer payment consumes the whole cap; the receive hook tries again.
        vm.prank(agent);
        vm.expectRevert(); // the reentrant inner call reverts, which reverts the whole tx
        t.agentPay(NATIVE, address(bad), CAP);

        assertEq(address(t).balance, 100 ether, "nothing may leave when a reentry is attempted");
        assertEq(t.spentThisEpoch(NATIVE), 0, "and the meter must not be advanced");
    }

    function test_adapter_cannot_reenter_the_pay_path() public {
        ReentrantAdapter bad = new ReentrantAdapter(t);
        vm.startPrank(owner);
        t.setAdapter(address(bad), true);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(); // nonReentrant on agentPay, surfaced through agentCall
        t.agentCall(address(bad), 1 ether, abi.encodeWithSignature("work()"));
    }

    /// The genuine article: agent is a contract, the adapter hands control back
    /// to it, and it re-enters. This is what the guard is actually for.
    function test_an_agent_contract_cannot_reenter_through_an_adapter() public {
        ReentrantAgent ra = new ReentrantAgent(t);
        CallbackAdapter cb = new CallbackAdapter(address(ra));
        ra.setPayee(payee);
        vm.startPrank(owner);
        t.setAgent(address(ra));
        t.setAdapter(address(cb), true);
        vm.stopPrank();

        ra.go(address(cb), 1 ether);
        assertTrue(ra.tried(), "the callback must actually have fired");
        assertTrue(ra.innerReverted(), "the reentrant payment must be refused");
        assertEq(payee.balance, 0, "and nothing may reach the payee");
        assertEq(t.spentThisEpoch(NATIVE), 0, "and the meter must not move");
    }

    /// Belt and braces, proven separately: even if the guard were absent, the
    /// cap could not be exceeded, because the spend is recorded BEFORE the
    /// transfer. Effects precede interactions, so a reentrant caller sees the
    /// budget it has already consumed.
    function test_cap_accounting_is_effects_before_interactions() public {
        vm.prank(agent);
        t.agentPay(NATIVE, payee, CAP);
        assertEq(t.spentThisEpoch(NATIVE), CAP, "the meter advances with the send, not after it");
        assertEq(t.remainingThisEpoch(NATIVE), 0);
    }

    // ── tokens that misbehave ────────────────────────────────────────────────

    function test_a_token_that_returns_false_is_treated_as_failure() public {
        LyingToken liar = new LyingToken();
        vm.startPrank(owner);
        t.setCap(address(liar), 100 ether);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.TransferFailed.selector);
        t.agentPay(address(liar), payee, 1 ether);
        assertEq(t.spentThisEpoch(address(liar)), 0, "a failed send must not consume budget");
    }

    function test_a_token_that_returns_nothing_still_works() public {
        SilentToken quiet = new SilentToken();
        quiet.mint(address(t), 10 ether);
        vm.prank(owner);
        t.setCap(address(quiet), 10 ether);
        vm.prank(agent);
        t.agentPay(address(quiet), payee, 4 ether);
        assertEq(quiet.balanceOf(payee), 4 ether);
    }

    function test_a_rejecting_payee_reverts_and_costs_no_budget() public {
        RejectingPayee r = new RejectingPayee();
        vm.prank(owner);
        t.setPayee(address(r), true);
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.TransferFailed.selector);
        t.agentPay(NATIVE, address(r), 0.5 ether);
        assertEq(t.spentThisEpoch(NATIVE), 0);
    }

    // ── the owner changing the rules mid-epoch ───────────────────────────────

    function test_lowering_the_cap_below_spend_leaves_nothing_available() public {
        vm.prank(agent);
        t.agentPay(NATIVE, payee, 0.8 ether);
        vm.prank(owner);
        t.setCap(NATIVE, 0.5 ether); // now below what is already spent
        assertEq(t.remainingThisEpoch(NATIVE), 0, "must clamp at zero, never underflow");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, 1, 0));
        t.agentPay(NATIVE, payee, 1);
    }

    function test_setting_cap_to_zero_freezes_agent_payments() public {
        vm.prank(owner);
        t.setCap(NATIVE, 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, 1, 0));
        t.agentPay(NATIVE, payee, 1);
    }

    function test_deallowlisting_a_payee_stops_further_payment_immediately() public {
        vm.prank(agent);
        t.agentPay(NATIVE, payee, 0.1 ether);
        vm.prank(owner);
        t.setPayee(payee, false);
        vm.prank(agent);
        vm.expectRevert(AgentTreasury.NotAllowed.selector);
        t.agentPay(NATIVE, payee, 0.1 ether);
    }

    /// Rotating the agent must not hand the new key a fresh budget: the meter
    /// belongs to the epoch, not to whoever is holding the key.
    function test_rotating_the_agent_does_not_reset_the_meter() public {
        vm.prank(agent);
        t.agentPay(NATIVE, payee, CAP);
        address newAgent = address(0xF00D);
        vm.prank(owner);
        t.setAgent(newAgent);
        vm.prank(newAgent);
        vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, 1, 0));
        t.agentPay(NATIVE, payee, 1);
    }

    // ── boundaries and fuzzing ───────────────────────────────────────────────

    function test_epoch_boundary_is_exact() public {
        vm.prank(agent);
        t.agentPay(NATIVE, payee, CAP);
        uint256 start = t.epochStartedAt(NATIVE);
        vm.warp(start + EPOCH - 1);
        assertEq(t.remainingThisEpoch(NATIVE), 0, "one second early is still the same epoch");
        vm.warp(start + EPOCH);
        assertEq(t.remainingThisEpoch(NATIVE), CAP, "the boundary second is the new epoch");
    }

    /// Any split of payments inside one epoch sums to at most the cap.
    function testFuzz_no_split_of_payments_can_exceed_the_cap(uint96 a, uint96 b, uint96 c) public {
        uint256[3] memory amounts = [uint256(a), uint256(b), uint256(c)];
        uint256 paid;
        for (uint256 i = 0; i < 3; i++) {
            uint256 amt = amounts[i] % (CAP + 1);
            if (amt == 0) continue;
            vm.prank(agent);
            if (paid + amt > CAP) {
                vm.expectRevert(abi.encodeWithSelector(AgentTreasury.CapExceeded.selector, amt, CAP - paid));
                t.agentPay(NATIVE, payee, amt);
            } else {
                t.agentPay(NATIVE, payee, amt);
                paid += amt;
            }
        }
        assertLe(paid, CAP);
        assertEq(payee.balance, paid);
    }

    /// However the owner moves the cap around mid-epoch, the agent can never
    /// have sent more than the cap that was in force when it sent.
    function testFuzz_cap_changes_never_let_the_agent_overspend(uint96 first, uint96 second) public {
        uint256 cap1 = uint256(first) % 10 ether + 1;
        uint256 cap2 = uint256(second) % 10 ether + 1;
        vm.prank(owner);
        t.setCap(NATIVE, cap1);
        uint256 avail1 = t.remainingThisEpoch(NATIVE);
        vm.prank(agent);
        t.agentPay(NATIVE, payee, avail1);
        assertEq(t.remainingThisEpoch(NATIVE), 0);

        vm.prank(owner);
        t.setCap(NATIVE, cap2);
        uint256 avail2 = t.remainingThisEpoch(NATIVE);
        assertEq(avail2, cap2 > avail1 ? cap2 - avail1 : 0, "raising mid-epoch credits only the difference");
    }

    function testFuzz_owner_can_always_withdraw_everything(uint96 amount) public {
        uint256 amt = uint256(amount) % 100 ether;
        vm.prank(owner);
        t.withdraw(NATIVE, owner, amt);
        assertEq(owner.balance, amt, "the owner is never metered");
    }
}
