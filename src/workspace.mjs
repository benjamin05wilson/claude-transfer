/**
 * The session is the conversation. This is the work it was about.
 *
 * A transcript full of `src/App.tsx` is useless in a directory that has no
 * `src/App.tsx`. Claude Code's own `/teleport` verifies repository state and
 * switches to the remote session's branch before handing you the conversation,
 * for exactly this reason. Moving a session without its workspace gives you a
 * chat about code that isn't there.
 *
 * So a bundle records where the work was — remote, branch, commit, and any
 * uncommitted changes — and the receiving side compares before it does
 * anything. Nothing here modifies a repository unless explicitly asked, and it
 * refuses outright when the target has uncommitted work of its own: silently
 * checking out over somebody's in-progress edits would be a far worse bug than
 * the one it fixes.
 */

import { spawnSync } from 'node:child_process';

/** Cap the captured diff. A huge one usually means generated files, not work. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const gitRaw = (cwd, args) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? (res.stdout ?? '') : null;
};

// Trimmed, for the single-line answers. A patch must NOT be trimmed — `git
// apply` rejects one whose trailing newline has been eaten as "corrupt patch".
const git = (cwd, args) => {
  const out = gitRaw(cwd, args);
  return out === null ? null : out.trim();
};

/** What the work looked like where the session ran. */
export function captureWorkspace(cwd) {
  if (!cwd) return { isRepo: false, reason: 'no working directory recorded' };
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { isRepo: false, reason: 'not a git repository' };
  }

  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  const status = git(cwd, ['status', '--porcelain']) ?? '';

  // Tracked changes only. Untracked files are frequently secrets, build output
  // or scratch, and shipping them silently is not a decision to make for someone.
  let diff = gitRaw(cwd, ['diff', 'HEAD']) ?? '';
  let diffTruncated = false;
  if (diff.length > MAX_DIFF_BYTES) { diff = ''; diffTruncated = true; }

  return {
    isRepo: true,
    root,
    head,
    branch: branch === 'HEAD' ? null : branch,
    remote,
    dirty: status.length > 0,
    changedFiles: status ? status.split('\n').length : 0,
    untracked: status.split('\n').filter((l) => l.startsWith('??')).length,
    diff,
    diffTruncated,
  };
}

/** What the receiving directory looks like right now. */
export function inspectTarget(cwd) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { isRepo: false };
  }
  const status = git(cwd, ['status', '--porcelain']) ?? '';
  return {
    isRepo: true,
    root: git(cwd, ['rev-parse', '--show-toplevel']),
    head: git(cwd, ['rev-parse', 'HEAD']),
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: git(cwd, ['remote', 'get-url', 'origin']),
    dirty: status.length > 0,
  };
}

const sameRepo = (a, b) => {
  if (!a || !b) return false;
  const norm = (u) => u.replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * Compare where the session came from with where it is landing.
 *
 * @returns {{state:string, summary:string, actions:string[], safeForFileHistory:boolean}}
 */
export function compareWorkspace(origin, here, targetDir) {
  if (!origin?.isRepo) {
    return {
      state: 'no-repo-origin',
      summary: `the session did not run in a git repository (${origin?.reason ?? 'unknown'})`,
      actions: [],
      // Without a commit to match, restoring another machine's undo snapshots
      // is a guess, and a wrong guess overwrites real files.
      safeForFileHistory: false,
    };
  }

  const where = origin.branch ? `${origin.branch} @ ${origin.head?.slice(0, 8)}` : origin.head?.slice(0, 8);

  if (!here.isRepo) {
    return {
      state: 'missing',
      summary: `the session was working in ${where}, but ${targetDir} is not a git repository`,
      actions: origin.remote
        ? [`git clone ${origin.remote} ${JSON.stringify(targetDir)}`,
           `git -C ${JSON.stringify(targetDir)} checkout ${origin.head}`]
        : ['(no remote recorded, so the repository cannot be fetched here)'],
      safeForFileHistory: false,
    };
  }

  if (origin.remote && here.remote && !sameRepo(origin.remote, here.remote)) {
    return {
      state: 'different-repo',
      summary: `this is a different repository (${here.remote}) from the one the session used (${origin.remote})`,
      actions: [],
      safeForFileHistory: false,
    };
  }

  if (here.head === origin.head) {
    return {
      state: 'match',
      summary: `same commit as the session (${where})`,
      actions: origin.dirty && origin.diff
        ? ['the session had uncommitted changes — `/transfer` → Receive with --apply-diff to restore them']
        : [],
      safeForFileHistory: !here.dirty,
    };
  }

  return {
    state: 'different-commit',
    summary: `the session was on ${where}, this checkout is on `
      + `${here.branch ?? '?'} @ ${here.head?.slice(0, 8) ?? '?'}`,
    actions: here.dirty
      ? ['this checkout has uncommitted changes, so nothing will be moved — commit or stash first']
      : [`git -C ${JSON.stringify(targetDir)} checkout ${origin.head}`],
    safeForFileHistory: false,
  };
}

/** Move the target to the session's commit. Refuses to touch a dirty tree. */
export function checkout(targetDir, head) {
  const here = inspectTarget(targetDir);
  if (!here.isRepo) return { ok: false, error: 'not a git repository' };
  if (here.dirty) return { ok: false, error: 'uncommitted changes here — commit or stash first' };
  if (git(targetDir, ['checkout', head]) === null) {
    // Most often the commit simply is not present locally yet.
    if (git(targetDir, ['fetch', '--all']) === null) return { ok: false, error: `could not fetch to find ${head}` };
    if (git(targetDir, ['checkout', head]) === null) return { ok: false, error: `commit ${head?.slice(0, 8)} not found` };
  }
  return { ok: true };
}

/** Re-apply the uncommitted work the session had in flight. */
export function applyDiff(targetDir, diff) {
  if (!diff) return { ok: false, error: 'the bundle carries no diff' };
  const res = spawnSync('git', ['apply', '--3way', '-'], { cwd: targetDir, input: diff, encoding: 'utf8' });
  return res.status === 0
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'git apply failed').trim().split('\n')[0] };
}
