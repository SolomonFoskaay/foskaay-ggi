// api/verify-and-credit.mjs — AUTOMATED PAYMENT VERIFICATION + PREMIUM CREDIT.
// Owner-approved 2026-08-31. The player pays USDC from their OWN embedded
// Dynamic wallet to the platform treasury (on-chain). When they submit the
// resulting transaction signature, this endpoint INDEPENDENTLY re-reads that
// transaction from the chain and verifies:
//   1. it exists and is confirmed (no error),
//   2. it transferred EXACTLY (or more than) the plan's USDC amount to the
//      treasury ATA,
//   3. the sender ATA belongs to the provided owner wallet,
//   4. the mint is the configured USDC,
//   5. it is fresh (blocktime within FRESHNESS_MS - replay protection).
// Only then does it credit the premium points via the SAME sponsor-signed
// gasless path the admin dashboard uses (handleCreditPremium). A fake/replayed
// tx never credits, and the program's DuplicateCreditRef (creditRef derived
// from the tx signature) makes a re-submitted tx a no-op. Vercel-free-plan
// safe: request-driven, one RPC read += one gasless ER credit, no cron.
//
// The credit always lands on the DEVNET premium ledger regardless of which
// cluster the payment was made on (devnet test USDC now, mainnet real USDC
// after the one-line swap in scripts/pay-config.mjs).

import { createHash } from 'node:crypto';
import pkg from '@solana/web3.js';
const { PublicKey, Connection } = pkg;
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { payPlan, payRpcEndpoints, usdcBaseForCents, PAY_TREASURY_PUBKEY, USDC_MINT, PAY_ACCEPTED_DESTINATIONS, PAY_NETWORK } from '../scripts/pay-config.mjs';
import { handleAdminActivatePremium, handleAdminActivateBooster } from '../scripts/delegate-relay.mjs';
import { ensureTreasuryUsdcAta } from './../scripts/delegate-relay.mjs';

const FRESHNESS_MS = 30 * 60 * 1000;    // payment must be < 30 min old
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function parseUsdcTransfer(tx) {
  // TOKEN Transfer/TransferChecked shows up as a parsed instruction (top-level
  // or inside innerInstructions). We look for a parsed transfer whose mint is
  // USDC (transferChecked) or the only transfer in the tx.
  try {
    const msg = tx.transaction && tx.transaction.message;
    const inner = tx.meta && tx.meta.innerInstructions;
    const all = [];
    if (msg && msg.instructions) all.push(...msg.instructions);
    if (Array.isArray(inner)) {
      for (const group of inner) if (group && group.instructions) all.push(...group.instructions);
    }
    for (const ix of all) {
      const parsed = ix && ix.parsed;
      if (!parsed) continue;
      const info = parsed.info;
      if (!info) continue;
      const type = parsed.type || '';
      if (type !== 'transfer' && type !== 'transferChecked') continue;
      const mint = info.mint;
      if (type === 'transferChecked' && mint && mint !== USDC_MINT) continue;
      return {
        source: info.source,
        destination: info.destination,
        amountBase: Number(info.tokenAmount ? info.tokenAmount.amount : info.amount),
        mint: mint || null,
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function fetchTransaction(rpcUrl, txSignature) {
  const conn = new Connection(rpcUrl, 'confirmed');
  // Use getParsedTransaction (jsonParsed encoding) so SPL token instructions
  // come back with `.parsed` (type/info). Plain getTransaction returns raw
  // base64 instruction data with no `.parsed`, which made the verifier always
  // report 'No USDC transfer found' even for a successful payment.
  return conn.getParsedTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 1,
  });
}

function ataFor(ownerKey) {
  return PublicKey.findProgramAddressSync(
    [ownerKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(USDC_MINT).toBuffer()],
    new PublicKey(ATA_PROGRAM)
  )[0];
}

export async function verifyAndCredit({ owner, plan, txSignature, token }) {
  if (!owner || typeof owner !== 'string') throw new Error('missing "owner" wallet');
  let oKey;
  try { oKey = new PublicKey(owner); } catch (e) { throw new Error('invalid owner wallet address'); }
  if (oKey.toBase58() !== owner.trim()) throw new Error('invalid owner wallet (base58 is case-sensitive)');
  if (!plan) throw new Error('missing "plan"');
  const p = payPlan(plan);
  if (!p) throw new Error('unknown plan "' + plan + '"');
  if (!txSignature || typeof txSignature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,96}$/.test(txSignature)) {
    throw new Error('invalid transaction signature');
  }

  // ANTI-EXPLOIT GATE (owner 2026-08-31): DEVNET can be used to credit the
  // (devnet) premium ledger with FREE test USDC. Random players must NEVER be
  // able to trigger that. If the configured payment network is devnet, only an
  // operator holding GFG_OPERATOR_TOKEN may verify+credit (the admin test
  // flow). Production faces mainnet, which requires real USDC, so no token is
  // needed there. The server NEVER trusts the client's ?net= - it reads the
  // config here. If devnet and no valid token -> refuse before any credit.
  const expected = process.env.GFG_OPERATOR_TOKEN;
  if (PAY_NETWORK === 'devnet') {
    const okToken = expected && expected.length >= 16 && token && String(token) === expected;
    if (!okToken) {
      throw new Error('devnet payments are test-only: they are gated behind the operator token so free test USDC can never buy points on the live site.');
    }
  }
  if (PAY_NETWORK === 'mainnet' && expected && expected.length >= 16 && token && String(token) !== expected) {
    // If a token is supplied on mainnet it must be correct; otherwise ignore.
    throw new Error('unauthorized operator token');
  }

  const endpoints = payRpcEndpoints();
  let tx = null;
  for (let i = 0; i < 3 && !tx; i++) {
    for (const url of endpoints) {
      try { tx = await fetchTransaction(url, txSignature); if (tx) break; }
      catch (e) { /* try next endpoint */ }
    }
  }
  if (!tx) {
    throw new Error('transaction not found on the pay cluster yet (or the signature is invalid). Try again in a few seconds.');
  }
  if (tx.meta && tx.meta.err) {
    throw new Error('transaction failed on-chain: ' + JSON.stringify(tx.meta.err));
  }

  // Freshness (replay protection).
  const blockTime = tx.blockTime || 0;
  if (blockTime && (Date.now() - blockTime * 1000) > FRESHNESS_MS) {
    throw new Error('payment transaction is too old (replay guard). Please make a fresh payment.');
  }

  const transfer = parseUsdcTransfer(tx);
  if (!transfer) throw new Error('no USDC transfer found in this transaction');

  const ownerAta = ataFor(oKey);
  const treasuryAta = ataFor(new PublicKey(PAY_TREASURY_PUBKEY));
  // Accepted destinations: the current treasury (NFT wallet) + grace-period
  // destinations from before the wallet swap, so older payments still credit.
  const acceptedDest = [treasuryAta.toBase58()];
  for (const d of (PAY_ACCEPTED_DESTINATIONS || [])) {
    acceptedDest.push(ataFor(new PublicKey(d)).toBase58());
  }

  if (transfer.mint && transfer.mint !== USDC_MINT) throw new Error('payment is not the expected USDC mint');
  if (transfer.source !== ownerAta.toBase58()) throw new Error("sender is not this account's payment wallet");
  if (acceptedDest.indexOf(transfer.destination) === -1) throw new Error('payment did not go to a platform treasury wallet');

  const expectedBase = usdcBaseForCents(p.usdCents);
  const paidBase = transfer.amountBase;
  // Accept exact or slightly generous (>=) so exchange rounding never blocks,
  // but never credit MORE than the plan's points.
  if (!(paidBase >= expectedBase)) throw new Error('payment amount is below the plan price');

  // Idempotent creditRef derived STABLY from the tx signature: a re-submitted
  // tx produces the same ref, and the program's DuplicateCreditRef guard then
  // makes the second credit a clean no-op (never double pay).
  const hash = createHash('sha256').update(String(txSignature)).digest();
  const creditRef = Math.abs(hash.readUInt32LE(0)) * 1000003 + (hash.readUInt32LE(4) % 1000003);

  // Self-healing treasury: make sure our USDC receiving ATA exists (sponsor
  // pays the one-time rent) before crediting, so this endpoint is robust even
  // if the treasury address or cluster was switched (devnet <-> mainnet swap).
  await ensureTreasuryUsdcAta();

  // DIRECT ACTIVATION (M5 spec): the verified payment activates the plan or the
  // booster on the Player Core in ONE admin instruction. Premium points are no
  // longer part of the purchase flow. creditRef is derived from the tx
  // signature, and the on-chain payment_ref guard makes a re-submitted tx a
  // clean no-op (never a double activation / window extension).
  if (p.kind === 'booster') {
    const result = await handleAdminActivateBooster(oKey.toBase58(), p.hours || 72, creditRef);
    return {
      ok: true,
      plan,
      kind: p.kind,
      activated: 'booster',
      hours: result && result.hours,
      paymentRef: String(creditRef),
      sig: result && result.sig,
    };
  }

  const result = await handleAdminActivatePremium(oKey.toBase58(), p.level || 2, p.days || 30, creditRef);
  return {
    ok: true,
    plan,
    kind: p.kind,
    activated: 'plan',
    level: result && result.level,
    days: result && result.days,
    paymentRef: String(creditRef),
    sig: result && result.sig,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  let body = {};
  try {
    body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : (req.body || {});
  } catch (e) { res.status(400).json({ error: 'invalid JSON body' }); return; }

  try {
    const result = await verifyAndCredit({
      owner: body.owner,
      plan: body.plan,
      txSignature: body.txSignature,
      token: body.token,
    });
    res.status(200).json(result);
  } catch (e) {
    console.error('verify-and-credit error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
}