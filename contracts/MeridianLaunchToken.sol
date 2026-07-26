// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianLaunchToken — the token a launch actually mints.
//
// DRAFT · UNAUDITED · NOT DEPLOYED.
//
// Deliberately boring, and the boringness is the feature. Fixed supply minted
// once in the constructor, then nothing: no owner, no minter, no pauser, no
// blocklist, no transfer hook, no tax, no upgrade path. Every one of those is a
// lever a deployer could pull on their own holders later, and a launchpad that
// ships them is selling a rug with extra steps.
//
// What a buyer can verify in ten seconds by reading this file: the supply they
// see is the supply that will ever exist, and nobody can stop them selling.
// ─────────────────────────────────────────────────────────────────────────────

contract MeridianLaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZero();

    /// The entire supply goes to `mintTo` — the factory, which immediately puts
    /// it into the locked liquidity position. There is no second mint.
    constructor(string memory name_, string memory symbol_, uint256 supply, address mintTo) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[mintTo] = supply;
        emit Transfer(address(0), mintTo, supply);
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
        // The infinite-approval convention: skip the write when unlimited, both
        // to save gas and so the allowance does not quietly decay.
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
            balanceOf[to] += amount; // cannot overflow: bounded by totalSupply
        }
        emit Transfer(from, to, amount);
        return true;
    }
}
