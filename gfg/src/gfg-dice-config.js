// src/gfg-dice-config.js
// One-off deployment config for the gfg-dice MagicBlock VRF program.
// baseRpcUrl is resolved via src/gfg-rpc.js (provider key env override with
// keyless failover) — see THAT file for the endpoint priority order.
// programId + idl filled in AFTER `anchor build && anchor deploy`
// (see programs/README.md for the deploy steps).
//
// GASLESS setup (Ephemeral Rollup):
//   - erRpcUrl     : MagicBlock ER devnet RPC (current best region) — rolls run
//                    here, free. The client resolves each delegated account's
//                    hosting region via the Router and targets THAT region.
//   - erValidator  : the devnet ER validator new PDAs are pinned to (AS region
//                    since 2026-08-18; devnet-us banned). Mirrors the relay's
//                    pin; purely informational here (the relay does the pin).
//   - oracleQueue  : devnet ER VRF queue (free VRF). Base-layer queue is
//                    Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh.
//   - relayUrl     : app-sponsored initialize+delegate (scripts/relay-server.mjs
//                    in dev, api/delegate.mjs on Vercel). Players hold no SOL.

import idl from './gfg-dice-idl.json';
import { baseRpcUrl, pickErRpcUrl } from './gfg-rpc.js';

export const GFG_DICE = {
  programId: 'CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ',
  idl,
  baseRpcUrl: baseRpcUrl(),
  erRpcUrl: pickErRpcUrl(), // current best ER region; rotation handled in gfg-rpc.js
  erValidator: 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57', // AS region (relay pins new PDAs here)
  oracleQueue: '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc', // devnet ER VRF queue
  relayUrl: '/api/delegate',
};
