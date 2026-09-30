// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LudoGames} from "../gfgnew/board/ludo/LudoGames.sol";
import {LudoPlayers} from "../gfgnew/board/ludo/LudoPlayers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmLudo {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
}

/// gfgnew/board/ludo parity + upgrade-safety tests (testnet shape, no chain).
/// Proves the standalone copy kept the battle-tested rules AND the fixes:
/// idempotent settle (one credential per session) + relaxed timing that still
/// binds a forged clock.
contract LudoGamesTest {
    VmLudo constant vm = VmLudo(address(uint160(uint256(keccak256("hevm cheat code")))));

    LudoGames games;
    LudoPlayers players;

    function setUp() public {
        LudoPlayers playersImpl = new LudoPlayers();
        address playersProxy = address(new ERC1967Proxy(
            address(playersImpl),
            abi.encodeCall(LudoPlayers.initialize, (address(this)))
        ));
        players = LudoPlayers(playersProxy);
        LudoGames gamesImpl = new LudoGames();
        address gamesProxy = address(new ERC1967Proxy(
            address(gamesImpl),
            abi.encodeCall(LudoGames.initialize, (address(this), playersProxy))
        ));
        games = LudoGames(gamesProxy);
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
        vm.expectRevert(LudoGames.NotYourTurn.selector);
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
        LudoGames gamesImpl2 = new LudoGames();
        games.upgradeToAndCall(address(gamesImpl2), "");
        require(address(games) == proxyBefore, "address kept");
        require(games.version() == 1, "version kept");
        require(players.game() == address(games), "wiring kept");
    }

    function testTimeoutKeepsBonusTurn() public view {
        bytes memory s = games.getInitialState(2, 0);
        bytes memory t = new bytes(36);
        for (uint256 i = 0; i < 36; i++) t[i] = s[i];
        t[7] = bytes1(uint8(1)); // one pending double-six bonus
        bytes memory o = games.applyMove(t, 3, 0, 0, 0, new bytes32[](0));
        require(uint8(o[0]) == 0, "bonus turn kept");
        require(uint8(o[7]) == 0, "bonus consumed");
    }

    function testTimeoutAdvancesWithoutBonus() public view {
        bytes memory s = games.getInitialState(2, 0);
        bytes memory o = games.applyMove(s, 3, 0, 0, 0, new bytes32[](0));
        require(uint8(o[0]) == 1, "turn advances");
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

    function testTimerDefaultsAndHelpers() public view {
        require(games.turnSecs() == 45, "turnSecs default");
        require(games.maxMatchSecs() == 7200, "maxMatchSecs default");
        require(games.turnDeadline(1000) == 1045, "deadline");
        require(!games.isTurnExpired(1000, 1044), "not expired");
        require(games.isTurnExpired(1000, 1045), "expired");
    }

    function testSettleIsIdempotent() public {
        vm.warp(1000000);
        bytes memory s0 = games.getInitialState(2, 0);
        LudoGames.Game[] memory list = new LudoGames.Game[](1);
        list[0].turn = 0;
        list[0].seats = 2;
        list[0].step = 1;
        list[0].board = s0;
        list[0].boardHash = games.hashState(s0);
        list[0].over = false;
        address[] memory seats = new address[](2);
        seats[0] = address(0x1);
        seats[1] = address(0x2);
        uint64 nowTs = uint64(block.timestamp);
        uint64[] memory tss = new uint64[](2);
        tss[0] = nowTs - 10;
        tss[1] = nowTs;
        games.settle(bytes32("s3"), list, seats, bytes32("t"), tss);
        require(games.gameCount(bytes32("s3")) == 1, "committed once");
        vm.expectRevert(LudoGames.BadRepeat.selector);
        games.settle(bytes32("s3"), list, seats, bytes32("t"), tss);
    }

    function testRelaxedTimingAcceptsSlowButReal() public {
        vm.warp(1000000);
        bytes memory s0 = games.getInitialState(2, 0);
        LudoGames.Game[] memory list = new LudoGames.Game[](1);
        list[0].turn = 0;
        list[0].seats = 2;
        list[0].step = 3;
        list[0].board = s0;
        list[0].boardHash = games.hashState(s0);
        list[0].over = false;
        address[] memory seats = new address[](2);
        seats[0] = address(0x1);
        seats[1] = address(0x2);
        uint64 nowTs = uint64(block.timestamp);
        uint64[] memory tss = new uint64[](4);
        tss[0] = nowTs - 200;   // handover 200s ago
        tss[1] = nowTs - 150;   // 50s gap (allowed)
        tss[2] = nowTs - 40;    // 110s gap (old strict 60 would strand this)
        tss[3] = nowTs;         // 40s gap
        games.settle(bytes32("s4"), list, seats, bytes32("t"), tss);
        require(games.gameCount(bytes32("s4")) == 1, "sealed");
    }

    function testSettleRejectsMonotonicBreak() public {
        vm.warp(1000000);
        bytes memory s0 = games.getInitialState(2, 0);
        LudoGames.Game[] memory list = new LudoGames.Game[](1);
        list[0].turn = 0;
        list[0].seats = 2;
        list[0].step = 2;
        list[0].board = s0;
        list[0].boardHash = games.hashState(s0);
        list[0].over = false;
        address[] memory seats = new address[](2);
        seats[0] = address(0x1);
        seats[1] = address(0x2);
        uint64 nowTs = uint64(block.timestamp);
        uint64[] memory tss = new uint64[](3);
        tss[0] = nowTs - 100;
        tss[1] = nowTs - 50;
        tss[2] = nowTs - 60; // goes backwards
        vm.expectRevert(LudoGames.BadTiming.selector);
        games.settle(bytes32("s5"), list, seats, bytes32("t"), tss);
    }

    function testSettleRejectsEmptyTimestamps() public {
        bytes memory s0 = games.getInitialState(2, 0);
        LudoGames.Game[] memory list = new LudoGames.Game[](1);
        list[0].turn = 0;
        list[0].seats = 2;
        list[0].step = 0;
        list[0].board = s0;
        list[0].boardHash = games.hashState(s0);
        list[0].over = false;
        address[] memory seats = new address[](2);
        seats[0] = address(0x1);
        seats[1] = address(0x2);
        uint64[] memory tss = new uint64[](0);
        vm.expectRevert(LudoGames.BadTiming.selector);
        games.settle(bytes32("s6"), list, seats, bytes32("t"), tss);
    }

    function testSettleCreditsAllEarningSeats() public {
        vm.warp(1000000);
        // A finished 4P board: seats 0 (1st=100) and 2 (3rd=25) both earn.
        bytes memory s0 = games.getInitialState(4, 0);
        // Manually mark finishOrder + points via a move path: use decode/apply is
        // complex here, so build the terminal bytes directly (layout is public).
        bytes memory b = new bytes(36);
        for (uint256 i = 0; i < 36; i++) b[i] = s0[i];
        b[3] = bytes1(uint8(4));   // seatCount
        b[24] = bytes1(uint8(0));  // order[0] = seat 0 (1st)
        b[26] = bytes1(uint8(2));  // order[2] = seat 2 (3rd)
        b[1] = bytes1(uint8(3));   // finishCount = 3 (terminal for 4P)
        // points: seat0 = 100 (0x0064), seat2 = 25 (0x0019)
        b[28] = bytes1(uint8(0)); b[29] = bytes1(uint8(100));
        b[32] = bytes1(uint8(0)); b[33] = bytes1(uint8(25));

        LudoGames.Game[] memory list = new LudoGames.Game[](1);
        list[0].turn = 0;
        list[0].seats = 4;
        list[0].step = 6;
        list[0].board = b;
        list[0].boardHash = games.hashState(b);
        list[0].over = true;
        address[] memory seatPlayers = new address[](4);
        seatPlayers[0] = address(0xAAA);
        seatPlayers[1] = address(0);
        seatPlayers[2] = address(0xCCC);
        seatPlayers[3] = address(0);
        uint64 nowTs = uint64(block.timestamp);
        uint64[] memory tss = new uint64[](7);
        tss[0] = nowTs - 90; tss[1] = nowTs - 80; tss[2] = nowTs - 70;
        tss[3] = nowTs - 60; tss[4] = nowTs - 50; tss[5] = nowTs - 30;
        tss[6] = nowTs;
        games.settle(bytes32("s7"), list, seatPlayers, bytes32("ludo"), tss);
        require(players.pointsOf(address(0xAAA), bytes32("ludo")) == 100, "seat0 credited");
        require(players.pointsOf(address(0xCCC), bytes32("ludo")) == 25, "seat2 credited");
        require(players.pointsOf(address(0xBBB), bytes32("ludo")) == 0, "zero not credited");
    }
}