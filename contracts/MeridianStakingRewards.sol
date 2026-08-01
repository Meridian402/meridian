// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianStakingRewards — stake MERD, earn USDG, claim anytime.
//
// DRAFT · UNAUDITED · NOT DEPLOYED. Money-handling contract; needs an external
// audit before it holds a cent. See CUSTODY.md's posture: built and tested is
// not deployed and audited.
//
// WHAT THIS IS, AND HOW IT DIFFERS FROM MeridianStaking.sol:
//   MeridianStaking is an auto-compounding MERD vault: revenue arrives as MERD,
//   the pot grows, your claim grows silently, there is no claim step. This
//   contract is the model the operator chose instead: you stake MERD as
//   principal that does NOT change, and you earn a separate reward in USDG —
//   20% of platform revenue — which you actively claim while staying staked.
//   The two are alternatives, not layers. This one is the live design.
//
// WHY THERE IS STILL NO RATE, NO APR, NO periodFinish:
//   Same reason the other vault has none. Rewards are purely a distribution of
//   what actually arrived. fund(amount) splits that USDG pro-rata across
//   everyone staked AT THAT MOMENT. There is no reward-per-second, no schedule,
//   and no view that annualises anything. If no revenue is funded, stakers earn
//   exactly zero, and nothing here can pretend otherwise. earned() reports what
//   has already accrued, which is history, not a forecast.
//
// THE ACCOUNTING (standard cumulative-per-share, aka MasterChef):
//   accUsdgPerShare rises by amount*ACC/totalStaked on each fund(). A staker's
//   entitlement is their stake times the growth in accUsdgPerShare since they
//   last touched it. Every stake/unstake/claim first SETTLES that into a stored
//   balance, then re-checkpoints, so a stake made after a fund() never claims a
//   past distribution and an existing staker never loses one.
//
// SAFETY:
//   - Checks-effects-interactions on every path: state is written before any
//     token transfer, so a token callback cannot re-enter into stale state.
//   - fund() with no stakers REVERTS rather than accumulating USDG nobody can
//     claim. The treasury simply funds once there is someone to pay.
//   - MERD and USDG are fixed at construction. Neither can be swapped later.
//   - Nothing here can move a staker's MERD anywhere except back to that staker.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MeridianStakingRewards {
    IERC20 public immutable MERD; // staked (18 decimals)
    IERC20 public immutable USDG; // reward (6 decimals)

    // High precision because the reward token is low-decimal (USDG, 6) while the
    // stake is high-decimal (MERD, 18) and totalStaked can be large: a small
    // fund() over a big pool must not round the per-share increment to zero.
    uint256 internal constant ACC = 1e30;

    /// Minimum position, matching MeridianStaking: one whole MERD.
    uint256 public constant MIN_STAKE = 1e18;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedOf;

    /// USDG accrued per staked wei, scaled by ACC. Only ever rises.
    uint256 public accUsdgPerShare;
    /// The accUsdgPerShare each account was last settled at.
    mapping(address => uint256) internal checkpoint;
    /// USDG settled to an account and not yet claimed.
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 usdg);
    event Funded(address indexed from, uint256 usdg);

    error ZeroAmount();
    error BelowMinimum();
    error DustLeft();
    error InsufficientStake();
    error NoStakers();
    error TransferFailed();

    constructor(address merd, address usdg) {
        require(merd != address(0) && usdg != address(0), "zero token");
        MERD = IERC20(merd);
        USDG = IERC20(usdg);
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// USDG this account could claim right now: settled plus not-yet-settled.
    function earned(address account) public view returns (uint256) {
        return rewards[account] + (stakedOf[account] * (accUsdgPerShare - checkpoint[account])) / ACC;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    /// Move an account's accrued USDG into its stored balance and re-checkpoint.
    /// Called first on every state-changing path so the reward for the period
    /// just ending is banked at the OLD stake before the stake changes.
    function _settle(address account) internal {
        uint256 acc = accUsdgPerShare;
        rewards[account] += (stakedOf[account] * (acc - checkpoint[account])) / ACC;
        checkpoint[account] = acc;
    }

    function _pull(IERC20 token, address from, uint256 amount) internal {
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _send(IERC20 token, address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }

    // ── staking ────────────────────────────────────────────────────────────────

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        stakedOf[msg.sender] += amount;
        totalStaked += amount;
        if (stakedOf[msg.sender] < MIN_STAKE) revert BelowMinimum();
        _pull(MERD, msg.sender, amount); // interaction last
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) public {
        uint256 held = stakedOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > held) revert InsufficientStake();
        _settle(msg.sender);
        uint256 remaining = held - amount;
        // No dust positions: either exit fully or stay at or above the minimum.
        // A sub-minimum remainder would be a stuck position that cannot top up
        // without tripping the same rule.
        if (remaining != 0 && remaining < MIN_STAKE) revert DustLeft();
        stakedOf[msg.sender] = remaining;
        totalStaked -= amount;
        _send(MERD, msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// Claim accrued USDG without touching the staked MERD.
    function claim() public returns (uint256 owed) {
        _settle(msg.sender);
        owed = rewards[msg.sender];
        if (owed != 0) {
            rewards[msg.sender] = 0; // effect before interaction
            _send(USDG, msg.sender, owed);
            emit Claimed(msg.sender, owed);
        }
    }

    /// Claim everything and withdraw the whole stake in one transaction.
    function exit() external {
        claim();
        uint256 held = stakedOf[msg.sender];
        if (held != 0) unstake(held);
    }

    // ── funding (the treasury sends 20% of revenue here) ─────────────────────────

    /// Distribute `amount` USDG pro-rata across everyone currently staked.
    /// Permissionless on purpose: anyone may add to the pot, but in practice it
    /// is the treasury forwarding platform revenue. Reverts with no stakers so
    /// USDG is never credited to an empty pool where it could not be claimed.
    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (totalStaked == 0) revert NoStakers();
        _pull(USDG, msg.sender, amount);
        accUsdgPerShare += (amount * ACC) / totalStaked;
        emit Funded(msg.sender, amount);
    }
}
