#!/usr/bin/env node
// scripts/approve-roadmap.mjs
// Publish a roadmap item to the public user page.
//
// Usage:
//   node scripts/approve-roadmap.mjs "<title>" "<user summary>"
//
// Without this step a roadmap item stays ADMIN-ONLY: visible on
// /changelog/admin.html (the technical pipeline) but hidden from the public
// /changelog/ user page. Running this is YOUR explicit approval that the item
// is safe and appropriate for players to see. It sets `approved: true` and
// stores the user-facing summary.
//
// Security note: changelog.json is public, browser-served data. Do NOT approve
// anything that reveals unfixed security/anti-exploit work — that never belongs
// here (track it in docs/changelog/security-queue.md instead). Approval is for
// normal user-relevant features/UX only.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANGELOG = join(ROOT, 'public', 'changelog', 'changelog.json');

const title = process.argv[2] || '';
const summary = process.argv[3] || '';

if (!title || !summary) {
  console.error('Usage: node scripts/approve-roadmap.mjs "<title>" "<user summary>"');
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

item.approved = true;
item.summary = summary;
writeFileSync(CHANGELOG, JSON.stringify(data, null, 2) + '\n');
console.log(`roadmap: "${item.title}" APPROVED for the user page /changelog/`);
console.log(`user view  : ${item.summary}`);
console.log(`dev view   : ${(item.details || []).length} bullet(s) — still admin-only on /changelog/admin.html`);