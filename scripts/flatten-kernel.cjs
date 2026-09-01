'use strict';
/**
 * flatten-kernel.cjs — flatten the root pnpm node_modules into kernel/node_modules.
 *
 * Pure real-directory copies (no symlinks / junctions), Node 22+.
 *
 * Algorithm:
 *   (a) Top-level entries of node_modules that are symlinks/junctions are resolved
 *       to their real target (pnpm layout: node_modules/.pnpm/<pkg>@<ver>[_<hash>]/node_modules/<name>).
 *       The kernel seed set is the @deepseek-ai/* dependency names from kernel/package.json.
 *   (b) BFS over (name, realDir) pairs; the first occurrence of a name wins,
 *       duplicates are skipped.
 *   (c) For each realDir's package.json, recurse into dependencies + optionalDependencies
 *       (peerDependencies ignored). A dep name is resolved against the .pnpm store:
 *       scoped  @scope/name  -> .pnpm entry dir starting with `@scope+name@`
 *       plain  name          -> .pnpm entry dir starting with `name@`
 *       multiple versions -> pick the first existing one from the directory listing.
 *       The real dir to enqueue = <.pnpm entry>/node_modules/<name>.
 *   (d) Every unique (name, realDir) is copied with fs.cpSync(realDir,
 *       kernel/node_modules/<name>, { recursive: true }) (scope parent dirs are
 *       created first; a trailing `.bin` subdir is never present in a .pnpm real dir).
 *
 * Prints: number of top-level entries in kernel/node_modules, total bytes, elapsed time.
 */

const fs = require('node:fs');
const path = require('node:path');

const t0 = Date.now();
const root = path.resolve(__dirname, '..');
const srcNM = path.join(root, 'node_modules');
const pnpmStore = path.join(srcNM, '.pnpm');
const kernelNM = path.join(root, 'kernel', 'node_modules');

// --- seed names from kernel/package.json (@deepseek-ai/* deps) ---
const kernelPkg = JSON.parse(fs.readFileSync(path.join(root, 'kernel', 'package.json'), 'utf8'));
const seedNames = Object.keys(kernelPkg.dependencies || {}).filter((n) => n.startsWith('@deepseek-ai/'));
if (seedNames.length === 0) {
  console.error('FATAL: no @deepseek-ai/* dependencies found in kernel/package.json');
  process.exit(1);
}

// --- .pnpm listing (cached) ---
const pnpmEntries = fs.readdirSync(pnpmStore, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/** Resolve a package name to the real dir inside the .pnpm store (or null). */
function resolveInPnpm(name) {
  // scoped: @scope/name -> entry prefix "@scope+name@" ; plain: "name@"
  const pref = name.startsWith('@') ? `@${name.slice(1).replace('/', '+')}@` : `${name}@`;
  for (const entry of pnpmEntries) {
    if (entry.startsWith(pref)) {
      const real = path.join(pnpmStore, entry, 'node_modules', name);
      if (fs.existsSync(path.join(real, 'package.json'))) return real;
    }
  }
  return null;
}

/** Resolve a top-level node_modules entry (junction/symlink) to its real dir. */
function resolveTopLevel(name) {
  const p = path.join(srcNM, name);
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) {
    let real;
    try { real = fs.realpathSync(p); } catch { return null; }
    if (fs.existsSync(path.join(real, 'package.json'))) return real;
    return null;
  }
  if (st.isDirectory() && fs.existsSync(path.join(p, 'package.json'))) return p; // already real
  return null;
}

// --- BFS seed: (name -> realDir), first seen wins ---
const order = []; // [{name, realDir}] in resolution order
const seen = new Map();

function enqueue(name, realDir) {
  if (!realDir || seen.has(name)) return;
  seen.set(name, realDir);
  order.push({ name, realDir });
}

for (const name of seedNames) {
  enqueue(name, resolveTopLevel(name) ?? resolveInPnpm(name));
}

const scanEntryRoot = (dir, scopePrefix = '') => {
  if (!dir || dir === kernelNM || dir === srcNM || dir === pnpmStore) return;

  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    if (e.name === '.bin') continue;
    const p = path.join(dir, e.name);
    // a scope dir (@scope) at the entry root: recurse, remembering the scope
    if (e.isDirectory() && e.name.startsWith('@') && scopePrefix === '') {
      scanEntryRoot(p, e.name);
      continue;
    }
    const fullName = scopePrefix !== '' ? scopePrefix + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (fs.existsSync(path.join(p, 'package.json'))) enqueue(fullName, p);
      continue;
    }
    if (e.isSymbolicLink()) {
      // pnpm links deps/peers as symlinks at the entry root
      let real = null;
      try { real = fs.realpathSync(p); } catch { /* broken link */ }
      if (real && fs.existsSync(path.join(real, 'package.json'))) enqueue(fullName, real);
    }
  }
};

// BFS: for every package, scan its OWN pnpm entry's virtual-store root.
// pnpm links the package's version-exact deps AND auto-installed peers there
// as siblings — scanning the entry root (instead of global name resolution)
// keeps each dependent's exact versions, including peer-only packages such as
// @deepseek-ai/cosmokit. Non-scoped: <entry>/node_modules/<name> → root =
// dirname(realDir); scoped: <entry>/node_modules/@scope/<name> → both
// dirname(realDir) and dirname(dirname(realDir)).
// BFS over `order` itself: enqueue() pushes to the back while this
// loop consumes from the front, so newly discovered packages are processed too.
let cursor = 0;
while (cursor < order.length) {
  const { realDir } = order[cursor++];
  scanEntryRoot(path.dirname(realDir));
  scanEntryRoot(path.dirname(path.dirname(realDir)));
}

// --- copy phase ---
fs.mkdirSync(kernelNM, { recursive: true });
// fresh start: remove any previous kernel/node_modules contents
for (const child of fs.readdirSync(kernelNM)) {
  fs.rmSync(path.join(kernelNM, child), { recursive: true, force: true });
}

let bytes = 0;
function dirSize(dir) {
  let sum = 0;
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, child.name);
    if (child.isDirectory()) sum += dirSize(p);
    else if (child.isFile()) { try { sum += fs.statSync(p).size; } catch {} }
  }
  return sum;
}

// Copy phase: real-dir copies. The package's own node_modules subdir is SKIPPED —
// the flat root is the single resolution layer, so nested symlink trees are dropped
// (avoiding recursive duplication of the whole store).
function copyPackage(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.bin' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyPackage(s, d);
    else if (st.isFile()) fs.copyFileSync(s, d);
    // other types (symlinks at top level of a real dir) are skipped
  }
}

for (const { name, realDir } of order) {
  const dest = path.join(kernelNM, name);
  const parent = path.dirname(dest);
  if (parent !== kernelNM) fs.mkdirSync(parent, { recursive: true });
  copyPackage(realDir, dest);
  bytes += dirSize(dest);
}

// --- report ---
const topEntries = fs.readdirSync(kernelNM).length;
const scopedDirs = fs.readdirSync(kernelNM).filter((n) => n.startsWith('@'));
const scopeCounts = {};
for (const s of scopedDirs) {
  scopeCounts[s] = fs.readdirSync(path.join(kernelNM, s)).length;
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log(`[flatten] top-level entries: ${topEntries} (scoped: ${JSON.stringify(scopeCounts)})`);
console.log(`[flatten] packages copied: ${order.length}`);
console.log(`[flatten] total bytes: ${bytes} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`[flatten] elapsed: ${elapsed}s`);
