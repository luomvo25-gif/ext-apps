// Test that all SDK entry points import without errors
import { createRequire } from 'module';
import { readdir, access } from 'fs/promises';
import { join } from 'path';

const UNWANTED_DEPS = [
  // Bun platform binaries
  '@oven/bun-darwin-aarch64',
  '@oven/bun-darwin-x64',
  '@oven/bun-darwin-x64-baseline',
  '@oven/bun-linux-aarch64',
  '@oven/bun-linux-aarch64-musl',
  '@oven/bun-linux-x64',
  '@oven/bun-linux-x64-baseline',
  '@oven/bun-linux-x64-musl',
  '@oven/bun-linux-x64-musl-baseline',
  '@oven/bun-windows-x64',
  '@oven/bun-windows-x64-baseline',
  // Rollup platform binaries
  '@rollup/rollup-darwin-arm64',
  '@rollup/rollup-darwin-x64',
  '@rollup/rollup-linux-arm64-gnu',
  '@rollup/rollup-linux-x64-gnu',
  '@rollup/rollup-win32-arm64-msvc',
  '@rollup/rollup-win32-x64-msvc',
];

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  PASS  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

// ── 1. Import checks ──────────────────────────────────────────────────────────
console.log('\n── Import checks ──');

try {
  const mainPkg = await import('@modelcontextprotocol/ext-apps');
  if (typeof mainPkg !== 'object') throw new Error('not an object');
  ok('main entry: @modelcontextprotocol/ext-apps');
} catch (e) {
  fail('main entry: @modelcontextprotocol/ext-apps', e.message);
}

try {
  const serverPkg = await import('@modelcontextprotocol/ext-apps/server');
  if (typeof serverPkg !== 'object') throw new Error('not an object');
  // Check for expected exports
  const expectedExports = ['registerAppTool', 'registerAppResource'];
  for (const exp of expectedExports) {
    if (typeof serverPkg[exp] === 'function') {
      ok(`server entry exports ${exp}`);
    } else {
      fail(`server entry exports ${exp}`, `got ${typeof serverPkg[exp]}`);
    }
  }
} catch (e) {
  fail('server entry: @modelcontextprotocol/ext-apps/server', e.message);
}

try {
  const bridgePkg = await import('@modelcontextprotocol/ext-apps/app-bridge');
  if (typeof bridgePkg !== 'object') throw new Error('not an object');
  ok('app-bridge entry: @modelcontextprotocol/ext-apps/app-bridge');
} catch (e) {
  fail('app-bridge entry: @modelcontextprotocol/ext-apps/app-bridge', e.message);
}

// ── 2. Unwanted deps check ────────────────────────────────────────────────────
console.log('\n── Unwanted deps check ──');

const nmPath = new URL('./node_modules', import.meta.url).pathname;

for (const dep of UNWANTED_DEPS) {
  // scoped packages live in node_modules/@scope/name
  const depPath = join(nmPath, ...dep.split('/'));
  try {
    await access(depPath);
    fail(`absent: ${dep}`, 'directory exists — unwanted dep is present!');
  } catch {
    ok(`absent: ${dep}`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
