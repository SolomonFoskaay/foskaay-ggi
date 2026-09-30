// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GFGMerged} from "../gfgnew/board/ludo-mp/GFGMerged.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface VmM {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
}

/// Merged variant tests: identical rules + timer, ledger written internally.
contract GFGMergedTest {
    VmM constant vm = VmM(address(uint160(uint256(keccak256("hevm cheat code")))));

    GFGMerged games;
    bytes32 constant TAG = keccak256("ludo-mp");

    function setUp() public {
        GFGMerged impl = new GFGMerged();
        address proxy = address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(GFGMerged.initialize, (address(this)))
        ));
        games = GFGMerged(proxy);
        games.setTurnSecs(45);
        games.setMaxMatchSecs(3600);
    }

    function testSettleCreditsInternallyNoExternalCall() public {
        vm.warp(1000000);
        bytes memory s0 = games.getInitialState(2, 0);
        GFGMerged.Game[] memory list = new GFGMerged.Game[](1);
        list[0].turn = 0;
        list[0].seats = 2;
        list[0].step = 1;
        list[0].board = s0;
        list[0].boardHash = games.hashState(s0);
        list[0].over = false;
        address[] memory seats = new address[](2);
        seats[0] = address(0xA11CE);
        seats[1] = address(0xB0B);
        uint64[] memory tss = new uint64[](2);
        tss[0] = 999990;
        tss[1] = 1000000;
        // Points come from board bytes only, so a fresh board credits nothing.
        // The assertion that matters: settle succeeds with NO player contract.
        uint256 credited = games.settle(bytes32("m1"), list, seats, TAG, tss);
        require(credited == 0, "no points on fresh board");
        require(games.gameCount(bytes32("m1")) == 1, "committed");
        require(games.pointsOf(address(0xA11CE), TAG) == 0, "ledger readable");
    }

    function testTimerHelpersMatchSplit() public view {
        require(games.turnSecs() == 45, "turnSecs");
        require(games.turnDeadline(1000) == 1045, "deadline");
        require(games.isTurnExpired(1000, 1045), "expired");
    }

    function testOnlyOwnerGuards() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        games.setTurnSecs(30);
    }
}
