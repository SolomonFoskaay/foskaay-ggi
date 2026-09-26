// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MatchSettlement} from "../src/MatchSettlement.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
}

/// The off-chain engine signs keccak256(abi.encodePacked(gameId, moveDigest,
/// resultHash, moveCount)) with an ethereum-prefixed personal_sign, matching
/// MatchSettlement._recover. These tests use real keys so the signature path is
/// proved, not mocked.
contract MatchSettlementTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MatchSettlement ms;
    uint256 constant PK1 = 0xA11CE;
    uint256 constant PK2 = 0xB0B;
    address p1;
    address p2;
    bytes32 constant GAME = keccak256("gfg-match-1");

    function setUp() public {
        p1 = vm.addr(PK1);
        p2 = vm.addr(PK2);
        ms = new MatchSettlement(address(0xFEED)); // relayer address (unused for sigs)
    }

    function _h(bytes32 gameId, bytes32 moveDigest, bytes32 resultHash, uint32 moveCount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(gameId, moveDigest, resultHash, moveCount));
    }
    function _eth(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function testStartCommitThenCoSignedSettle() public {
        bytes32 commit = keccak256("start-state");
        ms.commitStart(GAME, p1, p2, 0, 2, commit, 600);
        (address a1, address a2, bytes32 ch, , , , uint64 deadline, , uint16 tag, uint8 seats, bool settled, ) = ms.matchOf(GAME);
        require(a1 == p1 && a2 == p2, "players");
        require(ch == commit, "commit");
        require(tag == 0 && seats == 2 && !settled, "fresh");
        require(deadline > block.timestamp, "clock");

        bytes32 moveDigest = keccak256("move-log-digest");
        bytes32 resultHash = keccak256("result");
        uint32 moveCount = 60;
        bytes32 h = _eth(_h(GAME, moveDigest, resultHash, moveCount));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK2, h);

        ms.settle(GAME, moveDigest, resultHash, moveCount, v1, r1, s1, v2, r2, s2);
        (,, , bytes32 md, bytes32 rh, , , uint32 mc, , , bool ok, ) = ms.matchOf(GAME);
        require(ok && md == moveDigest && rh == resultHash && mc == moveCount, "settled");
    }

    function testSettleRejectsOneSignatureOnly() public {
        ms.commitStart(GAME, p1, p2, 0, 2, keccak256("c"), 600);
        bytes32 moveDigest = keccak256("m");
        bytes32 resultHash = keccak256("r");
        uint32 mc = 10;
        bytes32 h = _eth(_h(GAME, moveDigest, resultHash, mc));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK2, h);
        // Player two's slot filled with player one's signature: must fail (no forgery by one side).
        vm.expectRevert();
        ms.settle(GAME, moveDigest, resultHash, mc, v1, r1, s1, v1, r1, s1);
        // Correct pair still works after the rejected attempt.
        ms.settle(GAME, moveDigest, resultHash, mc, v1, r1, s1, v2, r2, s2);
    }

    function testSettleRejectsTamperedDigest() public {
        ms.commitStart(GAME, p1, p2, 0, 2, keccak256("c"), 600);
        bytes32 moveDigest = keccak256("m");
        bytes32 resultHash = keccak256("r");
        uint32 mc = 10;
        bytes32 h = _eth(_h(GAME, moveDigest, resultHash, mc));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK2, h);
        // Someone swaps in a different result after signing: signatures no longer match.
        vm.expectRevert();
        ms.settle(GAME, moveDigest, keccak256("tampered-result"), mc, v1, r1, s1, v2, r2, s2);
    }

    function testCannotSettleTwiceOrUnknownMatch() public {
        bytes32 unknown = keccak256("nope");
        vm.expectRevert();
        ms.claimTimeout(unknown);

        ms.commitStart(GAME, p1, p2, 0, 2, keccak256("c"), 600);
        vm.expectRevert();
        ms.commitStart(GAME, p1, p2, 0, 2, keccak256("c2"), 600); // exists

        bytes32 md = keccak256("m");
        bytes32 rh = keccak256("r");
        uint32 mc = 1;
        bytes32 h = _eth(_h(GAME, md, rh, mc));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK1, h);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK2, h);
        ms.settle(GAME, md, rh, mc, v1, r1, s1, v2, r2, s2);
        vm.expectRevert();
        ms.settle(GAME, md, rh, mc, v1, r1, s1, v2, r2, s2); // already settled
    }

    function testDisputeFlagsMatch() public {
        ms.commitStart(GAME, p1, p2, 1, 2, keccak256("c"), 600);
        vm.prank(p1);
        ms.dispute(GAME, keccak256("revealed-log"));
        (,,,,,, , , , , , bool disputed) = ms.matchOf(GAME);
        require(disputed, "disputed");
        // A stranger cannot dispute.
        vm.expectRevert();
        ms.dispute(GAME, keccak256("x"));
    }

    function testTimeoutOnlyAfterDeadline() public {
        ms.commitStart(GAME, p1, p2, 0, 2, keccak256("c"), 10);
        vm.prank(p1);
        vm.expectRevert(); // too soon
        ms.claimTimeout(GAME);
        vm.warp(block.timestamp + 11);
        vm.prank(p2);
        ms.claimTimeout(GAME);
        (,,,,, , , , , , bool settled, ) = ms.matchOf(GAME);
        require(settled, "settled by clock");
    }
}
