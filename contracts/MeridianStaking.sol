// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MeridianStaking: stake MERD, and your MERD grows when the protocol earns.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// WHAT THIS IS:
//   One pot of MERD, and a ledger of who owns what fraction of it. You deposit
//   MERD and the ledger records shares. Your shares never change on their own.
//   The pot does. When revenue arrives, it is MERD sent into this contract, so
//   the same shares are now a claim on more MERD than they were a minute ago.
//   Withdraw whenever you like and you take your fraction of whatever the pot
//   holds at that moment.
//
//   That is the entire mechanism, and it is worth being blunt about why it is
//   built this way rather than the usual way.
//
// WHY THERE IS NO REWARD TOKEN AND NO EMISSIONS:
//   MERD has no mint function and no owner. Read MeridianToken.sol: the supply
//   was minted once in a constructor and there is no code anywhere that can
//   create another wei of it. So "emissions" are not a design choice we passed
//   on, they are physically unavailable. Any yield this contract ever pays is
//   MERD that somebody actually sent here, out of revenue that actually
//   happened. There is no second token, no points, no vesting schedule, and
//   nothing here that prints value out of nothing.
//
//   The honest consequence: if no revenue arrives, staking pays exactly zero.
//   Not a lower rate. Zero. This contract cannot promise otherwise and does not
//   contain a single field that would let it pretend to.
//
// WHY THERE IS NO APR ANYWHERE IN THIS FILE:
//   There is no rate variable, no reward-per-second, no period finish, no
//   projection, and no view that returns an annualised number. Those fields are
//   how a contract ends up implying a return it cannot deliver. What this
//   contract exposes instead is sharePrice(), the historical fact of how much
//   MERD one share is worth right now, plus events on every deposit, withdrawal
//   and funding, so an indexer can reconstruct what this vault ACTUALLY paid
//   over any past window. Backward-looking and checkable, rather than
//   forward-looking and asserted.
//
// WHAT COMPOUNDING MEANS HERE:
//   Nobody claims anything. There is no claim() function, because there is
//   nothing to claim: revenue lands in the pot and is already yours in
//   proportion to your shares. It therefore earns alongside your original
//   deposit from the moment it arrives, with no action from you and no gas
//   spent. That is the whole of the compounding, and it is a consequence of the
//   accounting rather than a feature bolted on top of it.
//
// WHY REVENUE IS NOT SWAPPED OR ROUTED IN HERE:
//   For the same reason MeridianBuyback is a separate contract from
//   MeridianTreasuryHook. Anything that swaps inside a path other people depend
//   on inherits every failure of the pool it swaps through. If revenue arrives
//   as USDG or ETH it must be converted to MERD somewhere ELSE and then sent
//   here as a plain transfer or through fund(). This contract does exactly one
//   thing, holds exactly one asset, and has no external dependency that can
//   break it. A staker's ability to withdraw does not depend on any pool, any
//   oracle, any router or any other contract being alive.
//
// WHY THERE IS NO LOCK AND NO COOLDOWN:
//   Because a vault that can trap funds is a vault that has to be trusted, and
//   the entire posture of this codebase is to remove things that require trust.
//   A lock would also be an admin surface by another name: someone has to set
//   the duration, someone has to be able to pause exits in an emergency, and
//   the moment those exist the answer to "can my MERD be held hostage" stops
//   being "no, read the file". Withdrawal is unconditional and available in the
//   same block as the deposit. The cost of that choice is real: nothing stops
//   somebody depositing right before revenue lands and leaving right after.
//   Sharing revenue with a late arrival is a smaller problem than being unable
//   to leave, so it is the one we take.
//
// WHAT IS DELIBERATELY ABSENT, and you can confirm every one of these by
// reading to the bottom of the file:
//   no owner, no admin, no governance, no timelock, no guardian
//   no pause, no freeze, no blocklist, no emergency stop
//   no upgrade path, no proxy, no delegatecall, no selfdestruct
//   no setter of any kind, so no parameter of this contract can ever change
//   no mint, no reward token, no emission schedule, no APR field
//   no lock, no cooldown, no withdrawal fee, no deposit fee, no exit penalty
//   no sweep, no rescue, no skim, no withdrawTo, no recipient argument
//   no function that moves a staker's MERD to any address except that staker
//
//   The last line is the one that matters most, and it is worth checking
//   directly: the only call to the token's transfer() below sends to
//   msg.sender, and the only call to transferFrom() pulls from msg.sender.
//   There is no path by which MERD leaves this contract toward anybody other
//   than the account whose shares were burned to release it.
//
// THE HAZARD THIS DESIGN HAS, AND HOW IT IS HANDLED:
//   Because the pot is measured as this contract's plain token balance, anyone
//   can increase it by sending MERD here. That is the feature that makes
//   funding trivial, and it is also the classic first-depositor inflation
//   attack: deposit 1 wei, transfer in a large amount to move the price of one
//   share above the next person's whole deposit, and their share count rounds
//   down to zero while their MERD stays in the pot. See VIRTUAL_SHARES below
//   for the defence and why this particular one was chosen.
//
// REENTRANCY:
//   There is no guard in this file and that is deliberate rather than an
//   oversight. MERD is a plain fixed-supply ERC-20 with no transfer hook, no
//   callback, no ERC-777 receiver and no code path that hands control to the
//   sender or the recipient of a transfer. It cannot call back into this
//   contract mid-transaction, so there is no reentrant sequence to guard
//   against. Every function below is still written checks, effects,
//   interactions, in that order, because that ordering costs nothing and is
//   what keeps the property true rather than merely currently unexploitable.
//   Note the standing constraint this creates: this contract is safe for MERD
//   specifically. It is not a general-purpose vault and must never be pointed
//   at a token with transfer hooks or fee-on-transfer behaviour.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MeridianStaking {
    // Uniswap's FullMath, not OpenZeppelin's Math, and the reason is not taste.
    // Adding an @openzeppelin remapping to this repo changes the metadata hash
    // of EVERY contract it builds, which changes their bytecode, which changes
    // their CREATE2 addresses. MERD's hook, lock and token addresses are mined
    // against exact bytecode, so a new remapping silently invalidates all three.
    // v4-core is already a dependency, its FullMath is the same 512-bit
    // algorithm, and using it keeps those mined addresses reproducible.
    using FullMath for uint256;

    /// The one and only asset. Fixed at construction, no setter, so this vault
    /// can never be repointed at a different token.
    IERC20 public immutable MERD;

    /**
     * THE FIRST-DEPOSITOR INFLATION DEFENCE.
     *
     * The share price is computed as if the vault always contained
     * VIRTUAL_ASSETS (1 wei) backing VIRTUAL_SHARES (10^DECIMALS_OFFSET)
     * shares that nobody holds. This is the OpenZeppelin ERC-4626 decimal
     * offset, and it is used here rather than the alternative because it is
     * the one that costs an honest user essentially nothing.
     *
     * How it defeats the attack: an attacker who deposits 1 wei receives 10^12
     * shares against 10^12 virtual shares, so they own about half the pot and
     * not effectively all of it. Every wei they then donate to inflate the
     * price is split with the virtual shares, which belong to no one and are
     * therefore unrecoverable.
     *
     * The result is that the attack becomes an extremely bad trade rather than
     * a theft. Two numbers make that concrete, and both follow directly from
     * the offset. Making a victim's deposit round down to zero shares requires
     * donating roughly 2 * 10^12 times that deposit, which for any real deposit
     * exceeds the entire supply of MERD. And short of that, the most the
     * attacker can shave off a victim is one share's worth of rounding, which
     * costs the attacker about 10^12 times what the victim loses. There is no
     * donation size at which the arithmetic favours the attacker.
     *
     * The offset is 12 rather than the more common 3 or 6 for exactly that
     * reason: the ratio above IS the offset, so a larger one is strictly
     * better protection, and 12 is comfortably below where the share numbers
     * threaten anything. Shares peak at MERD's whole supply times 10^12, and
     * every multiplication here runs through mulDiv at full 512-bit width.
     *
     * The alternative considered and rejected was locking a minimum number of
     * dead shares on the first deposit. It works, but it permanently strands a
     * slice of the first depositor's money, it needs a magic minimum chosen by
     * hand, and it does nothing at all if the vault is ever emptied back to
     * zero shares. The virtual offset needs no first-deposit special case, has
     * no state, and holds for the life of the contract including after the last
     * staker leaves.
     *
     * The price of the defence is one wei. Because the vault behaves as though
     * it holds one extra wei that nobody can withdraw, every withdrawal can
     * round down by at most 1 wei of MERD against the withdrawer. That wei
     * stays in the pot and belongs to the remaining stakers, and to the next
     * staker if there are none. It is not a fee, there is no recipient, and it
     * is 10^-18 of a token.
     *
     * The one case where that unowned wei is worth more than a wei: it holds a
     * 1 / (totalAssets + 1) fraction of anything newly funded, so funding an
     * essentially empty pot strands a real slice of the funding. Concretely, at
     * 100 MERD staked a 1 MERD funding strands well under a wei, while at 2000
     * wei staked it would strand a large fraction. Nobody is harmed by this
     * beyond the funder, it is not exploitable, and it is why fund() refuses to
     * run at all against a vault with no stakers.
     */
    uint8 public constant DECIMALS_OFFSET = 12;
    uint256 public constant VIRTUAL_SHARES = 10 ** 12;

    /**
     * The smallest stake the vault will accept, and the reason it exists.
     *
     * The virtual shares above stop a donation from rounding a later depositor
     * to zero, but they do NOT stop the opposite trick. One wei staked into an
     * empty vault mints VIRTUAL_SHARES shares against VIRTUAL_SHARES virtual
     * ones, so that one wei owns half the pot, and the next payment of revenue
     * hands half of itself to a position that risked nothing. The guard that
     * only checked "is anyone staked" was satisfied by exactly that wei.
     *
     * A floor fixes it by making a position cost something real. At one whole
     * MERD the same trick needs a stake ten to the eighteenth times larger, and
     * at that point the attacker is simply a staker, which is the outcome we
     * want: capturing a proportional share of revenue is what staking IS, and
     * the only thing worth preventing is capturing it for free.
     *
     * It is a constant rather than a settable parameter because a settable one
     * would be a lever over who may stake.
     */
    uint256 public constant MIN_STAKE = 1e18;
    uint256 public constant VIRTUAL_ASSETS = 1;

    /// One whole share, in the same sense that 1e18 is one whole MERD, so
    /// 10^(18 + DECIMALS_OFFSET). Present so sharePrice() has a unit to quote
    /// against: it starts at exactly 1e18, meaning one whole share is worth one
    /// whole MERD, and rises from there.
    uint256 public constant ONE_SHARE = 10 ** 30;

    /// The ledger. Shares are an internal accounting entry, not a token: there
    /// is no transfer, no approve and no ERC-20 surface on them. That is a
    /// deliberate limitation. A transferable receipt would create a second
    /// market whose price can detach from the vault's, and it is unnecessary
    /// here because exit is unconditional, so a staker who wants out sells MERD
    /// rather than a claim on MERD.
    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    /**
     * Enough to reconstruct the share price at every block it changed, without
     * needing an archive node. assetsAfter and sharesAfter are the vault totals
     * as of the end of the call, so an indexer can compute the price at each
     * event by division and never has to trust a quoted rate.
     */
    event Staked(address indexed staker, uint256 assets, uint256 shares, uint256 assetsAfter, uint256 sharesAfter);
    event Unstaked(address indexed staker, uint256 assets, uint256 shares, uint256 assetsAfter, uint256 sharesAfter);
    event Funded(address indexed from, uint256 assets, uint256 assetsAfter, uint256 sharesAfter);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error ZeroAssets();
    error InsufficientShares(uint256 held, uint256 requested);
    error TransferFailed();
    error NoStakers();
    error BelowMinimumStake(uint256 provided, uint256 minimum);

    constructor(IERC20 merd) {
        if (address(merd) == address(0)) revert ZeroAddress();
        MERD = merd;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Staking and unstaking.
    //
    // ROUNDING RULE, applied without exception: every division below rounds
    // DOWN, and down always means in favour of the pot and against the
    // individual doing the transaction. Depositing gives you the floor of the
    // shares you are owed; withdrawing gives you the floor of the assets you
    // are owed. The consequence is the property the vault needs: no sequence of
    // deposits and withdrawals, in any order, at any sizes, can take out more
    // than was put in, because every single step leaves any remainder behind
    // for the other stakers. The most an individual can lose to this is 1 wei
    // per transaction.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Deposit MERD and receive shares. Requires an allowance for this contract.
     *
     * The share price is read BEFORE the deposit lands, which is the whole of
     * the fairness argument: you buy in at the price the vault had when you
     * arrived, so you capture none of the revenue that arrived before you and
     * dilute nobody who was already here.
     */
    function stake(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        // Dust positions are the whole of the fund()-capture attack, so they
        // are refused at the door rather than defended against downstream.
        if (assets < MIN_STAKE) revert BelowMinimumStake(assets, MIN_STAKE);

        uint256 assetsBefore = totalAssets();
        uint256 sharesBefore = totalShares;
        shares = _toShares(assets, assetsBefore, sharesBefore);

        // Only reachable by depositing an amount so small it buys nothing at
        // the current price. Reverting is the correct answer: the alternative
        // is accepting MERD and issuing zero claim on it, which is the exact
        // loss the inflation defence exists to prevent.
        if (shares == 0) revert ZeroShares();

        totalShares = sharesBefore + shares;
        unchecked {
            // Bounded by totalShares, which was just increased by the same
            // amount, so this cannot overflow independently of that line.
            sharesOf[msg.sender] += shares;
        }

        // The interaction, last. MERD has no transfer hook so nothing can run
        // between the state write above and this line, and `assets` requested
        // is exactly `assets` received because MERD has no fee on transfer.
        // Both of those are properties of that specific token, not assumptions
        // that would hold for an arbitrary ERC-20.
        _pull(msg.sender, assets);

        emit Staked(msg.sender, assets, shares, assetsBefore + assets, totalShares);
    }

    /**
     * Burn shares and take the MERD they are worth. Always available, in any
     * block, including the block you staked in. There is no condition on this
     * function beyond holding the shares.
     */
    function unstake(uint256 shares) public returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();

        uint256 held = sharesOf[msg.sender];
        if (held < shares) revert InsufficientShares(held, shares);

        uint256 assetsBefore = totalAssets();
        uint256 sharesBefore = totalShares;
        assets = _toAssets(shares, assetsBefore, sharesBefore);
        if (assets == 0) revert ZeroAssets();

        unchecked {
            sharesOf[msg.sender] = held - shares;
            totalShares = sharesBefore - shares;
        }

        _push(msg.sender, assets);

        emit Unstaked(msg.sender, assets, shares, assetsBefore - assets, totalShares);
    }

    /// Exit completely. A convenience so nobody has to read their share balance
    /// first and nobody leaves a wei of a share behind by rounding a percentage
    /// off-chain. Identical in every other respect to unstake().
    function unstakeAll() external returns (uint256 assets) {
        uint256 held = sharesOf[msg.sender];
        if (held == 0) revert ZeroAmount();
        return unstake(held);
    }

    /**
     * Send MERD into the pot for the stakers, on the record.
     *
     * A plain transfer to this address does exactly the same thing to the
     * accounting, because the pot is just the balance. This function exists so
     * that funding is a named, indexable, attributable event rather than an
     * anonymous transfer that anyone auditing the vault has to infer. Both
     * paths compound identically and neither one mints a share, so funding
     * dilutes nobody: it raises the value of every share that already exists,
     * including those of stakers who have not touched the contract in months.
     *
     * Funding an empty vault is refused. It is not a safety issue, it is a
     * waste: with no shares outstanding there is no one for the money to belong
     * to, and it would sit behind the virtual shares unreachable by anybody.
     * Better to fail loudly than to quietly burn revenue.
     */
    function fund(uint256 assets) external {
        if (assets == 0) revert ZeroAmount();
        uint256 sharesOutstanding = totalShares;
        if (sharesOutstanding == 0) revert NoStakers();

        uint256 assetsBefore = totalAssets();
        _pull(msg.sender, assets);

        emit Funded(msg.sender, assets, assetsBefore + assets, sharesOutstanding);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views. Nothing below writes state, and nothing below returns a
    // projection, a rate, or anything about the future.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The staker's MERD claim: their shares converted to assets at the current
     * price, which means everything compounded into them so far, not the amount
     * they originally deposited.
     *
     * THIS SIGNATURE IS LOAD-BEARING AND MUST NOT CHANGE. The agent access gate
     * calls exactly `stakedBalanceOf(address) view returns (uint256)` on this
     * contract and compares the result against a basis-point threshold of
     * MERD's live total supply. Renaming it, or changing what it returns to
     * shares rather than assets, silently locks people out of their own agents.
     */
    function stakedBalanceOf(address account) external view returns (uint256) {
        return convertToAssets(sharesOf[account]);
    }

    /// The pot. Deliberately the raw token balance and nothing else, so there
    /// is no internal number that can drift out of step with reality, and so
    /// MERD arriving by any route at all is credited to stakers automatically.
    function totalAssets() public view returns (uint256) {
        return MERD.balanceOf(address(this));
    }

    /// What `assets` MERD would buy right now, rounded down.
    function convertToShares(uint256 assets) public view returns (uint256) {
        return _toShares(assets, totalAssets(), totalShares);
    }

    /// What `shares` are worth right now, rounded down.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, totalAssets(), totalShares);
    }

    /// Exactly what stake() would issue for this deposit, at this instant.
    function previewStake(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    /// Exactly what unstake() would pay out for these shares, at this instant.
    function previewUnstake(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    /**
     * MERD per whole share, to 18 decimals. Starts at exactly 1e18 and can only
     * go up, because the only ways the pot changes are deposits and withdrawals
     * priced at this number, funding which raises it, and rounding which leaves
     * remainders behind.
     *
     * This is a measurement of what has already happened. It is not a rate, it
     * does not annualise, and the difference between two readings tells you
     * only what the vault did between them, with no claim whatsoever about what
     * it will do next.
     */
    function sharePrice() external view returns (uint256) {
        return convertToAssets(ONE_SHARE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals.
    // ─────────────────────────────────────────────────────────────────────────

    /// mulDiv rather than a plain expression so the intermediate product is
    /// computed at full 512-bit width. With a 12 decimal offset the share
    /// numbers are a trillion times the asset numbers, and an overflow here
    /// would be a permanently stuck vault with no admin to unstick it.
    function _toShares(uint256 assets, uint256 totalAssets_, uint256 totalShares_) internal pure returns (uint256) {
        return assets.mulDiv(totalShares_ + VIRTUAL_SHARES, totalAssets_ + VIRTUAL_ASSETS);
    }

    function _toAssets(uint256 shares, uint256 totalAssets_, uint256 totalShares_) internal pure returns (uint256) {
        return shares.mulDiv(totalAssets_ + VIRTUAL_ASSETS, totalShares_ + VIRTUAL_SHARES);
    }

    /// Pull from `from`, who is always msg.sender at every call site.
    function _pull(address from, uint256 amount) private {
        _call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
    }

    /// Send to `to`, which is always msg.sender at every call site. There is no
    /// caller-supplied recipient anywhere in this contract.
    function _push(address to, uint256 amount) private {
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// Tolerates tokens that return nothing as well as those returning bool,
    /// and treats an explicit `false` as the failure it is. MERD itself returns
    /// bool and reverts on failure, so in practice this only ever passes
    /// through, but a silent false here would credit or debit shares against a
    /// transfer that never happened.
    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = address(MERD).call(data);
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // There is intentionally nothing below this line.
    //
    // No owner and therefore no onlyOwner anything. No pause, no upgrade, no
    // proxy hook, no delegatecall, no selfdestruct. No setter for the token,
    // the offset, or any other parameter, because none of them are variables.
    // No receive() and no fallback(), so this contract cannot hold ether. No
    // rescue or sweep function of any kind: a sweep that can move MERD is a
    // sweep that can move the stakers' MERD, and any other token sent here is
    // simply not this contract's problem.
    //
    // If a future version of this file has code here, it is not this contract.
    // ─────────────────────────────────────────────────────────────────────────
}
