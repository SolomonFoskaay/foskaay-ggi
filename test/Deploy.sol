// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {FoskaayGGI} from "../src/FoskaayGGI.sol";
import {FoskaayGGILudo} from "../demos/board/ludo/FoskaayGGILudo.sol";
import {FoskaayGGIGames} from "../demos/board/ludo/FoskaayGGIGames.sol";
import {FoskaayGGIPlayers} from "../demos/board/ludo/FoskaayGGIPlayers.sol";
import {GGTestGame} from "../testproof/GGTestGame.sol";
import {GGTestPlayer} from "../testproof/GGTestPlayer.sol";

/// Shared test helpers: deploy contracts BEHIND a proxy, exactly as production
/// does, and call initialize. Tests must go through the proxy so they exercise
/// the real deployed shape (and would catch a storage/initializer bug).
library Deploy {
    /// The SINGLE core: FoskaayGGI (the FeeVault is merged in).
    function registry(address owner, address destination, uint256 fee) internal returns (FoskaayGGI) {
        FoskaayGGI impl = new FoskaayGGI();
        bytes memory init = abi.encodeCall(FoskaayGGI.initialize, (owner, destination, fee, fee, 0, 0));
        return FoskaayGGI(address(new ERC1967Proxy(address(impl), init)));
    }

    /// The Ludo game BEHIND a UUPS proxy: its address is permanent and its logic
    /// is upgradeable, like every contract we ship.
    function ludo(address owner) internal returns (FoskaayGGILudo) {
        FoskaayGGILudo impl = new FoskaayGGILudo();
        bytes memory init = abi.encodeCall(FoskaayGGILudo.initialize, (owner));
        return FoskaayGGILudo(address(new ERC1967Proxy(address(impl), init)));
    }

    /// The real player account BEHIND a UUPS proxy (points/lives/records). Its
    /// `game` is pointed at the game right after, via setGame.
    function ggPlayers(address owner) internal returns (FoskaayGGIPlayers) {
        FoskaayGGIPlayers impl = new FoskaayGGIPlayers();
        bytes memory init = abi.encodeCall(FoskaayGGIPlayers.initialize, (owner));
        return FoskaayGGIPlayers(address(new ERC1967Proxy(address(impl), init)));
    }

    /// The real Ludo game BEHIND a UUPS proxy (rules + match + settle).
    function ggGames(address owner, address players) internal returns (FoskaayGGIGames) {
        FoskaayGGIGames impl = new FoskaayGGIGames();
        bytes memory init = abi.encodeCall(FoskaayGGIGames.initialize, (owner, players));
        return FoskaayGGIGames(address(new ERC1967Proxy(address(impl), init)));
    }

    /// PROOF-ONLY: a stateful game account behind a UUPS proxy.
    function ggTestGame(address owner) internal returns (GGTestGame) {
        GGTestGame impl = new GGTestGame();
        bytes memory init = abi.encodeCall(GGTestGame.initialize, (owner));
        return GGTestGame(address(new ERC1967Proxy(address(impl), init)));
    }

    /// PROOF-ONLY: a stateful player account behind a UUPS proxy.
    function ggTestPlayer(address owner, address game) internal returns (GGTestPlayer) {
        GGTestPlayer impl = new GGTestPlayer();
        bytes memory init = abi.encodeCall(GGTestPlayer.initialize, (owner, game));
        return GGTestPlayer(address(new ERC1967Proxy(address(impl), init)));
    }
}
