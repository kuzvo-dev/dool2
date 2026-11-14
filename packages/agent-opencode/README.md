# @dool2/agent-opencode

종량제 실행기예요. 구독 없이 **API 키로 쓴 만큼만** 내고 싶은 사람을 위해, 오픈소스 에이전트 OpenCode v2(MIT)를 두리 도구만 쓰게 묶어 실행해요([ADR 0010](../../docs/decisions/0010-pay-as-you-go-opencode.md)).

- `OpenCodeRuntime`: `AgentRuntime` 구현. 한 턴마다 `opencode serve --stdio`를 두리 전용 폴더에서 띄우고(127.0.0.1, 실행마다 새 비밀번호), `GET /api/event`(SSE)를 공통 `AgentEvent`로 바꿔요. 대화 이어 하기는 OpenCode 세션 id로 해요.
- `buildOpenCodeConfig()`: 모든 도구를 막고 `dool2_*`만 열어요. 기본 에이전트(build·plan·general·explore)는 끄고, OpenCode 자체 무료 모델·웹 검색·스킬·다른 MCP는 정책으로 막아요. MCP 도구를 코드 실행으로 감싸는 기능(`codemode`)도 꺼요.
- `buildOpenCodeEnv()`: 설정·데이터·상태·캐시 폴더를 모두 두리 쪽으로 돌리고, 사용자·프로젝트 설정을 읽지 않고, 자동 업데이트를 꺼요. 고른 제공자의 API 키만 환경 변수로 넘겨요.
- `OpenCodeEventMapper`: 글 조각, 도구 호출·결과, 단계별 **비용(USD)·토큰**(`cost` 사건), 끝·실패·중단. 두리 도구가 아닌 도구를 쓰려 하면 바로 멈춰요(`tools_unsafe`).
- `installOpenCode()`, `OpenCodeInstall`: 처음 쓸 때 공식 GitHub 릴리스(v2.3.0 고정)에서 받아 `SHA256SUMS`로 확인하고 OS의 `tar`로 풀어요. 설치 파일에는 넣지 않아요.

지원 제공자: Anthropic, OpenAI, OpenRouter, Google (API 키). **Claude Pro/Max 구독 로그인은 쓰지 않아요** — 구독은 공식 Claude Code로만 써요.

테스트는 실제 OpenCode v2.3.0 출력(`fixtures/auth-fail.jsonl`, 키·id 지움)과 스키마로 만든 성공 흐름(`fixtures/success.jsonl`)으로 해요.
