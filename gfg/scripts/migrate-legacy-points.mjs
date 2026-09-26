// scripts/migrate-legacy-points.mjs
// M3 data-preservation migration runner (see .opencode/rules/solana-upgrade-safety.md).
//
// The Scope B points ledger used seed [gfgpoints, player] (single `total_points`
// layout). M3 moved it to the per-game seed [gfgpoints, game_tag, player] with a
// two-track layout. This script migrates every tracked player's legacy account
// into the 'ludo' per-game ledger (old total split 1:1 into pure + spendable),
// via the program's permissionless, idempotent `migrate_points` instruction
// (sponsor signs as payer; the program itself preserves the data).
//
// Usage:
//   node scripts/migrate-legacy-points.mjs [playerPubkey ...] [--tag <game_tag>]
//
// With no explicit players it walks the spend ledger's tracked players.
// Idempotent: re-running is a no-op for already-migrated accounts.

import { existsSync } from 'fs';
import { loadLedger } from './spend-ledger.mjs';
import { Connection, PublicKey } from '@solana/web3.js';
import { baseRpcUrl, createConnection } from '../src/gfg-rpc.js';
import { handleMigratePoints, legacyPointsPdaFor } from './delegate-relay.mjs';

const GAME_TAG = process.argv.includes('--tag')
  ? process.argv[process.argv.indexOf('--tag') + 1]
  : 'ludo';

const explicit = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== GAME_TAG);

async function main() {
  const conn = createConnection(baseRpcUrl(), 'confirmed');

  let players = explicit;
  if (!players.length) {
    try {
      players = Object.keys(loadLedger().players || {});
    } catch (e) {
      console.error('No spend ledger found and no explicit players given.');
      process.exit(1);
    }
  }
  console.log(`Migrating legacy points -> game_tag "${GAME_TAG}" for ${players.length} player(s)...`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const player of players) {
    try {
      const pk = new PublicKey(player);
      const [legacy] = legacyPointsPdaFor(pk);
      const info = await conn.getAccountInfo(legacy);
      if (!info || info.data.length <= 8) {
        console.log(`  - ${pk.toBase58().slice(0, 12)}…  no legacy ledger (nothing to migrate)`);
        skipped++;
        continue;
      }
      const result = await handleMigratePoints(pk.toBase58(), GAME_TAG);
      if (result.migrated) {
        migrated++;
        console.log(`  - ${pk.toBase58().slice(0, 12)}…  MIGRATED ${result.legacyPda.slice(0, 8)}… -> ${result.pointsPda.slice(0, 8)}… (${result.sig})`);
      } else {
        skipped++;
        console.log(`  - ${pk.toBase58().slice(0, 12)}…  already migrated (skipped)`);
      }
    } catch (e) {
      failed++;
      console.error(`  ! ${player}: ${e.message || e}`);
    }
  }

  console.log(`\nDone. migrated: ${migrated}, skipped: ${skipped}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('\nMigration failed:', e.message || e); process.exit(1); });
