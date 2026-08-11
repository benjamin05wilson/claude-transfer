/**
 * The bugs that could reach outside the target directory.
 *
 * Each of these was a real, reproduced defect, and each is the kind that comes
 * back quietly during a refactor — a `lstatSync` softened to `statSync`, a
 * containment check moved one call earlier. That is what makes them worth
 * pinning rather than the more colourful failures elsewhere.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { collectFolder } from '../src/folder.mjs';
import { unpackDir, safeEntryPath } from '../src/session.mjs';
import { validateBundle } from '../src/validate.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'ct-sec-'));

// Creating a symlink on Windows needs a privilege the CI runner does not
// necessarily have. The behaviour being tested is real on every platform;
// only the ability to set up the fixture is not.
const symlinksWork = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'ct-link-'));
  try { writeFileSync(join(probe, 'a'), 'a'); symlinkSync(join(probe, 'a'), join(probe, 'b')); return true; }
  catch { return false; }
  finally { rmSync(probe, { recursive: true, force: true }); }
})();

test('a tracked symlink does not package the file it points at', { skip: symlinksWork ? false : 'symlinks unavailable on this host' }, () => {
  const root = temp();
  try {
    const outside = join(root, 'outside');
    const repo = join(root, 'repo');
    mkdirSync(outside, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'SUPER-SECRET-VALUE\n');
    writeFileSync(join(repo, 'normal.txt'), 'hello\n');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'linked-secret'));

    const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);

    const got = collectFolder(repo, {});
    const bodies = Object.values(got.files).map((v) => Buffer.from(v, 'base64').toString('utf8'));

    assert.ok(!bodies.some((b) => b.includes('SUPER-SECRET-VALUE')),
      'the file outside the repository must not be packaged');
    assert.ok(!Object.keys(got.files).includes('linked-secret'), 'the link itself is not collected');
    assert.ok(Object.keys(got.files).includes('normal.txt'), 'ordinary files are still collected');
    assert.ok(got.skipped.some((s) => s.path === 'linked-secret' && s.why === 'symlink'),
      'skipping it is reported rather than silent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a bundle is refused if any entry would be written through a symlink', { skip: symlinksWork ? false : 'symlinks unavailable on this host' }, () => {
  const root = temp();
  try {
    const target = join(root, 'target');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(target, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'untouched.txt'), 'original\n');
    symlinkSync(elsewhere, join(target, 'logs'));

    // Lexically innocent: "logs/untouched.txt" spells out inside the target.
    assert.ok(safeEntryPath(target, 'logs/untouched.txt'), 'the path passes the lexical check');

    assert.throws(
      () => unpackDir(target, { 'logs/untouched.txt': Buffer.from('OVERWRITTEN').toString('base64') }),
      /symlink/,
    );
    assert.equal(readFileSync(join(elsewhere, 'untouched.txt'), 'utf8').trim(), 'original',
      'the file outside the target is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plain traversal is still refused, and refuses the whole bundle', () => {
  const root = temp();
  try {
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    assert.throws(
      () => unpackDir(target, {
        'fine.txt': Buffer.from('ok').toString('base64'),
        '../../escape.txt': Buffer.from('bad').toString('base64'),
      }),
      /outside/,
    );
    assert.ok(!existsSync(join(root, 'escape.txt')), 'nothing escaped');
    assert.ok(!existsSync(join(target, 'fine.txt')),
      'the innocent entry is refused too — a bundle that tries is hostile, not partly valid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary nested writes still work', () => {
  const root = temp();
  try {
    const written = unpackDir(root, { 'a/b/c.txt': Buffer.from('fine').toString('base64') });
    assert.equal(written, 1);
    assert.equal(readFileSync(join(root, 'a/b/c.txt'), 'utf8'), 'fine');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validation rejects hostile paths before anything is written', () => {
  const bundle = {
    format: 3,
    transcript: ['{"type":"user"}'],
    session: { id: 'x' },
    origin: { cwd: '/somewhere' },
    folder: { '../../../../etc/pwned': 'eA==' },
  };
  const out = validateBundle(bundle, { maxFormat: 3, into: '/tmp/target' });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /would write outside/);
});

test('validation rejects an unsupported format and an empty transcript', () => {
  const base = { transcript: ['{}'], session: { id: 'x' }, origin: { cwd: '/a' } };

  const future = validateBundle({ ...base, format: 99 }, { maxFormat: 3, into: '/tmp/t' });
  assert.equal(future.ok, false);
  assert.match(future.errors.join(' '), /format 99/);

  const empty = validateBundle({ ...base, format: 3, transcript: [] }, { maxFormat: 3, into: '/tmp/t' });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(' '), /transcript is empty/);
});

test('validation accepts a well-formed bundle', () => {
  const out = validateBundle({
    format: 3,
    transcript: ['{"type":"user"}'],
    session: { id: 'x' },
    origin: { cwd: '/somewhere' },
    sidecars: { 'a.jsonl': 'eA==' },
  }, { maxFormat: 3, into: '/tmp/target' });
  assert.equal(out.ok, true, out.errors.join(' '));
  assert.equal(out.entries, 1);
});
