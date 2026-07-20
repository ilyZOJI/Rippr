#!/bin/zsh

# Double-click this file in Finder after a code change to build and restart
# the local development helper used by the Premiere panel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { print "\n==> $1"; }
fail() {
  print "\n[FAILED] $1"
  print "The Terminal will stay open so you can read the error."
  read -r
  exit 1
}

say "Checking required tools"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed or is not on PATH."
command -v cargo >/dev/null 2>&1 || fail "Rust/cargo is not installed or is not on PATH."
command -v ffmpeg >/dev/null 2>&1 || print "[warning] ffmpeg is not on PATH; downloads requiring conversion will fail."
command -v yt-dlp >/dev/null 2>&1 || print "[warning] yt-dlp is not on PATH; downloads cannot start."

say "Running tests and type checks"
pnpm test || fail "Tests or type checks failed."

say "Building the Premiere plugin"
pnpm build:plugin || fail "The plugin build failed."

say "Building the native helper"
cargo build --manifest-path helper/Cargo.toml || fail "The helper build failed."

say "Restarting the local helper"
# Only target the helper built from this workspace. This avoids touching any
# unrelated process while ensuring Premiere is connected to the latest build.
HELPER_PATH="$ROOT/helper/target/debug/rippr-helper"
OLD_PIDS="$(lsof -t -c rippr-hel -iTCP:43117 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$OLD_PIDS" ]]; then
  print "$OLD_PIDS" | xargs -n1 kill 2>/dev/null || true
  sleep 0.5
fi

HELPER_LOG="$ROOT/.rippr-helper.log"
nohup "$HELPER_PATH" >"$HELPER_LOG" 2>&1 &
HELPER_PID=$!
sleep 0.8

if ! lsof -nP -iTCP:43117 -sTCP:LISTEN >/dev/null 2>&1; then
  print "Helper log: $HELPER_LOG"
  fail "The helper did not start."
fi

print "\nREADY TO TEST"
print "Plugin build: $ROOT/plugin/dist"
print "Helper PID:    $HELPER_PID"
print "Helper log:    $HELPER_LOG"
print "\nReload the Rippr panel in Premiere, then test the change."
print "Press Return to close this window."
read -r
