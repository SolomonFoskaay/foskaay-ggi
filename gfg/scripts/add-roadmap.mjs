#!/usr/bin/env node
// scripts/add-roadmap.mjs
// Record an agreed feature in the Feature Tracker BEFORE coding it.
//
// Usage:
//   node scripts/add-roadmap.mjs "<title>" "<user summary>" [--approved]
//
// APPROVAL GATE (important):
//   By default a new roadmap item is ADMIN-ONLY: it shows on
//   /changelog/admin.html (technical pipeline) but is HIDDEN from the public
//   /changelog/ user page until YOU approve it. To publish it to the user
//   page now, pass --approved. Otherwise approve later with:
//     node scripts/approve-roadmap.mjs "<title>" "<user summary>"
//   Nothing technical/sensitive ever reaches the user page without your
//   explicit approval.
//
// SECURITY NOTE: do NOT record security/anti-exploit work here — not even as
// admin-only. Anything in changelog.json is served to browsers and is public
// data. Track unfixed security work ONLY in docs/changelog/security-queue.md
// (private git, never served). When a security fix ships, add it here as a
// normal shipped feature.
//
// What it does:
//   1. Appends a roadmap item to public/changelog/changelog.json under the
//      `roadmap` array with status "planned".
//   2. The item carries TWO views:
//      - `summary` : the optional public-facing, watered-down user view (what
//        the player gets, in plain language) — shown on /changelog/ ONLY after
//        approval.
//      - `details` : the admin-only engineer view — technical bullets folded
//        from docs/changelog/unreleased.md (what changes under the hood).
//   3. Leaves unreleased.md untouched so the same bullets feed the eventual
//      release bump.
//
// Status lifecycle (mark as you build, don't delete the entry):
//   planned -> in-progress -> shipped
//   set:   node scripts/set-roadmap-status.mjs "<title>" in-progress
//   ship:  node scripts/bump-version.mjs <major|minor|patch> "<title>" "<summary>"
//          (promotes the matching roadmap item into a shipped changelog entry)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANGELOG = join(ROOT, 'public', 'changelog', 'changelog.json');
const UNRELEASED = join(ROOT, 'docs', 'changelog', 'unreleased.md');

const title = process.argv[2] || '';
const summary = process.argv[3] || '';
const approved = process.argv.includes('--approved');

if (!title) {
  console.error('Usage: node scripts/add-roadmap.mjs "<title>" "<user summary>" [--approved]');
  process.exit(1);
}

// ---- 1. load changelog store ----
let data = { current: '', entries: [], roadmap: [] };
if (existsSync(CHANGELOG)) {
  try { data = JSON.parse(readFileSync(CHANGELOG, 'utf8')); } catch (e) {
    console.error('changelog.json unparseable:', e.message);
    process.exit(1);
  }
}
if (!Array.isArray(data.entries)) data.entries = [];
if (!Array.isArray(data.roadmap)) data.roadmap = [];

// ---- 2. guard against duplicates ----
const norm = s => String(s).toLowerCase().trim();
if (data.roadmap.some(r => norm(r.title) === norm(title))) {
  console.error(`Roadmap already has "${title}". If its status needs changing, use scripts/set-roadmap-status.mjs.`);
  process.exit(1);
}

// ---- 3. fold engineer notes from unreleased.md into dev-only details ----
const details = [];
if (existsSync(UNRELEASED)) {
  const body = readFileSync(UNRELEASED, 'utf8').trim();
  if (body) {
    for (const l of body.split(/\r?\n/)) {
      const t = l.trim();
      if (t && !t.startsWith('#')) details.push(t.replace(/^[-*]\s*/, ''));
    }
  }
}

const item = {
  title,
  summary: summary || '',
  details,
  status: 'planned',
  approved, // admin-only until you approve for the user page
  added: new Date().toISOString().slice(0, 10),
};
data.roadmap.push(item);

writeFileSync(CHANGELOG, JSON.stringify(data, null, 2) + '\n');

console.log(`\nroadmap added (status: planned): "${item.title}"`);
console.log(`approved for user view : ${approved ? 'YES (public /changelog/)' : 'NO (admin-only until approved)'}`);
console.log(`user view  : ${item.summary || '(none — add one when approving)'}`);
console.log(`dev view   : ${item.details.length} bullet(s) folded from unreleased.md`);
console.log(`raw on     : /changelog/admin.html\n`);
if (!approved) {
  console.log('Approve it for the user page with:');
  console.log(`  node scripts/approve-roadmap.mjs "${title}" "<user summary>"\n`);
}
console.log('Now mark progress with: node scripts/set-roadmap-status.mjs "<title>" in-progress');
console.log('Ship it with         : node scripts/bump-version.mjs patch "<title>" "<summary>"');