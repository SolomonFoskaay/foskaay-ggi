// foskaay-ggi/deployments/addresses.mjs
//
// SINGLE SOURCE OF TRUTH for the PUBLIC, NON-SECRET Foskaay GGI addresses and
// Arc network facts. Edit HERE, never in Vercel env, so changing an address
// never needs a dashboard edit. The relay imports it; the frontend reads the
// published copy in packages/contracts/deployments.
//
// NEVER put a secret (private key, API token, RPC with a key) in this file.

export const NETWORKS = {
  testnet: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    contracts: {
      FoskaayGGI: '0x793785CE66992211B7c60dFCf0318869678D33a4',
      FoskaayGGIGames: '0x24e38ac2e80958782a8Bc5CD479bbe2e5D81EcDF',
      FoskaayGGIPlayers: '0x1614ebc72eA1cB3D31975b3976B5B474FAcE3b3C',
      FoskaayGGILudo: '0xa5040Ece5945a8551499ad1148fc3cD15b165987',
    },
  },
  mainnet: {
    name: 'Arc Mainnet',
    chainId: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    contracts: {
      FoskaayGGI: '0xb406295b4F7E5B513b656122AfFF29AF720E9E23',
      FoskaayGGIGames: '0xb2d5DfF81B076948f50dA2CcF01887f5ed6Ae2b2',
      FoskaayGGIPlayers: '0x9425c1d6bA7923D5C804c5e549E08629AbBe3165',
      FoskaayGGILudo: null,
    },
  },
};

// Back-compat defaults (testnet).
export const ADDRESSES = NETWORKS.testnet.contracts;
export const ARC = NETWORKS.testnet;

export default { NETWORKS, ADDRESSES, ARC };