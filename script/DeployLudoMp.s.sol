// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GFGGames} from "../gfgnew/board/ludo-mp/GFGGames.sol";
import {GFGPlayers} from "../gfgnew/board/ludo-mp/GFGPlayers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeployMp {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc TESTNET deploy script for ludo-mp (isolated multiplayer copy).
/// Deploys GFGGames + GFGPlayers behind UUPS proxies, wires them once.
/// Proxy addresses are PERMANENT; future features are upgrades, never new addresses.
/// NO secrets here; deployer key comes from env at runtime.
/// Target: Arc testnet only until owner confirms working, then mainnet.
contract DeployLudoMp {
    VmDeployMp constant vm = VmDeployMp(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (address gamesProxy, address playersProxy) {
        vm.startBroadcast();
        GFGPlayers playersImpl = new GFGPlayers();
        playersProxy = address(new ERC1967Proxy(
            address(playersImpl),
            abi.encodeCall(GFGPlayers.initialize, (msg.sender))
        ));
        GFGGames gamesImpl = new GFGGames();
        gamesProxy = address(new ERC1967Proxy(
            address(gamesImpl),
            abi.encodeCall(GFGGames.initialize, (msg.sender, playersProxy))
        ));
        GFGPlayers(playersProxy).setGame(gamesProxy);
        vm.stopBroadcast();
        return (gamesProxy, playersProxy);
    }
}
