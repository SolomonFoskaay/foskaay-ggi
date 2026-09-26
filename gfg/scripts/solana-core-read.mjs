// scripts/solana-core-read.mjs — read a player's Solana Player Core (server-side).
// Shared by the batch migration script and the relayer's lazy login migration.
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program } from '@anchor-lang/core';
import { readFileSync } from 'fs';
import { baseRpcUrl, createConnection, getDelegationStatus, regionUrlForFqdn, pickErRpcUrl } from '../src/gfg-rpc.js';

const IDL = JSON.parse(readFileSync(new URL('../src/gfg-dice-idl.json', import.meta.url), 'utf8'));
const PROGRAM_ID = new PublicKey(IDL.address);
const conn = createConnection(baseRpcUrl(), 'confirmed');
const noWallet = {
  publicKey: Keypair.generate().publicKey,
  signTransaction: async (t) => t,
  signAllTransactions: async (t) => t,
};
const program = new Program(IDL, new AnchorProvider(conn, noWallet, { commitment: 'confirmed' }));

export function corePdaFor(player) {
  return PublicKey.findProgramAddressSync([Buffer.from('gfgcore'), player.toBytes()], PROGRAM_ID)[0];
}

/// Read the Solana Player Core for a wallet (hosting ER region first, then base).
export async function readSolanaCore(playerStr) {
  let pk; try { pk = new PublicKey(playerStr); } catch (e) { return null; }
  const pda = corePdaFor(pk);
  try {
    const st = await getDelegationStatus(conn, pda);
    if (st && st.isDelegated) {
      const url = regionUrlForFqdn(st.fqdn) || pickErRpcUrl();
      const c = createConnection(url, 'confirmed', 8000);
      const info = await c.getAccountInfo(pda).catch(() => null);
      if (info) {
        try { return await program.account.playerCore.fetch(pda); } catch (e) { /* decode below */ }
      }
    }
  } catch (e) { /* fall through */ }
  return program.account.playerCore.fetch(pda).catch(() => null);
}

const n = (v) => { if (v == null) return 0; try { return Number(v.toString()); } catch (e) { return 0; } };

/// Extract the migration payload from a decoded core (all figures are raw points).
export function coreBalances(core, tag) {
  if (!core) return null;
  const list = core.buckets || [];
  let bucket = { pure: 0, spendable: 0 };
  for (let i = 0; i < n(core.bucketCount); i++) {
    const t = Buffer.from(list[i].gameTag).toString('utf8').replace(/\0+$/, '');
    if (t === tag) { bucket = { pure: n(list[i].localPure), spendable: n(list[i].localSpendable) }; break; }
  }
  return {
    tag,
    localPure: bucket.pure,
    localSpendable: bucket.spendable,
    globalPure: n(core.globalPure),
    globalLifetime: n(core.globalLifetime),
    globalSpendable: n(core.globalSpendable),
    premiumLifetime: n(core.premiumLifetime),
    premiumSpendable: n(core.premiumSpendable),
    level: n(core.subscriptionLevel),
    activeUntil: n(core.subscriptionActiveUntil),
  };
}

export function hasBalances(b) {
  return !!(b && (b.localPure || b.localSpendable || b.globalPure || b.globalLifetime || b.globalSpendable || b.premiumLifetime || b.premiumSpendable || b.level));
}
