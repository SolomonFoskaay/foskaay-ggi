// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGI} from "../src/FoskaayGGI.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Arc deploy script for the SINGLE core Foskaay GGI contract, behind a UUPS proxy.
///
/// WHY A PROXY: the proxy address is PERMANENT. Upgrading public logic never moves
/// an address, so active sessions and data are never stranded. The owner controls
/// upgrades now; before mainnet that moves to a timelock or multisig.
///
/// NO secrets live here: at run time the deployer key comes from the environment.
/// On Arc the gas token is USDC (native, 18 decimals), so the sponsor only needs
/// test USDC. The fee is taken in native USDC.
contract DeployGI {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Legacy single fee for `handover` (native USDC, 18 decimals).
    uint256 constant LEGACY_FEE = 4e14;   // 0.0004
    /// The session fee parts (all charged at connect): base + per account + per game.
    uint256 constant FEE_BASE = 4e14;        // 0.0004
    uint256 constant FEE_PER_ACCOUNT = 4e14; // 0.0004
    uint256 constant FEE_PER_GAME = 2e14;    // 0.0002

    function run() external returns (address registry) {
        vm.startBroadcast();
        FoskaayGGI regImpl = new FoskaayGGI();
        registry = address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(FoskaayGGI.initialize, (msg.sender, msg.sender, LEGACY_FEE, FEE_BASE, FEE_PER_ACCOUNT, FEE_PER_GAME))
        ));
        vm.stopBroadcast();
        return registry;
    }
}
