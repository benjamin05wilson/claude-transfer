/**
 * GitHub as a courier.
 *
 * The LAN wire is direct and stores nothing, but it only works in one building.
 * Mesh VPNs and tunnels fix that at the cost of asking every user to install
 * something before they can move a session — a steep price for a tool people
 * are meant to try in a minute.
 *
 * Most developers already have `gh` authenticated, so this uses a **private
 * gist** as a drop box: one per transfer, deleted the moment it is collected.
 * It works through any firewall, needs no open ports, and — unlike a direct
 * connection — does not require both machines to be awake at the same time.
 *
 * GitHub never sees anything meaningful. The bundle is encrypted before it
 * leaves, and the key travels in the fragment of the code you paste, which is
 * never uploaded. A gist that leaked would be an opaque blob.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Gists are git repositories; base64 inflates by a third, so keep it sane. */
export const MAX_GIST_BYTES = 40 * 1024 * 1024;

const FILENAME = 'session.transfer.b64';

const gh = (args, input) => spawnSync('gh', args, {
  encoding: 'utf8',
  input,
  maxBuffer: 256 * 1024 * 1024,
});

/** Is the `gh` CLI present and signed in? */
export function ghStatus() {
  const which = spawnSync('which', ['gh'], { stdio: 'ignore' });
  if (which.status !== 0) {
    return { ok: false, reason: 'the GitHub CLI is not installed — see https://cli.github.com' };
  }
  const auth = gh(['auth', 'status']);
  if (auth.status !== 0) {
    return { ok: false, reason: 'the GitHub CLI is not signed in — run `gh auth login`' };
  }
  return { ok: true };
}

/**
 * Upload an encrypted bundle and return the code the other machine needs.
 *
 * @param {Buffer} blob  already encrypted — this function never sees plaintext
 * @returns {{ id:string, url:string }}
 */
export function put(blob, { description = 'claude session transfer' } = {}) {
  const status = ghStatus();
  if (!status.ok) throw new Error(status.reason);
  if (blob.length > MAX_GIST_BYTES) {
    throw new Error(`this session is ${Math.round(blob.length / 1048576)} MB, too large for a gist — use \`claude-transfer out\` and move the file`);
  }

  // `gh gist create -` reads the content from stdin.
  const res = gh(['gist', 'create', '-', '--filename', FILENAME, '--desc', description],
    blob.toString('base64'));
  if (res.status !== 0) {
    throw new Error(`could not create the gist: ${(res.stderr || '').trim().split('\n').pop()}`);
  }

  const url = (res.stdout || '').trim().split('\n').pop();
  const id = url.split('/').pop();
  if (!id) throw new Error('GitHub did not return a gist id');
  return { id, url };
}

/** Fetch a bundle by gist id. Still encrypted when it comes back. */
export function get(id) {
  const status = ghStatus();
  if (!status.ok) throw new Error(status.reason);

  const res = gh(['gist', 'view', id, '--filename', FILENAME, '--raw']);
  if (res.status !== 0) {
    const err = (res.stderr || '').trim();
    if (/not found|404/i.test(err)) {
      throw new Error(`no transfer at ${id} — it may already have been collected`);
    }
    throw new Error(`could not read the gist: ${err.split('\n').pop()}`);
  }

  const body = (res.stdout || '').replace(/\s+/g, '');
  if (!body) throw new Error('that transfer is empty');
  return Buffer.from(body, 'base64');
}

/**
 * Delete a transfer once it has been collected.
 *
 * Best effort: a failure here leaves an encrypted blob in your own private
 * gists, which is untidy rather than dangerous, and should not fail an import
 * that has otherwise succeeded.
 */
export function remove(id) {
  const res = gh(['gist', 'delete', id, '--yes']);
  return res.status === 0;
}

/** List transfers still sitting in your gists. */
export function pending() {
  const status = ghStatus();
  if (!status.ok) return [];
  const res = gh(['gist', 'list', '--limit', '100']);
  if (res.status !== 0) return [];
  return (res.stdout || '')
    .split('\n')
    .filter((line) => line.includes(FILENAME) || /claude session transfer/.test(line))
    .map((line) => {
      const [id, ...rest] = line.split('\t');
      return { id, description: rest[0] ?? '', raw: line };
    });
}

/** `gh:<id>#<key>` — the whole address in one pasteable token. */
export const buildCode = (id, keyHex) => `gh:${id}#${keyHex}`;

export function parseCode(input) {
  if (typeof input !== 'string') return null;
  const m = /^gh:([0-9a-f]{8,})(?:#([0-9a-f]{64}))?$/i.exec(input.trim());
  if (!m) return null;
  return { id: m[1], key: m[2] ?? null };
}

export const looksLikeGhCode = (s) => typeof s === 'string' && /^gh:/i.test(s.trim());

/** A short, unguessable description so gists are not correlatable by name. */
export const anonymousDescription = () => `claude session transfer ${randomBytes(3).toString('hex')}`;
