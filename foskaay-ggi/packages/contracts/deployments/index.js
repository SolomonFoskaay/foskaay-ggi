// @foskaay/ggi-contracts-sdk — deployed addresses, testnet + mainnet.
//
// Usage (ESM):
//   import ggiContracts from '@foskaay/ggi-contracts-sdk';
//   ggiContracts.testnet.contracts.FoskaayGGI;
//   ggiContracts.forChain(5042002).name;
//
// Usage (CommonJS):
//   const ggiContracts = require('@foskaay/ggi-contracts-sdk');
//
// The addresses live in addresses.js, the single runtime source. addresses.json
// holds the same values for non-JS tooling; the deploy script writes both.

import { addresses } from './addresses.js';

function forChain(chainId) {
  const id = Number(chainId);
  if (id === addresses.testnet.chainId) return addresses.testnet;
  if (id === addresses.mainnet.chainId) return addresses.mainnet;
  throw new Error('Foskaay GGI: no deployment for chain id ' + id);
}

function isDeployed(chainId, contractName) {
  try {
    const net = forChain(chainId);
    return Boolean(net.contracts[contractName]);
  } catch (_) {
    return false;
  }
}

const api = {
  all: addresses,
  testnet: addresses.testnet,
  mainnet: addresses.mainnet,
  forChain,
  isDeployed,
};

export default api;
export { addresses, forChain, isDeployed };
export const testnet = addresses.testnet;
export const mainnet = addresses.mainnet;
