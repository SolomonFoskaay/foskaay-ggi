// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GameRegistry} from "../src/GameRegistry.sol";
import {Randomness} from "../src/Randomness.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Phase 1 (Arc Testnet) deploy script. NO secrets live here: at run time the
/// deployer key comes from the environment, e.g.
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $GFG_Arc_RPC --private-key $GFG_Arc_Gasless_Sponsor_Key --broadcast
/// On Arc the gas is USDC, so the sponsor wallet only needs test USDC.
contract Deploy {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (address registry, address randomness) {
        vm.startBroadcast();
        GameRegistry reg = new GameRegistry(30 minutes);
        Randomness rnd = new Randomness();
        vm.stopBroadcast();
        return (address(reg), address(rnd));
    }
}
