/**
 * Check a bundle before letting it touch the machine.
 *
 * A bundle arrives from wherever the user got the code, and the import writes
 * into `~/.claude`. The old order validated as it went: it deleted the courier
 * copy, then checked the format, then discovered bad entries while already
 * halfway through writing. Anything that failed after the delete — an
 * unsupported format, a hostile path, a full disk — destroyed the only copy and
 * left a partial session behind.
 *
 * So every check that can be made without writing is made here, first, and the
 * import refuses as a whole rather than stopping in the middle.
 */

import { safeEntryPath } from './session.mjs';

/** A session with sidecars is normally under 50 MB; well past that is not one. */
export const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRIES = 20000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @returns {{ok:boolean, errors:string[], entries:number, bytes:number}}
 */
export function validateBundle(b, { maxFormat, into }) {
  const errors = [];
  const say = (m) => errors.push(m);

  if (!isObject(b)) return { ok: false, errors: ['this is not a bundle'], entries: 0, bytes: 0 };

  if (typeof b.format !== 'number') say('no format number — this may not be a bundle');
  else if (b.format > maxFormat) {
    say(`bundle format ${b.format}; this build understands up to ${maxFormat} — upgrade claude-transfer`);
  }

  if (!Array.isArray(b.transcript)) say('no transcript');
  else if (!b.transcript.length) say('the transcript is empty');
  else if (!b.transcript.every((l) => typeof l === 'string')) say('the transcript is malformed');

  if (!isObject(b.session)) say('no session block');
  else if (typeof b.session.id !== 'string' || !b.session.id) say('the session has no id');

  if (!isObject(b.origin)) say('no origin block');
  else if (typeof b.origin.cwd !== 'string' || !b.origin.cwd) {
    say('this bundle records no working directory — it may be truncated');
  }

  if (b.redaction !== undefined && !isObject(b.redaction)) say('the redaction block is malformed');
  if (b.workspace !== undefined && !isObject(b.workspace)) say('the workspace block is malformed');
  if (b.prompts !== undefined && !Array.isArray(b.prompts)) say('the prompt history is malformed');

  // Every file map, checked for hostile paths *before* a single byte is written.
  let entries = 0;
  let bytes = 0;
  for (const [name, map] of [['sidecars', b.sidecars], ['fileHistory', b.fileHistory], ['folder', b.folder]]) {
    if (map === undefined || map === null) continue;
    if (!isObject(map)) { say(`the ${name} block is malformed`); continue; }

    for (const [rel, value] of Object.entries(map)) {
      entries++;
      if (typeof value !== 'string') { say(`${name}: ${JSON.stringify(rel)} is not file content`); continue; }
      // A hostile entry is a property of the bundle, not of one destination, so
      // it is caught here even though unpackDir would also refuse it.
      if (into && !safeEntryPath(into, rel)) {
        say(`${name}: ${JSON.stringify(rel)} would write outside the target directory`);
      }
      bytes += Math.floor(value.length * 0.75); // base64 → bytes
    }
  }

  if (entries > MAX_ENTRIES) say(`${entries} files is more than an import should contain`);
  if (bytes > MAX_EXPANDED_BYTES) {
    say(`this bundle expands to about ${Math.round(bytes / 1048576)} MB, which is more than an import should be`);
  }

  return { ok: errors.length === 0, errors, entries, bytes };
}
