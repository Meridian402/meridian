// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianLaunchSplitter · the router share, enforced by code.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// One splitter is deployed per agent launch and set as the launch's
// creatorFeeRecipient on the PONS v2 factory. Everything the launch's fee
// stream pays to its creator lands here, and anyone may crank the split:
// 20% to the Meridian treasury (the router share), 80% to the team. Both
// addresses are immutable and there is no owner, no pause, and no upgrade,
// so "from the tax, never your supply" is a property of the bytecode, not
// a promise on a website.
//
// WHY PER-LAUNCH INSTEAD OF ONE SHARED SPLITTER: a shared splitter needs a
// mapping from token to team, and that mapping needs a writer, and that
// writer is a trusted party who can redirect team payouts. A 40-line
// immutable contract per launch removes the trusted party entirely, and on
// this chain the deploy costs cents.
//
// FEE PATHS COVERED: the PONS FeeEscrow credits creator earnings to the
// recipient for pull-based claiming (claim for the native quote, claimToken
// for an ERC20 quote such as USDG); claimAndSplit pulls then splits. Anything
// transferred here directly is handled by split alone. The two payout legs are
// independent: a team address that reverts on native receive cannot block the
// treasury's share or lock funds — its own leg is credited to owedNative and
// pulled with withdrawNative(). The ERC20 path uses SafeERC20-style calls, so
// no-bool-return tokens (USDT-style) do not brick the split.
// ─────────────────────────────────────────────────────────────────────────────

interface IFeeEscrow {
    function claim() external;
    function claimToken(address token) external;
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MeridianLaunchSplitter {
    address public immutable team;
    address public immutable treasury;
    IFeeEscrow public immutable escrow;

    /// The router share in basis points. Constant, compiled in, not a knob.
    uint16 public constant ROUTER_BPS = 2000;

    /// Native owed to a recipient whose direct send failed (a non-payable or
    /// reverting team contract). Kept as a pull balance so one hostile recipient
    /// can never brick the other party's share or lock the contract's funds.
    mapping(address => uint256) public owedNative;

    event Split(address indexed currency, uint256 toTeam, uint256 toTreasury);
    event NativeOwed(address indexed to, uint256 amount);
    event NativeWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error NativeSendFailed();
    error TokenTransferFailed();
    error NothingOwed();

    constructor(address team_, address treasury_, address escrow_) {
        if (team_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        team = team_;
        treasury = treasury_;
        escrow = IFeeEscrow(escrow_);
    }

    receive() external payable {}

    /// Pull whatever the escrow owes this splitter in `currency` (zero address
    /// means the native quote), then split it. Permissionless by design: the
    /// only thing a caller can make happen is money moving to the two
    /// immutable addresses in the fixed ratio.
    function claimAndSplit(address currency) external {
        if (address(escrow) != address(0)) {
            if (currency == address(0)) {
                if (escrow.balanceOf(address(this)) > 0) escrow.claim();
            } else {
                if (escrow.balanceOfToken(address(this), currency) > 0) escrow.claimToken(currency);
            }
        }
        split(currency);
    }

    /// Split this contract's full balance of `currency`: ROUTER_BPS to the
    /// treasury, the rest to the team. Rounding dust favors the team.
    ///
    /// Robust to hostile or non-standard parties: the two legs are INDEPENDENT.
    /// A team address that reverts on native receive no longer bricks the whole
    /// split (which used to lock the treasury's 20% too) — the failed leg is
    /// credited to owedNative for the party to pull later. The ERC20 path uses a
    /// SafeERC20-style call so no-bool-return tokens (USDT-style) do not revert
    /// forever, and re-reads the balance for the team leg so fee-on-transfer
    /// tokens do not over-draw. The intended quotes are native and USDG.
    function split(address currency) public {
        if (currency == address(0)) {
            uint256 bal = address(this).balance;
            if (bal == 0) return;
            uint256 cut = (bal * ROUTER_BPS) / 10_000;
            _payNative(treasury, cut);
            _payNative(team, bal - cut);
            emit Split(currency, bal - cut, cut);
        } else {
            uint256 bal = _erc20Balance(currency);
            if (bal == 0) return;
            uint256 cut = (bal * ROUTER_BPS) / 10_000;
            _safeTransfer(currency, treasury, cut);
            // Re-read: fee-on-transfer tokens leave less than bal-cut behind, so
            // paying the precomputed remainder would over-draw and revert.
            uint256 remaining = _erc20Balance(currency);
            _safeTransfer(currency, team, remaining);
            emit Split(currency, remaining, cut);
        }
    }

    /// Pull native credited to you by a failed direct send in split().
    function withdrawNative() external {
        uint256 amount = owedNative[msg.sender];
        if (amount == 0) revert NothingOwed();
        owedNative[msg.sender] = 0; // effect before interaction
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) {
            owedNative[msg.sender] = amount; // restore on failure
            revert NativeSendFailed();
        }
        emit NativeWithdrawn(msg.sender, amount);
    }

    /// Send native; on failure credit a pull balance instead of reverting, so
    /// one party can never block the other's leg or lock the contract.
    function _payNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            owedNative[to] += amount;
            emit NativeOwed(to, amount);
        }
    }

    function _erc20Balance(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this))
        );
        if (!ok || data.length < 32) revert TokenTransferFailed();
        return abi.decode(data, (uint256));
    }

    /// SafeERC20 transfer: tolerates tokens that return no data on success
    /// (USDT-style) and treats a false return or a revert as failure.
    function _safeTransfer(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MeridianSplitterFactory · deploys one splitter per launch, deterministically.
//
// The splitter address must exist before launchToken is signed, because it
// goes into TokenParams.creatorFeeRecipient. CREATE2 lets the router predict
// the address off-chain, hand the team both transactions in one flow, and
// verify afterwards that the launch points at the right splitter. Treasury
// and escrow are pinned once at factory deployment; per-launch input is only
// the team address and a salt, so no caller can point the router share
// anywhere else.
// ─────────────────────────────────────────────────────────────────────────────
contract MeridianSplitterFactory {
    address public immutable treasury;
    address public immutable escrow;

    /// PROVENANCE. True for every splitter this factory deployed, and only
    /// those. The launch registry checks this on-chain to decide whether a
    /// launch's creatorFeeRecipient is a real Meridian splitter. An attacker
    /// can deploy a look-alike contract whose team()/treasury() getters LIE
    /// (returning the real treasury while routing 100% to themselves), and no
    /// getter read can tell it apart; this mapping can, because only create()
    /// writes it. Identity must come from provenance, never self-report.
    mapping(address => bool) public isSplitter;

    event SplitterCreated(address indexed team, bytes32 indexed salt, address splitter);

    error ZeroAddress();

    constructor(address treasury_, address escrow_) {
        // Both are required for the production path: the treasury receives the
        // router share, and the escrow is where PONS credits pull-based creator
        // fees. A factory deployed with escrow=0 would silently produce
        // splitters that can never claim earnings, so reject it here.
        if (treasury_ == address(0) || escrow_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        escrow = escrow_;
    }

    function create(address team, bytes32 salt) external returns (address splitter) {
        splitter = address(
            new MeridianLaunchSplitter{salt: keccak256(abi.encode(team, salt))}(team, treasury, escrow)
        );
        isSplitter[splitter] = true;
        emit SplitterCreated(team, salt, splitter);
    }

    function predict(address team, bytes32 salt) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(MeridianLaunchSplitter).creationCode, abi.encode(team, treasury, escrow))
        );
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(team, salt)), initCodeHash)
        );
        return address(uint160(uint256(h)));
    }
}
