// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {FoskaayGGILudo} from "../demos/board/ludo/FoskaayGGILudo.sol";

/// Shared test helpers: deploy contracts BEHIND a proxy, exactly as production
/// does, and call initialize. Tests must go through the proxy so they exercise
/// the real deployed shape (and would catch a storage/initializer bug).
library Deploy {
    /// The SINGLE core: SessionRegistry (the FeeVault is merged in).
    function registry(address owner, address destination, uint256 fee) internal returns (SessionRegistry) {
        SessionRegistry impl = new SessionRegistry();
        bytes memory init = abi.encodeCall(SessionRegistry.initialize, (owner, destination, fee));
        return SessionRegistry(address(new ERC1967Proxy(address(impl), init)));
    }

    /// The Ludo game BEHIND a UUPS proxy: its address is permanent and its logic
    /// is upgradeable, like every contract we ship.
    function ludo(address owner) internal returns (FoskaayGGILudo) {
        FoskaayGGILudo impl = new FoskaayGGILudo();
        bytes memory init = abi.encodeCall(FoskaayGGILudo.initialize, (owner));
        return FoskaayGGILudo(address(new ERC1967Proxy(address(impl), init)));
    }
}
