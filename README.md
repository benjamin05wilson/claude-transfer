<div align="center">

# claude-transfer

**Pick up a Claude Code conversation on another computer, with its full history.**

[![MIT](https://img.shields.io/badge/licence-MIT-1c6ea4?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-1c6ea4?style=flat-square)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-1c6ea4?style=flat-square)](#install)
[![Dependencies](https://img.shields.io/badge/dependencies-none-2f7d5d?style=flat-square)](package.json)

</div>

<br>

Claude Code can pull a session down from the web to your terminal. It can't move
one from your laptop to your desktop.
[The docs are explicit](https://code.claude.com/docs/en/remote-control):

> You can pull a web session down to your terminal, but you cannot push an
> existing local session up to the web.

This is the missing direction. The whole conversation travels — not a summary.
Same chat, same history, same place in it.

**It makes a resumable copy.** The original stays on the sending machine and both
sides can carry on independently, which is usually what you want — the laptop
still has it if the desktop import goes wrong. It does mean two histories that
can drift apart, so when you have finished with one side,
`claude-transfer archive` retires it: it stops appearing in `/resume` there,
nothing is deleted, and it can be restored.

<br>

```
  MacBook                                Windows desktop
  ─────────────────────────────────      ─────────────────────────────────
  /transfer  →  Send                     /transfer  →  Receive
                                          ┌ paste the code
  gh:b1e7286c…#6bdfc9af26e945cb…   ────►  └ landed.
                                          "Discuss implementation approach"
  2.2 MB · 6 parts · encrypted             is in /resume now.
```

<div align="center"><sub>

Different OS · different username · different path root · over the internet

</sub></div>

<br>

---

## Install

On each machine:

```bash
git clone https://github.com/benjamin05wilson/claude-transfer
cd claude-transfer

./install.sh          # macOS, Linux
.\install.ps1         # Windows
```

It checks Node, installs the command, adds the `/transfer` skill, and puts npm's
global bin on your PATH if it isn't there already. Restart Claude Code
afterwards — skills load at startup.

Requires **Node 18+**, and no npm dependencies.

Sending through a gist — the default — also needs the
[GitHub CLI](https://cli.github.com) installed and signed in. The installer
checks for it. Without it, Send still works directly between two machines on the
same network.

> A gist belongs to the account that created it, so the tidy-up after collection
> only happens when both machines are signed in as you. Sending to somebody
> else's account works, but they cannot delete your gist — remove it yourself
> afterwards.

<br>

## Use it

Type **`/transfer`** and pick **Send** or **Receive**.

Send gives you a code. Paste it on the other machine. The session is in
`/resume` within seconds — no restart.

That's the whole interface. There's a CLI underneath doing the work, but you
shouldn't need to touch it.

<br>

## Where it fits

|  | |
|---|---|
| pick up a **web** session in your terminal | `/teleport` — built in |
| drive a **local** session from your phone | `/remote-control` — built in |
| **move a local session to another computer** | **`/transfer`** — this |

<br>

## How it travels

Through a **private gist** by default. Two useful consequences: it works from
any network, and **both machines never need to be awake at the same time** —
close the laptop, collect it on the desktop tomorrow.

On the same network it can go direct instead: peer-to-peer, one-shot, nothing in
the middle.

Either way the bundle is **encrypted before it leaves**. The key rides in the
part of the code after `#`, which is never uploaded, so a leaked gist is an
opaque blob. It's deleted the moment it's collected.

> Very large sessions can exceed what a gist will hold. Those go as a file
> instead, moved however you like.

<br>

---

<details>
<summary><b>What actually moves</b></summary>

<br>

A Claude Code session is four things on disk, all keyed to a session id and an
absolute path:

|  |  |
|---|---|
| `projects/<cwd>/<id>.jsonl` | the conversation, and the records `/resume` reads for its title |
| `projects/<cwd>/<id>/` | subagents, workflows, tool results |
| `file-history/<id>/` | `/rewind` snapshots |
| `history.jsonl` | ↑ prompt recall |

Move that naively and you get a conversation full of directories that don't
exist, on a machine with a different username.

So an import mints a **new session id** — the original still belongs to the
sending machine — and rewrites it everywhere, along with every path, in both the
raw and JSON-escaped spellings a Windows path takes.

Two record types are deliberately left behind: one points into the sender's temp
directory, the other ties the session to a cloud session that isn't the
receiving machine's to inherit.

</details>

<details>
<summary><b>It brings the work, not just the chat</b></summary>

<br>

A transcript full of `src/App.tsx` is useless in a directory that has none. So a
bundle records where the work was — remote, branch, commit, uncommitted changes
— and the receiving side compares before doing anything:

```
workspace  the session was on main @ b4c126c9, this checkout is on old @ 62bbb715
```

It can move the checkout to that commit, or re-apply the changes that were in
flight. Both refuse when you have uncommitted work of your own.

That happens through `claude-transfer sync`, not by importing again — a transfer
is consumed once collected, and a second import would only mint a second
session. The coordinates are written down at import time, so syncing works days
later with no code and no file.

`--dry-run` shows the whole import plan first — what lands where, which files
would be overwritten, whether rewind can be restored, whether secrets are still
in the bundle — and writes nothing.

**Rewind data is gated on that comparison.** Another machine's undo snapshots
restored into a different checkout would let `/rewind` write foreign content over
your files, so when the workspace doesn't match they're skipped — and you're told
why.

When the far machine can't fetch the repo at all — private and unconfigured
there, or never a repo — it can carry the files themselves. **Tracked files
only**: `.gitignore` already records what you decided not to commit, so your
`.env`, your keys and your `node_modules` stay put.

</details>

<details>
<summary><b>Secrets</b></summary>

<br>

**The transcript travels intact, and you're told what's in it.**

Sending your own session to your own machine over an encrypted channel doesn't
increase exposure — the secret is already at both ends. Redaction is
irreversible: the placeholder is all the bundle would carry, so the resumed
conversation would read mangled text forever.

```
contains
      3  GitHub token
      1  AWS access key id
   5764  home paths made portable
  (left intact — this is your data)
```

Redaction is there for when it's warranted — a file that might travel, or a
session going to someone who isn't you — and each hit can be previewed in
context with the value masked.

The detector is deliberately narrow, because a looser one corrupts ordinary
source like `password: string`. Treat the scan as a reason to look rather than a
guarantee.

</details>

<details>
<summary><b>Trust</b></summary>

<br>

The wire is **AES-256-GCM**, with the key in the URL fragment — a part no HTTP
client transmits, so it stays on the two machines.

Everything else assumes a bundle may be hostile, because `/transfer` will accept
a code from wherever you got it:

- **An entry that would write outside the target directory is refused, and the
  whole bundle with it** — an archive that tries is hostile, not malformed.
- A bundle can be inspected file by file before it's accepted.
- Decompression is capped, so a small archive can't expand until the disk fills.
- Only `GET` is served on a direct transfer, so pasting a link into a chat app
  doesn't let its link unfurler swallow the transfer.
- The direct server binds one address rather than every interface, and gives up
  after 20 wrong guesses.

</details>

<details>
<summary><b>The CLI underneath</b></summary>

<br>

`/transfer` drives a small command. You aren't meant to type it, but it's there
when Claude Code isn't:

```
claude-transfer list                             sessions here, newest first
claude-transfer send [session] [--via github]    hand it to the other machine
  --with-files                                   carry the working folder too
  --redact                                       replace secrets (irreversible)
claude-transfer in <file|url|gh:code> --into .   pick it up here
  --sync                                         check out the session's commit
  --apply-diff                                   restore its uncommitted changes
claude-transfer sync <session-id>                line the working tree up afterwards
  --checkout                                     move to the session's commit
  --apply-diff                                   restore its uncommitted changes
claude-transfer archive <session>                retire this side; --restore puts it back
claude-transfer check <file> [--files]           inspect a bundle first
claude-transfer setup                            (re)install the /transfer skill
```

</details>

<br>

---

<div align="center"><sub>

MIT

</sub></div>
