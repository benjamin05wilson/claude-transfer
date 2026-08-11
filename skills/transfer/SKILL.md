---
name: transfer
description: Move this conversation to another computer and carry on there, with its full history. Use when the user wants to continue a session on a different machine, hand off between laptop and desktop, or asks to send or receive a session.
when_to_use: "/transfer", "send this to my other machine", "continue this on my laptop", "pick this up on the desktop", "move this chat to my other computer", "carry on where I left off"
argument-hint: "[send|receive]"
allowed-tools: AskUserQuestion, Bash(claude-transfer:*), Bash(node:*)
---

# Move this conversation to another computer

Claude Code can already pull a *web* session down to a terminal (`/teleport`)
and drive a *local* session from a phone (`/remote-control`). It cannot move a
local session to another machine. This does.

**This slash command is the whole interface.** `claude-transfer` underneath is plumbing —
never tell the user to run it, never show them its flags, and never leave them
holding a command to type. They chose a menu item; give them a sentence and a
code.

## If the user did not say which direction

Ask with `AskUserQuestion`. Two options, nothing else, no preamble:

- **Send** — "Put this conversation somewhere my other computer can pick it up."
- **Receive** — "Continue a conversation sent from another computer."

## Send

Ask nothing first. Run:

```bash
claude-transfer send --via github
```

That routes through a private gist, which works from any network and does not
need both machines awake at once. Use `claude-transfer send` (direct, same network) only if
the user says they are on the same network and wants it direct.

Add `--with-files` when the other machine may not have the code: a private repo
it cannot clone, or a folder that was never a repo. Tracked files only, so
`.gitignore` still decides what stays home.

Then tell them, in your own words:

- the code, on its own line, exactly as printed
- that on the other computer they type `/transfer` and choose **Receive**
- what is in the bundle, if the report flagged anything — say it plainly:
  *"this carries 3 credential-shaped values, which is fine for your own machine"*

Do not explain gists, encryption or the CLI unless asked.

## Receive

Ask for the code if they have not pasted one. Accept any of these — a `gh:` code,
a `http://…#…` link, or a path to a `.claude-transfer` file:

```bash
claude-transfer in <code> --into .
```

`--into .` matters: `/resume` only lists sessions belonging to the directory it
runs in, so the session must land where the user is working.

Add `--dry-run` first when the user is landing something into a directory that
already has work in it. It prints the whole import plan — what lands where, which
files would be overwritten, whether the workspace matches — and writes nothing.
Show them that, then run it for real. A dry run does not consume the transfer.

Then tell them:

- that the conversation is here, and they can pick it from `/resume` — it appears
  immediately, no restart
- the title to look for
- the `workspace` line in plain language

**If the workspace does not match, do not re-run the import.** The transfer is
consumed by a successful receive, and importing again would only mint a second
session. Use `sync`, which works from what the import recorded and needs no code
or file:

```bash
claude-transfer sync <session-id> --checkout      # move to the session's commit
claude-transfer sync <session-id> --apply-diff    # restore its uncommitted changes
```

`claude-transfer sync` with no arguments lists what has been imported here, with
their ids. Both actions refuse when the user has uncommitted work of their own.
That is correct — say so, and offer to help them commit or stash rather than
forcing it.

If files were carried and some already exist here and differ, `claude-transfer`
refuses and lists them. Show that list and ask before re-running with
`--overwrite-files`.

## When the session came from the web instead

If they are picking up something started on claude.ai or a phone, this is the
wrong tool and Claude Code has it built in:

```bash
claude --teleport
```

Say so rather than packaging anything. It wants a clean working directory.

## Worth knowing

The bundle is encrypted before it leaves, and the key is in the part of the code
after `#`. If a user pastes a code without that part, the transfer cannot be
opened — tell them to copy the whole line.

Never invent a code, never guess an id, and never suggest working around a
refusal. If something fails, say what failed and what it would take to fix.
