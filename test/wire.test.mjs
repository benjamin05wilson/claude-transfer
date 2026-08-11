/**
 * The direct transfer, and what it refuses.
 *
 * Two of these pin behaviour that was deliberately chosen rather than obvious.
 * A non-GET must not consume the transfer, because link unfurlers in chat apps
 * fetch any URL you paste and would otherwise collect the bundle while telling
 * the sender it arrived safely. And the size cap has to be enforced while
 * reading, not after, because `content-length` is a claim made by whoever is on
 * the other end.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import { serveOnce, collect, encrypt, decrypt, splitUrl, MAX_BUNDLE_BYTES } from '../src/wire.mjs';

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

test('a payload round-trips through the one-shot server', async () => {
  const payload = Buffer.from(JSON.stringify({ hello: 'world', big: 'x'.repeat(50_000) }));
  const { url } = await serveOnce(payload, { host: '127.0.0.1', timeout: 10_000 });
  const got = await collect(url, { timeout: 10_000 });
  assert.ok(got.equals(payload));
});

test('the key never appears in the part of the URL a server can see', async () => {
  const { url, server } = await serveOnce(Buffer.from('x'), { host: '127.0.0.1', timeout: 5_000 });
  const { url: addressed, key } = splitUrl(url);
  assert.ok(key, 'the key is in the fragment');
  assert.ok(!addressed.includes(key), 'and not in the path the server receives');
  server.close();
});

test('a transfer is one-shot', async () => {
  const { url } = await serveOnce(Buffer.from('once'), { host: '127.0.0.1', timeout: 10_000 });
  const first = await collect(url, { timeout: 10_000 });
  assert.equal(first.toString(), 'once');
  await assert.rejects(() => collect(url, { timeout: 5_000 }), /already collected|could not reach/);
});

test('a HEAD request does not consume the transfer', async () => {
  const { url } = await serveOnce(Buffer.from('still here'), { host: '127.0.0.1', timeout: 10_000 });
  const { url: addressed } = splitUrl(url);

  const probe = await fetch(addressed, { method: 'HEAD' });
  assert.equal(probe.status, 405, 'anything but GET is refused outright');

  const got = await collect(url, { timeout: 10_000 });
  assert.equal(got.toString(), 'still here', 'the transfer survived the probe');
});

test('the wrong key cannot open a transfer', () => {
  const payload = Buffer.from('secret contents');
  const key = randomBytes(32).toString('hex');
  const blob = encrypt(payload, key);
  assert.ok(decrypt(blob, key).equals(payload));
  assert.throws(() => decrypt(blob, randomBytes(32).toString('hex')), /could not decrypt/);
});

test('a tampered payload fails authentication rather than opening', () => {
  const key = randomBytes(32).toString('hex');
  const blob = encrypt(Buffer.from('original'), key);
  blob[blob.length - 1] ^= 0x01;
  assert.throws(() => decrypt(blob, key), /could not decrypt/);
});

test('a response with no content-length is cut off at the cap', async () => {
  let stopped = false;
  const { server, port } = await listen((req, res) => {
    res.writeHead(200); // deliberately no content-length
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const pump = () => {
      if (stopped || res.writableEnded) return;
      if (!res.write(chunk)) { res.once('drain', pump); return; }
      setImmediate(pump);
    };
    res.on('close', () => { stopped = true; });
    pump();
  });

  try {
    const url = `http://127.0.0.1:${port}/abc#${'a'.repeat(64)}`;
    const before = process.memoryUsage().heapUsed;
    await assert.rejects(
      () => collect(url, { maxBytes: 1024 * 1024, timeout: 15_000 }),
      /refusing a transfer over/,
    );
    const grew = (process.memoryUsage().heapUsed - before) / 1048576;
    assert.ok(grew < 60, `memory growth must stay bounded, was ${grew.toFixed(1)} MB`);
  } finally { stopped = true; server.close(); }
});

test('a declared length over the cap is refused before the body is read', async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'content-length': String(MAX_BUNDLE_BYTES + 1) });
    res.end(Buffer.alloc(16));
  });
  try {
    await assert.rejects(
      () => collect(`http://127.0.0.1:${port}/abc#${'a'.repeat(64)}`, { timeout: 10_000 }),
      /refusing a/,
    );
  } finally { server.close(); }
});

test('a link with no key is rejected with an explanation', async () => {
  await assert.rejects(() => collect('http://127.0.0.1:1/abc', { timeout: 1000 }), /no key on the end/);
});
