/**
 * An import either happens or it does not.
 *
 * The original receive deleted the courier copy, then checked the format, then
 * discovered bad entries while already writing. Anything failing after the
 * delete destroyed the only copy and left a partial session behind — so these
 * tests assert what the machine looks like *after a refusal*, which is the part
 * that was wrong, rather than only that the error message appeared.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { sandbox, cli, cliFails } from './helpers.mjs';

const readBundle = (p) => JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
const writeBundle = (p, b) => writeFileSync(p, gzipSync(Buffer.from(JSON.stringify(b))));

/** Every session transcript the sandbox can see. */
function sessionCount(box) {
  const root = join(box.config, 'projects');
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const dir of readdirSync(root)) {
    try { n += readdirSync(join(root, dir)).filter((f) => f.endsWith('.jsonl')).length; } catch { /* not a dir */ }
  }
  return n;
}

const stagingLeft = (box) =>
  readdirSync(box.config).filter((f) => f.startsWith('.claude-transfer-staging-')).length;

/** A sandbox holding a valid bundle at a known path. */
function withBundle(fn) {
  const box = sandbox();
  try {
    const id = box.session(['hello']);
    const path = join(box.root, 'b.claude-transfer');
    cli(box, ['out', id, '-o', path]);
    fn(box, path);
  } finally { box.cleanup(); }
}

test('a valid bundle imports and is resumable', () => {
  withBundle((box, path) => {
    const before = sessionCount(box);
    const said = cli(box, ['in', path, '--into', box.work]);
    assert.equal(sessionCount(box), before + 1);
    assert.match(said, /resume it:/);
    assert.equal(stagingLeft(box), 0, 'no staging directory is left behind');
  });
});

test('an unsupported format is refused and nothing is written', () => {
  withBundle((box, path) => {
    const b = readBundle(path);
    b.format = 99;
    writeBundle(path, b);

    const before = sessionCount(box);
    const { failed, output } = cliFails(box, ['in', path, '--into', box.work]);
    assert.ok(failed);
    assert.match(output, /format 99/);
    assert.equal(sessionCount(box), before, 'the session count must be unchanged');
    assert.equal(stagingLeft(box), 0);
  });
});

test('a traversal entry is refused and nothing is written', () => {
  withBundle((box, path) => {
    const b = readBundle(path);
    b.folder = { '../../../../etc/pwned.txt': Buffer.from('x').toString('base64') };
    writeBundle(path, b);

    const before = sessionCount(box);
    const { failed, output } = cliFails(box, ['in', path, '--into', box.work]);
    assert.ok(failed);
    assert.match(output, /outside the target directory/);
    assert.equal(sessionCount(box), before);
    assert.equal(stagingLeft(box), 0);
  });
});

test('an empty transcript is refused', () => {
  withBundle((box, path) => {
    const b = readBundle(path);
    b.transcript = [];
    writeBundle(path, b);

    const before = sessionCount(box);
    const { failed, output } = cliFails(box, ['in', path, '--into', box.work]);
    assert.ok(failed);
    assert.match(output, /transcript is empty/);
    assert.equal(sessionCount(box), before);
  });
});

test('--dry-run prints the plan and writes nothing', () => {
  withBundle((box, path) => {
    const before = sessionCount(box);
    const said = cli(box, ['in', path, '--into', box.work, '--dry-run']);

    assert.match(said, /import plan/);
    assert.match(said, /into /);
    assert.match(said, /workspace /);
    assert.match(said, /nothing was written/);
    assert.equal(sessionCount(box), before, 'a dry run must not import');
  });
});

test('the import mints a new session id rather than reusing the sender\'s', () => {
  withBundle((box, path) => {
    const original = readBundle(path).session.id;
    const said = cli(box, ['in', path, '--into', box.work]);
    const landed = /resume it:\s+claude --resume (\S+)/.exec(said)?.[1];
    assert.ok(landed, 'it prints the new id');
    assert.notEqual(landed, original, 'the id must be new — the original belongs to the sending machine');
  });
});

test('an import records a receipt, and sync can use it without the bundle', () => {
  withBundle((box, path) => {
    cli(box, ['in', path, '--into', box.work]);

    const receipts = join(box.config, 'claude-transfer', 'imports');
    assert.ok(existsSync(receipts), 'a receipt directory exists');
    assert.equal(readdirSync(receipts).filter((f) => f.endsWith('.json')).length, 1);

    // The whole point: this works with the bundle gone.
    const listed = cli(box, ['sync']);
    assert.match(listed, /imported sessions/);
  });
});

test('the transcript is re-homed to the receiving directory', () => {
  withBundle((box, path) => {
    const said = cli(box, ['in', path, '--into', box.work]);
    const landed = /landed\s+(\S+)/.exec(said)?.[1];
    assert.ok(landed && existsSync(landed));

    // Parsed, not string-matched. A transcript is JSON, so a Windows path is
    // stored escaped (`C:\\Users\\…`) while the path itself has single
    // separators — comparing raw text passes on POSIX and fails on Windows
    // without either result saying anything about whether re-homing worked.
    const records = readFileSync(landed, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const cwds = [...new Set(records.map((r) => r.cwd).filter(Boolean))];
    assert.deepEqual(cwds, [box.work], 'every record points at the receiving directory');
    assert.ok(!readFileSync(landed, 'utf8').includes('‹home›'),
      'the portable home marker is resolved, not left in place');
  });
});
