// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGIGames} from "../demos/board/ludo/FoskaayGGIGames.sol";
import {FoskaayGGIPlayers} from "../demos/board/ludo/FoskaayGGIPlayers.sol";
import {Deploy} from "./Deploy.sol";

interface VmGames {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// Phase 2: FoskaayGGIGames + FoskaayGGIPlayers. The game holds the match and the
/// rules, settle writes N games in ONE tx and credits the player in the same step,
/// only the game can credit, and both contracts are UUPS (address + data kept).
contract FoskaayGGIGamesTest {
    VmGames constant vm = VmGames(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 constant TAG = keccak256("ludo");
    bytes32 constant SID = keccak256("session-1");

    FoskaayGGIGames games;
    FoskaayGGIPlayers players;
    address constant P0 = address(0xA0);
    address constant P1 = address(0xB0);

    function setUp() public {
        players = Deploy.ggPlayers(address(this));
        games = Deploy.ggGames(address(this), address(players));
        players.setGame(address(games));
    }

    // ---- helpers ----

    function _board(uint8 seats, uint16[4] memory pts) internal pure returns (bytes memory b) {
        b = new bytes(36);
        b[2] = bytes1(uint8(0)); // userSeat
        b[3] = bytes1(seats);
        for (uint256 i = 0; i < 16; i++) b[8 + i] = bytes1(0xFF);
        for (uint256 s = 0; s < 4; s++) {
            b[28 + 2 * s] = bytes1(uint8(pts[s] >> 8));
            b[29 + 2 * s] = bytes1(uint8(pts[s] & 0xFF));
        }
    }

    function _game(bytes memory board, uint8 seats) internal pure returns (FoskaayGGIGames.Game memory g) {
        g.turn = 0;
        g.seats = seats;
        g.step = 42;
        g.board = board;
        g.boardHash = keccak256(board);
        g.over = true;
    }

    function _one(address a) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory x) {
        x = new address[](2);
        x[0] = a;
        x[1] = b;
    }

    // ---- core behavior ----

    function testGameHoldsMatchAndCreditsInOneStep() public {
        uint16[4] memory pts;
        pts[0] = 100;
        FoskaayGGIGames.Game[] memory list = new FoskaayGGIGames.Game[](1);
        list[0] = _game(_board(2, pts), 2);
        uint256 credited = games.settle(SID, list, _two(P0, P1), TAG);

        require(credited == 100, "credited 100");
        require(games.gameCount(SID) == 1, "one game held");
        FoskaayGGIGames.Game[] memory got = games.gamesOf(SID);
        require(got[0].over && got[0].step == 42 && got[0].seats == 2, "match stored");
        require(got[0].boardHash == keccak256(got[0].board), "board hash stored");
        require(players.pointsOf(P0, TAG) == 100, "player credited, same step");
        require(players.pointsOf(P1, TAG) == 0, "loser not credited");
    }

    function testSettleManyWritesAllAndCreditsSummed() public {
        uint16[4] memory pts;
        pts[0] = 100;
        FoskaayGGIGames.Game[] memory list = new FoskaayGGIGames.Game[](3);
        list[0] = _game(_board(2, pts), 2);
        list[1] = _game(_board(2, pts), 2);
        list[2] = _game(_board(2, pts), 2);
        uint256 credited = games.settle(SID, list, _two(P0, P1), TAG);
        require(credited == 300, "summed 3 games");
        require(games.gameCount(SID) == 3, "3 games in one tx");
        require(players.pointsOf(P0, TAG) == 300, "player credited 3x");
    }

    function testOnlyGameCanCredit() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(FoskaayGGIPlayers.OnlyGame.selector);
        players.credit(P0, TAG, 100);
    }

    function testSettleOnlyOwner() public {
        uint16[4] memory pts;
        FoskaayGGIGames.Game[] memory list = new FoskaayGGIGames.Game[](1);
        list[0] = _game(_board(2, pts), 2);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        games.settle(SID, list, _two(P0, P1), TAG);
    }

    function testBadBoardHashReverts() public {
        uint16[4] memory pts;
        FoskaayGGIGames.Game[] memory list = new FoskaayGGIGames.Game[](1);
        list[0] = _game(_board(2, pts), 2);
        list[0].boardHash = bytes32(uint256(1));
        vm.expectRevert(FoskaayGGIGames.BadHash.selector);
        games.settle(SID, list, _two(P0, P1), TAG);
    }

    function testPureRulesRunFree() public {
        bytes memory s0 = games.getInitialState(2, 0);
        require(s0.length == 36, "initial state");
        bytes32[] memory seeds = new bytes32[](2);
        seeds[0] = bytes32(uint256(5)); // 5 % 6 + 1 = 6
        seeds[1] = bytes32(uint256(0)); // 1
        bytes memory s1 = games.applyMove(s0, 0, 0, 0, 0, seeds);
        require(uint8(s1[4]) == 6 && uint8(s1[5]) == 1, "dice rolled by pure rules");
        require(games.hashState(s1) == keccak256(s1), "hashState");
    }

    // ---- upgrade safety ----

    function testGamesUpgradeKeepsAddressAndData() public {
        uint16[4] memory pts;
        pts[0] = 100;
        FoskaayGGIGames.Game[] memory list = new FoskaayGGIGames.Game[](1);
        list[0] = _game(_board(2, pts), 2);
        games.settle(SID, list, _two(P0, P1), TAG);

        address before = address(games);
        FoskaayGGIGames impl = new FoskaayGGIGames();
        games.upgradeToAndCall(address(impl), "");
        require(address(games) == before, "address kept");
        require(games.gameCount(SID) == 1, "games data kept");
        require(address(games.players()) == address(players), "players kept");
    }

    function testPlayersUpgradeKeepsAddressAndData() public {
        players.credit(P0, TAG, 100);
        address before = address(players);
        FoskaayGGIPlayers impl = new FoskaayGGIPlayers();
        players.upgradeToAndCall(address(impl), "");
        require(address(players) == before, "address kept");
        require(players.pointsOf(P0, TAG) == 100, "points kept");
        require(players.game() == address(games), "game kept");
    }

    function testPlayersLivesAndRecords() public {
        players.setLives(P0, TAG, 5);
        players.addRecord(P0, TAG, 1, 1, 100);
        players.addRecord(P0, TAG, 1, 0, 50);
        require(players.livesOf(P0, TAG) == 5, "lives");
        (uint64 played, uint64 wins, uint64 best) = players.recordOf(P0, TAG);
        require(played == 2 && wins == 1 && best == 100, "record accumulates");
    }
}
