#!/bin/sh
# claude-transfer — installer for macOS and Linux.
#
#   ./install.sh              interactive
#   ./install.sh --yes        answer yes to everything
#   ./install.sh --uninstall  take it back off
#
# Deliberately POSIX sh, no dependencies beyond node and npm: an installer that
# needs installing is not an installer.

set -eu

BOLD='' DIM='' RED='' GREEN='' YELLOW='' RESET=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') RESET=$(printf '\033[0m')
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*"; }
die()  { printf '\n%sbeam:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

ASSUME_YES=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

# Non-interactive shells (a pipe, CI) must not hang waiting for an answer.
[ -t 0 ] || ASSUME_YES=1

ask() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '  %s [Y/n] ' "$1"
  read -r reply </dev/tty || return 0
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE"

say ""
say "${BOLD}claude-transfer${RESET} — move a Claude Code session to another machine"
say "${DIM}$HERE${RESET}"
say ""

if [ "$UNINSTALL" -eq 1 ]; then
  say "${BOLD}Removing${RESET}"
  if command -v claude-transfer >/dev/null 2>&1; then
    claude-transfer setup --uninstall >/dev/null 2>&1 && ok "removed the /transfer skill" || warn "no skill to remove"
  fi
  npm uninstall -g claude-transfer-session >/dev/null 2>&1 && ok "uninstalled the claude-transfer command" || warn "claude-transfer was not installed globally"
  say ""
  say "Sessions you already imported are untouched — they are just Claude Code sessions now."
  exit 0
fi

# --- what we need -----------------------------------------------------------
say "${BOLD}Checking${RESET}"

command -v node >/dev/null 2>&1 || die "node is not installed. Get it from https://nodejs.org (18 or newer)."
NODE_VERSION=$(node -p 'process.versions.node')
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_VERSION is too old — claude-transfer needs 18 or newer."
ok "node $NODE_VERSION"

command -v npm >/dev/null 2>&1 || die "npm is not installed, but node is. Odd — reinstall node from nodejs.org."
ok "npm $(npm -v)"

if [ -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ]; then
  ok "Claude Code config at ${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
else
  warn "no Claude Code config found — claude-transfer will still install, but there is nothing to move yet"
fi

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')  ${DIM}(used to match up your working tree)${RESET}"
else
  warn "git not found — sessions will still move, but claude-transfer cannot check out the code they refer to"
fi

# --- install ----------------------------------------------------------------
say ""
say "${BOLD}Installing${RESET}"

if [ "$ASSUME_YES" -eq 0 ]; then
  ask "Install the ${BOLD}claude-transfer${RESET} command globally with npm?" || die "nothing installed."
fi

if npm install -g . >/dev/null 2>&1; then
  ok "claude-transfer installed"
else
  say ""
  warn "npm could not install globally — usually a permissions problem."
  say "  ${DIM}Try:  sudo npm install -g .${RESET}"
  say "  ${DIM}Or point npm somewhere you own:  npm config set prefix ~/.local${RESET}"
  die "install failed."
fi

# Everything below must keep working even when the global bin is not on PATH —
# otherwise the installer fails on its own advice.
CT="node $HERE/bin/claude-transfer.mjs"
if command -v claude-transfer >/dev/null 2>&1; then
  CT=claude-transfer
else
  NPM_BIN="$(npm prefix -g)/bin"
  say ""
  warn "claude-transfer is installed, but ${BOLD}$NPM_BIN${RESET} is not on your PATH,"
  say "    so typing ${BOLD}claude-transfer${RESET} will not find it."

  # Which file matters depends on how the shell is started, and it is not the
  # obvious one. `.zshrc` is read only by *interactive* zsh — Claude Code runs
  # tools in a non-interactive shell, which reads `.zshenv`. Putting the line
  # only in `.zshrc` makes `claude-transfer` work when you type it and fail when the
  # /transfer skill runs it, which is a baffling way to discover the difference.
  PROFILES=""
  case "${SHELL:-}" in
    */zsh)  PROFILES="$HOME/.zshenv $HOME/.zshrc" ;;
    */bash) PROFILES="$HOME/.bashrc $HOME/.profile" ;;
    */fish) PROFILES="$HOME/.config/fish/config.fish" ;;
    *)      PROFILES="$HOME/.profile" ;;
  esac

  LINE="export PATH=\"$NPM_BIN:\$PATH\""
  [ "${SHELL##*/}" = "fish" ] && LINE="fish_add_path $NPM_BIN"

  if ask "Add it to your shell startup files?"; then
    for PROFILE in $PROFILES; do
      if grep -qF "$NPM_BIN" "$PROFILE" 2>/dev/null; then
        ok "already in $(basename "$PROFILE")"
      else
        mkdir -p "$(dirname "$PROFILE")"
        printf '\n# added by claude-transfer installer\n%s\n' "$LINE" >> "$PROFILE"
        ok "added to $(basename "$PROFILE")"
      fi
    done
    say "  ${DIM}open a new terminal, or: $LINE${RESET}"
  else
    say "  ${DIM}Add this yourself:  $LINE${RESET}"
  fi
fi

say ""
if ask "Install the ${BOLD}/transfer${RESET} skill, so you can type /transfer in Claude Code?"; then
  if $CT setup >/dev/null 2>&1; then ok "/transfer skill installed"; else warn "could not install the skill"; fi
else
  say "  ${DIM}skipped — claude-transfer still works from the command line${RESET}"
fi

# --- prove it ---------------------------------------------------------------
say ""
say "${BOLD}Checking it works${RESET}"

if COUNT=$($CT list 2>/dev/null | grep -c '^[0-9a-f]\{8\}' || true); then
  if [ "${COUNT:-0}" -gt 0 ]; then
    ok "found $COUNT session(s) here that can be moved"
  else
    warn "no sessions found in this directory's history — that is fine, you can move any session"
  fi
else
  bad "claude-transfer list did not run"
fi

# The /transfer skill shells out to `claude-transfer` from a *non-interactive* shell. If it
# cannot be found there the skill fails with "command not found", which looks
# like a broken skill rather than a PATH problem — so check it properly.
if [ "${SHELL##*/}" = "zsh" ]; then
  if zsh -c 'command -v claude-transfer' >/dev/null 2>&1; then
    ok "/transfer will find claude-transfer when it runs"
  else
    warn "/transfer will not find claude-transfer yet — open a new terminal, then re-run this script"
  fi
fi

say ""
say "${BOLD}Ready.${RESET}"
say ""
say "  In Claude Code, type ${BOLD}/transfer${RESET} and pick Send or Receive."
say ""
say "  ${DIM}That is the whole interface. Restart Claude Code first — skills load at startup.${RESET}"
say ""
