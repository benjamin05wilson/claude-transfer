/**
 * What an import left behind, so the workspace can be dealt with later.
 *
 * The old advice was: import, look at the workspace mismatch, then run the same
 * command again with `--sync`. That cannot work. A gist is consumed by the first
 * successful receive, so the second run has nothing to fetch — and even from a
 * file it would mint a *second* session rather than finish the first.
 *
 * So the coordinates are written down at import time. `claude-transfer sync
 * <session-id>` then works from local state: no bundle, no code, no second
 * session, and it can be run days later.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = (claudeDir) => join(claudeDir, 'claude-transfer', 'imports');
const file = (claudeDir, id) => join(dir(claudeDir), `${id}.json`);

/**
 * @param {object} receipt  the new session id, where it landed, and the
 *                          workspace the session was originally working in
 */
export function writeReceipt(claudeDir, receipt) {
  // A receipt names a working directory, a branch and a commit, and sits in a
  // home directory that may be shared. Owner-only is the right default for
  // anything describing somebody's work; the modes are set explicitly rather
  // than left to whatever umask happens to be.
  mkdirSync(dir(claudeDir), { recursive: true, mode: 0o700 });
  writeFileSync(file(claudeDir, receipt.session), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  return file(claudeDir, receipt.session);
}

export function readReceipt(claudeDir, id) {
  const exact = file(claudeDir, id);
  if (existsSync(exact)) {
    try { return JSON.parse(readFileSync(exact, 'utf8')); } catch { return null; }
  }
  // Session ids are long and nobody types them in full.
  for (const r of listReceipts(claudeDir)) {
    if (r.session?.startsWith(id)) return r;
  }
  return null;
}

export function listReceipts(claudeDir) {
  const root = dir(claudeDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
