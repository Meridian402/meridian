// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianToken — Meridian's own token.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// There is deliberately nothing here. Fixed supply minted once in the
// constructor, then no owner, no minter, no pauser, no blocklist, no transfer
// hook, no tax, no upgrade path, no admin of any kind. Every one of those is a
// lever someone could pull on holders later, and this file is short enough that
// anyone can confirm in a minute that none of them exist.
//
// The protocol fee lives in the v4 pool's hook, NOT in this contract. That
// separation is the whole point: a fee implemented as a transfer tax rides
// along on every transfer forever — wallet to wallet, into a bridge, into a
// vault — and it makes the token itself unsafe to integrate. A fee implemented
// as a hook only touches swaps in the one pool that opted into it, is capped by
// a constant in that hook's bytecode, and leaves this contract free of it.
//
// So: the token is boring on purpose, and the boringness is a feature you can
// point at.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    /// Immutable, and there is no function anywhere that mints or burns.
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZero();

    /// The whole supply goes to `treasury` at deploy. Distribution from there is
    /// an off-chain decision recorded on-chain by ordinary transfers, which is
    /// easier for anyone to audit than a vesting contract they have to trust.
    constructor(string memory name_, string memory symbol_, uint256 supply, address treasury) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[treasury] = supply;
        emit Transfer(address(0), treasury, supply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // Infinite approval stays infinite: skip the write, both for gas and so
        // a long-lived integration's allowance does not silently decay.
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        if (to == address(0)) revert TransferToZero();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount; // bounded by totalSupply, cannot overflow
        }
        emit Transfer(from, to, amount);
        return true;
    }
}
