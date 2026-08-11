/**
 * Scaffolding for the suite: a throwaway git repo and a real session on disk.
 *
 * Every test gets its own temporary CLAUDE_CONFIG_DIR and working directory, so
 * nothing here can touch the machine's actual sessions — which matters more than
 * usual for a tool whose whole job is writing into `~/.claude`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const VERIFIED_VERSION = '2.1.226';

const encode = (cwd) => String(cwd).replace(/[^A-Za-z0-9_-]/g, '-');

/** A sandbox with a git repo, a config dir, and a session that refers to both. */
export function sandbox({ version = VERIFIED_VERSION, remote = 'https://github.com/acme/app.git' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-test-'));
  const work = join(root, 'work');
  const config = join(root, 'config');
  mkdirSync(work, { recursive: true });
  mkdirSync(config, { recursive: true });

  const git = (args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  if (remote) git(['remote', 'add', 'origin', remote]);
  writeFileSync(join(work, 'app.js'), 'const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  const projectDir = join(config, 'projects', encode(work));
  mkdirSync(projectDir, { recursive: true });

  return {
    root,
    work,
    config,
    projectDir,
    git,
    head: () => git(['rev-parse', 'HEAD']).trim(),
    /** Write a session transcript referring to this working directory. */
    session(lines = [], id = SESSION_ID) {
      const records = [
        { type: 'ai-title', aiTitle: 'Test session' },
        ...lines.map((content) => ({
          type: 'user',
          timestamp: '2026-08-01T10:00:00.000Z',
          cwd: work,
          version,
          message: { role: 'user', content },
        })),
      ];
      writeFileSync(join(projectDir, `${id}.jsonl`),
        `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
      return id;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

/** Run the CLI in a sandbox and capture everything it said. */
export function cli(box, args, { version = VERIFIED_VERSION, cwd = box.work } = {}) {
  // fileURLToPath, not .pathname: on Windows the latter yields "/C:/…", which is
  // not a path any process can be spawned with.
  const bin = fileURLToPath(new URL('../bin/claude-transfer.mjs', import.meta.url));
  const res = execFileSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: box.config,
      CLAUDE_CODE_VERSION: version,
      NO_COLOR: '1',
    },
  });
  return res;
}

/** As `cli`, but for the cases where a non-zero exit is the point. */
export function cliFails(box, args, opts = {}) {
  try {
    cli(box, args, opts);
    return { failed: false, output: '' };
  } catch (e) {
    return { failed: true, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
