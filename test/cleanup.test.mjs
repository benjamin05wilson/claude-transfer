/**
 * Destructive arguments have to be parsed strictly.
 *
 * `Number('nope')` is NaN, and every comparison against NaN is false — so an
 * unparseable age silently skipped the age check and `--clean` deleted
 * everything. The failure mode is the wrong way round: a value someone typed to
 * *narrow* a deletion instead widened it to all of them.
 *
 * These run without touching GitHub. `pending` needs `gh` to list anything, so
 * what is asserted here is that a bad argument is rejected before any of that
 * happens — which is exactly where the bug was.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { sandbox, cliFails } from './helpers.mjs';

const BAD_AGES = ['nope', 'NaN', '-1', '', 'Infinity', '1e400', 'seven'];

test('an unparseable --older-than stops the command', () => {
  const box = sandbox();
  try {
    for (const bad of BAD_AGES) {
      const { failed, output } = cliFails(box, ['pending', '--clean', '--older-than', bad]);
      assert.ok(failed, `--older-than ${JSON.stringify(bad)} must not be accepted`);
      assert.match(output, /--older-than needs a number of days|needs a value/,
        `and must say why, for ${JSON.stringify(bad)}`);
    }
  } finally { box.cleanup(); }
});

test('a negative age is rejected rather than treated as "everything"', () => {
  const box = sandbox();
  try {
    const { failed, output } = cliFails(box, ['pending', '--clean', '--older-than', '-5']);
    assert.ok(failed);
    assert.match(output, /needs a number of days|needs a value/);
  } finally { box.cleanup(); }
});

test('a valid age is accepted', () => {
  const box = sandbox();
  try {
    // No assertion on the outcome — without gh there is nothing to list. The
    // point is that a well-formed argument gets past validation rather than
    // dying on it.
    const { output } = cliFails(box, ['pending', '--clean', '--older-than', '7']);
    assert.ok(!/needs a number of days/.test(output), `7 must be accepted, got: ${output}`);
  } finally { box.cleanup(); }
});
