// scripts/arc-merkle.mjs — the Merkle tree behind GlobalFolkGames Batched
// Settlement (GFG-BS). Games are leaves; one root goes on-chain per window and
// each game can prove itself against that root.
//
// Leaf = keccak256(encodePacked(gameId, resultHash, points, player))
// Root = keccak256 of the sorted pair-hash chain (odd node carried up).
import { keccak256, encodePacked, getAddress } from 'viem';

export function leafOf({ gameId, resultHash, points, player }) {
  return keccak256(encodePacked(
    ['bytes32', 'bytes32', 'uint256', 'address'],
    [gameId, resultHash, BigInt(points || 0), getAddress(player)]
  ));
}

function hashPair(a, b) {
  // sort so order never matters
  return BigInt(a) < BigInt(b)
    ? keccak256(encodePacked(['bytes32', 'bytes32'], [a, b]))
    : keccak256(encodePacked(['bytes32', 'bytes32'], [b, a]));
}

/// Build the tree. Returns { root, layers, proofs: Map<leaf, proof[]> }.
export function buildTree(leaves) {
  if (!leaves.length) return { root: null, layers: [], proofs: new Map() };
  let layer = leaves.slice();
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) next.push(hashPair(layer[i], layer[i + 1]));
      else next.push(layer[i]);
    }
    layers.push(next);
    layer = next;
  }
  const root = layer[0];
  const proofs = new Map();
  leaves.forEach((leaf, idx) => {
    const proof = [];
    let i = idx;
    for (let l = 0; l < layers.length - 1; l++) {
      const pair = i % 2 === 0 ? i + 1 : i - 1;
      if (pair < layers[l].length) proof.push(layers[l][pair]);
      i = Math.floor(i / 2);
    }
    proofs.set(leaf, proof);
  });
  return { root, layers, proofs };
}

export function verifyProof(leaf, proof, root) {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h === root;
}
