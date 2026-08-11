/**
 * Which Claude Code versions this has actually been tried against.
 *
 * This writes into Claude Code's own on-disk session format. That format is
 * documented as existing — transcripts live under `~/.claude/projects` — but it
 * is not published as a stable interchange format, and nothing promises it will
 * not change. Everything here was reverse-engineered from a specific build.
 *
 * So the version is treated as part of the contract rather than a footnote. A
 * bundle records the version that wrote it, an import records the version
 * reading it, and a combination nobody has tested is **refused rather than
 * warned about**. A warning printed after the session has already landed is
 * advice arriving too late to act on; the whole point of refusing is that the
 * bundle is still intact and can be imported by a build that does understand it.
 *
 * `--force` exists because being stuck with a bundle and no way to open it is
 * worse than a documented risk knowingly taken.
 */

/** Reverse-engineered and tested end to end against this build. */
export const VERIFIED = ['2.1.226'];

/**
 * The range believed compatible. Same major and minor as a verified build, on
 * the assumption that a patch release does not restructure the session format —
 * which is an assumption, and is why it reports as "likely" rather than "known".
 */
export const SUPPORTED_MAJOR_MINOR = ['2.1'];

const parse = (v) => {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) } : null;
};

const majorMinor = (v) => {
  const p = parse(v);
  return p ? `${p.major}.${p.minor}` : null;
};

/**
 * Judge a source/destination pair.
 *
 * @returns {{level:'verified'|'likely'|'untested'|'unknown', ok:boolean, summary:string, detail:string|null}}
 */
export function assess({ sourceVersions = [], hereVersion = null } = {}) {
  const sources = sourceVersions.filter(Boolean);
  const here = hereVersion || null;

  // Nothing to judge. Not a reason to refuse — plenty of bundles predate this
  // check, and the older behaviour was to say nothing at all.
  if (!sources.length && !here) {
    return { level: 'unknown', ok: true, summary: 'no version recorded on either side', detail: null };
  }

  const all = [...sources, here].filter(Boolean);
  const unsupported = all.filter((v) => {
    const mm = majorMinor(v);
    return mm !== null && !SUPPORTED_MAJOR_MINOR.includes(mm);
  });

  if (unsupported.length) {
    const which = [...new Set(unsupported)].join(', ');
    return {
      level: 'untested',
      ok: false,
      summary: `Claude Code ${which} has not been tested with this tool`,
      detail: `Verified against ${VERIFIED.join(', ')}. The session format is not a published `
        + 'interchange format, so a different release may store things differently and an import '
        + 'could produce a session that does not resume.',
    };
  }

  const exact = all.every((v) => VERIFIED.includes(v));
  if (exact) {
    return { level: 'verified', ok: true, summary: `Claude Code ${all[0]}, tested`, detail: null };
  }

  const versions = [...new Set(all)].join(' → ');
  return {
    level: 'likely',
    ok: true,
    summary: `Claude Code ${versions}`,
    detail: `Tested against ${VERIFIED.join(', ')}; these are the same minor release, so the `
      + 'format is expected to match.',
  };
}

/** The version of Claude Code running this, if it told us. */
export const hereVersion = () => process.env.CLAUDE_CODE_VERSION || null;
