/**
 * Redaction has to cover the bundle, not just the transcript.
 *
 * The original bug reported "1 secret removed" and shipped the same key in four
 * other places, because the bundle was assembled after redaction ran. These
 * tests assert the property that actually matters — no occurrence anywhere in
 * the finished object — rather than a count, since a count is exactly what was
 * wrong last time.
 *
 * The false-positive cases are here for the opposite reason: the fix for the
 * first version of this was a redactor so eager it replaced `password: string`
 * in an interface, which is unrecoverable because the placeholder is all the
 * bundle carries.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { sandbox, cli } from './helpers.mjs';
import { redactBundle, verifyRedacted, stripUrlCredentials } from '../src/bundle-redact.mjs';
import { redactText } from '../src/redact.mjs';

const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const readBundle = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));

test('--redact leaves no occurrence anywhere in the bundle', () => {
  const box = sandbox({ remote: `https://user:${TOKEN}@github.com/acme/private.git` });
  try {
    const id = box.session([`here is my key ${KEY} please use it`]);
    // Uncommitted, so the same secret is also in the captured diff.
    writeFileSync(join(box.work, 'app.js'), `const a = 1;\nconst k = "${KEY}";\n`);

    const out = join(box.root, 'b.claude-transfer');
    const said = cli(box, ['out', id, '--redact', '--with-files', '-o', out]);

    const whole = JSON.stringify(readBundle(out));
    assert.ok(!whole.includes(KEY), 'the api key must not survive anywhere in the bundle');
    assert.ok(!whole.includes(TOKEN), 'the token must not survive anywhere in the bundle');
    assert.match(said, /verified/, 'and it says it checked');
  } finally { box.cleanup(); }
});

test('the finished bundle is verified independently, not by its own tally', () => {
  const bundle = {
    session: { title: `key ${KEY}`, firstPrompt: null },
    workspace: { diff: `+const k = "${KEY}";`, remote: `https://x:${TOKEN}@github.com/a/b.git` },
    prompts: [{ display: `use ${KEY}` }],
    folder: { 'app.js': Buffer.from(`const k = "${KEY}";`).toString('base64') },
  };

  const before = verifyRedacted(bundle);
  assert.equal(before.clean, false, 'an unredacted bundle must not pass verification');
  assert.ok(before.remaining.length >= 3);

  redactBundle(bundle, { scanOnly: false });

  const after = verifyRedacted(bundle);
  assert.equal(after.clean, true, `still found: ${JSON.stringify(after.remaining)}`);
  assert.ok(!JSON.stringify(bundle).includes(KEY));
});

test('credentials are stripped from a remote URL even without --redact', () => {
  const bundle = { workspace: { remote: `https://user:${TOKEN}@github.com/acme/private.git` } };
  const out = redactBundle(bundle, { scanOnly: true });
  assert.equal(out.remotesStripped, 1);
  assert.equal(bundle.workspace.remote, 'https://github.com/acme/private.git',
    'the URL stays usable, just without the credentials');
});

test('stripUrlCredentials handles both spellings and leaves clean URLs alone', () => {
  assert.equal(stripUrlCredentials('https://u:p@host/x').url, 'https://host/x');
  assert.equal(stripUrlCredentials('https://token@host/x').url, 'https://host/x');
  assert.equal(stripUrlCredentials('https://host/x').url, 'https://host/x');
  assert.equal(stripUrlCredentials('git@github.com:acme/app.git').url, 'git@github.com:acme/app.git',
    'ssh remotes carry no secret and must not be mangled');
});

test('binary files are reported as unscannable, never counted as clean', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const bundle = { folder: { 'logo.png': png.toString('base64') } };
  const out = redactBundle(bundle, { scanOnly: true });
  assert.deepEqual(out.binaries, ['folder:logo.png']);
  assert.equal(bundle.folder['logo.png'], png.toString('base64'), 'the bytes are untouched');
});

test('scanning does not alter a single byte', () => {
  const original = { workspace: { diff: `+const k = "${KEY}";` }, prompts: [{ display: `use ${KEY}` }] };
  const copy = JSON.parse(JSON.stringify(original));
  const out = redactBundle(copy, { scanOnly: true });
  assert.ok(out.findings.some((f) => !f.fake), 'it still reports what it found');
  assert.deepEqual(copy.workspace, original.workspace, 'full fidelity is the default');
  assert.deepEqual(copy.prompts, original.prompts);
});

test('ordinary source is not mistaken for a credential', () => {
  const samples = [
    'password: string;',
    'token=token',
    'const apiKey = process.env.API_KEY;',
    'api_key=os.getenv("API_KEY")',
    'secret: config.clientSecret',
    'password = None',
  ];
  for (const s of samples) {
    const { text, findings } = redactText(s, { scanOnly: false });
    assert.equal(text, s, `must not rewrite: ${s}`);
    assert.equal(findings.filter((f) => !f.fake).length, 0, `must not flag: ${s}`);
  }
});

test('real credentials are still caught', () => {
  for (const s of [`key ${KEY}`, `token ${TOKEN}`, 'AKIAIOSFODNN7EXAMPLE']) {
    const { findings } = redactText(s, { scanOnly: true });
    assert.ok(findings.length > 0, `must flag: ${s}`);
  }
});

test('--preview shows context with the value masked', () => {
  const { findings } = redactText(`here is my key ${KEY} please use it`, { scanOnly: true, context: true });
  const real = findings.filter((f) => !f.fake);
  assert.ok(real.length > 0);
  assert.ok(real[0].context, 'context is populated when asked for');
  assert.ok(!real[0].context.includes(KEY), 'the preview must never print the secret itself');
  assert.match(real[0].context, /⟪\d+ chars⟫/);
});
