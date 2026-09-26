// scripts/agm-lobby-e2e.mjs — devnet end-to-end: post->match->lock->settle + P2C via the relay module.
import { agmPost, agmList, agmMatch, agmLock, agmSettle, agmP2cFund, agmP2cSettle } from './agm-relay.mjs';
import { Keypair } from '@solana/web3.js';

const mk = Keypair.generate().publicKey.toBase58(); // authenticated wallet !== sponsor
const r1 = await agmPost({ game: 1, stakeUsdCents: 500, seats: 2, maker: mk });
console.log('POST   -> order', r1.orderId, 'status', r1.order.status, 'maker-match', r1.order.maker === mk);

const r2 = await agmMatch({ game: 1, orderId: r1.orderId, taker: 'guest' });
console.log('MATCH  -> status', r2.order.status, 'taker!=maker', r2.order.taker !== r2.order.maker);

let self = false;
try { await agmMatch({ game: 1, orderId: r1.orderId, taker: mk }); } catch (e) { self = true; }
console.log('SELF-MATCH blocked:', self);

const r3 = await agmLock({ game: 1, orderId: r1.orderId, winnerSeat: 0 });
console.log('LOCK   -> status', r3.order.status, 'pot $' + (r3.pot_usd_cents / 100));

const r4 = await agmSettle({ game: 1, orderId: r1.orderId });
console.log('SETTLE -> status', r4.order.status);

await agmP2cFund({ game: 1, amountUsdCents: 100000 });
const r5 = await agmP2cSettle({ game: 1, orderId: r1.orderId, computerSeat: 1, computerWon: false });
const b = r5.bank;
const n = (x) => Number(x);
console.log('P2C    -> balance $' + (n(b.balanceUsdCents) / 100) + ' dayNet $' + (n(b.dayNetUsdCents) / 100) + ' trades ' + n(b.trades));

const lst = await agmList({});
console.log('LOBBY  -> ' + lst.count + ' orders, latest #' + lst.orders[0].order_id + ' status ' + lst.orders[0].status);

const pass = r1.order.status === 0 && r2.order.status === 2 && self && r3.order.status === 1 && r4.order.status === 1 && n(b.trades) >= 1;
console.log('AGM LOBBY E2E PASS:', pass ? 'YES' : 'NO');
process.exit(0);