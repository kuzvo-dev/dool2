# 두리 (dool2)

> 내 컴퓨터에 사는 AI 비서 — 부탁은 폰으로, 일은 내 컴퓨터가.

폰으로 부탁하면 내 컴퓨터(맥·윈도우)가 대신 일을 해요. 돈 쓰는 일은 꼭 먼저 물어봐요.

- 홈페이지: https://dool2.com
- 상태: **개발 초기 (M0 뼈대)**. 아직 일반 사용자용 설치 파일은 없어요.

_English: dool2 is an open-source personal AI assistant that lives on your own PC. You ask from your phone; your computer does the work with your own Claude Code or Codex subscription. Spending money or contacting people always requires a signed approval from your phone. Korean-first._

## 어떻게 돌아가나

- 두리는 사용자가 이미 쓰는 **Claude Code** 또는 **Codex**를 사용자 PC에서, 사용자 구독으로 실행해요.
- AI의 기본 기능(셸·파일·웹)은 끄고, **두리 도구만** 쓰게 해요. 그래야 허락 없이 위험한 일을 할 길이 없어요.
- 대화 기록은 이 PC에만 남아요.

자세한 설계: [아키텍처](docs/architecture.md) · [오픈소스 운영안](docs/open-source.md)

## 개발 시작하기

필요한 것: Node 24 (`.nvmrc`), pnpm (corepack이 맞춰 줘요). Claude Code로 시험하려면 `claude`가 설치·로그인돼 있어야 해요.

```bash
corepack enable
pnpm install
pnpm build
pnpm test

# PC 앱 실행 (Electron)
pnpm dev:desktop

# 본체만 실행 (주소와 토큰이 출력돼요)
pnpm dev:daemon
```

## 레포 구성

```
apps/
  desktop/        PC 앱 (Electron)
  daemon/         두리 본체 dool2d — 로컬 API, 대화 실행, 기록
packages/
  protocol/       공통 타입
  engine/         대화 진행, 에이전트 공통 인터페이스
  agent-claude/   Claude Code 연동 (`claude -p`, 내장 도구 끔)
  agent-codex/    Codex 연동 (`codex app-server`, 셸 끔, 고정 버전 동봉)
  mcp-tools/      두리 도구 (MCP)
  store/          기록 (SQLite)
docs/             설계 문서
```

## 라이선스

- 코드: [Apache License 2.0](LICENSE)
- 스킬(`skills/`, 추가 예정): CC BY-SA 4.0
- "두리" 이름과 로고는 상표로 따로 보호해요. 포크할 때는 이름과 로고를 바꿔 주세요.

Claude Code는 Anthropic의 제품이고, Codex는 OpenAI의 제품이에요. 두리는 두 회사와 관계없는 독립 프로젝트예요.
