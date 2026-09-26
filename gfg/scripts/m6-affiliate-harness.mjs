// scripts/m6-affiliate-harness.mjs
// M6 harness: prove the on-chain affiliate ledger end to end on devnet.
// Uses a fresh random affiliate wallet (never writes to a real account owner);
// referral = the owner's test wallet. Records the FIRST-upgrade earned period,
// asserts the one-time-per-pair guard (AffiliateOnceOnly), pays out, then reads
// the ledger back. Run: node scripts/m6-affiliate-harness.mjs
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  handleRecordAffiliatePeriod, handleAffiliatePayout, readAffiliateLedger,
  affiliateAccountPda,
} from './affiliate-relay.mjs';
import './load-env.mjs';

async function main() {
  const affiliate = Keypair.generate().publicKey.toBase58();
  const referral = '42Xs2owrBnKsZXDfVbzxEGG3b2b3QDm3WD4uHujgSjew';
  console.log('affiliate (fresh, no owner data):', affiliate);
  console.log('affiliate PDA:', affiliateAccountPda(affiliate).toBase58());

  const period = 202608;
  console.log('\n1) record EARNED (first upgrade: 20% of $5 = 100 USD cents)');
  let r = await handleRecordAffiliatePeriod({ affiliate, referral, period, usdCents: 100, eligibility: 0 });
  console.log('   sig', String(r.sig).slice(0, 20));

  console.log('\n2) duplicate same period should error (idempotency)');
  try {
    await handleRecordAffiliatePeriod({ affiliate, referral, period, usdCents: 100, eligibility: 0 });
    console.log('   FAIL: did not reject duplicate');
  } catch (e) { console.log('   ok duplicate rejected:', e.message.slice(0, 60)); }

  console.log('\n3) a SECOND earned period (later upgrade) must be REJECTED (first-upgrade-only)');
  let onceOnly = false;
  try {
    await handleRecordAffiliatePeriod({ affiliate, referral, period: 202609, usdCents: 200, eligibility: 0 });
    console.log('   FAIL: second earned period was accepted (must be one-time)');
  } catch (e) {
    onceOnly = String(e.message || '').indexOf('AffiliateOnceOnly') >= 0
      || /one-time per referral/i.test(String(e.message || ''))
      || String(e.message || '').indexOf('6028') >= 0
      || /"Custom":6028/.test(String(e.message || ''));
    console.log('   ' + (onceOnly ? 'ok second earn rejected (one-time per pair)' : 'rejected: ' + e.message.slice(0, 80)));
  }

  console.log('\n4) payout 100 cents (pending -> paid)');
  let r3 = await handleAffiliatePayout({ affiliate, usdCents: 100, payoutRef: 9001 });
  console.log('   sig', String(r3.sig).slice(0, 20));

  console.log('\n5) read ledger back');
  const ledger = await readAffiliateLedger(affiliate);
  console.log('   lifetime', ledger && ledger.lifetimeUsdCents, 'pending', ledger && ledger.pendingUsdCents,
    'paid', ledger && ledger.paidUsdCents, 'entries', ledger && ledger.entryCount);
  if (onceOnly && ledger && ledger.lifetimeUsdCents === 100 && ledger.pendingUsdCents === 0 && ledger.paidUsdCents === 100) {
    console.log('\nPASS');
  } else {
    console.log('\nCHECK: ledger totals', JSON.stringify(ledger), 'onceOnly', onceOnly);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });