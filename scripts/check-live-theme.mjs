#!/usr/bin/env node
// Compare the live theme against a git ref (origin/main by default) and list
// every file that differs, with the commit each stale live file matches.
//
// The GitHub-connected live theme can silently miss files: Shopify deploys
// each push on its own diff, and a push that lands while an earlier one is
// still deploying can be dropped. Run this after every merge to main (wait a
// couple of minutes first) and before any UAT pass.
//
// Read-only: it pulls the live theme into a temp dir and never pushes.
//
//   node scripts/check-live-theme.mjs
//   node scripts/check-live-theme.mjs --ref origin/main --theme 188846997785
//   node scripts/check-live-theme.mjs --live-dir /tmp/live   # reuse a pull
//
// Exits 0 when live matches the ref, 1 when it doesn't, 2 on errors.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const THEME_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
// Owned by the theme editor, not by git.
const IGNORED = new Set(['config/settings_data.json']);

const args = { store: 'texasbookman.myshopify.com', theme: '188846997785', ref: 'origin/main', liveDir: null, fetch: true };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--store') args.store = next();
  else if (a === '--theme') args.theme = next();
  else if (a === '--ref') args.ref = next();
  else if (a === '--live-dir') args.liveDir = next();
  else if (a === '--no-fetch') args.fetch = false;
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

const git = (...a) => execFileSync('git', a, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const gitText = (...a) => git(...a).toString().trim();

if (args.fetch && args.ref.startsWith('origin/')) git('fetch', '--quiet', 'origin');
const sha = gitText('rev-parse', '--short', args.ref);

let liveDir = args.liveDir;
let tempDir = null;
if (!liveDir) {
  tempDir = mkdtempSync(join(tmpdir(), 'live-theme-'));
  liveDir = tempDir;
  console.error(`Pulling theme ${args.theme} from ${args.store} ...`);
  try {
    execFileSync('shopify', ['theme', 'pull', '--store', args.store, '--theme', args.theme, '--path', liveDir], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (e) {
    console.error('shopify theme pull failed');
    process.exit(2);
  }
}

// Shopify adds a comment header to JSON it writes, drops "disabled": false,
// and may reformat. Compare JSON by value, everything else byte for byte
// after normalising line endings.
function normalise(path, buf) {
  const text = buf.toString('utf8').replace(/\r\n/g, '\n');
  if (!path.endsWith('.json')) return text;
  const stripped = text.replace(/^\s*\/\*[\s\S]*?\*\//, '').replace(/,(\s*[}\]])/g, '$1');
  const drop = (v) => {
    if (Array.isArray(v)) return v.map(drop);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) if (!(k === 'disabled' && v[k] === false)) out[k] = drop(v[k]);
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(drop(JSON.parse(stripped)));
  } catch {
    return text;
  }
}

function listLive(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  for (const d of THEME_DIRS) if (existsSync(join(dir, d))) walk(join(dir, d));
  return out;
}

const gitFiles = gitText('ls-tree', '-r', '--name-only', args.ref, '--', ...THEME_DIRS).split('\n').filter(Boolean);
const liveFiles = listLive(liveDir);
const all = [...new Set([...gitFiles, ...liveFiles])].filter((f) => !IGNORED.has(f)).sort();
const inGit = new Set(gitFiles);
const inLive = new Set(liveFiles);

// Find the newest commit on the ref whose copy of `path` matches the live copy.
function matchingCommit(path, liveNorm) {
  const commits = gitText('log', '--format=%h', '-40', args.ref, '--', path).split('\n').filter(Boolean);
  for (const c of commits) {
    let blob;
    try {
      blob = git('show', `${c}:${path}`);
    } catch {
      continue;
    }
    if (normalise(path, blob) === liveNorm) return gitText('log', '-1', '--format=%h %ad %an: %s', '--date=short', c);
  }
  return null;
}

const problems = [];
for (const f of all) {
  if (!inLive.has(f)) {
    problems.push(`missing on live: ${f}`);
    continue;
  }
  if (!inGit.has(f)) {
    problems.push(`only on live (not in ${args.ref}): ${f}`);
    continue;
  }
  const want = normalise(f, git('show', `${args.ref}:${f}`));
  const have = normalise(f, readFileSync(join(liveDir, f)));
  if (want === have) continue;
  const match = matchingCommit(f, have);
  problems.push(`DIFFERS: ${f}${match ? ` (live matches ${match})` : ' (live matches no recent commit: edited on Shopify?)'}`);
}

if (tempDir) rmSync(tempDir, { recursive: true, force: true });

if (problems.length === 0) {
  console.log(`Live theme ${args.theme} matches ${args.ref} (${sha}).`);
  process.exit(0);
}
console.log(`Live theme ${args.theme} differs from ${args.ref} (${sha}) in ${problems.length} file(s):`);
for (const p of problems) console.log(`- ${p}`);
console.log(
  '\nMain already has these files, so another merge will not redeploy them. Push just these files to live ' +
    '(shopify theme push --theme <live id> --allow-live --nodelete --only <file> ...) once nobody is editing the live theme, then rerun this check.',
);
process.exit(1);
