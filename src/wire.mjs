/**
 * Handing a bundle straight from one machine to the other.
 *
 * Claude Code can pull a web session down to a terminal (`/teleport`) and can
 * drive a local session from a phone (`/remote-control`). What it cannot do is
 * move a local session to another local machine — and every workaround for that
 * routes your transcript through somebody else's server.
 *
 * So this doesn't use one. The sending machine serves the bundle once, on its
 * LAN address, and then stops.
 *
 * The URL looks like `http://192.168.0.5:54321/a1b2c3d4#<key>`:
 *
 *   - the **path** addresses the transfer, and the server sees it
 *   - the **fragment** is the encryption key, and a browser or HTTP client never
 *     transmits a fragment, so it stays on the two machines
 *
 * That split is the point. Someone sniffing the network sees the request path
 * and can fetch the ciphertext, but they cannot read it. They can burn the
 * one-shot transfer, which is a nuisance rather than a disclosure — and the
 * sender is told the collection happened, so a failed handoff is visible.
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/** Refuse to expand a bundle past this. A small archive can otherwise fill a disk. */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/** Wrong guesses tolerated before the transfer gives up. */
const MAX_BAD_REQUESTS = 20;

/**
 * Tailscale hands every device an address in 100.64.0.0/10 that is reachable
 * from any of your other devices, wherever they are. When one exists it beats a
 * LAN address outright: same code, same encryption, no longer same building.
 */
export const isTailnetAddress = (ip) =>
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(ip));

const isPrivateAddress = (ip) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(ip));

/**
 * The address another machine can actually reach us on.
 *
 * Ordered by how far the address reaches: a tailnet works from anywhere, a LAN
 * address works in the building, and anything else is a guess. Handing someone
 * an address they cannot route to is a baffling failure, so the ordering
 * matters more than it looks.
 */
export function lanAddress(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;

      let score;
      if (isTailnetAddress(a.address) || /tailscale/i.test(name)) score = 0;
      else if (isPrivateAddress(a.address)) score = /^en|^eth|^wl|^Wi-?Fi|^Ethernet/i.test(name) ? 1 : 2;
      else score = 3;

      candidates.push({ address: a.address, score, name });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.address ?? null;
}

/** Whether we are handing out an address that works beyond this building. */
export const reachBeyondLan = (address = lanAddress()) => isTailnetAddress(address);

const keyFrom = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest();

/** iv ‖ tag ‖ ciphertext */
export function encrypt(payload, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyHex), iv);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob, keyHex) {
  if (blob.length < 29) throw new Error('the transfer was truncated');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(keyHex), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  } catch {
    // GCM authentication covers tampering as well as a wrong key.
    throw new Error('could not decrypt — wrong key, or the transfer was altered in flight');
  }
}

const constantTimeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Split `…/path#key` into its two halves. */
export function splitUrl(url) {
  const hash = String(url).indexOf('#');
  if (hash === -1) return { url: String(url), key: null };
  return { url: String(url).slice(0, hash), key: String(url).slice(hash + 1) || null };
}

/**
 * Serve one bundle, once.
 *
 * @returns {Promise<{url:string, port:number, done:Promise<string>}>}
 */
export function serveOnce(payload, { port = 0, timeout = 10 * 60_000, host } = {}) {
  const pathToken = randomBytes(8).toString('hex');
  const keyHex = randomBytes(32).toString('hex');
  const blob = encrypt(payload, keyHex);

  return new Promise((resolveReady, rejectReady) => {
    let settle;
    const done = new Promise((r) => { settle = r; });
    let bad = 0;
    let served = false;

    const server = createServer((req, res) => {
      const wanted = `/${pathToken}`;
      const got = (req.url ?? '').split('?')[0];

      // HEAD and friends must not consume the transfer. Link unfurlers in Slack
      // and iMessage fetch any URL you paste, and a non-GET that counted as a
      // collection would hand the bundle to a third party while telling the
      // sender it arrived safely.
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      if (!constantTimeEqual(got, wanted)) {
        res.writeHead(404).end();
        if (++bad >= MAX_BAD_REQUESTS) { server.close(); settle('too many wrong guesses'); }
        return;
      }
      if (served) { res.writeHead(410).end(); return; }
      served = true;

      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': blob.length,
        'cache-control': 'no-store',
      });
      res.end(blob, () => { server.close(); settle('collected'); });
    });

    const timer = setTimeout(() => { server.close(); settle('timed out'); }, timeout);
    timer.unref?.();

    const ip = host ?? lanAddress();
    if (!ip) {
      rejectReady(new Error('no local network address found — is this machine offline?'));
      return;
    }

    server.on('error', rejectReady);
    // Bound to the LAN address rather than 0.0.0.0, so the bundle is not also
    // offered on every other interface this machine happens to have.
    server.listen(port, ip, () => {
      const actual = server.address().port;
      resolveReady({ url: `http://${ip}:${actual}/${pathToken}#${keyHex}`, port: actual, done, server });
    });
  });
}

/** Collect a bundle another machine is serving, and decrypt it. */
/**
 * Read a response body, refusing it the moment it exceeds the cap.
 *
 * The declared content-length is a claim by whoever is on the other end, and
 * this accepts a URL the user pasted from anywhere. What is actually received
 * is the only thing worth trusting, so it is counted as it arrives and the
 * connection is dropped as soon as the total is too large — rather than
 * discovering it after the whole body is already in memory.
 */
async function readCapped(res, maxBytes) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('refusing a transfer larger than the limit');
    return buf;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      // Stop pulling; the sender does not get to decide how much we hold.
      await res.body.cancel?.().catch(() => {});
      throw new Error(`refusing a transfer over ${Math.round(maxBytes / 1048576)} MB`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export async function collect(fullUrl, { timeout = 60_000, maxBytes = MAX_BUNDLE_BYTES } = {}) {
  const { url, key } = splitUrl(fullUrl);
  if (!key) throw new Error('that link has no key on the end — copy the whole line, including the # part');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 410) throw new Error('already collected — ask the sender to run `/transfer` → Send again');
    if (!res.ok) throw new Error(`the sender responded ${res.status}`);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`refusing a ${Math.round(declared / 1048576)} MB transfer`);
    }

    // Read incrementally and stop the moment the cap is passed. `arrayBuffer()`
    // buffers the entire response before anything can be checked, so a server
    // that omits or lies about content-length could hand over as much as it
    // liked — the check afterwards happens once the memory is already spent.
    const blob = await readCapped(res, maxBytes);
    return decrypt(blob, key);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`no answer from ${url} — same network?`);
    if (/decrypt|truncated|already collected|refusing|responded/.test(err.message)) throw err;
    throw new Error(`could not reach ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export const looksLikeUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s.trim());
