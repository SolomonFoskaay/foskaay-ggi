// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Randomness} from "../src/Randomness.sol";

interface Vm2 {
    function expectRevert() external;
}

contract RandomnessTest {
    Vm2 constant vm = Vm2(address(uint160(uint256(keccak256("hevm cheat code")))));
    Randomness rnd;
    bytes32 constant B = keccak256("batch-1");
    bytes32 constant GAME = keccak256("game-1");

    function setUp() public {
        rnd = new Randomness();
    }

    function testCommitRevealRollDeterministic() public {
        bytes32 seed = keccak256("server-secret-seed");
        rnd.commitSeed(B, keccak256(abi.encodePacked(seed)));
        // cannot roll before reveal
        vm.expectRevert();
        rnd.roll(B, GAME, 0, 6);

        rnd.revealSeed(B, seed);
        require(rnd.seedOf(B) == seed, "seed");

        uint8 a = rnd.roll(B, GAME, 0, 6);
        uint8 b = rnd.roll(B, GAME, 0, 6);
        require(a == b, "deterministic");
        require(a >= 1 && a <= 6, "range");

        uint256 expected = uint256(keccak256(abi.encode(seed, GAME, uint32(0)))) % 6 + 1;
        require(a == uint8(expected), "matches derived value");

        // different counter -> (very likely) a different roll value path
        uint8 c = rnd.roll(B, GAME, 1, 6);
        require(c >= 1 && c <= 6, "range 2");
    }

    function testRevealWrongSeedReverts() public {
        bytes32 seed = keccak256("seed");
        rnd.commitSeed(B, keccak256(abi.encodePacked(seed)));
        vm.expectRevert();
        rnd.revealSeed(B, keccak256("other"));
    }

    function testDoubleCommitReverts() public {
        rnd.commitSeed(B, keccak256("a"));
        vm.expectRevert();
        rnd.commitSeed(B, keccak256("b"));
    }

    function testDoubleRevealReverts() public {
        bytes32 seed = keccak256("seed");
        rnd.commitSeed(B, keccak256(abi.encodePacked(seed)));
        rnd.revealSeed(B, seed);
        vm.expectRevert();
        rnd.revealSeed(B, seed);
    }

    function testRevealWithoutCommitReverts() public {
        vm.expectRevert();
        rnd.revealSeed(B, keccak256("seed"));
    }
}
