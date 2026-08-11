/**
 * Version gating, and the CLI surfaces that depend on it.
 *
 * These fixtures are the closest thing this project has to a compatibility
 * matrix: when Claude Code moves to a version that has actually been tested,
 * VERIFIED and SUPPORTED_MAJOR_MINOR change and these assertions say what that
 * did to the behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

import { assess, VERIFIED, SUPPORTED_MAJOR_MINOR } from '../src/compat.mjs';
import { sandbox, cli, cliFails, VERIFIED_VERSION } from './helpers.mjs';

test('a verified pair is reported as tested', () => {
  const out = assess({ sourceVersions: [VERIFIED[0]], hereVersion: VERIFIED[0] });
  assert.equal(out.level, 'verified');
  assert.equal(out.ok, true);
});

test('a different patch of a supported minor is allowed, but labelled', () => {
  const out = assess({ sourceVersions: [`${SUPPORTED_MAJOR_MINOR[0]}.999`], hereVersion: VERIFIED[0] });
  assert.equal(out.level, 'likely');
  assert.equal(out.ok, true);
  assert.match(out.detail, /same minor/);
});

test('an untested major is refused, whichever side it is on', () => {
  const fromThere = assess({ sourceVersions: ['9.9.9'], hereVersion: VERIFIED[0] });
  assert.equal(fromThere.ok, false);
  assert.match(fromThere.summary, /9\.9\.9/);

  const fromHere = assess({ sourceVersions: [VERIFIED[0]], hereVersion: '9.9.9' });
  assert.equal(fromHere.ok, false, 'the receiving machine is checked too');
});

test('no version on either side is not a reason to refuse', () => {
  const out = assess({ sourceVersions: [], hereVersion: null });
  assert.equal(out.ok, true);
  assert.equal(out.level, 'unknown');
});

test('an untested version stops an import before anything is written', () => {
  const box = sandbox({ version: '9.9.9' });
  try {
    const id = box.session(['hello']);
    const path = join(box.root, 'b.claude-transfer');
    cli(box, ['out', id, '-o', path], { version: '9.9.9' });

    const countBefore = readdirSync(join(box.config, 'projects')).length;
    const { failed, output } = cliFails(box, ['in', path, '--into', box.work]);
    assert.ok(failed);
    assert.match(output, /has not been tested/);
    assert.match(output, /Nothing was written/);
    assert.equal(readdirSync(join(box.config, 'projects')).length, countBefore);
  } finally { box.cleanup(); }
});

test('--force imports an untested version anyway', () => {
  const box = sandbox({ version: '9.9.9' });
  try {
    const id = box.session(['hello']);
    const path = join(box.root, 'b.claude-transfer');
    cli(box, ['out', id, '-o', path], { version: '9.9.9' });

    const said = cli(box, ['in', path, '--into', box.work, '--force']);
    assert.match(said, /resume it:/, 'being stuck with an unopenable bundle is worse than a known risk');
  } finally { box.cleanup(); }
});

test('check reports the verdict without accepting the bundle', () => {
  const box = sandbox();
  try {
    const id = box.session(['hello']);
    const path = join(box.root, 'b.claude-transfer');
    cli(box, ['out', id, '-o', path]);

    const said = cli(box, ['check', path], { version: VERIFIED_VERSION });
    assert.match(said, /versions/);
    assert.match(said, /title/);
    assert.ok(!existsSync(join(box.config, 'claude-transfer', 'imports')),
      'inspecting must not import anything');
  } finally { box.cleanup(); }
});

test('archive removes a session from the list and restores it', () => {
  const box = sandbox();
  try {
    const id = box.session(['hello']);
    assert.match(cli(box, ['list']), new RegExp(id.slice(0, 8)));

    cli(box, ['archive', id]);
    assert.ok(!cli(box, ['list']).includes(id.slice(0, 8)), 'it is gone from /resume');

    cli(box, ['archive', `--restore`, id]);
    assert.match(cli(box, ['list']), new RegExp(id.slice(0, 8)), 'and comes back intact');
  } finally { box.cleanup(); }
});

test('a known sender and an unknown receiver is not "verified"', () => {
  // Knowing the sender's version says nothing about this machine's, and the
  // half that is missing is the one about to be written to.
  const out = assess({ sourceVersions: [VERIFIED[0]], hereVersion: null });
  assert.notEqual(out.level, 'verified');
  assert.equal(out.ok, false, 'it must require --force rather than proceed quietly');
  assert.match(out.detail, /--force/);
});

test('a bundle with no versions at all is still importable', () => {
  // Bundles predate this check; refusing them would be a regression rather
  // than a safeguard.
  const out = assess({ sourceVersions: [], hereVersion: null });
  assert.equal(out.ok, true);
  assert.equal(out.level, 'unknown');
});
