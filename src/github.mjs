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
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Gists are git repositories; base64 inflates by a third, so keep it sane. */
export const MAX_GIST_BYTES = 40 * 1024 * 1024;

/**
 * GitHub truncates any gist file over 1 MB in its API response, flagging it
 * `truncated: true` and expecting the caller to follow a separate raw URL.
 * Whether the CLI does that for you is platform-dependent: the same 3 MB
 * transfer came back whole on macOS and clipped on Windows. A clipped payload
 * fails authenticated decryption, which looks exactly like a wrong key and
 * sends you hunting for a problem that is not there.
 *
 * So no file is ever allowed near the limit. The payload is split into parts
 * well under it, and a manifest records how many there should be.
 */
const CHUNK_CHARS = 512 * 1024;
const MANIFEST = 'manifest.json';
const partName = (i) => `part-${String(i).padStart(3, '0')}.b64`;

const gh = (args, input) => spawnSync('gh', args, {
  encoding: 'utf8',
  input,
  maxBuffer: 256 * 1024 * 1024,
});

/** Is the `gh` CLI present and signed in? */
export function ghStatus() {
  // `which` does not exist on Windows, so this always failed there and reported
  // gh as missing — on the very platform where /transfer defaults to GitHub
  // delivery. `where` is the equivalent.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(finder, ['gh'], { stdio: 'ignore' });
  if (found.status !== 0) {
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

  const b64 = blob.toString('base64');
  const parts = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) parts.push(b64.slice(i, i + CHUNK_CHARS));

  // `gh gist create` takes files from disk, so the parts land in a temp
  // directory that is removed whatever happens.
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  try {
    const files = [];
    parts.forEach((part, i) => {
      const path = join(dir, partName(i));
      writeFileSync(path, part);
      files.push(path);
    });

    // A length and a digest, so a short read is reported as a short read.
    const manifest = join(dir, MANIFEST);
    writeFileSync(manifest, JSON.stringify({
      parts: parts.length,
      chars: b64.length,
      sha256: createHash('sha256').update(blob).digest('hex'),
    }));

    const res = gh(['gist', 'create', manifest, ...files, '--desc', description]);
    if (res.status !== 0) {
      throw new Error(`could not create the gist: ${(res.stderr || '').trim().split('\n').pop()}`);
    }

    const url = (res.stdout || '').trim().split('\n').pop();
    const id = url.split('/').pop();
    if (!id) throw new Error('GitHub did not return a gist id');
    return { id, url, parts: parts.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every file in the gist, with the URL that always serves it whole.
 *
 * The API's inline `content` is truncated once a gist gets large — measured at
 * 397,209 of 524,288 characters for one part here — and whether the CLI
 * transparently follows `raw_url` instead turns out to vary by platform. Asking
 * for the raw URL ourselves removes that difference entirely.
 */
function fileIndex(id) {
  const res = gh(['api', `gists/${id}`, '--jq',
    '.files | to_entries | map({name: .key, raw: .value.raw_url}) | tostring']);
  if (res.status !== 0) {
    const err = (res.stderr || '').trim();
    if (/not found|404/i.test(err)) {
      throw new Error(`no transfer at ${id} — it may already have been collected`);
    }
    throw new Error(`could not read the transfer: ${err.split('\n').pop()}`);
  }
  try {
    return JSON.parse((res.stdout || '').trim());
  } catch {
    throw new Error('GitHub returned something unexpected for that transfer');
  }
}

async function fetchRaw(url) {
  // A secret gist's raw URL carries its own unguessable hash, so no auth is
  // required — but send the token when we have one, for private-org setups.
  const token = gh(['auth', 'token']).stdout?.trim();
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  if (!res.ok) throw new Error(`could not download part of the transfer (${res.status})`);
  return (await res.text()).replace(/\s+/g, '');
}

/**
 * Fetch a bundle by gist id. Still encrypted when it comes back.
 *
 * Verifies what arrived against the manifest, so an incomplete download says so
 * rather than surfacing later as a decryption failure — which reads as "wrong
 * key" and sends you looking in entirely the wrong place.
 */
export async function get(id) {
  const status = ghStatus();
  if (!status.ok) throw new Error(status.reason);

  const index = fileIndex(id);
  const urlFor = (name) => index.find((f) => f.name === name)?.raw;

  const manifestUrl = urlFor(MANIFEST);
  if (!manifestUrl) {
    // A transfer from an older version: a single file, no manifest.
    const legacy = urlFor('session.transfer.b64');
    if (!legacy) throw new Error('that transfer is missing its manifest');
    return Buffer.from(await fetchRaw(legacy), 'base64');
  }

  const manifest = JSON.parse(await fetchRaw(manifestUrl));

  let b64 = '';
  for (let i = 0; i < manifest.parts; i++) {
    const url = urlFor(partName(i));
    if (!url) throw new Error(`part ${i + 1} of ${manifest.parts} is missing from the transfer`);
    b64 += await fetchRaw(url);
  }

  if (manifest.chars && b64.length !== manifest.chars) {
    throw new Error(
      `incomplete download: got ${b64.length} of ${manifest.chars} characters. `
      + 'The transfer is intact on GitHub — try again.',
    );
  }

  const blob = Buffer.from(b64, 'base64');
  if (manifest.sha256) {
    const got = createHash('sha256').update(blob).digest('hex');
    if (got !== manifest.sha256) {
      throw new Error('the transfer arrived corrupted — the contents do not match their checksum');
    }
  }
  return blob;
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
    .filter((line) => /claude session transfer/.test(line))
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
