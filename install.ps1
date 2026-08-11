# claude-transfer — installer for Windows.
#
#   .\install.ps1              interactive
#   .\install.ps1 -Yes         answer yes to everything
#   .\install.ps1 -Uninstall   take it back off
#
# If PowerShell refuses to run this, it is the execution policy, not the script:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1

[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host $m }
function Ok   { param($m) Write-Host "  " -NoNewline; Write-Host "OK " -ForegroundColor Green -NoNewline; Write-Host $m }
function Warn { param($m) Write-Host "  " -NoNewline; Write-Host "!  " -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Die  { param($m) Write-Host ""; Write-Host "claude-transfer: $m" -ForegroundColor Red; exit 1 }

function Ask {
  param($question)
  if ($Yes) { return $true }
  $reply = Read-Host "  $question [Y/n]"
  return ($reply -eq '' -or $reply -match '^[Yy]')
}

Set-Location -Path $PSScriptRoot

Say ""
Write-Host "claude-transfer" -ForegroundColor White -NoNewline
Say " - move a Claude Code session to another machine"
Write-Host $PSScriptRoot -ForegroundColor DarkGray
Say ""

if ($Uninstall) {
  Say "Removing"
  if (Get-Command claude-transfer -ErrorAction SilentlyContinue) {
    try { claude-transfer setup --uninstall | Out-Null; Ok "removed the /transfer skill" } catch { Warn "no skill to remove" }
  }
  try { npm uninstall -g claude-transfer 2>&1 | Out-Null; Ok "uninstalled the claude-transfer command" }
  catch { Warn "claude-transfer was not installed globally" }
  Say ""
  Say "Sessions you already imported are untouched - they are just Claude Code sessions now."
  exit 0
}

# --- what we need -----------------------------------------------------------
Say "Checking"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "node is not installed. Get it from https://nodejs.org (18 or newer)."
}
$nodeVersion = (node -p 'process.versions.node')
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) { Die "node $nodeVersion is too old - claude-transfer needs 18 or newer." }
Ok "node $nodeVersion"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Die "npm is not installed, but node is. Reinstall node from nodejs.org."
}
Ok "npm $(npm -v)"

$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
if (Test-Path $claudeDir) { Ok "Claude Code config at $claudeDir" }
else { Warn "no Claude Code config found - claude-transfer will still install, but there is nothing to move yet" }

# The default Send path goes through a private gist, so gh is not optional for
# the way most people will actually use this.
if (Get-Command gh -ErrorAction SilentlyContinue) {
  gh auth status 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "GitHub CLI, signed in (used by the default Send path)" }
  else {
    Warn "the GitHub CLI is installed but not signed in - run: gh auth login"
    Warn "until then, Send can only hand over directly on the same network"
  }
} else {
  Warn "the GitHub CLI is not installed - see https://cli.github.com"
  Warn "/transfer defaults to sending through a private gist, which needs it."
}

if (Get-Command git -ErrorAction SilentlyContinue) {
  Ok "git $((git --version).Split(' ')[2])  (used to match up your working tree)"
} else {
  Warn "git not found - sessions will still move, but claude-transfer cannot check out the code they refer to"
}

# --- install ----------------------------------------------------------------
Say ""
Say "Installing"

if (-not (Ask "Install the claude-transfer command globally with npm?")) { Die "nothing installed." }

try {
  npm install -g . 2>&1 | Out-Null
  Ok "claude-transfer installed"
} catch {
  Say ""
  Warn "npm could not install globally."
  Write-Host "  Try running this terminal as Administrator, or:" -ForegroundColor DarkGray
  Write-Host "  npm config set prefix `"$env:LOCALAPPDATA\npm`"" -ForegroundColor DarkGray
  Die "install failed."
}

if (-not (Get-Command claude-transfer -ErrorAction SilentlyContinue)) {
  Warn "claude-transfer installed but is not on your PATH."
  Write-Host "  npm puts it in $(npm prefix -g) - add that to PATH, then reopen PowerShell." -ForegroundColor DarkGray
}

if (Ask "Install the /transfer skill, so you can type /transfer in Claude Code?") {
  try { claude-transfer setup | Out-Null; Ok "/transfer skill installed" } catch { Warn "could not install the skill" }
} else {
  Write-Host "  skipped - claude-transfer still works from the command line" -ForegroundColor DarkGray
}

# --- prove it ---------------------------------------------------------------
Say ""
Say "Checking it works"
try {
  $count = (claude-transfer list 2>$null | Select-String -Pattern '^[0-9a-f]{8}').Count
  if ($count -gt 0) { Ok "found $count session(s) here that can be moved" }
  else { Warn "no sessions found yet - that is fine, you can move any session" }
} catch {
  Warn "claude-transfer list did not run"
}

Say ""
Write-Host "Ready." -ForegroundColor White
Say ""
Say "  In Claude Code, type /transfer and pick Send or Receive."
Say ""
Write-Host "  That is the whole interface. Restart Claude Code first - skills load at startup." -ForegroundColor DarkGray
Say ""
