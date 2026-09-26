#!/usr/bin/env node
// scripts/set-roadmap-status.mjs
// Mark the lifecycle stage of a roadmap feature as it's being built.
//
// Usage:
//   node scripts/set-roadmap-status.mjs "<title>" <planned|in-progress>
//
// Security note: changelog.json is public, browser-served data. Unfixed
// security/anti-exploit work must NOT be added here — track it in
// docs/changelog/security-queue.md instead (see add-roadmap.mjs).
//
// Statuses: planned -> in-progress -> shipped (shipped happens via
// scripts/bump-version.mjs, which promotes the item into a changelog entry).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANGELOG = join(ROOT, 'public', 'changelog', 'changelog.json');

const title = process.argv[2] || '';
const status = (process.argv[3] || '').toLowerCase();

if (!title || !['planned', 'in-progress'].includes(status)) {
  console.error('Usage: node scripts/set-roadmap-status.mjs "<title>" <planned|in-progress>');
  process.exit(1);
}
if (!existsSync(CHANGELOG)) {
  console.error('changelog.json not found');
  process.exit(1);
}

const data = JSON.parse(readFileSync(CHANGELOG, 'utf8'));
if (!Array.isArray(data.roadmap)) {
  console.error('No roadmap array in changelog.json');
  process.exit(1);
}

const norm = s => String(s).toLowerCase().trim();
const item = data.roadmap.find(r => norm(r.title) === norm(title));
if (!item) {
  console.error(`No roadmap item titled "${title}". Add it first: node scripts/add-roadmap.mjs "<title>" "<summary>"`);
  process.exit(1);
}

const prev = item.status;
item.status = status;
writeFileSync(CHANGELOG, JSON.stringify(data, null, 2) + '\n');
console.log(`roadmap: "${item.title}" ${prev} -> ${status}`);