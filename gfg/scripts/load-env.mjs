// scripts/load-env.mjs
// Minimal .env loader for Node 18 (relay + lab scripts). Vite loads .env
// itself for the browser; plain Node does NOT, so the relay reads it here.
//
// Safety: never overrides env vars already set by the shell/Vercel — the
// .env file is only a local-dev fallback. GFG_DEVNET_RPC is the keyed
// Alchemy endpoint used server-side only (never shipped to the browser).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

export function loadEnv() {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (_) {
    return; // no .env file — rely on process env / Vercel dashboard
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key] && process.env[key] !== '') {
      process.env[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
}

loadEnv();