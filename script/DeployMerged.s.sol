// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GFGMerged} from "../gfgnew/board/ludo-mp/GFGMerged.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeployMerged {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc TESTNET deploy for the merged test variant (ONE proxy, rules + ledger).
/// Proxy address is permanent; future changes are upgrades. TESTNET ONLY.
contract DeployMerged {
    VmDeployMerged constant vm = VmDeployMerged(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (address gamesProxy) {
        vm.startBroadcast();
        GFGMerged impl = new GFGMerged();
        gamesProxy = address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(GFGMerged.initialize, (msg.sender))
        ));
        GFGMerged(gamesProxy).setTurnSecs(45);
        GFGMerged(gamesProxy).setMaxMatchSecs(3600);
        vm.stopBroadcast();
        return gamesProxy;
    }
}
