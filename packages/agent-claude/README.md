# @dool2/agent-claude

Claude Code 어댑터예요. 사용자가 설치하고 로그인한 공식 `claude` 바이너리를 수정 없이 `claude -p`로 실행해요([ADR 0002](../../docs/decisions/0002-official-agent-binaries.md)).

- `ClaudeRuntime`: `AgentRuntime` 구현. `detect()`는 `claude --version`과 `claude auth status`로 설치·로그인·구독 종류를 확인해요.
- `buildClaudeArgs()`: 내장 도구를 끄고(`--tools ""`) 두리 MCP 서버만 연결하는 실행 인자를 만들어요.
- `ClaudeStreamParser`: `stream-json` 출력을 공통 `AgentEvent`로 바꿔요. 두리 도구가 아닌 도구가 보이면 `tools_unsafe`로 멈추게 해요.

**두리는 Claude 로그인 정보나 토큰을 읽거나 저장하지 않아요.** 이 원칙을 바꾸는 변경은 받지 않아요.

테스트는 실제 출력을 개인정보 없이 저장한 [`fixtures/`](fixtures)로 해요.
