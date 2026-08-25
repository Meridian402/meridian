// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MeridianSplitterFactory} from "../MeridianLaunchSplitter.sol";

// Deploys the splitter factory for the agent-launch router. House invariant:
// this runs standalone via forge with the one-shot DEPLOYER key from the
// environment, never the engine signer, never inside the desk process.
//
//   DEPLOYER_PRIVATE_KEY=0x... forge script \
//     contracts/script/DeploySplitterFactory.s.sol --rpc-url $RPC --broadcast
//
// Constructor pins both parties forever:
//   treasury = the Meridian treasury (router share destination)
//   escrow   = the PONS v2 FeeEscrow (what splitters pull from)
contract DeploySplitterFactory is Script {
    address constant TREASURY = 0x475C1fe4d1e7A703eaca6141978b04010e410Bf4; // TREASURY_WALLET (wallets.ts)
    address constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;

    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        MeridianSplitterFactory factory = new MeridianSplitterFactory(TREASURY, PONS_FEE_ESCROW);
        vm.stopBroadcast();
        console.log("MeridianSplitterFactory:", address(factory));
        console.log("  treasury:", factory.treasury());
        console.log("  escrow:  ", factory.escrow());
    }
}
