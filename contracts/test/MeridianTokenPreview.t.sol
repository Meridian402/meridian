// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {MeridianToken} from "../MeridianToken.sol";

/**
 * Not a test so much as a receipt: deploy MERD with the exact arguments we
 * intend to submit and print back what a wallet, an explorer and an aggregator
 * would each read off the chain.
 *
 * Worth doing because name and symbol are the two values nobody can change
 * afterwards and everybody sees first. A typo here is permanent and public.
 */
contract MeridianTokenPreviewTest is Test {
    // The exact arguments that will be submitted.
    string constant NAME = "Meridian";
    string constant SYMBOL = "MERD";
    uint256 constant SUPPLY = 1_000_000_000 ether; // 1,000,000,000 with 18 decimals
    address constant TREASURY = 0xB849aa20b21C015e8F5118Dcf4b631366C2e87bB;

    function test_previewWhatTheChainWillShow() public {
        MeridianToken token = new MeridianToken(NAME, SYMBOL, SUPPLY, TREASURY);

        console2.log("--- as a wallet or explorer reads it ---");
        console2.log("name():       ", token.name());
        console2.log("symbol():     ", token.symbol());
        console2.log("decimals():   ", token.decimals());
        console2.log("totalSupply():", token.totalSupply());
        console2.log("  = human:    ", token.totalSupply() / 1e18);
        console2.log("holder:       ", TREASURY);
        console2.log("balance:      ", token.balanceOf(TREASURY) / 1e18);

        // The values are what they are, byte for byte.
        assertEq(token.name(), "Meridian");
        assertEq(token.symbol(), "MERD");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000_000 * 1e18);
        assertEq(token.balanceOf(TREASURY), token.totalSupply());

        // No stray whitespace or invisible characters, which is exactly the
        // kind of thing that survives a copy-paste and is permanent on-chain.
        assertEq(bytes(token.name()).length, 8, "name must be exactly 'Meridian'");
        assertEq(bytes(token.symbol()).length, 4, "symbol must be exactly 'MERD'");
    }

    function test_theConstructorCalldataWeWouldSubmit() public pure {
        bytes memory args = abi.encode(NAME, SYMBOL, SUPPLY, TREASURY);
        console2.log("--- ABI-encoded constructor arguments ---");
        console2.logBytes(args);
        console2.log("length:", args.length);
    }
}
