/**
 * Nothing here may destroy uncommitted work.
 *
 * Uncommitted changes are the one thing on a developer's machine with no copy
 * anywhere — not in the reflog, not on a remote. Both of these operations write
 * into a working tree, so the interesting assertion in each case is that the
 * user's own edits are still there afterwards, not merely that an error was
 * returned.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sandbox } from './helpers.mjs';
import { applyDiff, checkout, captureWorkspace, compareWorkspace, inspectTarget } from '../src/workspace.mjs';

const DIFF = `diff --git a/app.js b/app.js
index 8b13789..f2e4a6f 100644
--- a/app.js
+++ b/app.js
@@ -1 +1,2 @@
 const a = 1;
+const b = 2;
`;

test('applyDiff refuses a dirty tree and leaves the work alone', () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.work, 'app.js'), 'const a = 1;\nMY UNCOMMITTED WORK\n');

    const out = applyDiff(box.work, DIFF);
    assert.equal(out.ok, false);
    assert.match(out.error, /uncommitted/);
    assert.match(readFileSync(join(box.work, 'app.js'), 'utf8'), /MY UNCOMMITTED WORK/,
      'the user\'s own edits must survive');
  } finally { box.cleanup(); }
});

test('applyDiff applies on a clean tree and reports the paths', () => {
  const box = sandbox();
  try {
    const out = applyDiff(box.work, DIFF);
    assert.equal(out.ok, true, out.error);
    assert.match(readFileSync(join(box.work, 'app.js'), 'utf8'), /const b = 2;/);
    assert.ok(out.files?.includes('app.js'), 'it says what it touched');
  } finally { box.cleanup(); }
});

test('a patch that cannot apply changes nothing', () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.work, 'app.js'), 'completely different\n');
    box.git(['add', '-A']);
    box.git(['commit', '-qm', 'diverge']);
    const before = readFileSync(join(box.work, 'app.js'), 'utf8');

    const out = applyDiff(box.work, DIFF);
    assert.equal(out.ok, false);
    assert.equal(readFileSync(join(box.work, 'app.js'), 'utf8'), before,
      'a failed apply must not half-write the tree');
  } finally { box.cleanup(); }
});

test('checkout refuses a dirty tree', () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.work, 'app.js'), 'dirty\n');
    const out = checkout(box.work, box.head());
    assert.equal(out.ok, false);
    assert.match(out.error, /uncommitted/);
  } finally { box.cleanup(); }
});

test('neither touches a directory that is not a repository', () => {
  const box = sandbox();
  try {
    assert.equal(applyDiff(box.root, DIFF).ok, false);
    assert.match(applyDiff(box.root, DIFF).error, /not a git repository/);
    assert.equal(checkout(box.root, 'abc1234').ok, false);
  } finally { box.cleanup(); }
});

test('the same repository is recognised however it was cloned', () => {
  // sameRepo is internal, so this goes through the behaviour that depends on it:
  // a session sent from an ssh clone landing in an https clone is the same repo.
  const origin = { isRepo: true, head: 'abc1234', branch: 'main', remote: 'git@github.com:acme/app.git' };
  const target = { isRepo: true, head: 'abc1234', branch: 'main', remote: 'https://github.com/ACME/App.git', dirty: false };
  assert.equal(compareWorkspace(origin, target, '/tmp/x').state, 'match');

  const other = { ...target, remote: 'https://github.com/acme/something-else.git' };
  assert.equal(compareWorkspace(origin, other, '/tmp/x').state, 'different-repo');
});

test('a workspace comparison reports the states the import depends on', () => {
  const box = sandbox();
  try {
    const origin = captureWorkspace(box.work);
    assert.equal(origin.isRepo, true);

    const same = compareWorkspace(origin, inspectTarget(box.work), box.work);
    assert.equal(same.state, 'match');
    assert.equal(same.safeForFileHistory, true, 'rewind data is safe only when the workspace matches');

    // A dirty target is never safe for rewind data, even at the same commit.
    writeFileSync(join(box.work, 'app.js'), 'dirty\n');
    const dirty = compareWorkspace(origin, inspectTarget(box.work), box.work);
    assert.equal(dirty.safeForFileHistory, false);
  } finally { box.cleanup(); }
});

test('captureWorkspace records the coordinates a receiver needs', () => {
  const box = sandbox();
  try {
    const state = captureWorkspace(box.work);
    assert.equal(state.isRepo, true);
    assert.equal(state.remote, 'https://github.com/acme/app.git');
    assert.ok(state.head);
    assert.equal(state.dirty, false);
    assert.equal(state.branch, 'main');
  } finally { box.cleanup(); }
});
