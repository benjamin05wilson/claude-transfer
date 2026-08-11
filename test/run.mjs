/**
 * Run the suite the same way everywhere.
 *
 * `node --test test/*.test.mjs` relies on the shell expanding the glob, which
 * cmd.exe does not do, and glob support inside `--test` itself only arrived in
 * Node 21 — so the obvious spellings each break on some part of the matrix this
 * project claims to support. Enumerating the files here and passing them
 * explicitly works on every version and every platform.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(here, f));

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
