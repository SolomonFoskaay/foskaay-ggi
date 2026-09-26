#!/usr/bin/env node
// scripts/bump-version.mjs
// Bump the project version and record a changelog entry.
//
// Usage:
//   node scripts/bump-version.mjs major   "Title for this release"        "One-line user summary"
//   node scripts/bump-version.mjs minor   "On-chain moves shipped"        "Game moves now validated on-chain"
//   node scripts/bump-version.mjs patch   "Fixed relay flakiness"         "Smoother onboarding"
//
// What it does:
//   1. Reads the CURRENT version from package.json (the single numeric source,
//      so npm, the site header and the changelog always agree).
//   2. Bumps it per semver (major / minor / patch).
//   3. Writes the new version back to package.json.
//   4. Appends a changelog entry to public/changelog/changelog.json.
//      - `summary` is the watered-down text shown on the public changelog.
//      - `details` gets any technical bullets you appended to docs/changelog/
//        unreleased.md (engineer notes, test findings, tables). If that file
//        is missing/empty, it is left out and the entry carries only summary.
//      - `tech` is always captured: the git commit ids + any unreleased.md body.
//   5. Clears docs/changelog/unreleased.md for the next cycle.
//
// The admin-only raw changelog page (/changelog/admin.html) shows summary +
// details + git refs; the public page (/changelog/) shows only summaries.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PKG = join(ROOT, 'package.json');
const CHANGELOG = join(ROOT, 'public', 'changelog', 'changelog.json');
const UNRELEASED = join(ROOT, 'docs', 'changelog', 'unreleased.md');

const type = (process.argv[2] || '').toLowerCase();
const title = process.argv[3] || '';
const summary = process.argv[4] || '';

if (!['major', 'minor', 'patch'].includes(type)) {
  console.error('Usage: node scripts/bump-version.mjs <major|minor|patch> "<title>" "<user summary>"');
  process.exit(1);
}

// ---- 1. read current version ----
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);

let next;
if (type === 'major') next = [maj + 1, 0, 0];
if (type === 'minor') next = [maj, min + 1, 0];
if (type === 'patch') next = [maj, min, pat + 1];
const nextVersion = next.join('.');

// ---- 2. changelog store ----
let changelog = { current: nextVersion, entries: [] };
if (existsSync(CHANGELOG)) {
  try { changelog = JSON.parse(readFileSync(CHANGELOG, 'utf8')); } catch (e) { console.warn('changelog.json unparseable, starting fresh:', e.message); }
}
const prevVersion = pkg.version;
changelog.current = nextVersion;
if (!Array.isArray(changelog.entries)) changelog.entries = [];

// ---- 3. capture engineer notes from docs/changelog/unreleased.md ----
let details = [];
if (existsSync(UNRELEASED)) {
  const body = readFileSync(UNRELEASED, 'utf8').trim();
  if (body) details = body.split(/\r?\n/).filter(l => l.trim()).map(l => l.trim().replace(/^[-*]\s*/, ''));
}

// ---- 4. git refs for the admin raw view ----
function git(args) {
  try { return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return ''; }
}
const head = git('rev-parse --short HEAD');
const headMsg = git('log -1 --pretty=%s');

// ---- 5. append entry (promote a matching roadmap item if one exists) ----
// The Feature Tracker workflow: features are recorded first via
// scripts/add-roadmap.mjs (planned -> in-progress), then promoted here into a
// shipped changelog entry. If a roadmap item's title matches this release,
// its summary/details carry over; otherwise this entry is created fresh.
const norm = s => String(s).toLowerCase().trim();
if (!Array.isArray(changelog.roadmap)) changelog.roadmap = [];
const roadmapIdx = changelog.roadmap.findIndex(r => norm(r.title) === norm(title));
const roadmapItem = roadmapIdx >= 0 ? changelog.roadmap[roadmapIdx] : null;

// Approval gate: a roadmap item may only be promoted to a shipped entry (which
// always appears on the public /changelog/ page) once the owner has approved it
// for the user page via scripts/approve-roadmap.mjs. Unapproved (admin-only)
// items must never leak to public via a release.
if (roadmapItem && roadmapItem.approved !== true) {
  console.error(`"${roadmapItem.title}" is NOT approved for the user page yet.`);
  console.error(`Approve it first: node scripts/approve-roadmap.mjs "${title}" "<user summary>"`);
  console.error('or remove --promote intent by shipping a title that is not an unapproved roadmap item.');
  process.exit(1);
}

// Merge engineer notes: roadmap details (if any) + fresh unreleased.md bullets.
const mergedDetails = roadmapItem
  ? [...(roadmapItem.details || []), ...details].filter((v, i, arr) => arr.indexOf(v) === i)
  : details;

// SECURITY: nothing sensitive is ever stored in changelog.json (client-served
// data) — security/anti-exploit work is tracked only in
// docs/changelog/security-queue.md (private git, never served). So a shipped
// entry here is always safe to show publicly. Do NOT reintroduce a flag to
// hide entries; keep the bytes out of the client payload entirely.
const entry = {
  version: nextVersion,
  date: new Date().toISOString().slice(0, 10),
  type,                                // major | minor | patch
  title: title || `v${nextVersion}`,
  summary: summary || (roadmapItem && roadmapItem.summary) || '', // public-facing (watered down)
  details: mergedDetails,              // technical bullets (admin only)
  git: head && headMsg ? { head, message: headMsg } : undefined,
};
changelog.entries.unshift(entry);
if (roadmapItem) changelog.roadmap.splice(roadmapIdx, 1);

writeFileSync(CHANGELOG, JSON.stringify(changelog, null, 2) + '\n');
pkg.version = nextVersion;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

// ---- 6. clear the unreleased notes for the next cycle ----
mkdirSync(dirname(UNRELEASED), { recursive: true });
writeFileSync(UNRELEASED, '');

console.log(`\nbumped ${prevVersion} -> ${nextVersion} (${type})`);
console.log(`changelog entry: "${entry.title}"`);
console.log(`public changelog: /changelog/  ·  admin raw: /changelog/admin.html\n`);
console.log('Recorded git ref:', entry.git ? `${entry.git.head} — ${entry.git.message}` : '(no git)');
if (roadmapItem) console.log(`roadmap promoted: "${roadmapItem.title}" (${roadmapItem.details.length} recorded details) -> shipped entry`);
if (!mergedDetails.length) console.log('note: no technical bullets captured — entry is summary only.');