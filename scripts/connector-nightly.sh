#!/bin/bash
# Nightly service tools check and draft fixes (ADR 0020). Runs every night on a maintainer PC (scripts/install-nightly-mac.sh).
#   1. Pull main and build
#   2. Check against real sites: run lookup tools with sample input -> report (HTML, JSON), GitHub issue per broken tool
#   3. A coding agent fixes a few broken tools with the repo skill (.claude/skills/connector) as draft PRs (a person merges)
#
# Environment variables
#   DOOL2_TEST_CHROME   Chrome for Testing executable (required)
#   DOOL2_NIGHTLY_DIR   Repo working folder for the check (default ~/dev/kuzvo/dool2-nightly, git worktree or clone)
#   DOOL2_NIGHTLY_OUT   Report and log folder (default ~/.dool2-nightly)
#   DOOL2_FIX_MAX       Draft fixes per night (default 3, 0 turns it off)
#   DOOL2_REPORT_COPY   Extra place to copy the report to (e.g. a folder served on the web)
#   DOOL2_GH_USER       GitHub account that files issues and PRs (must be logged in with gh auth)
set -uo pipefail

DIR=${DOOL2_NIGHTLY_DIR:-$HOME/dev/kuzvo/dool2-nightly}
OUT=${DOOL2_NIGHTLY_OUT:-$HOME/.dool2-nightly}
FIX_MAX=${DOOL2_FIX_MAX:-3}
DAY=$(date +%F)
LOG="$OUT/$DAY.log"
mkdir -p "$OUT"
exec >>"$LOG" 2>&1
echo "== $(date '+%F %T') nightly check start"

if [ -z "${DOOL2_TEST_CHROME:-}" ]; then
  echo "DOOL2_TEST_CHROME is not set"; exit 2
fi
if [ -n "${DOOL2_GH_USER:-}" ]; then
  GH_TOKEN=$(gh auth token -h github.com -u "$DOOL2_GH_USER")
  export GH_TOKEN
fi

cd "$DIR" || { echo "Working folder not found: $DIR"; exit 2; }
git fetch -q origin && git checkout -q --detach origin/main && git clean -fdq skills
pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null || { echo "Build failed"; exit 1; }

# 2. Check (exits 1 if any tool is broken, but the next step still runs)
pnpm -s connector canary --json "$OUT/$DAY.json" --report "$OUT/latest.html" --issues
echo "Check done: $(node -e "const r=require('$OUT/$DAY.json').results;console.log(r.length+' tools, broken '+r.filter(x=>!x.ok&&!x.blocked&&x.verified).length+', failing drafts '+r.filter(x=>!x.ok&&!x.blocked&&!x.verified).length+', blocked by site '+r.filter(x=>x.blocked).length)")"
[ -n "${DOOL2_REPORT_COPY:-}" ] && cp "$OUT/latest.html" "$DOOL2_REPORT_COPY"

# 3. Draft fixes
if [ "$FIX_MAX" -le 0 ] || ! command -v claude >/dev/null; then
  echo "Skipping draft fixes"; exit 0
fi
node -e "
const r = require('$OUT/$DAY.json').results.filter((x) => !x.ok && !x.blocked && x.verified)
const seen = new Set()
for (const x of r) {
  if (seen.has(x.tool) || seen.size >= $FIX_MAX) continue
  seen.add(x.tool)
  console.log([x.service, x.tool, JSON.stringify(x.input), (x.error ?? x.problems.join(' · ')).split('\n')[0]].join('\t'))
}" | while IFS=$'\t' read -r SVC TOOL INPUT WHY; do
  BRANCH="fix/connector-${TOOL//_/-}-$DAY"
  WT="$OUT/fix-$TOOL"
  # Skip if a fix PR is already open (the Korean PR title is matched, keep it)
  if gh pr list --repo kuzvo-dev/dool2 --state open --search "서비스 도구 수리: $TOOL in:title" --json number -q '.[0].number' | grep -q .; then
    echo "Fix PR already open: $TOOL"; continue
  fi
  ISSUE=$(gh issue list --repo kuzvo-dev/dool2 --label connector-broken --state open --search "[커넥터] $TOOL in:title" --json number -q '.[0].number')
  rm -rf "$WT"; git worktree prune
  git worktree add -q -b "$BRANCH" "$WT" origin/main || continue
  (
    cd "$WT" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null || exit 1
    echo "-- Trying a fix: $TOOL ($WHY)"
    claude -p "A service tool in the Dool2 repo broke on the real site. Fix it by following '6. Fixing blocks' in the repo skill .claude/skills/connector/SKILL.md.
- Tool: $TOOL (file skills/$SVC/tools.json)
- Check input: $INPUT
- Symptom: $WHY
- Rules: do not change anything except skills/$SVC/tools.json. Do not call the site's API directly (only open URLs, read the screen, capture, embedded). Do not log in, pay or send anything.
- Verify with: pnpm -s connector page \"<url>\" [selector], pnpm -s connector try $SVC <tool> '<input>', pnpm -s connector check $SVC (DOOL2_TEST_CHROME is already set)
- Once try works: set status to '검증됨($DAY, how far it was verified)' (keep this exact Korean status format), git add skills/$SVC/tools.json -> git commit -s (English message) -> git push -u origin $BRANCH -> gh pr create --draft --repo kuzvo-dev/dool2 --title '서비스 도구 수리: $TOOL' (keep this exact title) --body (what changed on the site and how you fixed it, a summary of the try result${ISSUE:+, and Fixes #$ISSUE on the last line}).
- If you cannot fix it, do not push anything and just say why in a few words." \
      --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(pnpm -s connector:*)" "Bash(pnpm connector:*)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)" "Bash(git diff:*)" "Bash(git status:*)" "Bash(gh pr create:*)" \
      --permission-mode acceptEdits </dev/null
  )
  git worktree remove --force "$WT" 2>/dev/null
done
echo "== $(date '+%F %T') done"
