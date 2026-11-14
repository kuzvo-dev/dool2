# @dool2/engine

대화 진행과 에이전트 공통 인터페이스예요. Claude Code와 Codex 어댑터는 이 인터페이스를 구현해요.

| 내보내는 것                                | 설명                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `AgentRuntime`                             | 에이전트 어댑터 인터페이스: `detect()`로 설치·로그인 상태, `runTurn()`으로 한 턴 실행(`AgentEvent` 스트림) |
| `TurnInput`, `McpServerSpec`               | 한 턴에 넘기는 입력: 글, 이어 하기 id, 시스템 지침, 두리 MCP 서버, 작업 폴더, 중단 신호                    |
| `ThreadService`                            | 대화 하나를 진행해요. 사용자 메시지 저장 → 에이전트 실행 → 이어 하기 id·답 저장                            |
| `buildSystemPrompt`, `DOOL2_SYSTEM_PROMPT` | [두리 페르소나](../../docs/persona.md) 지침. 두 에이전트가 같은 지침을 받아요                              |
| `findExecutable`, `runOnce`, `spawnLines`  | 외부 프로그램을 찾고 실행하는 도우미 (맥·윈도우 경로 차이 처리)                                            |

새 에이전트를 붙이려면 `AgentRuntime`을 구현하고, [ADR 0003](../../docs/decisions/0003-dool2-tools-only.md)대로 두리 도구만 쓰게 묶어야 해요.
