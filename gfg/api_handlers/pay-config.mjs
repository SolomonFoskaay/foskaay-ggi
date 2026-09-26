// api/pay-config.mjs — public, client-safe payment network config.
// The client fetches this so the running site can use whichever payment
// cluster the server is set to (mainnet by default; devnet for the admin
// test submenu) without a rebuild. No secrets.
import { publicPayConfig } from '../scripts/pay-config.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json(publicPayConfig());
}