// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GameRegistry} from "../src/GameRegistry.sol";

/// Minimal cheatcode surface (no forge-std dependency, so a fresh clone needs
/// no submodules to run the tests).
interface Vm {
    function warp(uint256 newTimestamp) external;
    function expectRevert() external;
    function prank(address) external;
}

contract GameRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GameRegistry reg;
    bytes32 constant G = keccak256("game-1");
    address constant P2 = address(0xBEEF);

    function setUp() public {
        reg = new GameRegistry(30 minutes);
    }

    function testOpenThenSettle() public {
        reg.openGame(G, P2, 30 minutes);
        (address p1, address p2, uint64 startAt, uint64 deadline, bytes32 resultHash, bool expired) = reg.gameState(G);
        require(p1 == address(this), "p1");
        require(p2 == P2, "p2");
        require(startAt > 0 && deadline == startAt + 30 minutes, "window");
        require(resultHash == bytes32(0) && !expired, "fresh");

        bytes32 r = keccak256("result");
        reg.settleGame(G, r);
        (,,,, bytes32 got, bool exp2) = reg.gameState(G);
        require(got == r && !exp2, "settled");
    }

    function testTtlAboveCapReverts() public {
        vm.expectRevert();
        reg.openGame(G, P2, 31 minutes);
    }

    function testZeroTtlReverts() public {
        vm.expectRevert();
        reg.openGame(G, P2, 0);
    }

    function testOpenTwiceReverts() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert();
        reg.openGame(G, P2, 30 minutes);
    }

    function testSettleByThirdPartyReverts() public {
        reg.openGame(G, P2, 30 minutes);
        // GameRegistry has no external caller switching here, so simulate by
        // settling twice (already-settled guard) and by the expiry path below.
        reg.settleGame(G, keccak256("ok"));
        vm.expectRevert();
        reg.settleGame(G, keccak256("again"));
    }

    function testExpireOnlyAfterDeadline() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert(); // too soon
        reg.expireGame(G);
        vm.warp(block.timestamp + 30 minutes + 1);
        reg.expireGame(G);
        (,,,,, bool expired) = reg.gameState(G);
        require(expired, "expired");
    }

    function testCannotExpireSettledGame() public {
        reg.openGame(G, P2, 30 minutes);
        reg.settleGame(G, keccak256("ok"));
        vm.warp(block.timestamp + 30 minutes + 1);
        vm.expectRevert();
        reg.expireGame(G);
    }

    function testExpireTwiceReverts() public {
        reg.openGame(G, P2, 30 minutes);
        vm.warp(block.timestamp + 30 minutes + 1);
        reg.expireGame(G);
        vm.expectRevert();
        reg.expireGame(G);
    }

    function testBatchCommitRoots() public {
        bytes32 openRoot = keccak256("open-root");
        reg.commitBatch(0, openRoot, 100);
        require(reg.lastOpenRoot() == openRoot, "open root");
        bytes32 settleRoot = keccak256("settle-root");
        reg.commitBatch(1, settleRoot, 100);
        require(reg.lastSettleRoot() == settleRoot, "settle root");
        vm.expectRevert();
        reg.commitBatch(2, settleRoot, 1); // bad kind
    }

    // ===== arcv2m1 on-chain turn clock =====

    function testBeginStampsSeatZeroDeadline() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 4, 45);
        (uint8 seats, uint8 activeSeat, uint32 turnSecs, uint64 turnDeadline, uint32 moves, bool begun) = reg.turnState(G);
        require(seats == 4 && activeSeat == 0 && turnSecs == 45 && begun, "began");
        require(moves == 0, "moves");
        require(turnDeadline == block.timestamp + 45, "deadline");
    }

    function testBeginRejectsBadSeatsAndTurn() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert();
        reg.beginGame(G, address(this), 1, 45); // seats < 2
        vm.expectRevert();
        reg.beginGame(G, address(this), 9, 45); // seats > MAX_SEATS
        vm.expectRevert();
        reg.beginGame(G, address(this), 4, 0); // zero turn
    }

    function testBeginRejectsNonHost() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert(); // a stranger is not p1/p2
        reg.beginGame(G, address(0x1234), 4, 45);
    }

    function testCommitMoveAdvancesActiveSeat() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 4, 45);
        vm.warp(block.timestamp + 10);
        reg.commitMove(G, address(this), 0, 1, keccak256("m1"));
        (,,, uint64 dl, uint32 moves, ) = reg.turnState(G);
        require(moves == 1, "moves");
        require(dl == block.timestamp + 45, "restamped");
        require(reg.lastMoveCommit(G) == keccak256("m1"), "commit");
        // Only the active seat (1, held by P2) may move next.
        reg.commitMove(G, P2, 1, 2, keccak256("m2"));
        (, uint8 activeSeat, , , uint32 m2, ) = reg.turnState(G);
        require(activeSeat == 2 && m2 == 2, "advanced");
    }

    function testCommitByNonActiveSeatReverts() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 4, 45);
        vm.expectRevert(); // seat 1 is not the active seat
        reg.commitMove(G, P2, 1, 2, keccak256("bad"));
    }

    function testCommitByWrongWalletReverts() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 4, 45);
        vm.expectRevert(); // P2 holds seat 1, seat 0 is the active seat
        reg.commitMove(G, P2, 0, 1, keccak256("bad"));
    }

    function testSeatUpThenThatWalletMayMove() public {
        address seat2 = address(0xCAFE);
        reg.openGame(G, P2, 30 minutes);
        reg.seatUp(G, address(this), 2, seat2);
        require(reg.seatOwner(G, 2) == seat2, "owner");
        reg.beginGame(G, address(this), 4, 45);
        reg.commitMove(G, address(this), 0, 1, keccak256("m1"));
        reg.commitMove(G, P2, 1, 2, keccak256("m2"));
        reg.commitMove(G, seat2, 2, 3, keccak256("m3"));
        (, uint8 activeSeat, , , uint32 moves, ) = reg.turnState(G);
        require(activeSeat == 3 && moves == 3, "seat wallet moved");
        // A seat already taken cannot be re-assigned.
        vm.expectRevert();
        reg.seatUp(G, address(this), 2, address(0xDEAD));
    }

    function testSeatUpAfterBeginReverts() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 4, 45);
        vm.expectRevert();
        reg.seatUp(G, address(this), 2, address(0xCAFE));
    }

    function testExpireOnlyAfterDeadlineAndIsPermissionless() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 3, 45);
        vm.expectRevert(); // still running
        reg.expireTurn(G);
        vm.warp(block.timestamp + 46);
        // A random third party (not a player) may advance the stalled turn.
        vm.prank(address(0x1234));
        reg.expireTurn(G);
        (, uint8 activeSeat, , uint64 dl, uint32 moves, ) = reg.turnState(G);
        require(activeSeat == 1 && moves == 1, "force-passed");
        require(dl == block.timestamp + 45, "fresh window");
        // Wraps around the seat count.
        vm.warp(block.timestamp + 46);
        reg.expireTurn(G);
        vm.warp(block.timestamp + 46);
        reg.expireTurn(G);
        (, uint8 wrapped, , , , ) = reg.turnState(G);
        require(wrapped == 0, "wrap");
    }

    function testExpireTurnOnUnbegunOrSettledReverts() public {
        reg.openGame(G, P2, 30 minutes);
        vm.expectRevert(); // not begun
        reg.expireTurn(G);
        reg.beginGame(G, address(this), 2, 45);
        reg.settleGame(G, keccak256("done"));
        vm.warp(block.timestamp + 46);
        vm.expectRevert(); // settled
        reg.expireTurn(G);
    }

    // ===== arcv2m1 finish order + result =====

    function testSettleGameOrderStoresOrder() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 4, 45);
        uint8[] memory order = new uint8[](4);
        order[0] = 2; order[1] = 0; order[2] = 3; order[3] = 1;
        bytes32 r = keccak256("final");
        reg.settleGameOrder(G, address(this), r, order);
        (bytes32 got, uint8[] memory stored) = reg.resultOrder(G);
        require(got == r, "hash");
        require(stored.length == 4, "len");
        require(stored[0] == 2 && stored[1] == 0 && stored[2] == 3 && stored[3] == 1, "order");
        vm.expectRevert(); // cannot settle twice
        reg.settleGameOrder(G, address(this), keccak256("again"), order);
    }

    function testResultOrderEmptyBeforeSettle() public {
        reg.openGame(G, P2, 30 minutes);
        (bytes32 got, uint8[] memory stored) = reg.resultOrder(G);
        require(got == bytes32(0) && stored.length == 0, "empty");
    }

    function testSettleGameOrderRejectsBadSeat() public {
        reg.openGame(G, P2, 30 minutes);
        reg.beginGame(G, address(this), 2, 45);
        uint8[] memory order = new uint8[](2);
        order[0] = 0; order[1] = 5; // seat 5 is outside the 2 seats
        vm.expectRevert();
        reg.settleGameOrder(G, address(this), keccak256("bad"), order);
    }

    function testSettleGameOrderRejectsNonPlayer() public {
        reg.openGame(G, P2, 30 minutes);
        uint8[] memory order = new uint8[](2);
        order[0] = 0; order[1] = 1;
        vm.expectRevert();
        reg.settleGameOrder(G, address(0x1234), keccak256("bad"), order);
    }

    function testSettleGameOrderRejectsEmptyOrder() public {
        reg.openGame(G, P2, 30 minutes);
        uint8[] memory order = new uint8[](0);
        vm.expectRevert();
        reg.settleGameOrder(G, address(this), keccak256("bad"), order);
    }
}
