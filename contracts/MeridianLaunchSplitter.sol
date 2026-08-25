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
// transferred here directly is handled by split alone. A team address that
// reverts on native receive can block only its own native-quote splits; the
// ERC20 path, which is what USDG-paired launches use, is unaffected.
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

    event Split(address indexed currency, uint256 toTeam, uint256 toTreasury);

    error ZeroAddress();
    error NativeSendFailed();
    error TokenTransferFailed();

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
    function split(address currency) public {
        if (currency == address(0)) {
            uint256 bal = address(this).balance;
            if (bal == 0) return;
            uint256 cut = (bal * ROUTER_BPS) / 10_000;
            _sendNative(treasury, cut);
            _sendNative(team, bal - cut);
            emit Split(currency, bal - cut, cut);
        } else {
            IERC20Minimal t = IERC20Minimal(currency);
            uint256 bal = t.balanceOf(address(this));
            if (bal == 0) return;
            uint256 cut = (bal * ROUTER_BPS) / 10_000;
            if (!t.transfer(treasury, cut)) revert TokenTransferFailed();
            if (!t.transfer(team, bal - cut)) revert TokenTransferFailed();
            emit Split(currency, bal - cut, cut);
        }
    }

    function _sendNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeSendFailed();
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

    event SplitterCreated(address indexed team, bytes32 indexed salt, address splitter);

    error ZeroAddress();

    constructor(address treasury_, address escrow_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        escrow = escrow_;
    }

    function create(address team, bytes32 salt) external returns (address splitter) {
        splitter = address(
            new MeridianLaunchSplitter{salt: keccak256(abi.encode(team, salt))}(team, treasury, escrow)
        );
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
