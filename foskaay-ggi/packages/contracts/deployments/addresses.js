// @foskaay/ggi-contracts-sdk — deployed addresses, testnet + mainnet.
//
// This is the runtime source. addresses.json holds the same values for tooling
// that prefers JSON; keep the two in sync (addresses.json is the canonical copy
// written by the deploy script).
//
// Note: the data is declared as a plain object (not a JSON import) so it works
// in every bundler and Node version without import-assertion syntax.

export const addresses = {
  note: 'PUBLIC deployed addresses for Foskaay Gasless Games Infrastructure (Foskaay GGI). Addresses and endpoints only, safe to serve. Never put secrets here.',
  testnet: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    usdcDecimalsNative: 18,
    usdcDecimalsErc20: 6,
    contracts: {
      FoskaayGGI: '0x793785CE66992211B7c60dFCf0318869678D33a4',
      FoskaayGGIGames: '0x24e38ac2e80958782a8Bc5CD479bbe2e5D81EcDF',
      FoskaayGGIPlayers: '0x1614ebc72eA1cB3D31975b3976B5B474FAcE3b3C',
      FoskaayGGILudo: '0xa5040Ece5945a8551499ad1148fc3cD15b165987',
    },
    feeNative: '400000000000000',
    feeBase: '400000000000000',
    feePerAccount: '400000000000000',
    feePerGame: '200000000000000',
    upgradeable: true,
    pattern: 'UUPS proxies (ERC1967). These addresses are permanent: an upgrade swaps the logic behind them and never moves the address or strands data.',
    deployedAt: '2026-09-25',
  },
  mainnet: {
    name: 'Arc Mainnet',
    chainId: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    usdcDecimalsNative: 18,
    usdcDecimalsErc20: 6,
    contracts: {
      FoskaayGGI: null,
      FoskaayGGIGames: null,
      FoskaayGGIPlayers: null,
    },
    deployedAt: null,
    note: 'Not deployed yet. Testnet first. Addresses appear here in the same format once deployed.',
  },
};

export default addresses;
