#!/usr/bin/env node
/**
 * Build pipeline for @ahumanflourish/portfolio-core.
 *
 * One core, three targets:
 *
 *   1. dist/esm/              ESM library + .d.ts, for the Next.js site.
 *   2. dist/html/…offline.html  One file, no network, engine + data inlined.
 *   3. dist/artifact/…artifact.js  One JS blob, no imports, for claude.ai.
 *
 * Bundler: esbuild, pinned. It is the boring choice — one binary, no plugin
 * graph, deterministic output, first-class JSON inlining and IIFE output,
 * which is precisely the shape targets 2 and 3 need. Rollup would need a
 * plugin each for TypeScript and JSON; Vite would drag a dev server and an
 * HTML pipeline in for a page that is 90 lines of static markup; tsc alone
 * cannot inline JSON into a single file. Type declarations still come from
 * tsc, because esbuild does not emit them and should not pretend to.
 *
 * Determinism: the same inputs and the same pinned esbuild produce identical
 * bytes. Nothing here stamps a date, a hostname, a version or a random id into
 * the output, and `absWorkingDir` is fixed so esbuild's path comments do not
 * vary with the caller's cwd. `npm run build && sha256sum` twice is the check.
 *
 * Usage:  node build.mjs [--no-acceptance]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { findExternalReferences } from './lib/verify-offline.mjs';

const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = join(BUILD_DIR, '..', 'core');
const DIST = join(BUILD_DIR, 'dist');

const DATA_FILES = ['benchmarks.json', 'strategies.json', 'fixtures.json'];

/** Shared esbuild settings. `neutral` keeps Node and browser shims out. */
const COMMON = {
  absWorkingDir: BUILD_DIR,
  bundle: true,
  platform: 'neutral',
  target: ['es2022'],
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  write: false,
};

const emitted = [];

/** Write a file, remember it for the size report. */
function emit(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  emitted.push({
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return bytes;
}

function step(n, what) {
  console.log(`\n[${n}] ${what}`);
}

// ─────────────────────────────────────────────────────────── clean

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ──────────────────────────────────────────── 1. ESM library target

step(1, 'ESM library  →  dist/esm/');

const lib = await esbuild.build({
  ...COMMON,
  entryPoints: [join(CORE_DIR, 'src', 'index.ts')],
  format: 'esm',
  outfile: join(DIST, 'esm', 'index.js'),
});
emit(join(DIST, 'esm', 'index.js'), lib.outputFiles[0].contents);

// Data ships beside the library so the site can import it directly; the core
// package already exposes it as `@ahumanflourish/portfolio-core/data/*`.
for (const f of DATA_FILES) {
  const src = join(CORE_DIR, 'src', 'data', f);
  const dest = join(DIST, 'esm', 'data', f);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  const bytes = readFileSync(dest);
  emitted.push({
    path: dest,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

// Declarations come from tsc — esbuild does not emit types.
execFileSync(
  process.execPath,
  [join(BUILD_DIR, 'node_modules', 'typescript', 'bin', 'tsc'), '-p',
   join(BUILD_DIR, 'tsconfig.build.json')],
  { stdio: 'inherit' },
);
for (const f of ['index.d.ts', 'engine.d.ts', 'index.d.ts.map', 'engine.d.ts.map']) {
  const p = join(DIST, 'esm', f);
  const bytes = readFileSync(p);
  emitted.push({
    path: p,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

// ───────────────────────── shared standalone bundle for targets 2 & 3

step(2, 'standalone bundle (engine + data inlined, IIFE)');

const standalone = await esbuild.build({
  ...COMMON,
  entryPoints: [join(BUILD_DIR, 'src', 'entry.standalone.ts')],
  format: 'iife',
  globalName: 'PortfolioCore',
  loader: { '.json': 'json' },
});
const bundleJs = Buffer.from(standalone.outputFiles[0].contents).toString('utf8');

// ─────────────────────────────────── 3. artifact payload target

const artifactPath = join(DIST, 'artifact', 'portfolio-core.artifact.js');
emit(artifactPath, bundleJs);

// ────────────────────────────────── 4. single-file offline HTML

step(3, 'single-file offline HTML  →  dist/html/');

const shell = readFileSync(join(BUILD_DIR, 'src', 'shell.html'), 'utf8');
if (!shell.includes('/*__BUNDLE__*/')) {
  throw new Error('shell.html lost its /*__BUNDLE__*/ marker');
}
// `</script` cannot legally appear outside a string literal in JS, so this
// escape is safe and prevents a data string from closing the tag early.
const inlineSafe = bundleJs.replace(/<\/script/gi, '<\\/script');
const htmlPath = join(DIST, 'html', 'portfolio-core.offline.html');
emit(htmlPath, shell.replace('/*__BUNDLE__*/', () => inlineSafe));

// ───────────────────────────────────── static offline verification

step(4, 'static verification: zero external references');

const violations = [
  ...findExternalReferences('offline.html', readFileSync(htmlPath, 'utf8'), { html: true }),
  ...findExternalReferences('artifact.js', readFileSync(artifactPath, 'utf8')),
];
if (violations.length) {
  console.error('\nEXTERNAL REFERENCES FOUND:');
  for (const v of violations) console.error('  ✗ ' + v);
  process.exit(1);
}
console.log('    ✓ offline.html   no external references, no network APIs');
console.log('    ✓ artifact.js    no imports, no bare specifiers, no network APIs');

// ─────────────────────────────────────────────────────── size report

console.log('\nemitted:');
const w = Math.max(...emitted.map((e) => relative(BUILD_DIR, e.path).length));
for (const e of emitted) {
  console.log(
    `  ${relative(BUILD_DIR, e.path).padEnd(w)}  ${String(e.bytes).padStart(7)} B  ` +
    `sha256:${e.sha256.slice(0, 16)}`,
  );
}

// ───────────────────────────────────────── acceptance (headless browser)

if (!process.argv.includes('--no-acceptance')) {
  step(5, 'acceptance: headless browser, file:// URL, zero network');
  execFileSync('python3', [join(BUILD_DIR, 'test', 'acceptance.py')], { stdio: 'inherit' });
}
