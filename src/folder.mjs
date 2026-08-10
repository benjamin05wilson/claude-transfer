/**
 * Sending the work itself, not just a pointer to it.
 *
 * Git coordinates are enough when the other machine can fetch the repository.
 * Often it cannot — the repo is private and unconfigured there, the folder was
 * never a repo, or you are handing work to a machine that has never seen the
 * project. Then the files have to travel.
 *
 * The danger is obvious: a working folder holds `.env`, private keys, and a
 * `node_modules` the size of a small country. So the default is **tracked files
 * only** — `git ls-files`, which respects `.gitignore` and therefore excludes
 * exactly the things people already decided should not be committed. That is a
 * judgement the user has usually already made; reusing it beats inventing one.
 *
 * Untracked files are available with a flag, never by default, and always with
 * a report of what that pulled in.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MAX_FOLDER_BYTES = 30 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 4000;

/** Things nobody means to send, for folders that are not git repositories. */
const NEVER = [
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', 'coverage',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.gradle', '.idea', '.vscode', 'vendor', 'Pods', '.terraform', '.cache',
];
const NEVER_FILE = /(^\.DS_Store$|\.log$|\.tmp$|^\.env(\..*)?$|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|\.sqlite3?$)/i;

const git = (cwd, args) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? res.stdout : null;
};

const isRepo = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';

/** Tracked files, and optionally the untracked ones git is not ignoring. */
function gitFileList(dir, includeUntracked) {
  const tracked = (git(dir, ['ls-files', '-z']) ?? '').split('\0').filter(Boolean);
  if (!includeUntracked) return { list: tracked, method: 'git tracked files' };

  const untracked = (git(dir, ['ls-files', '-z', '--others', '--exclude-standard']) ?? '')
    .split('\0').filter(Boolean);
  return { list: [...tracked, ...untracked], method: 'git tracked + untracked' };
}

/** For a plain folder: walk it, skipping the obvious. */
function walk(dir) {
  const out = [];
  const recurse = (current) => {
    if (out.length > MAX_FILES) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (NEVER.includes(entry.name)) continue;
        recurse(join(current, entry.name));
      } else if (entry.isFile()) {
        if (NEVER_FILE.test(entry.name)) continue;
        out.push(relative(dir, join(current, entry.name)).split(sep).join('/'));
      }
    }
  };
  recurse(dir);
  return { list: out, method: 'folder walk' };
}

/**
 * Gather the working folder.
 *
 * @returns {{files:object, bytes:number, count:number, method:string,
 *            skipped:Array<{path:string,why:string}>, truncated:boolean}}
 */
export function collectFolder(dir, {
  includeUntracked = false,
  maxBytes = MAX_FOLDER_BYTES,
  maxFileBytes = MAX_FILE_BYTES,
} = {}) {
  if (!dir || !existsSync(dir)) {
    return { files: {}, bytes: 0, count: 0, method: 'none', skipped: [], truncated: false };
  }

  const { list, method } = isRepo(dir) ? gitFileList(dir, includeUntracked) : walk(dir);

  const files = {};
  const skipped = [];
  let bytes = 0;
  let truncated = false;

  for (const rel of list) {
    if (Object.keys(files).length >= MAX_FILES) { truncated = true; break; }
    const full = join(dir, rel);

    let size;
    try { size = statSync(full).size; } catch { continue; }

    if (size > maxFileBytes) {
      skipped.push({ path: rel, why: `${Math.round(size / 1048576)} MB` });
      continue;
    }
    if (bytes + size > maxBytes) { truncated = true; break; }

    try { files[rel] = readFileSync(full).toString('base64'); } catch { continue; }
    bytes += size;
  }

  return { files, bytes, count: Object.keys(files).length, method, skipped, truncated };
}

/** Which of these files already exist at the destination, and differ. */
export function conflicts(dir, files) {
  const clashes = [];
  for (const [rel, b64] of Object.entries(files ?? {})) {
    const full = join(dir, rel);
    if (!existsSync(full)) continue;
    try {
      const here = readFileSync(full);
      if (!here.equals(Buffer.from(b64, 'base64'))) clashes.push(rel);
    } catch { clashes.push(rel); }
  }
  return clashes;
}
