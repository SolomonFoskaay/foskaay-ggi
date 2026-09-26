// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Randomness — arcv2m16 (EVM rail, Phase 0).
///
/// Arc has no on-chain randomness (PREVRANDAO returns 0), so we bring our own:
/// commit ONE seed hash per batch, reveal it later, and derive every game roll
/// from it. Rolls therefore cost nothing extra and are publicly verifiable.
/// The commit binds the caller before any move is seen, so outcomes cannot be
/// adapted after the fact.
contract Randomness {
    mapping(bytes32 => bytes32) public commitOf; // batchId => keccak256(seed)
    mapping(bytes32 => bytes32) public seedOf;   // batchId => revealed seed

    event SeedCommitted(bytes32 indexed batchId, bytes32 seedHash);
    event SeedRevealed(bytes32 indexed batchId, bytes32 seed);

    function commitSeed(bytes32 batchId, bytes32 seedHash) external {
        require(batchId != bytes32(0), "batch");
        require(seedHash != bytes32(0), "hash");
        require(commitOf[batchId] == bytes32(0), "committed");
        commitOf[batchId] = seedHash;
        emit SeedCommitted(batchId, seedHash);
    }

    function revealSeed(bytes32 batchId, bytes32 seed) external {
        require(commitOf[batchId] != bytes32(0), "no commit");
        require(seedOf[batchId] == bytes32(0), "revealed");
        require(keccak256(abi.encodePacked(seed)) == commitOf[batchId], "mismatch");
        seedOf[batchId] = seed;
        emit SeedRevealed(batchId, seed);
    }

    /// A provable roll: 1..sides. Same inputs always give the same result.
    function roll(bytes32 batchId, bytes32 gameId, uint32 counter, uint8 sides) external view returns (uint8) {
        bytes32 seed = seedOf[batchId];
        require(seed != bytes32(0), "not revealed");
        require(sides > 1, "sides");
        uint256 r = uint256(keccak256(abi.encode(seed, gameId, counter)));
        // casting to uint8 is safe: sides is uint8, so r % sides < 256.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(r % sides) + 1;
    }
}
