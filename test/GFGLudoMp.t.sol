// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GFGGames} from "../gfgnew/board/ludo-mp/GFGGames.sol";
import {GFGPlayers} from "../gfgnew/board/ludo-mp/GFGPlayers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmMp {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// ludo-mp parity + upgrade-safety tests (testnet shape, no chain needed).
/// Proves the copy kept single-player rules and stays UUPS upgradeable.
contract GFGLudoMpTest {
    VmMp constant vm = VmMp(address(uint160(uint256(keccak256("hevm cheat code")))));

    GFGGames games;
    GFGPlayers players;

    function setUp() public {
        GFGPlayers playersImpl = new GFGPlayers();
        address playersProxy = address(new ERC1967Proxy(
            address(playersImpl),
            abi.encodeCall(GFGPlayers.initialize, (address(this)))
        ));
        players = GFGPlayers(playersProxy);
        GFGGames gamesImpl = new GFGGames();
        address gamesProxy = address(new ERC1967Proxy(
            address(gamesImpl),
            abi.encodeCall(GFGGames.initialize, (address(this), playersProxy))
        ));
        games = GFGGames(gamesProxy);
        players.setGame(address(games));
    }

    function testInitialState2P() public view {
        bytes memory s = games.getInitialState(2, 0);
        require(s.length == 36, "len");
        require(uint8(s[3]) == 2, "seats");
        for (uint256 i = 0; i < 16; i++) require(uint8(s[8 + i]) == 0xFF, "yard");
    }

    function testRollProducesDice1to6() public view {
        bytes memory s0 = games.getInitialState(2, 0);
        bytes32[] memory seeds = new bytes32[](2);
        seeds[0] = keccak256("a");
        seeds[1] = keccak256("b");
        bytes memory s1 = games.applyMove(s0, 0, 0, 0, 0, seeds);
        uint8 d1 = uint8(s1[4]);
        uint8 d2 = uint8(s1[5]);
        require(d1 >= 1 && d1 <= 6, "d1");
        require(d2 >= 1 && d2 <= 6, "d2");
    }

    function testNotYourTurnReverts() public {
        bytes memory s0 = games.getInitialState(2, 0);
        bytes32[] memory seeds = new bytes32[](2);
        seeds[0] = bytes32(uint256(1));
        seeds[1] = bytes32(uint256(2));
        vm.expectRevert(GFGGames.NotYourTurn.selector);
        games.applyMove(s0, 0, 1, 0, 0, seeds);
    }

    function testPlacePoints() public view {
        require(games.placePoints(1, 4) == 100, "p1");
        require(games.placePoints(2, 4) == 50, "p2");
        require(games.placePoints(3, 4) == 25, "p3");
        require(games.placePoints(4, 4) == 0, "p4");
        require(games.placePoints(1, 2) == 100, "2p1");
        require(games.placePoints(2, 2) == 0, "2p2");
    }

    function testProxyAddressesStableOnUpgrade() public {
        address proxyBefore = address(games);
        GFGGames gamesImpl2 = new GFGGames();
        games.upgradeToAndCall(address(gamesImpl2), "");
        require(address(games) == proxyBefore, "address kept");
        require(games.version() == 3, "version kept");
        require(players.game() == address(games), "wiring kept");
    }

    function testOnlyOwnerGuards() public {
        address stranger = address(0xBEEF);
        vm.prank(stranger);
        vm.expectRevert();
        games.setPlayers(address(1));
        vm.prank(stranger);
        vm.expectRevert();
        players.setGame(address(1));
    }
}
