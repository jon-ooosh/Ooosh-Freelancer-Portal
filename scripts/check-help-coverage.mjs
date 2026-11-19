#!/usr/bin/env node
// Keeps the staff Help guides honest (help/README.md). Two checks, no dependencies:
//
//  1. Every guide is well formed: the fixed parts are there, its pictures exist, the guides
//     it points at exist.
//  2. A change to code a guide `covers` must come with a change to that guide — new steps or
//     pictures, or at least a new `checked` date once someone has confirmed it still reads
//     true. Otherwise the guide quietly goes stale, which is worse than having none.
//
//   node scripts/check-help-coverage.mjs            # shape only
//   node scripts/check-help-coverage.mjs origin/main  # shape + what changed since that ref
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(ROOT, 'help', 'guides');
const problems = [];
const guides = [];

for (const slug of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const file = path.join(DIR, slug, 'guide.json');
  if (!existsSync(file)) { problems.push(`${slug}: no guide.json`); continue; }
  let g;
  try { g = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { problems.push(`${slug}: guide.json is not valid JSON (${e.message})`); continue; }
  guides.push({ slug, ...g });
  const need = (ok, what) => { if (!ok) problems.push(`${slug}: ${what}`); };
  need(/^[a-z0-9-]+$/.test(slug), 'folder name must be lower-case words joined by hyphens');
  for (const k of ['title', 'area', 'who', 'summary']) need(typeof g[k] === 'string' && g[k].trim(), `"${k}" is missing`);
  need(/^\d{4}-\d{2}-\d{2}$/.test(g.checked || ''), '"checked" must be a date, YYYY-MM-DD');
  for (const k of ['useWhen', 'notWhen', 'steps', 'next', 'wrong', 'routes', 'covers']) need(Array.isArray(g[k]) && g[k].length > 0, `"${k}" must be a list with something in it`);
  for (const [i, s] of (g.steps || []).entries()) {
    need(typeof s.text === 'string' && s.text.trim(), `step ${i + 1} has no text`);
    if (s.image) need(existsSync(path.join(DIR, slug, s.image)), `step ${i + 1}: picture ${s.image} is not in the guide's folder`);
  }
}
const slugs = new Set(guides.map((g) => g.slug));
for (const g of guides) {
  const refs = [...(g.related || []), ...(g.notWhen || []).map((n) => n.see), ...(g.steps || []).map((s) => s.see)].filter(Boolean);
  for (const r of refs) if (!slugs.has(r)) problems.push(`${g.slug}: points at a guide that does not exist ("${r}")`);
}

// ── What changed ──
const base = process.argv[2];
if (base) {
  const changed = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT }).toString().split('\n').filter(Boolean);
  // 'a/**' = anything under a/; '*' = anything within one folder.
  const toRegex = (glob) => new RegExp(`^${glob.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  for (const g of guides) {
    const touched = changed.filter((f) => (g.covers || []).some((c) => toRegex(c).test(f)));
    if (touched.length === 0) continue;
    if (changed.some((f) => f.startsWith(`help/guides/${g.slug}/`))) continue;
    problems.push(
      `help/guides/${g.slug} ("${g.title}") describes code this change touches:\n`
      + touched.map((f) => `      ${f}`).join('\n')
      + '\n    Update the guide (steps, pictures: help/README.md) — or, if it still reads true, set its "checked" date to today.',
    );
  }
}

if (problems.length) {
  console.error(`Help guides: ${problems.length} thing${problems.length === 1 ? '' : 's'} to sort\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
console.log(`Help guides: ${guides.length} guide${guides.length === 1 ? '' : 's'} OK${base ? `, nothing stale against ${base}` : ''}.`);
