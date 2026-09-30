// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LudoGames} from "../gfgnew/board/ludo/LudoGames.sol";
import {LudoPlayers} from "../gfgnew/board/ludo/LudoPlayers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeployLudo {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc TESTNET deploy script for gfgnew/board/ludo (standalone multiplayer).
/// Deploys LudoGames + LudoPlayers behind UUPS proxies, wires them once.
/// Proxy addresses are PERMANENT; future features are upgrades, never new
/// addresses. NO secrets here; deployer key comes from env at runtime.
/// Target: Arc testnet only until owner confirms working, then mainnet.
contract DeployLudo {
    VmDeployLudo constant vm = VmDeployLudo(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (address gamesProxy, address playersProxy) {
        vm.startBroadcast();
        LudoPlayers playersImpl = new LudoPlayers();
        playersProxy = address(new ERC1967Proxy(
            address(playersImpl),
            abi.encodeCall(LudoPlayers.initialize, (msg.sender))
        ));
        LudoGames gamesImpl = new LudoGames();
        gamesProxy = address(new ERC1967Proxy(
            address(gamesImpl),
            abi.encodeCall(LudoGames.initialize, (msg.sender, playersProxy))
        ));
        LudoPlayers(playersProxy).setGame(gamesProxy);
        vm.stopBroadcast();
        return (gamesProxy, playersProxy);
    }
}