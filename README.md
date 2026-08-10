# claude-transfer

**Move a Claude Code session to another computer and carry on there.**

Claude Code can pull a *web* session down to a terminal (`/teleport`) and drive a
*local* session from your phone (`/remote-control`). It cannot move a local
session to another machine — the docs are explicit:

> You can pull a web session down to your terminal, but you cannot push an
> existing local session up to the web.

That's the gap this fills. The whole conversation moves, not a summary: same
chat, same history, same place in it.

## Use it

Type **`/transfer`** in Claude Code and pick **Send** or **Receive**. That is the
whole interface.

```
/transfer  →  Send
              gh:1442539ad4f0dfe7…#d3cb920a73df39bc…

              on the other computer: /transfer → Receive, paste this

/transfer  →  Receive
              landed. "Discuss implementation approach" is in /resume now.
```

The session appears in `/resume` immediately — no restart.

## Install

On each machine:

```bash
git clone https://github.com/benjamin05wilson/claude-transfer
cd claude-transfer
./install.sh            # macOS and Linux
.\install.ps1           # Windows
```

It checks Node, installs the command, adds the `/transfer` skill, and puts npm's
global bin on your PATH if it isn't already. Then restart Claude Code — skills
load at startup.

Node ≥ 18. No dependencies.

## How it travels

By default through a **private gist**, which means it works from any network and
**both machines never need to be awake at the same time**. Close the laptop, pick
it up on the desktop tomorrow.

On the same network it can go direct instead — peer-to-peer, one-shot, nothing
in the middle.

Either way the bundle is encrypted before it leaves. The key travels in the part
of the code after `#`, which is never uploaded, so a leaked gist is an opaque
blob. It's deleted the moment it's collected.

## What actually moves

A Claude Code session is four things on disk, all keyed by session id:

| what | where | why it matters |
|---|---|---|
| transcript | `projects/<enc-cwd>/<id>.jsonl` | the conversation, and the records `/resume` reads for its title |
| sidecars | `projects/<enc-cwd>/<id>/` | subagents, workflows, tool results |
| file history | `file-history/<id>/` | `/rewind` snapshots |
| prompt history | `history.jsonl` | ↑ recall in the terminal |

An import mints a **new session id** — the original still belongs to the sending
machine — and rewrites it everywhere, along with every absolute path, so the
session is coherent on a machine with a different username and a different home
directory. Two record types are deliberately left behind: one points into the
sender's temp directory, the other ties the session to a cloud session that isn't
the receiving machine's to inherit.

## It brings the work, not just the chat

A transcript full of `src/App.tsx` is useless in a directory that has none. So a
bundle records where the work was — remote, branch, commit, and any uncommitted
changes — and the receiving side compares before doing anything:

```
workspace  the session was on main @ b4c126c9, this checkout is on old @ 62bbb715
```

It can then move the checkout to that commit, or re-apply the changes that were
in flight. Both refuse when you have uncommitted work of your own — silently
checking out over your edits would be worse than the problem it solves.

**Rewind data is gated on that comparison.** Restoring another machine's undo
snapshots into a checkout at a different commit would let `/rewind` write foreign
content over your files, so when the workspace doesn't match they're skipped and
you're told why.

When the other machine can't fetch the repository at all — private and
unconfigured there, or never a repo — it can carry the files themselves.
**Tracked files only**: `.gitignore` already records which files you decided not
to commit, and reusing that judgement means your `.env`, your keys and your
`node_modules` stay where they are. Files that already exist and differ are never
overwritten without you saying so.

## Secrets

**The transcript travels intact, and you're told what's in it.**

Moving your own session to your own machine over an encrypted channel doesn't
increase exposure — the secret is already at both ends. Redaction is
irreversible: the placeholder is all the bundle would carry, so the resumed
conversation would read mangled text forever. That's a poor trade for a risk that
isn't there.

```
contains
      3  Assigned secret
      1  AWS access key id
    153  home paths made portable
  (left intact — this is your data)
```

Redaction is available for the cases that warrant it — a bundle written to a file
that might travel, or a session going to somebody who isn't you — and you can
preview each hit in context with the value masked.

**What the detector will miss:** a password shaped like a variable name, such as
`myDogRex2024`, reads as code and is left alone. The rule is deliberately narrow,
because a looser one corrupts ordinary source like `password: string`. Treat the
scan as a reason to look, not a guarantee.

## Trust

The wire is AES-256-GCM, with the key in the URL fragment — a part no HTTP client
transmits, so it stays on the two machines.

Everything else assumes a bundle may be hostile, because `/transfer` will accept
a code from wherever you got it:

- **Entries that would write outside the target directory are refused, and the
  whole bundle with them** — an archive that tries is hostile, not malformed.
- A bundle can be inspected, file by file, before it's accepted.
- Decompression is capped, so a small archive can't expand until the disk fills.
- Only `GET` is served on a direct transfer, so pasting a link into a chat app
  doesn't let its link unfurler consume the transfer.
- The direct server binds one address rather than every interface, and gives up
  after 20 wrong guesses.

## Underneath

`/transfer` drives a small CLI. You aren't meant to type it, but it's there when
Claude Code isn't:

```
claude-transfer list                             sessions here, newest first
claude-transfer send [session] [--via github]    hand it to the other machine
  --with-files                                   carry the working folder too
  --redact                                       replace secrets (irreversible)
claude-transfer in <file|url|gh:code> --into .   pick it up here
  --sync                                         check out the session's commit
  --apply-diff                                   restore its uncommitted changes
claude-transfer check <file> [--files]           inspect a bundle first
claude-transfer setup                            (re)install the /transfer skill
```

## Licence

MIT
