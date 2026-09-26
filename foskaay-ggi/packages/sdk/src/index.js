// @foskaay/ggi-sdk — Foskaay Gasless Games Infrastructure (Foskaay GGI) client.
//
// WHAT THIS IS: the one-line integration that makes any on-chain game gasless.
// The game CONNECTS a session (one transaction, the per-session fee is paid
// there), plays inside for free (signed moves, no chain writes, no wallet
// popups), and SETTLES ONCE. See /foskaay-ggi/docs for the full story.
//
// THE CALLS: handover, signMove, settle, plus free randomness and read helpers.
// Nothing here is opinionated: the rail never learns your game.
//
// DESIGN NOTES:
//   - `viem` is a peer dependency, so this package stays tiny.
//   - The fee is READ FROM CHAIN at runtime (`fee()`), never hardcoded.
//   - `signMove()` signs the exact digest the registry checks (OpenZeppelin
//     ECDSA on-chain), so a move cannot be forged or replayed elsewhere.
//   - `random()`/`randomN()` are the registry's PURE functions, read via
//     eth_call, so randomness costs nothing.

import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  getAddress,
  recoverAddress,
} from 'viem';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Addresses come from the PUBLISHED dependency @foskaay/ggi-contracts-sdk, not a
// relative repo path, so the SDK is self-contained once installed.
import ggiContracts from '@foskaay/ggi-contracts-sdk';

const registryAbi = parseAbi([
  'function handover(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount) payable',
  'function handoverMany(bytes32[] sessionIds, address gameLogic, bytes32[] startHashes, bytes32[] seedCommits, address[][] players, address[][] sessionKeys, uint16 randomCount) payable',
  'function handoverWithAccounts(bytes32 sessionId, address gameLogic, bytes32 startHash, bytes32 seedCommit, address[] players, address[] sessionKeys, uint16 randomCount, address[] accounts, uint16 games) payable',
  'function settle(bytes32 sessionId, bytes32 finalHash, bytes32 seedReveal, address[] players, address[] sessionKeys, bytes[] sigs, address[] signers)',
  'function settleMany(bytes32[] sessionIds, bytes32[] finalHashes, bytes32[] seedReveals, address[][] players, address[][] sessionKeys, bytes[][] sigs, address[][] signers)',
  'function midchainDigest(bytes32 sessionId, bytes32 finalHash) view returns (bytes32)',
  'function random(bytes32 seed, uint256 counter) pure returns (bytes32)',
  'function randomN(bytes32 seed, uint256 counter, uint256 count) pure returns (bytes32[])',
  'function fee() view returns (uint256)',
  'function feeBase() view returns (uint256)',
  'function feePerAccount() view returns (uint256)',
  'function feePerGame() view returns (uint256)',
  'function destination() view returns (address)',
  'function isPaid(bytes32 sessionId) view returns (bool)',
]);

// ---------------------------------------------------------------- helpers

function networkConfig(network) {
  const net = ggiContracts.all[network];
  if (!net) throw new Error('Foskaay GGI: unknown network "' + network + '". Use "testnet" or "mainnet".');
  return net;
}

function makeChain(net) {
  return defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } },
  });
}

export class GgiClient {
  constructor(opts = {}) {
    const network = opts.network || 'testnet';
    const net = networkConfig(network);
    this.network = network;
    this.chain = makeChain(net);
    this.addresses = {
      FoskaayGGI: net.contracts.FoskaayGGI,
      Ludo: net.contracts.FoskaayGGILudo,
    };
    this.deployed = Boolean(this.addresses.FoskaayGGI);
    this.publicClient = opts.publicClient || createPublicClient({ chain: this.chain, transport: http(net.rpc) });
    this.walletClient = opts.walletClient || null;
  }

  requireWallet() {
    if (!this.walletClient) throw new Error('Foskaay GGI: a walletClient is required for write calls.');
    if (!this.deployed) throw new Error('Foskaay GGI: contracts are not deployed on ' + this.network + ' yet.');
    return this.walletClient.account.address;
  }

  // ---------------------------------------------------------------- writes

  /// The current per-session fee, in native USDC base units (18 decimals on Arc).
  async fee() {
    if (!this.addresses.FoskaayGGI) return 0n;
    return this.publicClient.readContract({ address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'fee' });
  }

  async feeBase() {
    if (!this.addresses.FoskaayGGI) return 0n;
    return this.publicClient.readContract({ address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'feeBase' });
  }

  async feePerAccount() {
    if (!this.addresses.FoskaayGGI) return 0n;
    return this.publicClient.readContract({ address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'feePerAccount' });
  }

  async feePerGame() {
    if (!this.addresses.FoskaayGGI) return 0n;
    return this.publicClient.readContract({ address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'feePerGame' });
  }

  /// The exact session fee for a declared account count and game count, read live
  /// from the core (never hardcoded).
  async sessionFee(accountsCount, games) {
    const [base, perAccount, perGame] = await Promise.all([this.feeBase(), this.feePerAccount(), this.feePerGame()]);
    return base + perAccount * BigInt(accountsCount) + perGame * BigInt(games);
  }

  /// CONNECT one session and pay the fee in the same transaction. `cfg` =
  /// { sessionId, gameLogic, startHash, seedCommit, players[], sessionKeys[], randomCount }.
  async handover(cfg = {}) {
    const owner = this.requireWallet();
    const value = await this.fee();
    return this.walletClient.writeContract({
      address: this.addresses.FoskaayGGI,
      abi: registryAbi,
      functionName: 'handover',
      args: [
        cfg.sessionId,
        cfg.gameLogic,
        cfg.startHash,
        cfg.seedCommit || ('0x' + '00'.repeat(32)),
        cfg.players,
        cfg.sessionKeys,
        cfg.randomCount || 0,
      ],
      value,
      account: this.walletClient.account,
    });
  }

  /// CONNECT many sessions in ONE transaction. `msg.value` = fee x count.
  async handoverMany(cfg = {}) {
    this.requireWallet();
    const value = (await this.fee()) * BigInt(cfg.sessionIds.length);
    return this.walletClient.writeContract({
      address: this.addresses.FoskaayGGI,
      abi: registryAbi,
      functionName: 'handoverMany',
      args: [
        cfg.sessionIds,
        cfg.gameLogic,
        cfg.startHashes,
        cfg.seedCommits || cfg.sessionIds.map(() => '0x' + '00'.repeat(32)),
        cfg.players,
        cfg.sessionKeys,
        cfg.randomCount || 0,
      ],
      value,
      account: this.walletClient.account,
    });
  }

  /// CONNECT one session and pay the 3-part fee in the same transaction, recording
  /// the DEV-declared accounts (ANY count) and the number of games. `cfg` adds
  /// { accounts[], games } to the `handover` config. Value =
  /// feeBase + feePerAccount * accounts.length + feePerGame * games.
  async handoverWithAccounts(cfg = {}) {
    this.requireWallet();
    const accounts = cfg.accounts || [];
    const games = BigInt(cfg.games || 0);
    const [base, perAccount, perGame] = await Promise.all([this.feeBase(), this.feePerAccount(), this.feePerGame()]);
    const value = base + perAccount * BigInt(accounts.length) + perGame * games;
    return this.walletClient.writeContract({
      address: this.addresses.FoskaayGGI,
      abi: registryAbi,
      functionName: 'handoverWithAccounts',
      args: [
        cfg.sessionId,
        cfg.gameLogic,
        cfg.startHash,
        cfg.seedCommit || ('0x' + '00'.repeat(32)),
        cfg.players,
        cfg.sessionKeys,
        cfg.randomCount || 0,
        accounts,
        Number(games),
      ],
      value,
      account: this.walletClient.account,
    });
  }

  /// SETTLE one session. `cfg` = { sessionId, finalHash, seedReveal, players[],
  /// sessionKeys[], sigs[], signers[] }. `finalHash` may be one game's final hash
  /// or a session root. The players/sessionKeys must match the connect.
  async settle(cfg = {}) {
    this.requireWallet();
    return this.walletClient.writeContract({
      address: this.addresses.FoskaayGGI,
      abi: registryAbi,
      functionName: 'settle',
      args: [cfg.sessionId, cfg.finalHash, cfg.seedReveal || ('0x' + '00'.repeat(32)), cfg.players, cfg.sessionKeys, cfg.sigs, cfg.signers],
      account: this.walletClient.account,
    });
  }

  /// SETTLE many sessions in ONE transaction.
  async settleMany(cfg = {}) {
    this.requireWallet();
    return this.walletClient.writeContract({
      address: this.addresses.FoskaayGGI,
      abi: registryAbi,
      functionName: 'settleMany',
      args: [
        cfg.sessionIds,
        cfg.finalHashes,
        cfg.seedReveals || cfg.sessionIds.map(() => '0x' + '00'.repeat(32)),
        cfg.players,
        cfg.sessionKeys,
        cfg.sigs,
        cfg.signers,
      ],
      account: this.walletClient.account,
    });
  }

  // --------------------------------------------------------------- signing

  /// Create a fresh ephemeral session keypair. Keep the private key in memory
  /// only, and use it to sign each move silently (no wallet popup per move).
  createSessionKey() {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    return { privateKey, address: account.address, account };
  }

  /// The exact digest a participant signs to authorise a settlement.
  async midchainDigest(sessionId, finalHash) {
    return this.publicClient.readContract({
      address: this.addresses.FoskaayGGI,
      abi: registryAbi,
      functionName: 'midchainDigest',
      args: [sessionId, finalHash],
    });
  }

  /// Sign a move's final hash with a session key, silently. `key` is the object
  /// from createSessionKey() or a raw private key.
  async signMove(key, sessionId, finalHash) {
    const pk = typeof key === 'string' ? key : key && key.privateKey;
    if (!pk) throw new Error('Foskaay GGI: signMove needs a session key from createSessionKey().');
    const digest = await this.midchainDigest(sessionId, finalHash);
    return privateKeyToAccount(pk).sign({ hash: digest });
  }

  /// Verify a move signature recovers to the expected signer.
  async verifyMove(sessionId, finalHash, signature, expectedSigner) {
    const digest = await this.midchainDigest(sessionId, finalHash);
    const got = await recoverAddress({ hash: digest, signature });
    return got.toLowerCase() === getAddress(expectedSigner).toLowerCase();
  }

  // ------------------------------------------------------------- randomness

  /// One free random seed: keccak(seed, counter), via eth_call. Costs nothing.
  async random(seed, counter) {
    return this.publicClient.readContract({
      address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'random', args: [seed, BigInt(counter)],
    });
  }

  /// N free random seeds in one call.
  async randomN(seed, counter, count) {
    return this.publicClient.readContract({
      address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'randomN', args: [seed, BigInt(counter), BigInt(count)],
    });
  }

  // ---------------------------------------------------------------- reads

  /// Whether a session was paid at connect (the registry checks this to settle).
  async isPaid(sessionId) {
    return this.publicClient.readContract({
      address: this.addresses.FoskaayGGI, abi: registryAbi, functionName: 'isPaid', args: [sessionId],
    });
  }
}

export default GgiClient;
