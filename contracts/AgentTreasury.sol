// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// AgentTreasury — a launched token's fee stream, owned by its creator, worked
// by their agent.
//
// DRAFT · UNAUDITED · NOT DEPLOYED. This is the first contract we have written
// that would hold OTHER PEOPLE'S money. It does not go near a real fee stream
// without fork tests, mutation testing and an external audit.
//
// THE PROBLEM
//   A creator launches through Meridian and points the token's feeWallet here.
//   Trading fees arrive forever. They want their agent to actually DO things
//   with that money (compound it, buy back, burn, pay a contributor every week)
//   without handing anyone their keys, and without a compromised agent key
//   being able to empty the account.
//
// THE AUTHORITY MODEL, in three tiers, mirroring how Merd's own desk already
// operates (it trades autonomously; every treasury payment is human-signed):
//
//   1. VALUE CANNOT LEAVE. The agent may call allowlisted ADAPTERS and may burn.
//      Adapters are contracts audited to return proceeds to this treasury and to
//      expose no recipient parameter, which is the exact hole that makes scoping
//      a raw DEX router unsafe (see CUSTODY.md). Burning is unbounded because a
//      burn destroys value rather than diverting it: it cannot enrich a thief.
//
//   2. VALUE LEAVES, BOUNDED. The agent may pay addresses the OWNER has already
//      allowlisted, up to a per-token cap per epoch. This is what lets "pay the
//      contributor every Sunday" happen without a human clicking, while a fully
//      compromised agent key can still only reach destinations the owner already
//      blessed, for at most one epoch's cap.
//
//   3. OWNER ONLY. Adding a payee, raising a cap, changing or revoking the
//      agent, and withdrawing anything at all. The owner is never rate limited
//      and never needs the agent's cooperation.
//
// DELIBERATELY NOT UPGRADEABLE. A creator is trusting this with a revenue
// stream; an upgrade path is a promise that the rules can change later. If the
// rules need to change, a new treasury is deployed and the feeWallet is
// repointed, in the open.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AgentTreasury {
    /// Native ETH is addressed as this sentinel wherever a token address is taken.
    address public constant NATIVE = address(0);
    /// Burns go here. Not configurable: a "burn" that can be pointed elsewhere is a withdrawal.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// Ceiling on epoch length, so an owner cannot be tricked into a cap that never resets.
    uint256 public constant MAX_EPOCH = 30 days;

    address public owner;
    address public pendingOwner;
    address public agent;
    uint256 public epochLength;

    /// Contracts the agent may call. Each must return proceeds here and expose
    /// no recipient parameter. Owner-controlled.
    mapping(address => bool) public adapterAllowed;
    /// Addresses the agent may pay. Owner-controlled.
    mapping(address => bool) public payeeAllowed;
    /// token => amount the agent may send per epoch.
    mapping(address => uint256) public capPerEpoch;
    /// token => amount already sent in the current epoch.
    mapping(address => uint256) public spentThisEpoch;
    /// token => timestamp the current epoch began.
    mapping(address => uint256) public epochStartedAt;

    bool private locked;

    event Received(address indexed from, uint256 amount);
    event AgentChanged(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event AdapterSet(address indexed adapter, bool allowed);
    event PayeeSet(address indexed payee, bool allowed);
    event CapSet(address indexed token, uint256 amountPerEpoch);
    event EpochLengthSet(uint256 seconds_);
    event AgentPaid(address indexed token, address indexed to, uint256 amount);
    event AgentBurned(address indexed token, uint256 amount);
    event AgentCalled(address indexed adapter, uint256 value, bytes4 selector);
    event OwnerWithdrew(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotAgent();
    error NotAllowed();
    error CapExceeded(uint256 requested, uint256 remaining);
    error TransferFailed();
    error Reentrancy();
    error ZeroAddress();
    error EpochTooLong();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// The agent's authority is exactly what this modifier gates. The owner is
    /// deliberately NOT accepted here: owner actions have their own entry
    /// points, so a reader can see at a glance which paths are rate limited.
    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(address owner_, address agent_, uint256 epochLength_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (epochLength_ == 0 || epochLength_ > MAX_EPOCH) revert EpochTooLong();
        owner = owner_;
        agent = agent_;
        epochLength = epochLength_;
        emit OwnershipTransferred(address(0), owner_);
        emit AgentChanged(address(0), agent_);
        emit EpochLengthSet(epochLength_);
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ── Tier 3: owner only ───────────────────────────────────────────────────

    /// Two-step, because a fat-fingered owner transfer is unrecoverable.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// Setting the agent to address(0) revokes it entirely and instantly.
    function setAgent(address next) external onlyOwner {
        emit AgentChanged(agent, next);
        agent = next;
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        adapterAllowed[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function setPayee(address payee, bool allowed) external onlyOwner {
        if (payee == address(0)) revert ZeroAddress();
        payeeAllowed[payee] = allowed;
        emit PayeeSet(payee, allowed);
    }

    function setCap(address token, uint256 amountPerEpoch) external onlyOwner {
        capPerEpoch[token] = amountPerEpoch;
        emit CapSet(token, amountPerEpoch);
    }

    function setEpochLength(uint256 seconds_) external onlyOwner {
        if (seconds_ == 0 || seconds_ > MAX_EPOCH) revert EpochTooLong();
        epochLength = seconds_;
        emit EpochLengthSet(seconds_);
    }

    /// The owner's escape hatch: everything, anywhere, never capped. If this
    /// contract ever behaves in a way its owner dislikes, one call empties it.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _send(token, to, amount);
        emit OwnerWithdrew(token, to, amount);
    }

    // ── Tier 1: the agent, where value cannot leave ──────────────────────────

    /// Call an allowlisted adapter. The adapter, not this contract, is what
    /// guarantees proceeds come back here, which is why the allowlist is
    /// owner-controlled and adapters must be audited before being added.
    function agentCall(address adapter, uint256 value, bytes calldata data)
        external
        onlyAgent
        nonReentrant
        returns (bytes memory)
    {
        if (!adapterAllowed[adapter]) revert NotAllowed();
        (bool ok, bytes memory ret) = adapter.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit AgentCalled(adapter, value, bytes4(data[:4]));
        return ret;
    }

    /// Uncapped on purpose: burning destroys value rather than moving it, so a
    /// stolen agent key gains nothing by calling this. The destination is a
    /// constant for the same reason.
    function agentBurn(address token, uint256 amount) external onlyAgent nonReentrant {
        _send(token, BURN, amount);
        emit AgentBurned(token, amount);
    }

    // ── Tier 2: the agent, where value leaves, bounded ───────────────────────

    /// Pay an allowlisted address, within this epoch's remaining cap. Both
    /// conditions are owner-set, so the worst a compromised agent key can do is
    /// pay someone the owner already chose, up to an amount the owner already
    /// approved, once per epoch.
    function agentPay(address token, address to, uint256 amount) external onlyAgent nonReentrant {
        if (!payeeAllowed[to]) revert NotAllowed();
        // Roll FIRST, then measure, so the window a payment is charged against
        // is always the one it actually lands in.
        if (_epochElapsed(token)) {
            epochStartedAt[token] = block.timestamp;
            spentThisEpoch[token] = 0;
        }
        uint256 cap = capPerEpoch[token];
        uint256 spent = spentThisEpoch[token];
        uint256 remaining = spent >= cap ? 0 : cap - spent;
        if (amount > remaining) revert CapExceeded(amount, remaining);
        spentThisEpoch[token] += amount;
        _send(token, to, amount);
        emit AgentPaid(token, to, amount);
    }

    /// What the agent may still send this epoch. A fresh epoch reports the full
    /// cap without needing a transaction to roll it over.
    function remainingThisEpoch(address token) public view returns (uint256) {
        uint256 cap = capPerEpoch[token];
        if (_epochElapsed(token)) return cap;
        uint256 spent = spentThisEpoch[token];
        return spent >= cap ? 0 : cap - spent;
    }

    /// An unset epoch start means nothing has been spent yet, NOT that an epoch
    /// beginning at timestamp zero has long since elapsed. Left implicit, that
    /// distinction is a meter that silently measures from the wrong instant.
    function _epochElapsed(address token) private view returns (bool) {
        uint256 start = epochStartedAt[token];
        return start == 0 || block.timestamp >= start + epochLength;
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _send(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            // Tolerates tokens that return nothing on success, which several
            // widely held ones do, without trusting a bare call to have worked.
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
    }
}
