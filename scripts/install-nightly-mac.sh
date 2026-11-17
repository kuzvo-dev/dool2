#!/bin/bash
# 맥에 서비스 도구 매일 점검(scripts/connector-nightly.sh)을 launchd로 건다 (ADR 0020).
# 매일 새벽 4:30 (맥이 잠들어 있었으면 깨어날 때) 돈다. 끄기: launchctl bootout gui/$UID/com.dool2.connector-nightly
#
#   DOOL2_TEST_CHROME=".../Google Chrome for Testing" DOOL2_GH_USER=<계정> bash scripts/install-nightly-mac.sh
set -euo pipefail
: "${DOOL2_TEST_CHROME:?Chrome for Testing 경로가 필요해요}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
DIR=${DOOL2_NIGHTLY_DIR:-$HOME/dev/kuzvo/dool2-nightly}
LABEL=com.dool2.connector-nightly
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_DIR=$(dirname "$(command -v node)")

# 점검용 작업 폴더 (이 레포의 git worktree)
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
echo "걸었어요: 매일 4:30 ($PLIST). 지금 한 번 돌리려면: launchctl kickstart gui/$UID/$LABEL"
