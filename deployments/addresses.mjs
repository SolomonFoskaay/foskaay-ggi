// foskaay-ggi/deployments/addresses.mjs
//
// SINGLE SOURCE OF TRUTH for the PUBLIC, NON-SECRET Foskaay GGI addresses and
// Arc network facts. Edit HERE, never in Vercel env, so changing an address
// never needs a dashboard edit. The relay imports it; the frontend reads the
// published copy in packages/contracts/deployments.
//
// NEVER put a secret (private key, API token, RPC with a key) in this file.

export const ADDRESSES = {
  // Arc testnet, permanent UUPS proxies.
  FoskaayGGI: '0x793785CE66992211B7c60dFCf0318869678D33a4',
  FoskaayGGIGames: '0x24e38ac2e80958782a8Bc5CD479bbe2e5D81EcDF',
  FoskaayGGIPlayers: '0x1614ebc72eA1cB3D31975b3976B5B474FAcE3b3C',
  // Legacy pure-rules demo game (superseded by FoskaayGGIGames).
  FoskaayGGILudo: '0xa5040Ece5945a8551499ad1148fc3cD15b165987',
};

export const ARC = {
  name: 'Arc Testnet',
  chainId: 5042002,
  rpc: 'https://rpc.testnet.arc.io',
  explorer: 'https://explorer.testnet.arc.io',
  usdc: '0x3600000000000000000000000000000000000000',
};

export default { ADDRESSES, ARC };
