# @dool2/protocol

두리의 PC 앱, 본체(dool2d), 나중에 붙을 폰 앱이 함께 쓰는 타입과 규약이에요. 다른 `@dool2/*` 패키지에 의존하지 않아요.

| 내보내는 것                                             | 설명                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AgentId`, `AGENT_LABEL`                                | 지원하는 AI (`claude`, `codex`)와 화면에 보이는 이름                                                                       |
| `AgentStatus`                                           | 설치 여부, 버전, 로그인 상태, 구독 종류                                                                                    |
| `AgentEvent`                                            | 에이전트 한 턴에서 나오는 공통 이벤트: `started`, `text`, `tool`, `tool_result`, `usage`, `limit_reached`, `error`, `done` |
| `AgentErrorCode`                                        | `not_installed`, `not_logged_in`, `rate_limited`, `tools_unsafe`, `process_failed`, `aborted`, `unknown`                   |
| `ThreadSummary`, `StoredMessage`                        | 대화 목록과 메시지                                                                                                         |
| `CreateThreadRequestSchema`, `SendMessageRequestSchema` | 로컬 API 입력 검사(zod)                                                                                                    |
| `DaemonStreamEvent`                                     | 메시지 보내기 응답 스트림(SSE)의 이벤트                                                                                    |

보안 핵심 영역이에요. 규약을 바꾸는 PR은 [CONTRIBUTING](../../CONTRIBUTING.md#리뷰-강도)의 리뷰 기준을 따라요.
