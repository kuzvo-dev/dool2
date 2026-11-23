#!/bin/bash
# Installs the nightly service tools check (scripts/connector-nightly.sh) on a Mac with launchd (ADR 0020).
# Runs daily at 4:30 a.m. (or on wake if the Mac was asleep). Turn off: launchctl bootout gui/$UID/com.dool2.connector-nightly
#
#   DOOL2_TEST_CHROME=".../Google Chrome for Testing" DOOL2_GH_USER=<account> bash scripts/install-nightly-mac.sh
set -euo pipefail
: "${DOOL2_TEST_CHROME:?Path to Chrome for Testing is required}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
DIR=${DOOL2_NIGHTLY_DIR:-$HOME/dev/kuzvo/dool2-nightly}
LABEL=com.dool2.connector-nightly
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_DIR=$(dirname "$(command -v node)")

# Working folder for the check (a git worktree of this repo)
if [ ! -d "$DIR" ]; then
  git -C "$HERE" fetch -q origin
  git -C "$HERE" worktree add -q --detach "$DIR" origin/main
fi

esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
mkdir -p "$HOME/Library/LaunchAgents"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(esc "$DIR/scripts/connector-nightly.sh")</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer></dict>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(esc "$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")</string>
    <key>DOOL2_TEST_CHROME</key><string>$(esc "$DOOL2_TEST_CHROME")</string>
    <key>DOOL2_NIGHTLY_DIR</key><string>$(esc "$DIR")</string>
    <key>DOOL2_FIX_MAX</key><string>${DOOL2_FIX_MAX:-3}</string>
    <key>DOOL2_GH_USER</key><string>$(esc "${DOOL2_GH_USER:-}")</string>
    <key>DOOL2_REPORT_COPY</key><string>$(esc "${DOOL2_REPORT_COPY:-}")</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/dool2-nightly.out</string>
  <key>StandardErrorPath</key><string>/tmp/dool2-nightly.err</string>
</dict></plist>
EOF
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
echo "Installed: daily at 4:30 ($PLIST). To run once now: launchctl kickstart gui/$UID/$LABEL"
