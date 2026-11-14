# @dool2/agent-codex

Codex 어댑터예요. 고정 버전의 `@openai/codex`(Apache-2.0)를 함께 설치하고 `codex app-server`(JSON-RPC, 한 줄에 메시지 하나)로 실행해요([ADR 0002](../../docs/decisions/0002-official-agent-binaries.md)).

- `CodexRuntime`: `AgentRuntime` 구현. 사용자 본인의 Codex 설정과 섞이지 않게 두리 전용 `CODEX_HOME`을 써요. `login()`은 ChatGPT 로그인을 열어요.
- `buildCodexArgs()`: 셸·웹 검색을 끄고 읽기 전용 샌드박스로 묶고, 두리 MCP 서버를 필수로 등록해요.
- `CodexEventMapper`: app-server 알림을 공통 `AgentEvent`로 바꿔요. 셸 실행, 파일 변경, 웹 검색, 두리가 아닌 MCP 도구가 보이면 바로 멈춰요.
- `JsonRpcClient`: app-server와 주고받는 최소 JSON-RPC 클라이언트.
- `resolveBundledCodex()`: 플랫폼별로 함께 설치된 실행 파일 경로를 찾아요.

Codex 버전을 올릴 때는 app-server 규약이 바뀌었는지 테스트로 확인해요.
