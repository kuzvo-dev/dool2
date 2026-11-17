#!/bin/bash
# 서비스 도구 매일 점검과 수리 초안 (ADR 0020). 메인테이너 PC에서 밤마다 돈다 (scripts/install-nightly-mac.sh).
#   1. main을 받아 빌드
#   2. 실제 사이트 점검: 찾아보기 도구를 예시 입력으로 → 보고서(HTML·JSON), 깨진 도구는 GitHub 이슈
#   3. 깨진 도구 몇 개는 코딩 에이전트가 레포 스킬(.claude/skills/connector)로 고쳐 PR 초안 (머지는 사람이)
#
# 환경 변수
#   DOOL2_TEST_CHROME   Chrome for Testing 실행 파일 (필수)
#   DOOL2_NIGHTLY_DIR   점검용 레포 작업 폴더 (기본 ~/dev/kuzvo/dool2-nightly, git worktree 또는 clone)
#   DOOL2_NIGHTLY_OUT   보고서·로그 폴더 (기본 ~/.dool2-nightly)
#   DOOL2_FIX_MAX       하룻밤 수리 초안 개수 (기본 3, 0이면 끔)
#   DOOL2_REPORT_COPY   보고서를 하나 더 복사해 둘 곳 (예: 웹에서 보는 폴더)
#   DOOL2_GH_USER       이슈·PR을 올릴 GitHub 계정 (gh auth에 로그인돼 있어야 함)
set -uo pipefail

DIR=${DOOL2_NIGHTLY_DIR:-$HOME/dev/kuzvo/dool2-nightly}
OUT=${DOOL2_NIGHTLY_OUT:-$HOME/.dool2-nightly}
FIX_MAX=${DOOL2_FIX_MAX:-3}
DAY=$(date +%F)
LOG="$OUT/$DAY.log"
mkdir -p "$OUT"
exec >>"$LOG" 2>&1
echo "== $(date '+%F %T') 매일 점검 시작"

if [ -z "${DOOL2_TEST_CHROME:-}" ]; then
  echo "DOOL2_TEST_CHROME이 없어요"; exit 2
fi
if [ -n "${DOOL2_GH_USER:-}" ]; then
  GH_TOKEN=$(gh auth token -h github.com -u "$DOOL2_GH_USER")
  export GH_TOKEN
fi

cd "$DIR" || { echo "작업 폴더가 없어요: $DIR"; exit 2; }
git fetch -q origin && git checkout -q --detach origin/main && git clean -fdq skills
pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null || { echo "빌드 실패"; exit 1; }

# 2. 점검 (깨진 도구가 있으면 1로 끝나지만 다음 단계는 이어 간다)
pnpm -s connector canary --json "$OUT/$DAY.json" --report "$OUT/latest.html" --issues
echo "점검 끝: $(node -e "const r=require('$OUT/$DAY.json').results;console.log(r.length+'개 중 고장 '+r.filter(x=>!x.ok&&x.verified).length+', 초안이라 안 된 것 '+r.filter(x=>!x.ok&&!x.verified).length)")"
[ -n "${DOOL2_REPORT_COPY:-}" ] && cp "$OUT/latest.html" "$DOOL2_REPORT_COPY"

# 3. 수리 초안
if [ "$FIX_MAX" -le 0 ] || ! command -v claude >/dev/null; then
  echo "수리 초안은 건너뜀"; exit 0
fi
node -e "
const r = require('$OUT/$DAY.json').results.filter((x) => !x.ok && x.verified)
const seen = new Set()
for (const x of r) {
  if (seen.has(x.tool) || seen.size >= $FIX_MAX) continue
  seen.add(x.tool)
  console.log([x.service, x.tool, JSON.stringify(x.input), (x.error ?? x.problems.join(' · ')).split('\n')[0]].join('\t'))
}" | while IFS=$'\t' read -r SVC TOOL INPUT WHY; do
  BRANCH="fix/connector-${TOOL//_/-}-$DAY"
  WT="$OUT/fix-$TOOL"
  # 이미 열린 수리 PR이 있으면 건너뛴다
  if gh pr list --repo kuzvo-dev/dool2 --state open --search "서비스 도구 수리: $TOOL in:title" --json number -q '.[0].number' | grep -q .; then
    echo "수리 PR이 이미 있어요: $TOOL"; continue
  fi
  ISSUE=$(gh issue list --repo kuzvo-dev/dool2 --label connector-broken --state open --search "[커넥터] $TOOL in:title" --json number -q '.[0].number')
  rm -rf "$WT"; git worktree prune
  git worktree add -q -b "$BRANCH" "$WT" origin/main || continue
  (
    cd "$WT" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null || exit 1
    echo "-- 수리 시도: $TOOL ($WHY)"
    claude -p "두리 레포의 서비스 도구가 실제 사이트에서 깨졌어. 레포 스킬 .claude/skills/connector/SKILL.md의 '6. 막힘 고치기'를 따라 고쳐 줘.
- 도구: $TOOL (파일 skills/$SVC/tools.json)
- 점검 입력: $INPUT
- 증상: $WHY
- 규칙: skills/$SVC/tools.json 말고는 고치지 마. 사이트 API를 직접 부르지 않는다(주소 열기·화면 읽기·capture·embedded만). 로그인·결제·보내기는 하지 않는다.
- 확인: pnpm -s connector page \"<주소>\" [선택자], pnpm -s connector try $SVC <도구> '<입력>', pnpm -s connector check $SVC (DOOL2_TEST_CHROME은 이미 있어)
- 고쳐서 try가 되면: status를 '검증됨($DAY, 무엇까지)'로, git add skills/$SVC/tools.json → git commit -s (한국어 메시지) → git push -u origin $BRANCH → gh pr create --draft --repo kuzvo-dev/dool2 --title '서비스 도구 수리: $TOOL' --body (무엇이 바뀌어 어떻게 고쳤는지, try 결과 요약${ISSUE:+, 마지막 줄에 Fixes #$ISSUE}).
- 못 고치면 아무것도 올리지 말고 이유만 짧게 말해 줘." \
      --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(pnpm -s connector:*)" "Bash(pnpm connector:*)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)" "Bash(git diff:*)" "Bash(git status:*)" "Bash(gh pr create:*)" \
      --permission-mode acceptEdits </dev/null
  )
  git worktree remove --force "$WT" 2>/dev/null
done
echo "== $(date '+%F %T') 끝"
