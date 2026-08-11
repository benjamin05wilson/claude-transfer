/**
 * Redacting the bundle, rather than redacting the transcript and hoping.
 *
 * The original mistake was structural. Redaction ran over the transcript and the
 * sidecars, and then the bundle was assembled — picking up the prompt history,
 * the git diff, the origin remote and the working folder *after* the only thing
 * that scrubs anything had already finished. So `--redact` reported "1 secret
 * removed" and shipped the same key in four other places, which is worse than
 * not offering redaction at all: the label said the bundle was safe.
 *
 * The fix is an ordering rule. Assemble everything first, redact the finished
 * object, and then **check your work** — a second scan of the exact bytes about
 * to be written, which must come back empty. If it does not, the export fails
 * rather than producing a bundle whose label is a lie.
 *
 * Two things are handled unconditionally, with or without `--redact`:
 *
 *   **Credentials in a remote URL.** `https://user:ghp_xxx@github.com/acme/api`
 *   is a token stored where nobody looks. It is stripped always, because the URL
 *   is just as useful without it and nobody has ever wanted to send one.
 *
 *   **Binary files cannot be redacted.** A rule that matches inside a PNG cannot
 *   safely edit it. They are reported so the decision is visible, never silently
 *   treated as clean.
 */

import { redactText } from './redact.mjs';

/** A NUL byte means we cannot treat this as text, so we cannot redact it. */
const isTextBuffer = (buf) => !buf.includes(0) && buf.length < 8 * 1024 * 1024;

/**
 * Strip credentials from a URL, always.
 *
 * Handles the two spellings that carry them: `https://user:token@host/path`,
 * and the `token@host` form with no password.
 */
export function stripUrlCredentials(url) {
  if (typeof url !== 'string' || !url) return { url, stripped: false };
  const cleaned = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  return { url: cleaned, stripped: cleaned !== url };
}

/**
 * Every field of a bundle that can carry a secret, and how to reach it.
 *
 * Written as an explicit list rather than a blind walk of every string in the
 * object. A blind walk would also rewrite session ids, timestamps, sha hashes
 * and file paths — all of which are structural, and mangling them breaks the
 * import in ways that are far harder to diagnose than a missed secret.
 */
function textFields(bundle) {
  const fields = [];
  const push = (label, get, set) => fields.push({ label, get, set });

  push('session.title', () => bundle.session?.title, (v) => { if (bundle.session) bundle.session.title = v; });
  push('session.firstPrompt', () => bundle.session?.firstPrompt, (v) => { if (bundle.session) bundle.session.firstPrompt = v; });
  push('workspace.diff', () => bundle.workspace?.diff, (v) => { if (bundle.workspace) bundle.workspace.diff = v; });
  push('workspace.remote', () => bundle.workspace?.remote, (v) => { if (bundle.workspace) bundle.workspace.remote = v; });
  push('workspace.branch', () => bundle.workspace?.branch, (v) => { if (bundle.workspace) bundle.workspace.branch = v; });

  (bundle.prompts ?? []).forEach((p, i) => {
    push(`prompts[${i}]`, () => p.display, (v) => { p.display = v; });
  });

  return fields;
}

/** File maps whose values are base64 — the folder, the sidecars, the history. */
const fileMaps = (bundle) => [
  ['folder', bundle.folder],
  ['sidecars', bundle.sidecars],
  ['fileHistory', bundle.fileHistory],
];

/**
 * Redact — or, when scanning, merely count — everything in an assembled bundle.
 *
 * Mutates in place, because by this point the bundle *is* the thing being sent
 * and there is no value in leaving an unredacted copy alive in the same process.
 *
 * @returns {{findings:Array, binaries:Array<string>, remotesStripped:number}}
 */
export function redactBundle(bundle, { seen = new Map(), scanOnly = false, context = false } = {}) {
  const findings = [];
  const binaries = [];
  let remotesStripped = 0;

  // Always, regardless of --redact.
  if (bundle.workspace?.remote) {
    const { url, stripped } = stripUrlCredentials(bundle.workspace.remote);
    if (stripped) { bundle.workspace.remote = url; remotesStripped++; }
  }

  for (const { label, get, set } of textFields(bundle)) {
    const value = get();
    if (typeof value !== 'string' || !value) continue;
    const out = redactText(value, { seen, scanOnly, context });
    findings.push(...out.findings.map((f) => ({ ...f, where: label })));
    if (!scanOnly) set(out.text);
  }

  for (const [name, map] of fileMaps(bundle)) {
    if (!map || typeof map !== 'object') continue;
    for (const [rel, b64] of Object.entries(map)) {
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch { continue; }

      if (!isTextBuffer(buf)) {
        // Cannot be scanned or edited safely. Say so; never call it clean.
        binaries.push(`${name}:${rel}`);
        continue;
      }

      const out = redactText(buf.toString('utf8'), { seen, scanOnly, context });
      findings.push(...out.findings.map((f) => ({ ...f, where: `${name}:${rel}` })));
      if (!scanOnly && out.findings.some((f) => !f.fake)) {
        map[rel] = Buffer.from(out.text, 'utf8').toString('base64');
      }
    }
  }

  return { findings, binaries, remotesStripped };
}

/**
 * Read the finished bundle back and confirm nothing survived.
 *
 * Deliberately a separate pass over the assembled object rather than a tally of
 * what the redactor believes it did. The bug this exists to catch was precisely
 * a redactor that was confident and wrong, and a count it produced itself would
 * have been just as confident.
 */
export function verifyRedacted(bundle) {
  const copy = JSON.parse(JSON.stringify(bundle));
  const { findings, binaries } = redactBundle(copy, { seen: new Map(), scanOnly: true });
  const real = findings.filter((f) => !f.fake);
  return { clean: real.length === 0, remaining: real, binaries };
}
