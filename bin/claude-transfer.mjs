#!/usr/bin/env node
/**
 * claude-transfer — the plumbing behind /transfer.
 *
 * You are not meant to type these. Use `/transfer` in Claude Code, which drives
 * this. The commands exist so the skill has something to call, and so there is a
 * way in when Claude Code itself is not available.
 *
 *   claude-transfer list                        resumable sessions here, newest first
 *   claude-transfer out [session] [-o file]     package a session into a .claude-transfer bundle
 *                                    (--redact to strip secrets, --preview to see them)
 *                                    (--with-files to send the working folder too)
 *   claude-transfer send [session]              hand it straight to the other machine
 *                                    (--via github to go through a private gist)
 *   claude-transfer in <file|url|gh:code> [--into <dir>]  unpack it here, print the resume command
 *                                    (--dry-run to see the import plan and write nothing)
 *   claude-transfer sync [session]              line the working tree up with an imported session
 *                                    (--checkout for its commit, --apply-diff for its edits)
 *   claude-transfer archive [session]           retire a session here, so only one side stays live
 *   claude-transfer check <file|url|gh:code>    inspect a transfer without accepting it
 *   claude-transfer pending [--clean --yes]     transfers of yours still sitting on GitHub
 *                                    (--older-than <days> to narrow it)
 *                                    (--force to import despite an untested Claude Code version)
 *   claude-transfer setup                       install the /transfer skill for Claude Code
 *
 * The whole conversation travels, not a summary — you reopen the same chat and
 * carry on. What makes that work, reverse-engineered from Claude Code 2.1.226:
 *
 *   projects/<enc-cwd>/<id>.jsonl   the conversation, and the control records
 *                                   `/resume` reads for its title and preview
 *   projects/<enc-cwd>/<id>/        subagents, workflows, tool results
 *   file-history/<id>/              undo and rewind snapshots
 *   history.jsonl                   ↑ prompt recall, keyed by id and project
 *
 * All four are keyed by session id, so an import mints a new id and rewrites it
 * everywhere. Two record types are deliberately dropped: `frame-link` points
 * into the exporting machine's temp directory, and `bridge-session` ties the
 * session to a cloud session that is not yours to inherit.
 *
 * The whole transcript travels intact by default. Moving your own session to
 * your own machine over an encrypted one-shot channel does not increase
 * exposure — the secret is already at both ends — and redaction is
 * irreversible, so `claude-transfer` tells you what a bundle contains and leaves it alone.
 * `--redact` is for the cases that warrant it: a bundle written to a file, which
 * can travel anywhere, or a session going to somebody who is not you.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir, hostname, platform } from 'node:os';
import { resolve, join, basename, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  listSessions, findSession, readTranscript, writeTranscript, describe, rehome,
  destinationFor, newSessionId, projectsRoot, footprint, stripMachineLocal,
  packDir, unpackDir, readHistoryFor, appendHistory, encodeProjectDir, safeEntryPath, makeSwapper,
} from '../src/session.mjs';
import { redactText, redactTranscript, portablePaths, formatReport, summarise } from '../src/redact.mjs';
import { redactBundle, verifyRedacted } from '../src/bundle-redact.mjs';
import { serveOnce, collect, looksLikeUrl, MAX_BUNDLE_BYTES, lanAddress, reachBeyondLan, encrypt, decrypt } from '../src/wire.mjs';
import { captureWorkspace, inspectTarget, compareWorkspace, checkout, applyDiff } from '../src/workspace.mjs';
import * as github from '../src/github.mjs';
import { collectFolder, conflicts, MAX_FOLDER_BYTES } from '../src/folder.mjs';
import { validateBundle } from '../src/validate.mjs';
import { writeReceipt, readReceipt, listReceipts } from '../src/receipt.mjs';
import { assess, hereVersion } from '../src/compat.mjs';

const FORMAT = 3;
const die = (m) => { console.error(`claude-transfer: ${m}`); process.exit(1); };
const human = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const claudeDir = () => dirname(projectsRoot());

function parseArgs(argv) {
  const f = { __proto__: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      // Any leading dash means the next flag, not this one's value. Checking
      // only for `--` meant `--with-files -o out.claude-transfer` swallowed the `-o` and
      // silently wrote to the default filename.
      if (next === undefined || next.startsWith('-')) f[k] = true;
      else { f[k] = next; i++; }
    } else if (a === '-o') f.out = argv[++i];
    else f._.push(a);
  }
  return f;
}

/**
 * Read a flag that must carry a value.
 *
 * `--into` with nothing after it parses as `true`, and passing that to a path
 * function throws `The "paths[0]" argument must be of type string`, which tells
 * the user nothing about what they typed wrong.
 */
function strFlag(flags, name, fallback = undefined) {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') die(`--${name} needs a value, e.g. --${name} .`);
  return value;
}

/** Reject an unrecognised choice rather than quietly doing something else. */
function oneOf(value, allowed, name) {
  if (value !== undefined && !allowed.includes(value)) {
    die(`--${name} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

const isTextish = (buf) => !buf.includes(0) && buf.length < 8 * 1024 * 1024;

/**
 * Claude sessions running on this machine right now, and where.
 *
 * Used only to point out a likely mistake — landing a session in a directory
 * that is not the one the user is actually working in. Best effort: if the CLI
 * is missing or the shape changes, we simply say nothing.
 */
function runningSessions() {
  try {
    const res = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0) return [];
    const list = JSON.parse(res.stdout);
    return Array.isArray(list) ? list.filter((s) => s?.cwd) : [];
  } catch { return []; }
}

/** Redact and de-personalise the sidecar files — they are transcripts too. */
function cleanFiles(files, { home, seen, findings, scanOnly = true, context = false }) {
  const out = {};
  let paths = 0;
  for (const [rel, b64] of Object.entries(files)) {
    const buf = Buffer.from(b64, 'base64');
    if (!isTextish(buf)) { out[rel] = b64; continue; }
    const { text, findings: found } = redactText(buf.toString('utf8'), { seen, scanOnly, context });
    findings.push(...found);
    const portable = portablePaths(text, home);
    paths += portable.count;
    out[rel] = Buffer.from(portable.text).toString('base64');
  }
  return { files: out, paths };
}

/**
 * Package a session: strip machine-local records, redact, pack the sidecars,
 * and compress. Shared by `out` (writes a file) and `send` (hands it over).
 */
function build(flags) {
  const wanted = flags._[0];
  const session = wanted ? findSession(wanted) : listSessions()[0];
  if (!session) die(wanted ? `no session matching "${wanted}"` : 'no sessions found');

  const paths = footprint(session, { claudeDir: claudeDir() });
  const raw = readTranscript(paths.transcript);
  const kept = stripMachineLocal(raw);
  const info = describe(kept);
  const title = raw.find((r) => r.type === 'ai-title')?.aiTitle ?? null;

  // Full fidelity by default. Your session going to your own machine over an
  // encrypted one-shot channel does not increase exposure — the secret is
  // already at both ends — and redacting is irreversible: the placeholder is all
  // the bundle carries, so the resumed conversation reads mangled text forever.
  // Scanning tells you what is in there without touching a byte.
  const redacting = flags.redact === true;
  const seen = new Map();
  const findings = [];
  // --preview asks for the surrounding text of each hit, which costs nothing
  // when it is not requested and was simply never switched on.
  const wantContext = flags.preview === true;
  const scanOpts = { home: homedir(), seen, scanOnly: !redacting, context: wantContext };

  const done = redactTranscript(kept, scanOpts);
  const transcript = done.records;
  let report = done.report;

  const a = cleanFiles(packDir(paths.sidecars), { home: homedir(), seen, findings, scanOnly: !redacting, context: wantContext });
  const b = cleanFiles(packDir(paths.fileHistory), { home: homedir(), seen, findings, scanOnly: !redacting, context: wantContext });
  const sidecars = a.files;
  const history = b.files;

  // Fold the sidecar findings into the same report the transcript produced.
  const asFindings = report.rows.flatMap((r) => [
    ...Array.from({ length: r.redacted }, () => ({ id: r.id, label: r.label, fake: false })),
    ...Array.from({ length: r.examples }, () => ({ id: r.id, label: r.label, fake: true })),
  ]);
  report = summarise([...asFindings, ...findings], report.pathsRewritten + a.paths + b.paths);

  const prompts = readHistoryFor(paths.historyLog, session.id);
  const workspace = captureWorkspace(info.cwd);

  // The files themselves, when the far machine cannot fetch the repository —
  // private, unconfigured, or never a repository at all.
  const folder = flags['with-files']
    ? collectFolder(info.cwd, { includeUntracked: flags['include-untracked'] === true })
    : { files: {}, bytes: 0, count: 0, method: 'not included', skipped: [], truncated: false };

  // Home paths are always made portable — that is re-homing, not redaction, and
  // the import puts the receiving machine's home back.
  const portable = (text) => (text ? portablePaths(text, homedir()).text : text ?? null);
  const scrub = (text) => {
    if (!text) return null;
    const out = redactText(text, { seen, scanOnly: !redacting });
    findings.push(...out.findings);
    return portable(out.text);
  };

  console.log(`session   ${session.id}${title ? `  — ${title}` : ''}`);
  console.log(`from      ${info.cwd}`);
  console.log(`carries   transcript ${info.records} records`
    + `  ·  sidecars ${Object.keys(sidecars).length} files`
    + `  ·  file-history ${Object.keys(history).length}`
    + `  ·  ${prompts.length} prompts`);
  console.log(`dropped   ${raw.length - kept.length} machine-local records (frame-link, bridge-session)`);
  if (flags['with-files']) {
    console.log(`files     ${folder.count} file(s), ${human(folder.bytes)}  ·  ${folder.method}`);
    if (folder.skipped.length) {
      console.log(`          skipped ${folder.skipped.length} large file(s): `
        + folder.skipped.slice(0, 3).map((s2) => `${s2.path} (${s2.why})`).join(', '));
    }
    if (folder.truncated) console.log('          stopped early — the folder is bigger than a bundle should be');
    if (!flags['include-untracked'] && folder.method.startsWith('git')) {
      console.log('          tracked files only, so .gitignore still applies (--include-untracked to override)');
    }
  }
  console.log(`workspace ${workspace.isRepo
    ? `${workspace.branch ?? 'detached'} @ ${workspace.head?.slice(0, 8)}`
      + (workspace.dirty ? `  ·  ${workspace.changedFiles} uncommitted file(s)${workspace.diff ? ', diff included' : ''}` : ' · clean')
      + (workspace.diffTruncated ? '  ·  diff too large, omitted' : '')
    : workspace.reason}`);

  const body = formatReport(report);
  console.log(redacting ? 'redacted' : 'contains');
  console.log(body || '  nothing notable');
  if (!redacting && report.redacted) {
    console.log('  (left intact — this is your data. `--redact` replaces it, irreversibly)');
  }

  const bundle = {
    format: FORMAT,
    created: new Date().toISOString(),
    origin: {
      host: hostname(), platform: platform(),
      cwd: portable(info.cwd), branches: info.branches, versions: info.versions,
    },
    session: { id: session.id, title: scrub(title), records: info.records, firstPrompt: scrub(info.firstPrompt) },
    redaction: { applied: redacting, rows: report.rows, redacted: report.redacted, pathsRewritten: report.pathsRewritten },
    workspace,
    folder: folder.files,
    folderMeta: { count: folder.count, bytes: folder.bytes, method: folder.method, truncated: folder.truncated },
    transcript: transcript.map((r) => r.__raw ?? JSON.stringify(r)),
    sidecars,
    fileHistory: history,
    prompts,
  };

  // Everything above assembles the bundle. Redaction runs *here*, on the
  // finished object, because the prompt history, the git diff, the origin remote
  // and the working folder all arrive after the transcript has been scrubbed —
  // and redacting the transcript alone shipped the same key in four other places
  // under a label that said the bundle was safe.
  const sweep = redactBundle(bundle, { seen, scanOnly: !redacting, context: wantContext });
  const swept = sweep.findings.filter((f) => !f.fake);

  if (sweep.remotesStripped) {
    console.log('remote    credentials stripped from the origin URL');
  }

  if (swept.length) {
    const where = [...new Set(swept.map((f) => f.where))];
    console.log(redacting
      ? `also      ${swept.length} secret(s) removed from ${where.join(', ')}`
      : `also      ${swept.length} secret(s) in ${where.join(', ')}`);
  }

  // The count in the bundle is written before the sweep runs, so it only ever
  // described the transcript — a bundle could say "1 secret" while the sweep had
  // just handled four more in the diff, the prompts and the carried folder. The
  // number a reader sees should be the number of things that were found.
  bundle.redaction = {
    ...bundle.redaction,
    redacted: (bundle.redaction?.redacted ?? 0) + swept.length,
    inTranscript: bundle.redaction?.redacted ?? 0,
    inBundle: swept.length,
    binaries: sweep.binaries.length,
    remotesStripped: sweep.remotesStripped,
  };

  if (sweep.binaries.length) {
    console.log(`binary    ${sweep.binaries.length} file(s) cannot be scanned or redacted: `
      + `${sweep.binaries.slice(0, 3).join(', ')}${sweep.binaries.length > 3 ? ' …' : ''}`);
    if (redacting) {
      console.log('          they travel byte for byte — redaction cannot reach inside them');
    }
  }

  // --preview, over everything: the transcript, the sidecars, and the fields
  // swept from the assembled bundle. It used to read only the sidecar findings,
  // and no call ever asked for context, so it printed nothing at all.
  if (wantContext) {
    const all = [...(done.findings ?? []), ...findings, ...sweep.findings]
      .filter((f) => f.context && !f.fake);
    if (!all.length) {
      console.log('preview   nothing to show — no credential-shaped values found');
    } else {
      console.log(`preview   ${all.length} hit(s), value masked:`);
      for (const f of all.slice(0, 40)) {
        console.log(`    ${f.label}${f.where ? ` (${f.where})` : ''}: ${f.context.slice(0, 100)}`);
      }
      if (all.length > 40) console.log(`    …and ${all.length - 40} more`);
    }
  }

  // Check the work rather than trust the tally. The bug this guards against was
  // a redactor that was confident and wrong, so a count it produced itself would
  // have been equally confident.
  if (redacting) {
    const check = verifyRedacted(bundle);
    if (!check.clean) {
      const where = [...new Set(check.remaining.map((f) => f.where))];
      die(`redaction did not hold: ${check.remaining.length} value(s) still present in `
        + `${where.join(', ')}. Refusing to write a bundle labelled redacted. `
        + 'Please report this with the rule name.');
    }
    console.log('verified  a second scan of the finished bundle found nothing left');
  }

  const json = JSON.stringify(bundle);
  return { gz: gzipSync(Buffer.from(json), { level: 9 }), rawSize: json.length, session, title, report, redacting };
}

const commands = {
  __proto__: null,

  /**
   * Bring the working tree into line with an already-imported session.
   *
   * Separate from `in` on purpose. Telling someone to re-run the import with
   * `--sync` could never work: a gist is consumed by the first successful
   * receive, so there is nothing left to fetch, and even from a file it would
   * mint a second session rather than finish the first. This works from what the
   * import wrote down, so it needs no bundle and can be run whenever.
   */
  sync(flags) {
    const wanted = flags._[0];
    const receipts = listReceipts(claudeDir());

    if (!wanted) {
      if (!receipts.length) die('nothing has been imported on this machine yet');
      console.log('imported sessions');
      for (const r of receipts.slice(0, 10)) {
        console.log(`  ${r.session.slice(0, 8)}  ${r.title ?? '(untitled)'}`);
        console.log(`            into ${r.into}  ·  ${r.at?.slice(0, 16).replace('T', ' ')}`);
      }
      console.log('\nclaude-transfer sync <id> [--apply-diff]');
      return;
    }

    const r = readReceipt(claudeDir(), wanted);
    if (!r) die(`no imported session matching "${wanted}" — \`claude-transfer sync\` lists them`);
    if (!r.workspace?.isRepo) {
      die(`that session did not run in a git repository (${r.workspace?.reason ?? 'unknown'}), so there is nothing to sync`);
    }

    const here = inspectTarget(r.into);
    const ws = compareWorkspace(r.workspace, here, r.into);
    console.log(`session    ${r.title ?? '(untitled)'}  (${r.session.slice(0, 8)})`);
    console.log(`directory  ${r.into}`);
    console.log(`workspace  ${ws.summary}`);

    if (!flags.checkout && !flags['apply-diff']) {
      for (const action of ws.actions) console.log(`           ${action}`);
      console.log('\n--checkout to move to the session\'s commit, --apply-diff to restore its edits');
      return;
    }

    if (flags.checkout) {
      const moved = checkout(r.into, r.workspace.head);
      console.log(moved.ok
        ? `checked out ${r.workspace.head.slice(0, 8)}`
        : `could not check out: ${moved.error}`);
      if (!moved.ok) return;
    }

    if (flags['apply-diff']) {
      if (!r.workspace.diff) die('that session had no uncommitted changes to restore');
      const applied = applyDiff(r.into, r.workspace.diff);
      console.log(applied.ok
        ? `re-applied the uncommitted changes${applied.files?.length ? ` (${applied.files.length} file(s))` : ''}`
        : `could not apply the diff: ${applied.error}`);
    }
  },

  /**
   * Retire a session on this machine, so only one side stays live.
   *
   * A transfer copies. Both machines end up with a resumable session and can
   * carry on independently, which is usually what you want — the laptop still
   * has it if the desktop import goes wrong — but it does mean two histories
   * that can diverge without either side noticing.
   *
   * Archiving moves the session out of where `/resume` looks, rather than
   * deleting anything. It stops appearing in the list; it is still on disk, and
   * `--restore` puts it back.
   */
  archive(flags) {
    const dir = join(claudeDir(), 'claude-transfer', 'archive');

    if (flags.restore) {
      const id = strFlag(flags, 'restore');
      if (typeof id !== 'string') die('--restore needs a session id');
      const from = join(dir, `${id}.jsonl`);
      const meta = join(dir, `${id}.json`);
      if (!existsSync(from) || !existsSync(meta)) die(`nothing archived with id ${id}`);
      const { path } = JSON.parse(readFileSync(meta, 'utf8'));
      mkdirSync(dirname(path), { recursive: true });
      renameSync(from, path);
      rmSync(meta, { force: true });
      console.log(`restored ${path}`);
      return;
    }

    if (flags.list || !flags._[0]) {
      if (!existsSync(dir)) return console.log('nothing archived');
      const rows = readdirSync(dir).filter((f) => f.endsWith('.json'));
      if (!rows.length) return console.log('nothing archived');
      console.log('archived sessions');
      for (const f of rows) {
        try {
          const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          console.log(`  ${m.id.slice(0, 8)}  ${m.title ?? '(untitled)'}  ·  archived ${m.at?.slice(0, 16).replace('T', ' ')}`);
        } catch { /* a corrupt entry should not hide the rest */ }
      }
      console.log('\nclaude-transfer archive --restore <id>   to put one back');
      return;
    }

    const session = findSession(flags._[0]);
    if (!session) die(`no session matching "${flags._[0]}"`);

    const records = readTranscript(session.path);
    const title = records.find((r) => r.type === 'ai-title')?.aiTitle ?? null;

    // An archived session is a whole conversation. Owner-only, explicitly.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify({
      id: session.id, path: session.path, title, at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    renameSync(session.path, join(dir, `${session.id}.jsonl`));

    console.log(`archived  ${title ?? '(untitled)'}  (${session.id.slice(0, 8)})`);
    console.log('It no longer appears in /resume here. Nothing was deleted —');
    console.log(`restore it with:  claude-transfer archive --restore ${session.id}`);
  },

  /**
   * Transfers of yours still sitting on GitHub.
   *
   * A gist is deleted when it is collected, so anything listed here was never
   * picked up: a send that went to the wrong machine, a code that was lost, an
   * import that failed. They are encrypted and private, so this is untidiness
   * rather than exposure — but they are still your sessions, sitting in your
   * account indefinitely, and nothing else was ever going to clear them up.
   */
  pending(flags) {
    // Arguments are checked before anything is fetched. `Number('nope')` is NaN
    // and every comparison against NaN is false, so an unparseable age silently
    // skipped the age check and `--clean` deleted everything — the opposite of
    // what someone narrowing a deletion asked for. Validating after the early
    // return meant a bad value was never even noticed when nothing was pending.
    const raw = strFlag(flags, 'older-than', '0');
    // `Number('')` is 0, so an empty value would quietly mean "no age filter" —
    // the same silent widening, arrived at a different way.
    const days = String(raw).trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(days) || days < 0) {
      die(`--older-than needs a number of days, got ${JSON.stringify(raw)}`);
    }
    const cutoff = Date.now() - days * 86_400_000;

    const open = github.pending();
    if (!open.length) return console.log('no uncollected transfers');


    console.log(`${open.length} uncollected transfer${open.length === 1 ? '' : 's'}`);
    for (const g of open) console.log(`  ${g.id.slice(0, 12)}  ${g.description}`);

    if (!flags.clean) {
      console.log('\nThese are encrypted and private. `--clean` deletes them,');
      console.log('`--clean --older-than 7` only the ones older than a week.');
      return;
    }

    // Deleting every uncollected transfer is not something to do because a flag
    // was typed once. Narrowing by age is itself a statement of intent, so that
    // case stands on its own; deleting the lot is not.
    if (days === 0 && !flags.yes) {
      console.log(`\nThis would delete all ${open.length}. Re-run with --yes, or narrow it with --older-than <days>.`);
      return;
    }

    let gone = 0;
    for (const g of open) {
      // Best effort per gist: one failure should not abandon the rest.
      if (days > 0) {
        const when = Date.parse(g.raw?.split('\t').pop() ?? '');
        if (Number.isFinite(when) && when > cutoff) continue;
      }
      if (github.remove(g.id)) gone++;
    }
    console.log(`\ndeleted ${gone} of ${open.length}`);
  },

  list() {
    const sessions = listSessions().slice(0, 25);
    if (!sessions.length) return console.log('no sessions found');
    for (const s of sessions) {
      const records = readTranscript(s.path);
      const title = records.find((r) => r.type === 'ai-title')?.aiTitle;
      const info = describe(records);
      console.log(`${s.id.slice(0, 8)}  ${s.modified.slice(0, 16).replace('T', ' ')}  ${human(s.bytes).padStart(7)}  ${title ?? info.firstPrompt ?? '(untitled)'}`);
      console.log(`          ${info.cwd ?? '?'}`);
    }
  },

  out(flags) {
    const { gz, rawSize, session, report, redacting } = build(flags);
    const out = resolve(strFlag(flags, 'out', `${session.id.slice(0, 8)}.claude-transfer`));
    writeFileSync(out, gz);

    // A file is the one route that can end up somewhere you did not intend — a
    // shared drive, a repo, a chat thread. The encrypted one-shot wire cannot,
    // so `send` stays quiet about this.
    if (!redacting && report.redacted) {
      console.log(`\n⚠  this file contains ${report.redacted} credential-shaped value(s), unredacted.`);
      console.log('   Fine for your own machines. Re-run with --redact before sharing it.');
    }
    console.log(`\nwrote ${out}  (${human(gz.length)} from ${human(rawSize)})`);
    console.log(`sha256 ${createHash('sha256').update(gz).digest('hex').slice(0, 16)}`);
    console.log(`\nOn the other machine: /transfer → Receive, and give it this file.`);
  },

  /**
   * Hand the session straight to the other machine.
   *
   * Served once, on the local network, to whoever asks first with the right
   * token — then the server stops. No cloud, no third party, nothing stored:
   * the bytes go from this machine to that one and nowhere else.
   */
  async send(flags) {
    oneOf(flags.via, ['lan', 'github'], 'via');
    const { gz, rawSize } = build(flags);

    if (flags.via === 'github') {
      const keyHex = randomBytes(32).toString('hex');
      const blob = encrypt(gz, keyHex);
      let created;
      try { created = github.put(blob, { description: github.anonymousDescription() }); }
      catch (err) { return die(err.message); }

      console.log(`\nuploaded ${human(blob.length)} to a private gist`);
      console.log('GitHub holds ciphertext only — the key below never leaves this machine\'s output.\n');
      console.log('On the other machine: /transfer → Receive, and paste this code.\n');
      console.log(`  ${github.buildCode(created.id, keyHex)}\n`);
      console.log('It is deleted as soon as it is collected. Both machines never need to be');
      console.log('awake at the same time.');
      return;
    }

    const { url, done } = await serveOnce(gz, {
      port: Number(flags.port) || 0,
      timeout: (Number(flags.wait) || 600) * 1000,
    });

    const addr = lanAddress();
    console.log(`\nready    ${human(gz.length)} from ${human(rawSize)}`);
    console.log(reachBeyondLan(addr)
      ? `reach    ${addr} — a tailnet address, so this works from anywhere`
      : `reach    ${addr} — a local address, so the other machine must be on this network`);
    if (!reachBeyondLan(addr)) {
      console.log('         (tailscale on both machines makes this work anywhere)');
    }
    console.log(`\nOn the other machine: /transfer → Receive, and paste this code.\n`);
    console.log(`  ${url}\n`);
    console.log('waiting — this stops as soon as it is collected (Ctrl-C to cancel)');

    const outcome = await done;
    console.log(outcome === 'collected' ? '\ncollected. the session is on the other machine.' : '\ntimed out, nothing sent.');
    process.exit(outcome === 'collected' ? 0 : 1);
  },

  /**
   * Install the `/transfer` skill, so the whole thing is reachable by typing
   * `/transfer` in Claude Code rather than remembering a CLI.
   */
  setup(flags) {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const dest = join(claudeHome, 'skills', 'transfer');
    const source = fileURLToPath(new URL('../skills/transfer', import.meta.url));

    if (flags.uninstall) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`removed ${dest}`);
      return;
    }

    if (!existsSync(source)) die(`cannot find the skill to install (looked in ${source})`);
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(source, dest, { recursive: true });

    console.log(`installed  ${dest}`);
    console.log(`command    claude-transfer  (${process.argv[1]})`);
    const open = runningSessions();
    console.log(open.length
      ? `\nType /transfer in Claude Code. Reload an open session first — skills are read at startup,\nunlike sessions.`
      : '\nType /transfer in Claude Code.');
  },

  /**
   * Inspect a bundle without accepting it.
   *
   * Takes anything `in` takes — a file, a URL, or a gh: code — because the one
   * moment inspection is worth having is when somebody has sent you a code and
   * you do not yet know what is in it. Restricting this to files meant it could
   * only be used on bundles you had already made yourself.
   *
   * Nothing is written and, for a gh: code, nothing is consumed: the transfer is
   * still collectable afterwards.
   */
  async check(flags) {
    const source = flags._[0];
    if (!source) die('need a bundle file, a claude-transfer URL, or a gh: code');

    let b;
    if (github.looksLikeGhCode(source)) {
      const code = github.parseCode(source);
      if (!code) die('that gh: code looks malformed — copy the whole thing, including the # part');
      if (!code.key) die('that code has no key on the end — copy the whole line, including the # part');
      b = parseBundle(decrypt(await github.get(code.id), code.key));
      console.log('source     a GitHub transfer — still there, this did not collect it');
    } else if (looksLikeUrl(source)) {
      b = parseBundle(await collect(source));
      console.log('source     a direct transfer — note this DOES consume it, it is one-shot');
    } else {
      b = load(source);
    }

    // Validated before any field is read. `check` is the command people run on
    // something they do not trust, so it must not be the one that dereferences
    // a malformed bundle and dies with a type error instead of an explanation.
    const shape = validateBundle(b, { maxFormat: FORMAT, into: null });
    if (!shape.ok) {
      console.log('this bundle is malformed:');
      for (const e of shape.errors) console.log(`  ${e}`);
      console.log('\n`claude-transfer in` will refuse it.');
      return;
    }

    console.log(`format     ${b.format}`);
    console.log(`created    ${b.created}`);
    console.log(`origin     ${b.origin.host} (${b.origin.platform})  Claude Code ${b.origin.versions.join('/') || '?'}`);
    console.log(`cwd        ${b.origin.cwd}`);
    console.log(`title      ${b.session.title ?? '(untitled)'}`);
    console.log(`carries    ${b.session.records} records  ·  ${Object.keys(b.sidecars ?? {}).length} sidecars`
      + `  ·  ${Object.keys(b.fileHistory ?? {}).length} history files  ·  ${(b.prompts ?? []).length} prompts`);
    console.log(`redacted   ${b.redaction.applied ? `${b.redaction.redacted} secrets, ${b.redaction.pathsRewritten} paths` : 'NO — raw bundle'}`);

    const verdict = assess({ sourceVersions: b.origin?.versions ?? [], hereVersion: hereVersion() });
    console.log(`versions   ${verdict.summary}${verdict.ok ? '' : ' — `in` will refuse this without --force'}`);

    // A count is not an inspection. Show the paths, because these are the files
    // the bundle will write on this machine, and flag any that try to escape.
    // The carried folder belongs in here too: those are the entries that land in
    // the user's own project rather than under ~/.claude, so they are the ones
    // most worth seeing before accepting anything.
    const keys = [
      ...Object.keys(b.sidecars ?? {}),
      ...Object.keys(b.fileHistory ?? {}),
      ...Object.keys(b.folder ?? {}),
    ];
    const hostile = keys.filter((k) => !safeEntryPath('/probe', k));
    if (hostile.length) {
      console.log(`\n⚠  ${hostile.length} entr${hostile.length === 1 ? 'y' : 'ies'} would write OUTSIDE the target directory:`);
      for (const k of hostile.slice(0, 10)) console.log(`     ${k}`);
      console.log('   `claude-transfer in` will refuse this bundle. Do not trust its source.');
      return;
    }
    if (Object.keys(b.folder ?? {}).length) {
      console.log(`carries    ${Object.keys(b.folder).length} working file(s) that land in your project`);
    }
    if (flags.files && keys.length) {
      console.log('\nfiles it would write:');
      for (const k of keys) console.log(`  ${k}`);
    } else if (keys.length) {
      console.log(`\n(${keys.length} files — pass --files to list them)`);
    }
  },

  async in(flags) {
    const source = flags._[0];
    if (!source) die('need a bundle file, a claude-transfer URL, or a gh: code');

    // Fetched, never consumed. The courier copy is the only copy, and the old
    // order deleted it here — before the format check, before any validation,
    // before a byte was written. An unsupported format, a hostile path or a full
    // disk then destroyed the transfer and left a partial session behind.
    let b;
    let courier = null;
    if (github.looksLikeGhCode(source)) {
      const code = github.parseCode(source);
      if (!code) die('that gh: code looks malformed — copy the whole thing, including the # part');
      if (!code.key) die('that code has no key on the end — copy the whole line, including the # part');
      const blob = await github.get(code.id);
      b = parseBundle(decrypt(blob, code.key));
      courier = code.id;
    } else {
      b = looksLikeUrl(source) ? parseBundle(await collect(source)) : load(source);
    }

    const into = resolve(strFlag(flags, 'into', process.cwd()));
    // Not created yet: a dry run reports that nothing was written, and creating
    // a directory is a change. It happens once the import is actually going
    // ahead, just below.
    if (!flags['dry-run']) mkdirSync(into, { recursive: true });

    // Everything checkable is checked before anything is written, so a bad
    // bundle is refused whole rather than discovered halfway through.
    const valid = validateBundle(b, { maxFormat: FORMAT, into });
    if (!valid.ok) {
      die(`refusing this bundle:\n  ${valid.errors.join('\n  ')}`
        + (courier ? '\n\nThe transfer is still on GitHub — nothing was deleted.' : ''));
    }

    // The session format belongs to Claude Code, not to this tool, and is not
    // published as a stable interchange format. An untested pair is refused
    // here rather than warned about after landing: a warning that arrives once
    // the session is already on disk is advice too late to act on, whereas
    // refusing leaves the bundle intact for a build that understands it.
    const compat = assess({ sourceVersions: b.origin?.versions ?? [], hereVersion: hereVersion() });
    if (!compat.ok && !flags.force) {
      die(`${compat.summary}.\n  ${compat.detail}\n`
        + `\n  Nothing was written${courier ? ', and the transfer is still on GitHub' : ''}.`
        + '\n  Use --force to import anyway.');
    }

    const id = newSessionId();
    const records = b.transcript.map((line) => {
      try { return JSON.parse(line); } catch { return { __raw: line }; }
    });

    // `origin.cwd` is already stored in portable form (`‹home›/…`), which is
    // also why the bundle never carries the sender's username.
    const portableCwd = b.origin.cwd;
    if (typeof portableCwd !== 'string' || !portableCwd) {
      die('this bundle records no working directory — it may be truncated');
    }
    // The sidecars go through exactly the same boundary-aware substitution as
    // the transcript. A blind split/join here would reintroduce the bug `rehome`
    // exists to prevent, and leave the two describing different machines.
    const swap = makeSwapper({
      fromCwd: portableCwd, toCwd: into,
      fromId: b.session.id, toId: id,
      fromHome: '‹home›', toHome: homedir(),
    });

    // Does the work this conversation is about actually exist here?
    const here = inspectTarget(into);
    const ws = compareWorkspace(b.workspace, here, into);

    const transcriptPath = destinationFor(into, id);
    const sidecarDir = join(projectsRoot(), encodeProjectDir(into), id);
    const historyDir = join(claudeDir(), 'file-history', id);

    // The whole plan, before a single byte is written. Everything below is
    // already known by this point, and someone about to let a bundle from
    // another machine write into their project deserves to see it first rather
    // than read about it afterwards.
    const incomingFiles = b.folder ?? {};
    const clashesAhead = Object.keys(incomingFiles).length ? conflicts(into, incomingFiles) : [];
    const secretsLeft = b.redaction?.applied ? 0 : (b.redaction?.redacted ?? 0);

    console.log('import plan');
    console.log(`  session    ${b.session.title ?? '(untitled)'}`);
    console.log(`  from       ${b.origin.host} (${b.origin.platform})  Claude Code ${b.origin.versions.join('/') || '?'}`);
    console.log(`  into       ${into}`);
    console.log(`  transcript ${b.transcript.length} records  ·  ${Object.keys(b.sidecars ?? {}).length} sidecars`
      + `  ·  ${(b.prompts ?? []).length} prompts`);
    if (valid.entries) console.log(`  expands to ${valid.entries} file(s), about ${human(valid.bytes)}`);
    if (Object.keys(incomingFiles).length) {
      console.log(`  files      ${Object.keys(incomingFiles).length} carried`
        + (clashesAhead.length
          ? `  ·  ${clashesAhead.length} already exist here and differ`
            + (flags['overwrite-files'] ? ' — WILL BE OVERWRITTEN' : ' — will NOT be written')
          : ''));
    }
    console.log(`  workspace  ${ws.summary}`);
    console.log(`  rewind     ${ws.safeForFileHistory
      ? `${Object.keys(b.fileHistory ?? {}).length} snapshot(s) will be restored`
      : 'skipped — the workspace does not match, so restoring them could overwrite your work'}`);
    console.log(`  versions   ${compat.summary}${compat.level === 'likely' ? ' (same minor as tested)' : ''}`);
    console.log(`  secrets    ${b.redaction?.applied
      ? 'redacted before sending'
      : `carried intact${secretsLeft ? ` (${secretsLeft} credential-shaped value(s))` : ''}`}`);
    const asks = [
      flags.sync && ws.state === 'different-commit' ? `check out ${b.workspace?.head?.slice(0, 8)}` : null,
      flags['apply-diff'] && b.workspace?.diff ? 'apply the uncommitted changes' : null,
      flags['overwrite-files'] && clashesAhead.length ? `overwrite ${clashesAhead.length} existing file(s)` : null,
    ].filter(Boolean);
    console.log(`  will do    ${asks.length ? asks.join(', ') : 'nothing to your working tree'}`);

    if (flags['dry-run']) {
      console.log('\nnothing was written — this was a dry run.');
      if (courier) console.log('The transfer is still on GitHub, so the same code still works.');
      return;
    }
    console.log('');

    // Staged, then committed. Everything is built under one temporary directory
    // and moved into place only once all of it exists and the transcript has
    // been read back and found resumable. A failure part-way leaves the machine
    // exactly as it was, rather than a half-session that `/resume` would offer.
    const staging = join(claudeDir(), `.claude-transfer-staging-${randomBytes(6).toString('hex')}`);
    let nSide = 0;
    let nHist = 0;
    let skippedHist = 0;

    try {
      // The staging directory briefly holds the entire transcript.
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const stagedTranscript = join(staging, 'transcript.jsonl');
      const stagedSidecars = join(staging, 'sidecars');
      const stagedHistory = join(staging, 'file-history');

      writeTranscript(stagedTranscript, rehome(records, {
        fromCwd: portableCwd, toCwd: into,
        fromId: b.session.id, toId: id,
        fromHome: '‹home›', toHome: homedir(),
      }));

      nSide = unpackDir(stagedSidecars, b.sidecars, swap);

      // File-history is `/rewind`'s undo data. Restoring another machine's
      // snapshots into a checkout at a different commit means a rewind writes
      // foreign content over real files and destroys uncommitted work. Only when
      // the workspace genuinely matches.
      nHist = ws.safeForFileHistory ? unpackDir(stagedHistory, b.fileHistory, swap) : 0;
      skippedHist = ws.safeForFileHistory ? 0 : Object.keys(b.fileHistory ?? {}).length;

      // Read back what was actually written. A transcript that does not parse,
      // or that lost its records, is not resumable — and finding that out now
      // costs nothing, whereas finding out later costs the transfer.
      const readBack = readTranscript(stagedTranscript);
      if (readBack.length !== records.length) {
        throw new Error(`wrote ${readBack.length} of ${records.length} records`);
      }
      if (!readBack.some((r) => r.type === 'user' || r.type === 'assistant' || r.__raw)) {
        throw new Error('the written transcript has no conversation in it');
      }

      // Commit. Renames within one filesystem, so each is atomic.
      mkdirSync(dirname(transcriptPath), { recursive: true });
      renameSync(stagedTranscript, transcriptPath);
      if (nSide) { mkdirSync(dirname(sidecarDir), { recursive: true }); renameSync(stagedSidecars, sidecarDir); }
      if (nHist) { mkdirSync(dirname(historyDir), { recursive: true }); renameSync(stagedHistory, historyDir); }

      // The receipt belongs to the session, so it is written here rather than
      // afterwards: a session on disk with no record of where its work lives
      // cannot be synced later, and `sync` is the only route to the workspace
      // once the transfer has been collected.
      writeReceipt(claudeDir(), {
        session: id,
        into,
        at: new Date().toISOString(),
        title: b.session.title ?? null,
        origin: { host: b.origin.host, platform: b.origin.platform, versions: b.origin.versions },
        workspace: b.workspace ?? null,
        redacted: Boolean(b.redaction?.applied),
      });
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      die(`the import failed and nothing was changed: ${e.message}`
        + (courier ? '\n\nThe transfer is still on GitHub — try again with the same code.' : ''));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    // Past this line the session exists and is resumable, so the import has
    // succeeded. Everything remaining is an improvement on that, and a failure
    // in one is a warning rather than a failure of the import — reporting
    // otherwise left people with a session on disk and a message saying nothing
    // had been written, which invites a retry that then duplicates it.
    let nPrompts = 0;
    try {
      nPrompts = appendHistory(join(claudeDir(), 'history.jsonl'),
        (b.prompts ?? []).map((p) => ({ ...p, sessionId: id, project: into })));
    } catch (e) {
      console.log(`⚠  the session imported, but prompt recall could not be written: ${e.message}`);
      console.log('   the conversation is complete; only ↑ history in a new session is affected');
    }


    console.log(`landed     ${destinationFor(into, id)}`);
    console.log(`restored   ${nSide} sidecar files  ·  ${nHist} history files  ·  ${nPrompts} prompts`);

    // Restoring the folder is the one part that can overwrite work you already
    // have, so it never happens silently and never wins a conflict by default.
    let restoredFiles = true;
    const incoming = b.folder ?? {};
    if (Object.keys(incoming).length) {
      const clashes = conflicts(into, incoming);
      if (clashes.length && !flags['overwrite-files']) {
        console.log(`\nfiles      ${Object.keys(incoming).length} carried, NOT written —`
          + ` ${clashes.length} already exist here and differ:`);
        for (const c of clashes.slice(0, 5)) console.log(`             ${c}`);
        if (clashes.length > 5) console.log(`             …and ${clashes.length - 5} more`);
        console.log('           re-run with --overwrite-files to replace them');
      } else {
        // Files land one at a time, so a disk filling up part-way leaves the
        // folder half restored. That is survivable only while the transfer is
        // still collectable, which is why the courier is not deleted until
        // after this.
        try {
          const written = unpackDir(into, incoming, null);
          console.log(`\nfiles      restored ${written} file(s) into ${into}`
            + (clashes.length ? ` (${clashes.length} overwritten)` : ''));
        } catch (e) {
          restoredFiles = false;
          console.log(`\n⚠  the session imported, but the carried files did not: ${e.message}`);
        }
      }
    }

    console.log(`\nworkspace  ${ws.summary}`);
    for (const action of ws.actions) console.log(`           ${action}`);
    if (skippedHist) {
      console.log(`           skipped ${skippedHist} rewind snapshot(s) — they belong to a different checkout,`);
      console.log('           and applying them here could overwrite your own work');
    }

    if (ws.state === 'different-commit' && flags.sync) {
      const moved = checkout(into, b.workspace.head);
      console.log(moved.ok ? `           checked out ${b.workspace.head.slice(0, 8)}` : `           could not check out: ${moved.error}`);
    }
    if (flags['apply-diff'] && b.workspace?.diff) {
      const applied = applyDiff(into, b.workspace.diff);
      console.log(applied.ok ? '           re-applied the uncommitted changes' : `           could not apply the diff: ${applied.error}`);
    }

    // The courier copy is expendable only once everything asked for has
    // happened. Deleting it earlier meant a half-restored working folder with
    // nothing left to retry from.
    if (courier) {
      if (restoredFiles) {
        console.log(github.remove(courier)
          ? '\ncollected, and the transfer is deleted'
          : '\ncollected (could not delete the transfer — remove it from your gists if you like)');
      } else {
        console.log('\nThe transfer has been left on GitHub so you can run this again with the same code.');
      }
    }

    if (!b.redaction.applied) console.log('\nnote: this bundle carries the transcript intact, secrets and all');
    // `/resume` lists the sessions belonging to the directory it is running in,
    // and it reads them off disk each time — so a session that lands in the
    // wrong directory is invisible even though the import succeeded. If a
    // Claude session is open somewhere else, that is almost always the mistake.
    const elsewhere = runningSessions().filter((s) => s.cwd && resolve(s.cwd) !== into);
    const alreadyHere = runningSessions().some((s) => s.cwd && resolve(s.cwd) === into);

    console.log(`\nresume it:  claude --resume ${id}`);
    if (alreadyHere) {
      console.log(`\nA Claude session is already open here — press /resume and pick`);
      console.log(`  "${b.session.title ?? '(untitled)'}". No restart needed.`);
    } else {
      console.log('or run `claude` there and pick it from /resume');
      if (elsewhere.length) {
        console.log(`\nnote: your open Claude session${elsewhere.length > 1 ? 's are' : ' is'} in`);
        for (const s of elsewhere.slice(0, 3)) console.log(`        ${s.cwd}`);
        console.log('      /resume only lists sessions for the directory it runs in, so re-run');
        console.log(`      with --into "${elsewhere[0].cwd}" if you want it to show up there.`);
      }
    }
  },
};

function parseBundle(buf) {
  // Without a ceiling, a small crafted archive expands until the machine dies.
  try { return JSON.parse(gunzipSync(buf, { maxOutputLength: MAX_BUNDLE_BYTES }).toString()); }
  catch (err) {
    if (/maxOutputLength|buffer/i.test(err.message)) return die('that bundle expands to an absurd size — refusing it');
    return die('that is not a claude-transfer bundle');
  }
}

function load(file) {
  if (!file) die('need a bundle file');
  let buf;
  try { buf = readFileSync(resolve(file)); } catch { return die(`cannot read ${file}`); }
  return parseBundle(buf);
}

const argv = process.argv.slice(2);
const name = argv[0];
if (!name || !Object.hasOwn(commands, name)) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  console.log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/'))
    .split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim());
  process.exit(name ? 1 : 0);
}
try { await commands[name](parseArgs(argv.slice(1))); } catch (e) { die(e.message); }
