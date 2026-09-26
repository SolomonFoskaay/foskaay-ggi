// scripts/dev.mjs
// Runs the sponsor relay + Vite dev server together (Node >= 18 compatible).
// `npm run dev`

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const node = process.execPath;

const relay = spawn(node, ['scripts/relay-server.mjs'], { cwd: root, stdio: 'inherit' });
const vite = spawn(node, ['node_modules/vite/bin/vite.js', '--host'], { cwd: root, stdio: 'inherit' });

function shutdown(signal) {
  console.log(`\n[dev] ${signal} received — stopping relay + vite`);
  relay.kill('SIGTERM');
  vite.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
