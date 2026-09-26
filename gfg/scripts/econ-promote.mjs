#!/usr/bin/env node
// scripts/econ-promote.mjs
// Move an economics idea forward in the admin Game Economics pipeline.
//
// Usage:
//   node scripts/econ-promote.mjs "<title>" fine-tuned
//   node scripts/econ-promote.mjs "<title>" ready
//
// Pipeline: raw -> fine-tuned -> ready. When an item reaches "ready" it is
// finalized; promote it into the normal changelog roadmap (planned /
// in-progress) with:
//   node scripts/add-roadmap.mjs "<title>" "<user summary>"
//
// Security note: economics.json is client-served (admin-gated). Unfixed
// security/anti-exploit work must NEVER go here — keep it in
// docs/changelog/security-queue.md only (see add-roadmap.mjs rules).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ECON = join(ROOT, 'public', 'changelog', 'economics.json');

const title = process.argv[2] || '';
const stage = (process.argv[3] || '').toLowerCase();

if (!title || !['raw', 'fine-tuned', 'ready'].includes(stage)) {
  console.error('Usage: node scripts/econ-promote.mjs "<title>" <raw|fine-tuned|ready>');
  process.exit(1);
}
if (!existsSync(ECON)) {
  console.error('economics.json not found');
  process.exit(1);
}

const data = JSON.parse(readFileSync(ECON, 'utf8'));
if (!Array.isArray(data.items)) data.items = [];

const norm = s => String(s).toLowerCase().trim();
const item = data.items.find(i => norm(i.title) === norm(title));
if (!item) {
  console.error(`No economics item titled "${title}". Add it first: node scripts/econ-add.mjs "<title>"`);
  process.exit(1);
}

const prev = item.stage;
item.stage = stage;
item.updated = new Date().toISOString().slice(0, 10);
data.updated = item.updated;
writeFileSync(ECON, JSON.stringify(data, null, 2) + '\n');

console.log(`econ: "${item.title}" ${prev} -> ${stage}`);
if (stage === 'ready') {
  console.log('\nPromote this finalized design into the public roadmap with:');
  console.log('  node scripts/add-roadmap.mjs "<title>" "<user summary>"');
}
if (prev === 'ready' && stage !== 'ready') {
  console.log('\nNote: moved a ready item backward. Re-promote it to ready once re-finalized.');
}