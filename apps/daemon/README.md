# @dool2/daemon (dool2d)

두리 본체예요. 에이전트 실행, 대화 진행, 기록을 맡고, 화면(PC 앱, 나중에 폰)에는 로컬 API로 기능을 열어 줘요. PC 앱은 이 본체를 같은 프로세스에서 띄워요.

```bash
pnpm build
pnpm dev:daemon   # 주소와 토큰을 출력해요
```

## 로컬 API

`127.0.0.1`에서만 받고, 모든 요청에 `Authorization: Bearer <토큰>`이 필요해요. 토큰은 실행할 때마다 새로 만들어요.

| 메서드              | 경로                            | 설명                                                  |
| ------------------- | ------------------------------- | ----------------------------------------------------- |
| GET                 | `/api/health`                   | 살아 있는지                                           |
| GET                 | `/api/agents`                   | Claude Code·Codex 설치·로그인 상태                    |
| POST                | `/api/agents/codex/login`       | ChatGPT 로그인 (끝날 때까지 기다림)                   |
| GET / POST / DELETE | `/api/agents/claude/login`      | Claude 로그인 상태 / 시작(로그인 주소) / 취소         |
| POST                | `/api/agents/claude/login/code` | 브라우저에 나온 코드를 공식 로그인에 넘김             |
| GET / PATCH         | `/api/settings`                 | 설정 읽기 / 바꿀 항목만 저장                          |
| GET / POST          | `/api/threads`                  | 대화 목록 / 새 대화                                   |
| GET                 | `/api/threads/:id`              | 대화와 메시지                                         |
| POST                | `/api/threads/:id/messages`     | 메시지 보내기. 응답은 SSE 스트림(`DaemonStreamEvent`) |
| POST                | `/api/threads/:id/cancel`       | 진행 중인 답 멈추기                                   |

## 데이터 폴더

| OS      | 위치                                  |
| ------- | ------------------------------------- |
| macOS   | `~/Library/Application Support/dool2` |
| Windows | `%APPDATA%\dool2`                     |
| 그 밖   | `$XDG_DATA_HOME/dool2`                |

`DOOL2_DATA_DIR`로 바꿀 수 있어요. 개발과 캡처에는 임시 폴더를 쓰세요. 데모 대화는 `node scripts/seed-demo.mjs <폴더>`로 만들 수 있어요.
