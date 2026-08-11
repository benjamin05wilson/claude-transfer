/**
 * Reading, rewriting and re-homing Claude Code sessions.
 *
 * Verified against Claude Code 2.1.226. A session is a single `.jsonl` file at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where:
 *
 *   - the **filename is the sessionId**, and the same id is stamped on records
 *     inside the file;
 *   - the absolute **cwd is stamped on every record**;
 *   - `--resume <id>` loads it, and does not care that another machine wrote it.
 *
 * So a session moves if you rewrite exactly two things — the id and the paths —
 * and drop the file in the right directory. Proven end to end: a session created
 * in one directory, transplanted to another with a fresh id, resumed and still
 * recalled facts from before the move.
 */

import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync,
  statSync, lstatSync, existsSync, openSync, readSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const projectsRoot = () =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

/**
 * How Claude Code names a project directory: every character that is not
 * alphanumeric, underscore or dash becomes a dash. `/Users/me/.claude/jobs`
 * → `-Users-me--claude-jobs` — note the double dash where `/.` collapses.
 */
export const encodeProjectDir = (cwd) => String(cwd).replace(/[^A-Za-z0-9_-]/g, '-');

/**
 * Every *resumable* session on this machine, newest first.
 *
 * Deliberately one level deep. Below `projects/<enc-cwd>/` there is also
 * `<sessionId>/subagents/…` and `…/workflows/…`, which on one real machine held
 * 559 further `.jsonl` files against just 15 actual sessions. Those are sidecars
 * of a session, not sessions, and listing them would be nonsense.
 */
export function listSessions({ root = projectsRoot() } = {}) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    let entries;
    try { entries = readdirSync(full); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(full, file);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      out.push({
        id: basename(file, '.jsonl'),
        path,
        projectDir: dir,
        bytes: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function findSession(id, { root = projectsRoot() } = {}) {
  return listSessions({ root }).find((s) => s.id === id || s.id.startsWith(id)) ?? null;
}

/** Parse a transcript, keeping unparseable lines verbatim so nothing is lost. */
export function readTranscript(path) {
  const records = [];
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { records.push({ __raw: line }); }
  }
  return records;
}

export const writeTranscript = (path, records) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${records.map((r) => (r.__raw ?? JSON.stringify(r))).join('\n')}\n`);
};

/** Facts a receiving machine needs in order to re-home the session sensibly. */
export function describe(records) {
  const cwds = new Set();
  const versions = new Set();
  const branches = new Set();
  let firstPrompt = null;
  let userTurns = 0;
  let assistantTurns = 0;
  let earliest = null;
  let latest = null;

  for (const r of records) {
    if (r.cwd) cwds.add(r.cwd);
    if (r.version) versions.add(r.version);
    if (r.gitBranch) branches.add(r.gitBranch);
    if (r.timestamp) {
      if (!earliest || r.timestamp < earliest) earliest = r.timestamp;
      if (!latest || r.timestamp > latest) latest = r.timestamp;
    }
    if (r.type === 'assistant') assistantTurns++;
    if (r.type === 'user') {
      userTurns++;
      const c = r.message?.content;
      if (!firstPrompt && typeof c === 'string') firstPrompt = c.slice(0, 120);
      if (!firstPrompt && Array.isArray(c)) {
        const t = c.find((b) => b?.type === 'text')?.text;
        if (t) firstPrompt = t.slice(0, 120);
      }
    }
  }
  return {
    cwd: [...cwds][0] ?? null,
    allCwds: [...cwds],
    versions: [...versions],
    branches: [...branches],
    firstPrompt,
    userTurns,
    assistantTurns,
    records: records.length,
    earliest,
    latest,
  };
}

/**
 * Rewrite a transcript for a new home.
 *
 * Done as a string substitution over each serialised record rather than a
 * targeted field edit, because the old path appears in far more places than
 * `cwd`: tool inputs, command lines, file contents the agent read, diffs. A
 * field-level rewrite leaves a transcript full of paths that do not exist on the
 * receiving machine.
 */
/**
 * Build the text rewriter used to move a session to a new home.
 *
 * Exported so the sidecar files go through exactly the same substitution as the
 * transcript. They used to get a blind `split/join`, which reintroduced the very
 * bug this careful version exists to prevent — leaving the transcript and its
 * sidecars describing two different machines.
 */
export function makeSwapper({ fromCwd, toCwd, fromId, toId, fromHome, toHome }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inJson = (s) => JSON.stringify(s).slice(1, -1);

  /**
   * Substitute an identifier only where it stands alone.
   *
   * A blind replace is unsafe: with a short id, `"ai-title"` became
   * `"bi-title"`. Requiring a non-identifier character on each side means we
   * rewrite the id and never the words around it.
   */
  // A function replacer, so `$&`, `$'` and friends in a destination path are
  // treated as literal characters. As a string, a directory named `a$'b` made
  // the substitution emit invalid JSON.
  const literal = (to) => () => to;

  const replaceToken = (text, from, to) =>
    text.replace(new RegExp(`(?<![A-Za-z0-9_-])${esc(from)}(?![A-Za-z0-9_-])`, 'g'), literal(to));

  /**
   * Substitute a path prefix only at a path boundary.
   *
   * Otherwise a cwd of `/tmp` rewrites every unrelated temp path in the
   * transcript, and `/app` corrupts `/application`.
   */
  /**
   * Substitute a path in both spellings.
   *
   * This runs over JSON-serialised records *and* raw sidecar files. On POSIX the
   * two are identical, which is why one form sufficed; on Windows a path is
   * `C:\Users\me` raw and `C:\\Users\\me` inside JSON, and handling only one
   * leaves half the transcript pointing at the sending machine.
   */
  const replacePath = (text, from, to) => {
    // JSON spelling first: inside a serialised record both sides must be
    // escaped, and on POSIX that pass also handles the raw form because the two
    // are identical. The raw pass then catches plain files, where a Windows path
    // has single backslashes. Doing it the other way round would splice an
    // unescaped backslash into JSON and break the record.
    const passes = [[inJson(from), inJson(to)]];
    if (from !== inJson(from) || to !== inJson(to)) passes.push([from, to]);

    let out = text;
    for (const [f, t] of passes) {
      out = out.replace(new RegExp(`${esc(f)}(?=[/"'\\\\ ,;:)\\]]|$)`, 'g'), literal(t));
    }
    return out;
  };

  return (text) => {
    let out = text;
    if (fromId && toId) out = replaceToken(out, fromId, toId);
    if (fromCwd && toCwd) out = replacePath(out, fromCwd, toCwd);
    if (fromHome && toHome && fromHome !== toHome) out = replacePath(out, fromHome, toHome);
    return out;
  };
}

export function rehome(records, options) {
  const swap = makeSwapper(options);

  return records.map((r, i) => {
    if (r.__raw) return { __raw: swap(r.__raw) };
    const swapped = swap(JSON.stringify(r));
    try {
      return JSON.parse(swapped);
    } catch (err) {
      // Silently returning the original record here used to hide every class of
      // corruption this function can cause — you would get a transcript still
      // pointing at the sending machine, with no error anywhere.
      throw new Error(`record ${i} became invalid JSON while re-homing: ${err.message}`);
    }
  });
}

/** Where a session with this cwd and id belongs on this machine. */
export const destinationFor = (cwd, id, root = projectsRoot()) =>
  join(root, encodeProjectDir(cwd), `${id}.jsonl`);

export const newSessionId = () => randomUUID();

/**
 * The complete on-disk footprint of a session. Reverse-engineered from Claude
 * Code 2.1.226 — `--resume` needs the first of these, and everything that makes
 * a resumed session feel unchanged needs the rest.
 */
export function footprint(session, { root = projectsRoot(), claudeDir } = {}) {
  const home = claudeDir ?? join(root, '..');
  return {
    transcript: session.path,
    sidecars: join(root, session.projectDir, session.id),   // subagents/, workflows/, tool-results/
    fileHistory: join(home, 'file-history', session.id),    // undo and rewind snapshots
    historyLog: join(home, 'history.jsonl'),                // ↑ prompt recall
  };
}

/** Records that describe *this* machine and must not travel with the session. */
export const MACHINE_LOCAL_RECORDS = new Set([
  'frame-link',      // points into /private/tmp/claude-<uid>/… on the exporting host
  'bridge-session',  // ties the session to a cloud/Remote Control session id
]);

export const stripMachineLocal = (records) =>
  records.filter((r) => !(r?.type && MACHINE_LOCAL_RECORDS.has(r.type)));

/** Read every file under a directory as base64, for carrying inside a bundle. */
export function packDir(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out[rel] = readFileSync(full).toString('base64');
    }
  };
  walk(dir, '');
  return out;
}

/** Text can be rewritten for the new machine; anything else is copied verbatim. */
const isTextBuffer = (buf) => !buf.includes(0);

/**
 * Where a bundle entry is allowed to land.
 *
 * The keys come out of a file someone else made, and `claude-transfer in <url>` will fetch
 * that file from any address a user pastes. Without this check a key of
 * `../../../../.claude/settings.json` escapes the target directory and writes a
 * hook into the user's config, which runs on their next Claude Code invocation.
 *
 * @returns {string|null} the resolved path, or null if the entry tried to escape
 */
export function safeEntryPath(dir, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return null;
  if (rel.includes('\0')) return null;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;

  const root = resolve(dir);
  const target = resolve(root, rel);
  // `${root}${sep}` rather than a bare prefix test, so `/tmp/ab` cannot pass as
  // being inside `/tmp/a`.
  return target === root || target.startsWith(root + sep) ? target : null;
}

/**
 * Does the path reach its destination by passing through a symlink?
 *
 * `safeEntryPath` is a purely lexical check: it proves the *written* path spells
 * out somewhere inside the target. It cannot prove the path *leads* there. If
 * `logs` already exists as a link to `/etc`, then `logs/passwd` is lexically
 * innocent and lands outside the directory anyway.
 *
 * So every existing component between the root and the destination is checked,
 * and the destination itself — writing through a symlink follows it.
 */
function crossesSymlink(root, target) {
  const base = resolve(root);
  let current = base;
  const rest = resolve(target).slice(base.length).split(sep).filter(Boolean);

  for (const part of rest) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { return false; } // does not exist yet
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Write a packed directory back out.
 *
 * Refuses the whole bundle if any entry tries to escape: a bundle that attempts
 * traversal is hostile, not merely malformed, and unpacking the rest of it would
 * be doing an attacker a favour.
 */
export function unpackDir(dir, files, transform) {
  const entries = Object.entries(files ?? {});

  const escaped = entries.map(([rel]) => rel).filter((rel) => !safeEntryPath(dir, rel));
  if (escaped.length) {
    throw new Error(
      `refusing this bundle: ${escaped.length} entr${escaped.length === 1 ? 'y' : 'ies'} `
      + `would write outside ${dir} — first was ${JSON.stringify(escaped[0])}`,
    );
  }

  const throughLink = entries
    .map(([rel]) => rel)
    .filter((rel) => crossesSymlink(dir, safeEntryPath(dir, rel)));
  if (throughLink.length) {
    throw new Error(
      `refusing this bundle: ${throughLink.length} entr${throughLink.length === 1 ? 'y' : 'ies'} `
      + `would be written through a symlink and land outside ${dir} — `
      + `first was ${JSON.stringify(throughLink[0])}`,
    );
  }

  for (const [rel, b64] of entries) {
    const target = safeEntryPath(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    const buf = Buffer.from(b64, 'base64');
    // Only rewrite text. Round-tripping a PNG through utf8 replaces every
    // invalid sequence with U+FFFD and silently destroys it.
    writeFileSync(target, transform && isTextBuffer(buf) ? Buffer.from(transform(buf.toString('utf8'))) : buf);
  }
  return entries.length;
}

/** The prompt-history lines belonging to one session. */
export function readHistoryFor(historyPath, sessionId) {
  if (!existsSync(historyPath)) return [];
  const out = [];
  for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
    if (!line.includes(sessionId)) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Add prompts to the global history log.
 *
 * A genuine append, not a read-modify-write. This file is shared by every
 * Claude Code process on the machine — and this runs from *inside* one — so
 * rewriting it wholesale silently discarded whichever concurrent session
 * happened to write second.
 */
export function appendHistory(historyPath, entries) {
  if (!entries?.length) return 0;
  mkdirSync(join(historyPath, '..'), { recursive: true });

  // If the file does not end in a newline, our first record would be glued onto
  // the last existing one and neither would parse.
  let prefix = '';
  try {
    if (existsSync(historyPath) && statSync(historyPath).size > 0) {
      const fd = openSync(historyPath, 'r');
      const tail = Buffer.alloc(1);
      readSync(fd, tail, 0, 1, statSync(historyPath).size - 1);
      closeSync(fd);
      if (tail.toString() !== '\n') prefix = '\n';
    }
  } catch { /* if we cannot tell, the newline is harmless */ }

  appendFileSync(historyPath, prefix + entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return entries.length;
}
