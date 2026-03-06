#!/usr/bin/env node
/**
 * Fast batch typecheck of the SDK + all examples using tsgo (TypeScript native preview).
 *
 * This runs `tsgo -b` in build mode against every example's tsconfig in a single
 * process. On a 14-core machine this checks ~45 configs in <1s, vs ~50s for
 * individual `tsc --noEmit` invocations.
 *
 * Used by:
 *   - CI: fast-fail before the full examples:build (which still runs tsc for .d.ts emission)
 *   - pre-commit: typecheck everything without bundling
 *
 * Note: tsgo is a nightly preview. We pin a specific build in devDependencies.
 * It's used for --noEmit checking only; .d.ts emission still uses tsc (see build.bun.ts)
 * because tsgo's declaration emit has known nondeterminism (microsoft/typescript-go#1570).
 */
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const exampleDirs = readdirSync("examples", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `examples/${d.name}`);

// SDK root tsconfig + every example's client & server tsconfig that exists.
const projects = [
  "tsconfig.json",
  ...exampleDirs.flatMap((dir) =>
    ["tsconfig.json", "tsconfig.server.json"]
      .map((f) => `${dir}/${f}`)
      .filter(existsSync),
  ),
];

console.log(`Typechecking ${projects.length} projects with tsgo...`);

// Resolve tsgo's JS entrypoint directly and run it with the current Node.
// Avoids PATH/shim issues on Windows (no .cmd resolution needed).
// The package only exports ./package.json, so resolve that and derive the bin path.
const require = createRequire(import.meta.url);
const tsgoPkg = require("@typescript/native-preview/package.json");
const tsgoDir = dirname(
  require.resolve("@typescript/native-preview/package.json"),
);
const tsgoBin = join(tsgoDir, tsgoPkg.bin.tsgo);

// --noEmit prevents .d.ts output for configs with emitDeclarationOnly (SDK root,
// server tsconfigs). Unlike tsc, tsgo permits -b --noEmit together.
const result = spawnSync(
  process.execPath,
  [tsgoBin, "-b", "--noEmit", ...projects],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
