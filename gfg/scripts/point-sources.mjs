// scripts/point-sources.mjs
// M4 shared source-tag -> source-code mapping (server side).
//
// The SAME mapping the live M4 browser module uses
// (public/universal/ledgers/global-ledger.js SOURCE_CODES). The on-chain
// record_global_points instruction takes a u8 source_code enum, NOT a game-tag
// string. Both backfill routes (relay-server.mjs + api/backfill-global.mjs)
// derive the source identity from the M3 ledger's game tag and convert it here,
// keeping M3 the only source of truth and never letting a client input a
// different source than the live path banks with.

// Mirrors the program's u8 source_code enum:
//   1=ludo, 2=ayo_olopon, 10=signup_bonus, 11=referral, 12=giveaway, 13=tier_boost
export const SOURCE_CODES = {
  ludo: 1,
  ayo_olopon: 2,
  signup_bonus: 10,
  referral: 11,
  giveaway: 12,
  tier_boost: 13,
};

// Convert an M3 game tag (the [gfgpoints, game_tag, player] seed tag) to the
// u8 source_code the record_global_points instruction expects. Returns 0 for
// an unknown tag (never a negative/invalid value).
export function sourceCodeFor(gameTag) {
  if (SOURCE_CODES[gameTag] != null) return SOURCE_CODES[gameTag];
  return 0;
}