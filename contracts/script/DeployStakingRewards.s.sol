// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {MeridianStakingRewards} from "../MeridianStakingRewards.sol";

// Deploys the staking registry that arms the engine gate's stake path
// (2.5M MERD = the key). Per the simple plan, this ships as PURE STAKE
// REGISTRY first: stakedOf() is what the gate reads, and fund() may sit
// unused until the ladder vault supersedes this contract for yield.
// House invariant: standalone forge, DEPLOYER key from env, never the
// engine signer, never inside the desk process.
//
//   DEPLOYER_PRIVATE_KEY=0x... forge script \
//     contracts/script/DeployStakingRewards.s.sol --rpc-url $RPC --broadcast
//
// MERD address note for the operator, one last time before it is baked
// immutably: this uses the LIVE token 0x12f8... (the one merdSpot prices,
// the site displays, and the seat tests pin). merd.ts's 0x4663... is the
// unresolved other address; if that one is somehow the real MERD, stop
// and say so before running this.
contract DeployStakingRewards is Script {
    address constant MERD_LIVE = 0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        MeridianStakingRewards staking = new MeridianStakingRewards(MERD_LIVE, USDG);
        vm.stopBroadcast();
        console.log("MeridianStakingRewards:", address(staking));
        console.log("  MERD:", address(staking.MERD()));
        console.log("  USDG:", address(staking.USDG()));
        console.log("Then set on Railway: MERD_STAKING_ADDRESS + MERD_TOKEN_ADDRESS");
    }
}
