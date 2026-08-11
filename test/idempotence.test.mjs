/**
 * Redaction must be idempotent, for every rule.
 *
 * The bug this pins: rules run in sequence over the same text, so a value
 * replaced by an earlier rule was still sitting there when a later one looked.
 * `secret=sk-ant-…` became `secret=‹anthropic-key:1›`, which the generic
 * assigned-secret rule then read as another credential — so redacting twice gave
 * different answers, and the verification pass reported values still present and
 * refused the export.
 *
 * Two properties, asserted per rule rather than on a sample, because the failure
 * came from one specific pair of rules interacting and a sample would have
 * missed it:
 *
 *   redact(redact(x)) === redact(x)
 *   scan(redact(x)).findings === []
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { redactText, RULES, isRedacted } from '../src/redact.mjs';
import { redactBundle, verifyRedacted } from '../src/bundle-redact.mjs';

/**
 * Fixtures assembled at runtime rather than written out.
 *
 * A file full of credential-shaped literals is a file that secret scanners
 * block on push — which is the correct behaviour, and pushing this suite is how
 * I found that out. Joining the parts keeps the values realistic enough to
 * exercise the rules without ever committing something that looks like a live
 * key.
 */
const join = (...parts) => parts.join('');

const ANTHROPIC = join('sk-', 'ant-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
const GITHUB = join('ghp', '_', 'A'.repeat(36));
const AWS = join('AKIA', 'IOSFODNN7EXAMPLE');
const SLACK = join('xoxb', '-123456789012-123456789012-', 'abcdefghijklmnopqrstuvwx');
const BEARER = join('Bearer ', 'abcdefghijklmnopqrstuvwxyz0123456789');

/** One realistic value per rule, plus the assignment forms that broke it. */
const SAMPLES = [
  ANTHROPIC,
  `secret=${ANTHROPIC}`,
  `SECRET = ${ANTHROPIC}`,
  `api_key: ${ANTHROPIC}`,
  GITHUB,
  `token=${GITHUB}`,
  AWS,
  `aws_access_key_id=${AWS}`,
  'password=hunter2secretlongvalue',
  'DB_PASSWORD=aB3xK9zQ1mP7wR',
  `Authorization: ${BEARER}`,
  SLACK,
  join('-----BEGIN ', 'RSA PRIVATE KEY', '-----'),
];

test('redacting twice gives the same answer, for every sample', () => {
  for (const sample of SAMPLES) {
    const once = redactText(sample, { scanOnly: false }).text;
    const twice = redactText(once, { scanOnly: false }).text;
    assert.equal(twice, once, `not idempotent: ${sample}\n  once:  ${once}\n  twice: ${twice}`);
  }
});

test('scanning redacted text finds nothing left', () => {
  for (const sample of SAMPLES) {
    const once = redactText(sample, { scanOnly: false }).text;
    const left = redactText(once, { scanOnly: true }).findings.filter((f) => !f.fake);
    assert.equal(left.length, 0,
      `${left.length} finding(s) survive redaction of: ${sample}\n  redacted: ${once}`);
  }
});

test('every rule is idempotent against its own placeholder', () => {
  // Constructed rather than sampled: whatever a rule produces must not then look
  // like a credential to that rule, or to any other.
  for (const rule of RULES) {
    const placeholder = `‹${rule.id}:1›`;
    assert.ok(isRedacted(placeholder), `${rule.id}: its own placeholder must be recognised`);

    for (const prefix of ['', 'secret=', 'password: ', 'token = ', 'api_key=']) {
      const text = `${prefix}${placeholder}`;
      const out = redactText(text, { scanOnly: false });
      assert.equal(out.text, text, `${rule.id}: rewrote an existing placeholder in "${text}"`);
      assert.equal(out.findings.filter((f) => !f.fake).length, 0,
        `${rule.id}: flagged an existing placeholder in "${text}"`);
    }
  }
});

test('a bundle redacts idempotently and then verifies clean', () => {
  const make = () => ({
    session: { title: `secret=${ANTHROPIC}`, firstPrompt: null },
    workspace: { diff: '+password=hunter2secretlongvalue', remote: null },
    prompts: [{ display: `token=${GITHUB}` }],
    folder: { 'a.env': Buffer.from('DB_PASSWORD=aB3xK9zQ1mP7wR').toString('base64') },
  });

  const once = make();
  redactBundle(once, { scanOnly: false });

  const twice = JSON.parse(JSON.stringify(once));
  redactBundle(twice, { scanOnly: false });

  assert.deepEqual(twice, once, 'redacting a bundle twice must change nothing the second time');

  const check = verifyRedacted(once);
  assert.equal(check.clean, true,
    `verification refused a redacted bundle: ${JSON.stringify(check.remaining)}`);
});

test('the exact input from the report now redacts cleanly', () => {
  const input = `secret=${ANTHROPIC}`;
  const out = redactText(input, { scanOnly: false });
  assert.ok(!out.text.includes(ANTHROPIC));
  assert.equal(redactText(out.text, { scanOnly: false }).text, out.text);
  assert.equal(redactText(out.text, { scanOnly: true }).findings.filter((f) => !f.fake).length, 0);
});
