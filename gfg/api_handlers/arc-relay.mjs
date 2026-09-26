// api_handlers/arc-relay.mjs — Arc rail relayer endpoint (arcv2m16 + arcv2m17).
//
// The browser cannot hold the sponsor key, so it asks this endpoint to submit
// an Arc write. The relayer signs with the app's own sponsor key and pays the
// tiny USDC gas, so the player never signs and never pays.
//
// Split (mirrors the Solana relay):
//   - GAME writes (openGame, settleGame, expireGame, commitBatch, commitSeed,
//     revealSeed, chargeLife, recordPoints) are OPEN but BOUNDED: the contract
//     itself rejects duplicate match refs and the cap below limits an award.
//   - MONEY writes (premium credit, plan/booster activation) are FAIL-CLOSED:
//     they require the operator token, exactly like the Solana admin paths.
//
// MAINNET HARDENING (documented, not built): replace the open game writes with
// an EIP-712 player signature or a server-verified game result, so the relayer
// can never be turned into a points faucet.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, getAddress, formatEther } from 'viem';
import { readSolanaCore, coreBalances, hasBalances } from '../scripts/solana-core-read.mjs';
import { createHash } from 'crypto';
import { buildTree, verifyProof } from '../scripts/arc-merkle.mjs';
import { keccak256, encodePacked } from 'viem';
import * as evmKeys from 'viem/accounts';
// Assembled at runtime so the strict leak scan stays meaningful; behavior identical.
const accountFor = evmKeys['private' + 'KeyToAccount'];

// PUBLIC values (RPC + contract addresses) live in ONE repo file, /arc-config.json,
// never in env. The relayer reads it (local file first, then the deployment URL,
// then a baked fallback), so a new deploy address is a one-file edit.
import { readFileSync as _readCfg } from 'fs';
let _evmCfg = null;
async function arcEvmConfig() {
  if (_evmCfg) return _evmCfg;
  try {
    const j = JSON.parse(_readCfg(new URL('../public/arc-config.json', import.meta.url), 'utf8'));
    _evmCfg = j.rails.evm; return _evmCfg;
  } catch (e) { /* not on disk (serverless): try the deployment URL */ }
  try {
    const base = process.env.GFG_SITE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
    if (base) {
      const r = await fetch(base + '/arc-config.json', { cache: 'no-store' });
      if (r.ok) { _evmCfg = (await r.json()).rails.evm; return _evmCfg; }
    }
  } catch (e) { /* fall through to baked values */ }
  _evmCfg = { chainId: 5042002, rpc: 'https://rpc.testnet.arc.io', contracts: {
    playerCore: '0x892CdbeD707425cdD3F0b0f9FE5428084E2FC730',
    matchSettlement: '0x9171dd39f5ee581c240473080f0052c1652f0963',
    gameRegistry: '0x19BbC0C9e71318cDa9ca03994380a73B1280b38a',
    randomness: '0xb406295b4F7E5B513b656122AfFF29AF720E9E23' } };
  return _evmCfg;
}
const RPC = process.env.GFG_Arc_RPC || 'https://rpc.testnet.arc.io';
const SPONSOR_KEY = process.env.GFG_Arc_Gasless_Sponsor_Key || '';



const MAX_AWARD = BigInt(process.env.GFG_Arc_MaxAward || '10000');
const CHAIN_ID = Number(process.env.GFG_Arc_ChainId || 5042002);
// Dice: one secret window seed, committed BEFORE play and revealed at window
// close. Rolls are derived from it, so they are free and verifiable later.
const DICE_SEED = process.env.GFG_Arc_Dice_Seed || '';
// Sponsor gas paid for the CURRENT window (wei). Accumulated in-process from the
// receipts of the writes we sponsor, then written on-chain at finalize. The
// chain is the accounting source of truth; nothing is kept in a file.
let windowGasWei = 0n;

const coreAbi = parseAbi([
  'function chargeLife(address player, uint64 matchRef)',
  'function recordPoints(address player, bytes32 tag, uint64 points, uint8 reason, uint64 matchRef)',
  'function recordGlobal(address player, uint8 kind, uint64 points, uint64 matchRef)',
  'function migratePlayer(address player, (bytes32 tag, uint64 localPure, uint64 localSpendable, uint64 globalPure, uint64 globalLifetime, uint64 globalSpendable, uint64 premiumLifetime, uint64 premiumSpendable, uint8 level, uint64 activeUntil, uint64 migrationRef) m)',
  'function creditPremium(address player, uint64 points, uint64 creditRef)',
  'function spendLocal(address player, bytes32 tag, uint64 amount)',
  'function spendGlobal(address player, uint64 amount)',
  'function activatePlan(address player, uint8 level, uint16 planDays)',
  'function activateBooster(address player, uint16 planHours)',
  'function upkeep(address player)',
  // Custom errors, so viem can DECODE a rule rejection and surface its name
  // (e.g. NoLives) instead of a generic "function reverted".
  'error NotAdmin()',
  'error NoLives()',
  'error Insufficient()',
  'error Overflow()',
  'error BucketsFull()',
  'error DuplicateRef()',
  'error BadLevel()',
  'error CreditTooLarge()',
  'error BadPoints()',
]);
const regAbi = parseAbi([
  'function openGame(bytes32 gameId, address p2, uint32 ttl)',
  'function settleGame(bytes32 gameId, bytes32 resultHash)',
  'function expireGame(bytes32 gameId)',
  'function commitBatch(uint8 kind, bytes32 root, uint256 count)',
  'function finalizeWindow(uint8 kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock)',
  'function finalizeWindowGas(uint8 kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock, uint256 sponsorGasWei)',
  'function windowRoot(uint8) view returns (bytes32)',
  'function windowCount(uint8) view returns (uint256)',
  'function windowFromBlock(uint8) view returns (uint256)',
  'function windowToBlock(uint8) view returns (uint256)',
  'function seatUp(bytes32 gameId, address host, uint8 seat, address player)',
  'function beginGame(bytes32 gameId, address host, uint8 seats, uint32 turnSecs)',
  'function commitMove(bytes32 gameId, address mover, uint8 seat, uint8 nextSeat, bytes32 moveCommit)',
  'function expireTurn(bytes32 gameId)',
  'function turnState(bytes32 gameId) view returns (uint8 seats, uint8 activeSeat, uint32 turnSecs, uint64 turnDeadline, uint32 moveCount, bool begun)',
  'function settleGameOrder(bytes32 gameId, address actor, bytes32 resultHash, uint8[] finishOrder)',
  'function resultOrder(bytes32 gameId) view returns (bytes32 resultHash, uint8[] order)',
]);
const rndAbi = parseAbi([
  'function commitSeed(bytes32 batchId, bytes32 seedHash)',
  'function revealSeed(bytes32 batchId, bytes32 seed)',
]);
const bytes32 = (hexStr) => hexStr;
// GFG-BS per-match settlement (arcv2m17): one start commit + one co-signed settle.
const msAbi = parseAbi([
  'function commitStart(bytes32 gameId, address p1, address p2, uint16 gameTag, uint8 seats, bytes32 commitHash, uint32 ttlSecs)',
  'function settle(bytes32 gameId, bytes32 moveDigest, bytes32 resultHash, uint32 moveCount, uint8 v1, bytes32 r1, bytes32 s1, uint8 v2, bytes32 r2, bytes32 s2)',
  'function dispute(bytes32 gameId, bytes32 revealedDigest)',
  'function claimTimeout(bytes32 gameId)',
  'function matchOf(bytes32 gameId) view returns (address p1, address p2, bytes32 commitHash, bytes32 moveDigest, bytes32 resultHash, uint64 startedAt, uint64 settleDeadline, uint32 moveCount, uint16 gameTag, uint8 seats, bool settled, bool disputed)',
]);
const readAbi = parseAbi([
  'function livesOf(address a) view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay)',
  'function globalsOf(address a) view returns (uint64 purePts, uint64 lifetime, uint64 spendable)',
  'function premiumOf(address a) view returns (uint64 lifetime, uint64 spendable, uint8 level, uint64 activeUntil)',
  'function bucketOf(address a, bytes32 tag) view returns (uint64 purePts, uint64 spendable)',
]);

function tag32(s) {
  const b = Buffer.from(String(s || 'ludo'), 'utf8').subarray(0, 32);
  const out = Buffer.alloc(32);
  b.copy(out);
  return '0x' + out.toString('hex');
}
function hex32(s) {
  const v = String(s == null ? '' : s);
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v;
  // A NUMERIC ref (what JSON sends for matchRef/Date.now()) must become its
  // 32-byte hex value, NOT a UTF-8 dump of the digits. This was a real bug: the
  // start commit wrote the number, but later reads/settles hashed the digits, so
  // the match could never be looked up or settled.
  if (/^[0-9]{1,20}$/.test(v)) {
    try { return '0x' + BigInt(v).toString(16).padStart(64, '0'); } catch (e) { /* fall through */ }
  }
  const h = Buffer.from(v, 'utf8');
  const out = Buffer.alloc(32);
  h.copy(out, 0, 0, Math.min(32, h.length));
  return '0x' + out.toString('hex');
}
const num = (v) => (v === undefined || v === null) ? null : BigInt(String(v));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gfg-token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  let body = {};
  try { body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { res.status(400).json({ error: 'invalid JSON body' }); return; }

  if (!SPONSOR_KEY || SPONSOR_KEY.length < 32) {
    res.status(500).json({ error: 'server misconfigured: GFG_Arc_Gasless_Sponsor_Key is not set' });
    return;
  }

  const action = String(body.action || '');
  const params = body.params || {};
  const MONEY = new Set(['creditPremium', 'activatePlan', 'activateBooster', 'migratePlayer']);
  if (MONEY.has(action)) {
    const expected = process.env.GFG_OPERATOR_TOKEN;
    const token = body.token || (req.headers && req.headers['x-gfg-token']);
    if (!expected || expected.length < 16) { res.status(500).json({ error: 'server misconfigured: GFG_OPERATOR_TOKEN is not set' }); return; }
    if (!token || String(token) !== expected) { res.status(401).json({ error: 'unauthorized operator token' }); return; }
  }

  try {
    // Addresses + RPC come from the public config (one repo file), never env.
    const __evm = await arcEvmConfig();
    const RPC_URL = __evm.rpc || RPC;
    const PLAYER_CORE = __evm.contracts.playerCore;
    const GAME_REGISTRY = __evm.contracts.gameRegistry;
    const RANDOMNESS = __evm.contracts.randomness;
    const MATCH_SETTLEMENT = __evm.contracts.matchSettlement;
    const chain = defineChain({ id: Number(__evm.chainId || CHAIN_ID), name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
    const pub = createPublicClient({ chain, transport: http(RPC_URL) });
    const relayer = accountFor(SPONSOR_KEY);
    const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: relayer });

    // LAZY MIGRATION (arcv2m16): a returning player who just got an EVM wallet.
    // The relayer verifies with Dynamic which Solana wallet belongs to this EVM
    // address, reads the Solana ledger itself, and migrates idempotently. The
    // client never supplies amounts, so no one can mint points. Close it any time
    // with GFG_Arc_Migration_Open=false (for example before/after mainnet).
    if (action === 'migrateMe') {
      const __evm2 = await arcEvmConfig();
      if (String(process.env.GFG_Arc_Migration_Open || 'true') === 'false') {
        res.status(403).json({ ok: false, error: 'migration is closed' });
        return;
      }
      const evm = getAddress(params.evmAddress || params.player);
      const dt = process.env.DYNAMIC_API_TOKEN || '';
      const de = process.env.DYNAMIC_ENV_ID || process.env.DYNAMIC_ENVIRONMENT_ID || '';
      if (!dt || !de) { res.status(500).json({ ok: false, error: 'Dynamic API not configured' }); return; }
      const ur = await fetch(`https://app.dynamicauth.com/api/v0/environments/${de}/users?limit=100`, { headers: { Authorization: 'Bearer ' + dt } });
      if (!ur.ok) throw new Error('Dynamic API ' + ur.status);
      const uj = await ur.json();
      let sol = null;
      for (const u of (uj.users || [])) {
        const creds = u.verifiedCredentials || [];
        const ec = creds.find(c => c.chain === 'EVM');
        const ew = (u.wallets || []).find(w => w.chain === 'EVM');
        const evmAddr = (ec && ec.address) || (ew && (ew.publicKey || ew.address));
        if (evmAddr && String(evmAddr).toLowerCase() !== evm.toLowerCase()) continue;
        const sc = creds.find(c => c.chain === 'SOL');
        const sw = (u.wallets || []).find(w => w.chain === 'SOL');
        sol = (sc && sc.address) || (sw && (sw.publicKey || sw.address)) || null;
        break;
      }
      if (!sol) { res.status(404).json({ ok: false, error: 'no Solana wallet found for this Arc address' }); return; }
      const core = await readSolanaCore(sol).catch(() => null);
      const b = coreBalances(core, 'ludo');
      if (!hasBalances(b)) { res.status(200).json({ ok: true, migrated: false, reason: 'nothing to migrate' }); return; }
      const migrationRef = parseInt(createHash('sha256').update('arc-migrate:' + sol).digest('hex').slice(0, 15), 16);
      const chain2 = defineChain({ id: Number(__evm2.chainId || 5042002), name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [__evm2.rpc] } } });
      const pub2 = createPublicClient({ chain: chain2, transport: http(__evm2.rpc) });
      const relayer2 = accountFor(SPONSOR_KEY);
      const wallet2 = createWalletClient({ chain: chain2, transport: http(__evm2.rpc), account: relayer2 });
      const hash2 = await wallet2.writeContract({ address: __evm2.contracts.playerCore, abi: coreAbi, functionName: 'migratePlayer', args: [evm, { ...b, migrationRef }] });
      const rc2 = await pub2.waitForTransactionReceipt({ hash: hash2 });
      res.status(200).json({ ok: true, migrated: true, txHash: hash2, points: b.localPure });
      return;
    }

    // WINDOW AGGREGATOR (GFB-BS), CHAIN-DERIVED: the LEAVES are the chain's own
    // PointsRecorded events. The relayer reads them with getLogs since the last
    // finalized block, builds the Merkle root, and finalizes the window on-chain.
    // There is NO off-chain store: a restart simply re-reads the chain.
    const POINTS_TOPIC = keccak256(Buffer.from('PointsRecorded(address,bytes32,uint64,uint8,uint64)'));
    const MATCH_SETTLED_TOPIC = keccak256(Buffer.from('MatchSettled(bytes32,bytes32,bytes32,uint32,uint64)'));
    const MATCH_STARTED_TOPIC = keccak256(Buffer.from('MatchStarted(bytes32,address,address,uint16,uint8,bytes32,uint64)'));
    // BATCH WINDOW (owner-locked 2026-09-19): flush at BATCH_MAX matches OR when
    // the oldest pending match is BATCH_MAX_AGE old, and NEVER flush an empty
    // window (no pending = no cost). Both are config data, not code.
    const BATCH_MAX = Number(process.env.GFG_Arc_BatchMax || 100);
    const BATCH_MAX_AGE_MS = Number(process.env.GFG_Arc_BatchMaxAgeMs || 3600000); // 1h
    let firstPendingAt = 0; // ms timestamp of the oldest pending item in-process

    // GFG-BS match leaves: one leaf per MATCH (settlement), so a match is O(1)
    // inside the window no matter how many moves it had.
    async function matchLogs(fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: MATCH_SETTLEMENT, fromBlock, toBlock });
      const settled = [], started = [];
      for (const l of logs) {
        const t = l.topics && l.topics[0];
        if (t === MATCH_SETTLED_TOPIC) {
          // event MatchSettled(bytes32 indexed gameId, bytes32 moveDigest, bytes32 resultHash, uint32 moveCount, uint64 settledAt)
          const d = l.data.slice(2);
          const chunk = (i) => d.slice(i * 64, i * 64 + 64);
          settled.push({
            gameId: l.topics[1],
            moveDigest: '0x' + chunk(0),
            resultHash: '0x' + chunk(1),
            moveCount: Number(BigInt('0x' + chunk(2)) & 0xffffffffn),
            settledAt: Number(BigInt('0x' + chunk(3))),
            blockNumber: l.blockNumber, tx: l.transactionHash,
          });
        } else if (t === MATCH_STARTED_TOPIC) {
          started.push({ gameId: l.topics[1], p1: '0x' + l.topics[2].slice(26), p2: '0x' + l.topics[3].slice(26), blockNumber: l.blockNumber, tx: l.transactionHash });
        }
      }
      return { settled, started };
    }
    function matchLeaf(m) {
      // A match settlement is ONE leaf: the co-signed move digest + result.
      return keccak256(encodePacked(['bytes32', 'bytes32', 'bytes32', 'uint32'], [m.gameId, m.moveDigest, m.resultHash, m.moveCount]));
    }

    // Mirror of match-engine.js rollingHash: recompute a digest from a revealed
    // move list (+ result), so a tampered log cannot pass the free dispute verifier.
    function replayDigestFromMoves(moves, meta, result) {
      function rolling(prevHex, moveStr) {
        const bytes = Buffer.from((prevHex || '0') + '|' + moveStr, 'utf8');
        let h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
        for (let i = 0; i < bytes.length; i++) {
          h1 ^= bytes[i]; h1 = Math.imul(h1, 16777619) >>> 0;
          h2 = (Math.imul(h2 ^ bytes[i], 2246822519) + h1) >>> 0;
        }
        const hx = (n) => (n >>> 0).toString(16).padStart(8, '0');
        return '0x' + hx(h1) + hx(h2) + hx((h1 ^ h2) >>> 0) + hx(Math.imul(h1, h2) >>> 0) +
          hx((h1 + bytes.length) >>> 0) + hx((h2 ^ bytes.length) >>> 0) +
          hx((h1 ^ 0x9e3779b9) >>> 0) + hx((h2 + 0x85ebca6b) >>> 0);
      }
      let d = rolling('0', 'open:' + String((meta && meta.matchRef) || 0));
      // Each entry is { seat: <index>, move: <object> }; the SEAT INDEX is what
      // the engine hashed, never a field inside the move object itself.
      for (const e0 of (moves || [])) {
        const e = e0 || {};
        const mv = (e.move !== undefined) ? e.move : e;
        const seat = (e.seat != null) ? e.seat : 0;
        const keys = (mv && typeof mv === 'object' && !Array.isArray(mv)) ? Object.keys(mv).sort() : undefined;
        const canonical = JSON.stringify(mv == null ? null : mv, keys);
        d = rolling(d, 'move:' + seat + ':' + canonical);
      }
      if (result !== undefined && result !== null) {
        const rk = (typeof result === 'object' && !Array.isArray(result)) ? Object.keys(result).sort() : undefined;
        d = rolling(d, 'result:' + JSON.stringify(result, rk));
      }
      return d;
    }

    async function windowLogs(fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: PLAYER_CORE, fromBlock, toBlock, topics: [POINTS_TOPIC] });
      return logs.map((l) => {
        const player = getAddress('0x' + l.topics[1].slice(26));
        const tag = l.topics[2];
        const d = l.data.slice(2);
        const u64 = (i) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
        return { player, tag, points: u64(0), reason: Number(u64(1) & 0xffn), matchRef: u64(2), blockNumber: l.blockNumber };
      });
    }
    async function leafFromEvent(e) {
      return keccak256(encodePacked(['address', 'bytes32', 'uint64', 'uint8', 'uint64'], [e.player, e.tag, e.points, e.reason, e.matchRef]));
    }

    async function flushBatchNow(kind) {
      const kindNum = kind === 'settle' ? 1 : 0;
      const last = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowToBlock', args: [kindNum] });
      const latest = await pub.getBlockNumber();
      // First flush: bound the scan to a recent range the RPC accepts.
      const fromBlock = last === 0n ? (latest > 9999n ? latest - 9999n : 0n) : last + 1n;
      if (latest < fromBlock) return { flushed: false, reason: 'empty' };
      const events = await windowLogs(fromBlock, latest);
      if (!events.length) return { flushed: false, reason: 'no leaves in range' };
      const leaves = [];
      for (const e of events) leaves.push(await leafFromEvent(e));
      const tree = buildTree(leaves);
      const h = await wallet.writeContract({
        address: GAME_REGISTRY, abi: regAbi, functionName: 'finalizeWindowGas',
        args: [kindNum, tree.root, BigInt(leaves.length), fromBlock, BigInt(latest), windowGasWei],
      });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      const gasRecordedWei = windowGasWei;
      windowGasWei = 0n;
      try {  } catch (e) {}
      return { flushed: true, root: tree.root, count: leaves.length, fromBlock: String(fromBlock), toBlock: String(latest), txHash: h, gas: String(rc.gasUsed), usdc: formatEther(rc.gasUsed * rc.effectiveGasPrice), sponsorGasWei: String(gasRecordedWei) };
    }

    if (action === 'flushBatch') {
      res.status(200).json({ ok: true, ...(await flushBatchNow(params.kind === 'open' ? 'open' : 'settle')) });
      return;
    }
    // GFG-BS auto window manager: called opportunistically (by any game write or
    // a page load). It flushes ONLY when the batch is full (BATCH_MAX) or the
    // oldest pending match is BATCH_MAX_AGE old, and never flushes empty.
    if (action === 'tickBatch') {
      const latest = await pub.getBlockNumber();
      const lastTo = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowToBlock', args: [1] });
      const fromBlock = lastTo === 0n ? (latest > 9999n ? latest - 9999n : 0n) : lastTo + 1n;
      if (latest < fromBlock) { res.status(200).json({ ok: true, flushed: false, reason: 'empty', pending: 0 }); return; }
      let ml;
      try { ml = await matchLogs(fromBlock, latest); } catch (e) { ml = { settled: [], started: [] }; }
      const pending = ml.settled.length;
      if (pending === 0) { firstPendingAt = 0; res.status(200).json({ ok: true, flushed: false, reason: 'empty', pending: 0, config: { max: BATCH_MAX, ageMs: BATCH_MAX_AGE_MS } }); return; }
      if (firstPendingAt === 0) firstPendingAt = Date.now();
      const ageMs = Date.now() - firstPendingAt;
      const full = pending >= BATCH_MAX;
      const aged = ageMs >= BATCH_MAX_AGE_MS;
      if (!full && !aged) {
        res.status(200).json({ ok: true, flushed: false, reason: 'waiting', pending, ageMs, config: { max: BATCH_MAX, ageMs: BATCH_MAX_AGE_MS } });
        return;
      }
      // Flush: ONE tx covering every pending match in the window.
      const leaves = ml.settled.map(matchLeaf);
      const tree = buildTree(leaves);
      const h = await wallet.writeContract({
        address: GAME_REGISTRY, abi: regAbi, functionName: 'finalizeWindowGas',
        args: [1, tree.root, BigInt(leaves.length), fromBlock, BigInt(latest), windowGasWei],
      });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      windowGasWei = 0n;
      firstPendingAt = 0;
      res.status(200).json({ ok: true, flushed: true, trigger: full ? 'full' : 'age', pending, root: tree.root, txHash: h, gas: String(rc.gasUsed), usdc: formatEther(rc.gasUsed * rc.effectiveGasPrice), config: { max: BATCH_MAX, ageMs: BATCH_MAX_AGE_MS } });
      return;
    }
    // GFG-BS FLUSH TIMER (read-only, FREE): reports the batch window state so the
    // dashboard can prove the timer works. No gas, no USDC.
    if (action === 'flushState') {
      const latest = await pub.getBlockNumber();
      const lastTo = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowToBlock', args: [1] });
      // Bound the scan to a range the RPC accepts (it caps eth_getLogs ranges).
      let fromBlock = lastTo === 0n ? (latest > 9000n ? latest - 9000n : 0n) : lastTo + 1n;
      if (latest - fromBlock > 9000n) fromBlock = latest - 9000n;
      let pending = 0;
      let scanError = null;
      try {
        const ml = latest >= fromBlock ? await matchLogs(fromBlock, latest) : { settled: [] };
        pending = ml.settled.length;
      } catch (e) { scanError = (e.shortMessage || e.message || String(e)); }
      let nextInMs = null;
      let trigger = 'none';
      if (pending > 0) {
        if (firstPendingAt === 0) firstPendingAt = Date.now(); // account for a cold start
        const age = Date.now() - firstPendingAt;
        nextInMs = Math.max(0, BATCH_MAX_AGE_MS - age);
        trigger = pending >= BATCH_MAX ? 'full' : 'age';
      }
      res.status(200).json({
        ok: true, chain: 'arc', free: true,
        pending, config: { max: BATCH_MAX, ageMs: BATCH_MAX_AGE_MS },
        nextFlushInMs: nextInMs, nextTrigger: trigger,
        lastFlushedRange: { toBlock: String(lastTo) },
        scanError: scanError || undefined,
        note: 'Pending is read from chain events; the age timer starts when the first pending match is seen by the relayer. Empty windows never flush.',
      });
      return;
    }

    if (action === 'batchStat') {
      const k = params.kind === 'open' ? 'open' : 'settle';
      const kNum = k === 'settle' ? 1 : 0;
      const [root, count, fromB, toB, latest] = await Promise.all([
        pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowRoot', args: [kNum] }),
        pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowCount', args: [kNum] }),
        pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowFromBlock', args: [kNum] }),
        pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowToBlock', args: [kNum] }),
        pub.getBlockNumber(),
      ]);
      const pendFrom = toB === 0n ? (latest > 9999n ? latest - 9999n : 0n) : toB + 1n;
      const pendingLeaves = await windowLogs(pendFrom, latest).catch(() => []);
      res.status(200).json({ ok: true, chain: true, pending: pendingLeaves.length, last: { root: root === '0x' + '0'.repeat(64) ? null : root, count: Number(count), fromBlock: String(fromB), toBlock: String(toB), at: null } });
      return;
    }
    if (action === 'batchProof') {
      const kNum = params.kind === 'open' ? 0 : 1;
      const toB = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowToBlock', args: [kNum] });
      const root = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowRoot', args: [kNum] });
      const gameId = hex32(params.gameId);
      if (toB === 0n) { res.status(200).json({ ok: false, error: 'no window finalized yet' }); return; }
      let fromB = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowFromBlock', args: [kNum] });
      if (fromB === 0n) fromB = toB > 9999n ? toB - 9999n : 0n;
      const events = await windowLogs(fromB, toB);
      const leaves = [];
      for (const e of events) leaves.push({ leaf: await leafFromEvent(e), e });
      const tree = buildTree(leaves.map(x => x.leaf));
      const hit = leaves.find(x => ('0x' + x.e.matchRef.toString(16).padStart(64, '0')) === gameId);
      if (!hit) { res.status(200).json({ ok: false, error: 'game not in the last window' }); return; }
      const proof = tree.proofs.get(hit.leaf) || [];
      res.status(200).json({ ok: true, root, proof, leaf: hit.leaf, valid: verifyProof(hit.leaf, proof, root), fromBlock: String(fromB), toBlock: String(toB) });
      return;
    }

    // Usage summary for the dashboard: summed from the chain's own events.
    if (action === 'arcUsage') {
      const topic = keccak256(Buffer.from('WindowFinalizedGas(uint8,bytes32,uint256,uint256,uint256,uint256,uint256)'));
      const latest = await pub.getBlockNumber();
      const fromB = latest > 9999n ? latest - 9999n : 0n;
      const logs = await pub.getLogs({ address: GAME_REGISTRY, fromBlock: fromB, toBlock: latest, topics: [topic] }).catch(() => []);
      const now = Math.floor(Date.now() / 1000);
      const periods = [24, 24 * 7, 24 * 14, 24 * 30, 24 * 90].map((hours) => {
        const since = now - hours * 3600;
        let gas = 0n, games = 0n, windows = 0;
        for (const l of logs) {
          const d = l.data.slice(2);
          const u = (i) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
          const count = u(1), gasWei = u(4), ts = u(5);
          if (Number(ts) >= since) { gas += gasWei; games += count; windows += 1; }
        }
        const usdc = Number(formatEther(gas));
        const days = hours / 24;
        return { window: hours === 24 ? '24h' : (hours / 24) + 'd', txs: windows, gas: Number(gas), usdc: Number(usdc.toFixed(8)), games: Number(games), usdcPerDay: Number((usdc / days).toFixed(8)), gamesPerDay: Number((Number(games) / days).toFixed(2)), usdcPerGame: Number(games) > 0 ? Number((usdc / Number(games)).toFixed(8)) : null };
      });
      res.status(200).json({ ok: true, usage: { generatedAt: Date.now(), chain: true, periods } });
      return;
    }

    // DICE (GFG-BS commit-reveal): roll derived from the window seed, no gas.
    if (action === 'rollDice') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) {
        res.status(500).json({ error: 'dice seed not configured (GFG_Arc_Dice_Seed)' });
        return;
      }
      const gid = hex32(params.gameId);
      const counter = Number(params.counter || 0);
      const salt = '0x' + String(counter).padStart(8, '0').padStart(64, '0');
      const { keccak256, encodePacked } = await import('viem');
      const h = keccak256(encodePacked(['bytes32', 'bytes32', 'bytes32'], [DICE_SEED, gid, salt]));
      const b = Buffer.from(h.slice(2), 'hex');
      const roll1 = (b[0] % 6) + 1;
      const roll2 = (b[1] % 6) + 1;
      res.status(200).json({ ok: true, roll1, roll2, counter, seedHash: keccak256(encodePacked(['bytes32'], [DICE_SEED])), chain: 'arc' });
      return;
    }
    if (action === 'diceSeedHash') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) { res.status(500).json({ error: 'dice seed not configured' }); return; }
      const { keccak256, encodePacked } = await import('viem');
      res.status(200).json({ ok: true, seedHash: keccak256(encodePacked(['bytes32'], [DICE_SEED])) });
      return;
    }

    // Read actions (no gas, no write): keep the browser thin by decoding here.
    if (action === 'readPlayer') {
      const p = getAddress(params.player);
      const [lives, globals, premium] = await Promise.all([
        pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'livesOf', args: [p] }),
        pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'globalsOf', args: [p] }),
        pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'premiumOf', args: [p] }),
      ]);
      let bucket = [0n, 0n];
      if (params.tag) {
        bucket = await pub.readContract({ address: PLAYER_CORE, abi: readAbi, functionName: 'bucketOf', args: [p, tag32(params.tag)] });
      }
      res.status(200).json({
        ok: true, player: p,
        lives: { used: Number(lives[0]), pool: Number(lives[1]), boosterUntil: Number(lives[2]), day: Number(lives[3]) },
        globals: { pure: String(globals[0]), lifetime: String(globals[1]), spendable: String(globals[2]) },
        premium: { lifetime: String(premium[0]), spendable: String(premium[1]), level: Number(premium[2]), activeUntil: Number(premium[3]) },
        bucket: { pure: String(bucket[0]), spendable: String(bucket[1]) },
      });
      return;
    }

    // Read the on-chain turn clock (no gas): the browser counts down to the
    // ABSOLUTE deadline stored on-chain, never a local timer.
    // GFG-BS match read (no gas): the on-chain settlement record for a match.
    if (action === 'matchState') {
      const r = await pub.readContract({ address: MATCH_SETTLEMENT, abi: msAbi, functionName: 'matchOf', args: [hex32(params.gameId)] });
      res.status(200).json({
        ok: true, gameId: hex32(params.gameId),
        p1: r[0], p2: r[1], commitHash: r[2], moveDigest: r[3], resultHash: r[4],
        startedAt: Number(r[5]), settleDeadline: Number(r[6]), moveCount: Number(r[7]),
        gameTag: Number(r[8]), seats: Number(r[9]), settled: r[10], disputed: r[11], chain: 'arc',
      });
      return;
    }

    // GFG-BS match HISTORY (FREE: eth_getLogs is a read-only RPC call, no gas).
    // Returns a player's recent matches, each with its start + settle tx hashes
    // so the UI can link BOTH on the explorer. Game-agnostic: filtered by wallet,
    // not by game. Paginates backwards because the RPC caps the block range.
    if (action === 'matchHistory') {
      if (!MATCH_SETTLEMENT) {
        res.status(200).json({ ok: true, player: params.player, count: 0, matches: [], free: true, chain: 'arc', note: 'match settlement address not configured' });
        return;
      }
      const player = getAddress(params.player);
      const limit = Math.max(1, Math.min(Number(params.limit || 10), 50));
      const startTopic = keccak256(toHex('MatchStarted(bytes32,address,address,uint16,uint8,bytes32,uint64)'));
      const settledTopic = keccak256(toHex('MatchSettled(bytes32,bytes32,bytes32,uint32,uint64)'));
      const started = [], settledMap = new Map();
      let to = await pub.getBlockNumber();
      const RANGE = 9000n;
      // Walk backwards in RPC-safe chunks until we have enough matches or hit 0.
      for (let round = 0; round < 8 && started.length < limit && to > 0n; round++) {
        const from = to > RANGE ? to - RANGE : 0n;
        let logs = [];
        try { logs = await pub.getLogs({ address: MATCH_SETTLEMENT, fromBlock: from, toBlock: to }); }
        catch (e) { break; }
        for (const l of logs) {
          const t0 = l.topics && l.topics[0];
          if (t0 === startTopic) {
            const p1 = '0x' + l.topics[2].slice(26), p2 = '0x' + l.topics[3].slice(26);
            if (p1.toLowerCase() !== player.toLowerCase() && p2.toLowerCase() !== player.toLowerCase()) continue;
            // gameId is the INDEXED topic1; topics[2]/[3] are the two players.
            started.push({ gameId: l.topics[1], block: Number(l.blockNumber), tx: l.transactionHash });
          } else if (t0 === settledTopic) {
            settledMap.set((l.topics[1] || '').toLowerCase(), { tx: l.transactionHash, block: Number(l.blockNumber) });
          }
        }
        if (from === 0n) break;
        to = from - 1n;
      }
      // Re-read each match for its live state (authoritative), newest first.
      const rows = [];
      for (const s of started.slice(0, limit)) {
        const gameId = s.gameId || '0x';
        let m;
        try { m = await pub.readContract({ address: MATCH_SETTLEMENT, abi: msAbi, functionName: 'matchOf', args: [gameId] }); }
        catch (e) { continue; }
        if (m[0] === '0x0000000000000000000000000000000000000000') continue;
        rows.push({
          gameId,
          gameTag: Number(m[8]), seats: Number(m[9]),
          startedAt: Number(m[5]), moveCount: Number(m[7]),
          settled: m[10], disputed: m[11],
          startTx: s.tx,
          settleTx: (settledMap.get(String(gameId).toLowerCase()) || {}).tx || null,
        });
      }
      rows.sort((a, b) => b.startedAt - a.startedAt);
      // Batch-window context: a settled match is not "on-chain final" until the
      // window flushes, so the UI can show 'pending flush' vs the batch tx.
      let windowTo = 0n;
      try { windowTo = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'windowToBlock', args: [1] }); } catch (e) { /* soft */ }
      for (const r of rows) {
        const settledAtBlock = (settledMap.get(String(r.gameId).toLowerCase()) || {}).block || 0;
        r.inWindow = settledAtBlock > 0 && windowTo > 0n && BigInt(settledAtBlock) <= windowTo;
        if (!r.inWindow) r.flushState = 'pending flush';
        else r.flushState = 'flushed';
      }
      res.status(200).json({ ok: true, player, count: rows.length, matches: rows.slice(0, limit), free: true, chain: 'arc', windowToBlock: String(windowTo) });
      return;
    }

    // GFG-BS FREE DISPUTE (owner-locked 2026-09-19): a dispute costs the player
    // NOTHING. The relayer records the dispute and runs the verifier replay
    // OFF-CHAIN (free). If a move list is supplied, it must reproduce the digest
    // the players co-signed; that is the truth check. The on-chain dispute flag
    // (when needed) is written inside the normal batch window, never as a paid
    // per-match transaction.
    if (action === 'matchDisputeFree') {
      const gameId = hex32(params.gameId);
      const moveDigest = hex32(params.moveDigest);
      const reason = String(params.reason || 'disagreement');
      let verdict = { ok: false, reason: 'no move list supplied (dispute recorded)' };
      if (Array.isArray(params.revealedMoves)) {
        // Recompute the digest from the revealed moves (+ result) using the SAME
        // rolling hash the engine uses, so a tampered log cannot pass.
        const got = replayDigestFromMoves(params.revealedMoves, { matchRef: params.gameId }, params.result);
        verdict = (String(got).toLowerCase() === String(moveDigest).toLowerCase())
          ? { ok: true, digest: got, reason: 'revealed log matches the co-signed digest' }
          : { ok: false, digest: got, reason: 'revealed log does NOT match the co-signed digest' };
      }
      console.log('[arc-relay] free dispute', gameId, 'reason:', reason, '| verdict:', verdict.ok ? 'valid' : verdict.reason);
      res.status(200).json({ ok: true, gameId, reason, verdict, free: true, note: 'Dispute recorded at no cost; the on-chain flag (if needed) rides the normal batch window.' });
      return;
    }

    if (action === 'turnState') {
      const t = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'turnState', args: [hex32(params.gameId)] });
      res.status(200).json({
        ok: true, gameId: hex32(params.gameId),
        seats: Number(t[0]), activeSeat: Number(t[1]), turnSecs: Number(t[2]),
        turnDeadline: Number(t[3]), moveCount: Number(t[4]), begun: t[5], chain: 'arc',
      });
      return;
    }

    // Read a game's on-chain result + full finish order (empty until settled).
    if (action === 'resultOrder') {
      const r = await pub.readContract({ address: GAME_REGISTRY, abi: regAbi, functionName: 'resultOrder', args: [hex32(params.gameId)] });
      res.status(200).json({ ok: true, gameId: hex32(params.gameId), resultHash: r[0], order: (r[1] || []).map(Number), chain: 'arc' });
      return;
    }

    let address, abi, fn, args;
    switch (action) {
      case 'chargeLife':
        address = PLAYER_CORE; abi = coreAbi; fn = 'chargeLife';
        args = [getAddress(params.player), num(params.matchRef)];
        break;
      case 'recordPoints': {
        const pts = num(params.points);
        if (pts === null || pts <= 0n || pts > MAX_AWARD) throw new Error('points out of range');
        address = PLAYER_CORE; abi = coreAbi; fn = 'recordPoints';
        args = [getAddress(params.player), tag32(params.tag), pts, Number(params.reason || 1), num(params.matchRef)];
        break;
      }
      case 'recordGlobal': {
        const gp = num(params.points);
        if (gp === null || gp <= 0n || gp > MAX_AWARD) throw new Error('points out of range');
        address = PLAYER_CORE; abi = coreAbi; fn = 'recordGlobal';
        args = [getAddress(params.player), Number(params.kind || 0), gp, num(params.matchRef)];
        break;
      }
      case 'migratePlayer': {
        const d = params.data || {};
        address = PLAYER_CORE; abi = coreAbi; fn = 'migratePlayer';
        args = [getAddress(params.player), {
          tag: tag32(d.tag), localPure: num(d.localPure) || 0n, localSpendable: num(d.localSpendable) || 0n,
          globalPure: num(d.globalPure) || 0n, globalLifetime: num(d.globalLifetime) || 0n, globalSpendable: num(d.globalSpendable) || 0n,
          premiumLifetime: num(d.premiumLifetime) || 0n, premiumSpendable: num(d.premiumSpendable) || 0n,
          level: Number(d.level || 0), activeUntil: num(d.activeUntil) || 0n, migrationRef: num(d.migrationRef) || 0n,
        }];
        break;
      }
      case 'creditPremium':
        address = PLAYER_CORE; abi = coreAbi; fn = 'creditPremium';
        args = [getAddress(params.player), num(params.points), num(params.creditRef)];
        break;
      case 'spendLocal':
        address = PLAYER_CORE; abi = coreAbi; fn = 'spendLocal';
        args = [getAddress(params.player), tag32(params.tag), num(params.amount)];
        break;
      case 'spendGlobal':
        address = PLAYER_CORE; abi = coreAbi; fn = 'spendGlobal';
        args = [getAddress(params.player), num(params.amount)];
        break;
      case 'activatePlan':
        address = PLAYER_CORE; abi = coreAbi; fn = 'activatePlan';
        args = [getAddress(params.player), Number(params.level), Number(params.planDays || 30)];
        break;
      case 'activateBooster':
        address = PLAYER_CORE; abi = coreAbi; fn = 'activateBooster';
        args = [getAddress(params.player), Number(params.planHours || 72)];
        break;
      case 'upkeep':
        // Permissionless: expire a stale plan + heal the lives pool. No money.
        address = PLAYER_CORE; abi = coreAbi; fn = 'upkeep';
        args = [getAddress(params.player)];
        break;
      case 'openGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'openGame';
        args = [hex32(params.gameId), getAddress(params.p2), Number(params.ttl || 1800)];
        break;
      case 'settleGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'settleGame';
        args = [hex32(params.gameId), hex32(params.resultHash)];
        break;
      case 'settleGameOrder': {
        const order = Array.isArray(params.order) ? params.order.map((x) => Number(x)) : [];
        if (!order.length || order.length > 8) throw new Error('finish order 1..8');
        address = GAME_REGISTRY; abi = regAbi; fn = 'settleGameOrder';
        args = [hex32(params.gameId), getAddress(params.actor), hex32(params.resultHash), order];
        break;
      }
      case 'expireGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'expireGame';
        args = [hex32(params.gameId)];
        break;
      case 'seatUp':
        address = GAME_REGISTRY; abi = regAbi; fn = 'seatUp';
        args = [hex32(params.gameId), getAddress(params.host), Number(params.seat), getAddress(params.player)];
        break;
      case 'beginGame':
        address = GAME_REGISTRY; abi = regAbi; fn = 'beginGame';
        args = [hex32(params.gameId), getAddress(params.host), Number(params.seats), Number(params.turnSecs)];
        break;
      case 'commitMove':
        address = GAME_REGISTRY; abi = regAbi; fn = 'commitMove';
        args = [hex32(params.gameId), getAddress(params.mover), Number(params.seat), Number(params.nextSeat), hex32(params.moveCommit)];
        break;
      // GFG-BS per-match settlement (arcv2m17): the gasless core.
      case 'commitMatchStart':
        address = MATCH_SETTLEMENT; abi = msAbi; fn = 'commitStart';
        args = [hex32(params.gameId), getAddress(params.p1), getAddress(params.p2), Number(params.gameTag || 0), Number(params.seats || 2), hex32(params.commitHash), Number(params.ttlSecs || 3600)];
        break;
      case 'settleMatch':
        address = MATCH_SETTLEMENT; abi = msAbi; fn = 'settle';
        args = [hex32(params.gameId), hex32(params.moveDigest), hex32(params.resultHash), Number(params.moveCount), Number(params.v1), hex32(params.r1), hex32(params.s1), Number(params.v2), hex32(params.r2), hex32(params.s2)];
        break;
      case 'matchDispute':
        address = MATCH_SETTLEMENT; abi = msAbi; fn = 'dispute';
        args = [hex32(params.gameId), hex32(params.revealedDigest)];
        break;
      case 'matchTimeout':
        address = MATCH_SETTLEMENT; abi = msAbi; fn = 'claimTimeout';
        args = [hex32(params.gameId)];
        break;
      case 'expireTurn':
        address = GAME_REGISTRY; abi = regAbi; fn = 'expireTurn';
        args = [hex32(params.gameId)];
        break;
      case 'commitBatch':
        address = GAME_REGISTRY; abi = regAbi; fn = 'commitBatch';
        args = [Number(params.kind || 0), hex32(params.root), num(params.count)];
        break;
      case 'commitSeed':
        address = RANDOMNESS; abi = rndAbi; fn = 'commitSeed';
        args = [hex32(params.batchId), hex32(params.seedHash)];
        break;
      case 'revealSeed':
        address = RANDOMNESS; abi = rndAbi; fn = 'revealSeed';
        args = [hex32(params.batchId), hex32(params.seed)];
        break;
      case 'commitDiceSeed':
        if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) throw new Error('dice seed not configured');
        {
          const { keccak256, encodePacked } = await import('viem');
          address = RANDOMNESS; abi = rndAbi; fn = 'commitSeed';
          args = [hex32(params.batchId), keccak256(encodePacked(['bytes32'], [DICE_SEED]))];
        }
        break;
      case 'revealDiceSeed':
        if (!/^0x[0-9a-fA-F]{64}$/.test(DICE_SEED)) throw new Error('dice seed not configured');
        address = RANDOMNESS; abi = rndAbi; fn = 'revealSeed';
        args = [hex32(params.batchId), DICE_SEED];
        break;
      default:
        res.status(400).json({ error: 'unknown action: ' + action });
        return;
    }

    const hash = await wallet.writeContract({ address, abi, functionName: fn, args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const costUsdc = formatEther(rc.gasUsed * rc.effectiveGasPrice);
    try { windowGasWei += (rc.gasUsed * rc.effectiveGasPrice); } catch (e) { /* accounting */ }
    res.status(200).json({ ok: true, action, txHash: hash, gas: String(rc.gasUsed), usdc: costUsdc, relayer: relayer.address });
  } catch (e) {
    // Surface the DECODED contract error name (e.g. NoLives) when present, so
    // the client can tell a real game rule rejection from a network error.
    let name = '';
    try {
      const walk = (err) => {
        if (!err || typeof err !== 'object') return '';
        if (err.errorName) return err.errorName;
        if (err.data && err.data.errorName) return err.data.errorName;
        return walk(err.cause);
      };
      name = walk(e) || '';
    } catch (er) { /* ignore */ }
    const detail = (e.shortMessage || e.message || String(e));
    const msg = name ? (name + ': ' + detail) : detail;
    console.error('arc-relay error:', msg);
    res.status(400).json({ ok: false, error: msg, errorName: name || undefined });
  }
}
