// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGILudo} from "../demos/board/ludo/FoskaayGGILudo.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// The Ludo rules as a pure function: no storage, points inside the state, and
/// capture ("pe") matching ludo-lab exactly (unconditional on a common cell,
/// safe on the four coloured start cells).
contract FoskaayGGILudoTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    FoskaayGGILudo ludo;
    uint8 constant YARD = 0xFF;

    function setUp() public {
        ludo = Deploy.ludo(address(this));
    }

    function _build(uint8 turn, uint8 finishCount, uint8 userSeat, uint8 seatCount, uint8 dieA, uint8 dieB, uint8[16] memory steps) internal pure returns (bytes memory s) {
        s = new bytes(36);
        s[0] = bytes1(turn);
        s[1] = bytes1(finishCount);
        s[2] = bytes1(userSeat);
        s[3] = bytes1(seatCount);
        s[4] = bytes1(dieA);
        s[5] = bytes1(dieB);
        for (uint256 i = 0; i < 16; i++) s[8 + i] = bytes1(steps[i]);
    }

    function _yard() internal pure returns (uint8[16] memory s) {
        for (uint256 i = 0; i < 16; i++) s[i] = YARD;
    }

    function _seeds(uint256 a, uint256 b) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](2);
        s[0] = bytes32(a);
        s[1] = bytes32(b);
    }

    function testInitialAndRoll() public {
        bytes memory init = ludo.getInitialState(2, 0);
        bytes memory rolled = ludo.applyMove(init, 0, 0, 0, 0, _seeds(0, 5)); // dice 1 and 6
        (uint8 turn, , , , , , , uint8 dieA, uint8 dieB) = ludo.decodeState(rolled);
        require(turn == 0, "seat 0 still to move");
        require(dieA == 1 && dieB == 6, "dice 1 and 6");
    }

    function testYardNeedsSix() public {
        uint8[16] memory st = _yard();
        bytes memory s = _build(0, 0, 0, 2, 6, 1, st);
        vm.expectRevert(FoskaayGGILudo.YardNeedsSix.selector);
        ludo.applyMove(s, 1, 0, 0, 1, _seeds(0, 0));
    }

    function testCaptureSendsOpponentHomeAndExits() public {
        uint8[16] memory st = _yard();
        st[0] = 4;   // seat 0, token 0 at common 4
        st[4] = 44;  // seat 1, token 0: abs (13 + 44) % 52 = 5
        bytes memory s = _build(0, 0, 0, 2, 1, 0, st);
        bytes memory n = ludo.applyMove(s, 1, 0, 0, 1, _seeds(0, 0)); // 4 -> 5, lands on seat 1
        (, , , , int16[16] memory steps, , , , ) = ludo.decodeState(n);
        require(steps[0] == 57, "capturer exits the board");
        require(steps[4] == -1, "opponent sent home");
    }

    function testSafeStartCellNoCapture() public {
        uint8[16] memory st = _yard();
        st[0] = 12;  // seat 0 at 12; moving 1 lands on abs 13 (seat 1 start = safe)
        st[4] = 0;   // seat 1 token at abs 13
        bytes memory s = _build(0, 0, 0, 2, 1, 0, st);
        bytes memory n = ludo.applyMove(s, 1, 0, 0, 1, _seeds(0, 0));
        (, , , , int16[16] memory steps, , , , ) = ludo.decodeState(n);
        require(steps[0] == 13, "no capture on a start cell");
        require(steps[4] == 0, "opponent stays on the safe cell");
    }

    function testFinishRecordsPoints() public {
        uint8[16] memory st = _yard();
        st[0] = 57; st[1] = 57; st[2] = 57; st[3] = 56; // seat 0 needs this last step
        bytes memory s = _build(0, 0, 0, 2, 1, 0, st);  // userSeat 0, 2 seats
        bytes memory n = ludo.applyMove(s, 1, 0, 3, 1, _seeds(0, 0));
        (uint8 turn, uint8 finishCount, , , , uint8[4] memory order, uint16[4] memory points, , ) = ludo.decodeState(n);
        require(finishCount == 1, "one finisher");
        require(order[0] == 0, "seat 0 first");
        require(points[0] == 100, "1st place = 100 points inside the midchain");
        (bool finished, uint8 winner) = ludo.isTerminal(n);
        require(finished && winner == 0, "2-seat match ends on first finish");
        turn; // silence
    }

    function testPassAdvancesTurnAndBonusKeepsTurn() public {
        uint8[16] memory st = _yard();
        st[0] = 5; st[4] = 5;
        // normal pass: turn 0 -> 1
        bytes memory s = _build(0, 0, 0, 2, 0, 0, st);
        bytes memory p = ludo.applyMove(s, 2, 0, 0, 0, _seeds(0, 0));
        (uint8 t1, , , , , , , , ) = ludo.decodeState(p);
        require(t1 == 1, "pass advances to seat 1");
        // bonus (double six) keeps the seat
        bytes memory b = _build(0, 0, 0, 2, 0, 0, st);
        bytes memory rb = ludo.applyMove(b, 0, 0, 0, 0, _seeds(5, 5)); // 6 and 6
        bytes memory pb = ludo.applyMove(rb, 2, 0, 0, 0, _seeds(0, 0));
        (uint8 t2, , , , , , , , ) = ludo.decodeState(pb);
        require(t2 == 0, "bonus roll keeps the seat");
    }

    function testNotYourTurnReverts() public {
        bytes memory init = ludo.getInitialState(2, 0);
        vm.expectRevert(FoskaayGGILudo.NotYourTurn.selector);
        ludo.applyMove(init, 0, 1, 0, 0, _seeds(0, 0));
    }

    function testHashTracksState() public {
        bytes memory init = ludo.getInitialState(2, 0);
        bytes memory rolled = ludo.applyMove(init, 0, 0, 0, 0, _seeds(0, 0));
        require(ludo.hashState(init) != ludo.hashState(rolled), "hash changes with state");
    }
}
