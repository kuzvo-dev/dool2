# 두리에 기여하기

두리에 관심 가져 주셔서 고마워요. 두리는 한국 사용자를 위한 오픈소스 AI 비서라서, 코드만큼 **"이 서비스는 이렇게 써요"라는 현장 지식**이 중요해요. 개발자가 아니어도 기여할 수 있어요.

참여하는 모든 분은 [행동 강령](CODE_OF_CONDUCT.md)을 지켜 주세요.

## 기여할 수 있는 방법

| 하고 싶은 일                   | 어디서                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 질문, 아이디어, 사용 후기      | [Discussions](https://github.com/kuzvo-dev/dool2/discussions)                                     |
| 버그 신고                      | [이슈: 버그 신고](https://github.com/kuzvo-dev/dool2/issues/new?template=1-bug.yml)               |
| 기능 제안                      | [이슈: 기능 제안](https://github.com/kuzvo-dev/dool2/issues/new?template=2-feature.yml)           |
| 서비스 사용법(스킬) 요청·작성  | [이슈: 스킬 요청](https://github.com/kuzvo-dev/dool2/issues/new?template=3-skill-request.yml)     |
| 사이트가 바뀌어 스킬이 고장 남 | [이슈: 스킬 고장 신고](https://github.com/kuzvo-dev/dool2/issues/new?template=4-skill-broken.yml) |
| 보안 취약점                    | 공개 이슈 대신 [비공개 신고](SECURITY.md)                                                         |
| 코드·문서 고치기               | Pull Request (아래 절차)                                                                          |

처음이라면 [`good first issue`](https://github.com/kuzvo-dev/dool2/labels/good%20first%20issue) 라벨이 붙은 이슈부터 보세요.

## 개발 환경

**준비물**: Node.js 24 이상([`.nvmrc`](.nvmrc)), pnpm(corepack으로 레포가 정한 버전을 써요), Git.

```bash
git clone https://github.com/<내 계정>/dool2.git
cd dool2
corepack enable
pnpm install
pnpm build
pnpm dev:desktop       # PC 앱 실행
```

자주 쓰는 명령:

| 명령                                               | 하는 일                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm build`                                       | 모든 패키지 빌드 (Turborepo)                                     |
| `pnpm test`                                        | 테스트 (Vitest)                                                  |
| `pnpm typecheck`                                   | 타입 검사                                                        |
| `pnpm lint`                                        | 린트·포맷 검사 (Biome). `pnpm format`으로 자동 정리              |
| `pnpm dev:desktop`                                 | PC 앱 실행                                                       |
| `pnpm dev:daemon`                                  | 화면 없이 두리 본체만 실행                                       |
| `DOOL2_SMOKE=1 pnpm --filter @dool2/desktop smoke` | PC 앱을 띄워 화면을 캡처하고 종료 (`apps/desktop/out/smoke.png`) |

레포 구성은 [README](README.md#레포-구성), 전체 설계는 [아키텍처 문서](docs/architecture.md)를 봐 주세요.

### 실제 AI 없이 개발하기

- 테스트는 실제 Claude Code·Codex를 부르지 않아요. 실제 출력을 개인정보를 지운 뒤 `fixtures/`에 저장해서 그걸로 시험해요.
- 화면 캡처용 대화는 `node apps/daemon/scripts/seed-demo.mjs /tmp/dool2-demo`로 만들고, `DOOL2_DATA_DIR=/tmp/dool2-demo`로 앱을 띄워요.
- 실제 AI를 부르는 확인은 본인 구독 사용량을 써요. 꼭 필요할 때만 해 주세요.

## Pull Request 절차

1. 큰 변경이라면 먼저 이슈나 Discussions에서 방향을 이야기해 주세요. 특히 **보안 핵심 영역**(아래)은 설계부터 맞춰야 해요.
2. 포크한 뒤 브랜치를 만들어요. 이름은 `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`.
3. **PR 하나에 한 가지 일만** 담아요. 작게 나눌수록 빨리 리뷰돼요.
4. 올리기 전에 확인해요: `pnpm lint && pnpm build && pnpm typecheck && pnpm test`
5. 화면이 바뀌면 PR에 캡처를 붙여 주세요. 캡처에 개인정보가 보이면 안 돼요.
6. 리뷰 후 메인테이너가 squash로 머지해요.

처음 기여하시는 분의 PR은 메인테이너가 승인해야 CI가 돌아요. 맥·윈도우·리눅스 검사와 DCO 확인이 모두 통과해야 머지할 수 있어요.

### 리뷰 강도

| 영역      | 경로                                                                                      | 리뷰                                                         |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 보안 핵심 | `packages/gate`, `packages/protocol`, `packages/agent-*`, `packages/mcp-tools`, `.github` | 메인테이너 필수, 보안 테스트 필수. 설계 이슈부터 열어 주세요 |
| 일반 코드 | UI, 도구, 저장소                                                                          | 메인테이너 리뷰                                              |
| 스킬      | `skills/`                                                                                 | 형식 검사 후 리뷰                                            |
| 문서      | `docs/`, `*.md`                                                                           | 가벼운 리뷰                                                  |

## 커밋

- **모든 커밋에 서명(DCO)이 있어야 해요.** `git commit -s`로 커밋하면 `Signed-off-by` 줄이 붙어요. "이 코드를 기여할 권리가 있다"는 [Developer Certificate of Origin](https://developercertificate.org/)에 동의한다는 뜻이에요. CLA는 받지 않아요.
  - 빠뜨렸다면 `git commit --amend -s` 또는 `git rebase --signoff main`으로 고칠 수 있어요.
- 커밋 메시지는 한국어로, 무엇을 왜 바꿨는지 적어 주세요. 영어도 괜찮아요.

## 코드 스타일

- TypeScript(strict), ES 모듈. 포맷과 린트는 Biome이 정해요. 작은따옴표, 세미콜론 생략, 한 줄 110자.
- 사용자에게 보이는 문구는 [페르소나](docs/persona.md) 말투(해요체, 짧게, 기술 용어 없이)를 따라요.
- 주석은 한국어로, "왜"를 적어요.
- 새 기능에는 테스트를 함께 넣어 주세요.

## 지켜야 할 원칙

아래 원칙을 어기는 PR은 받기 어려워요. 이유는 [아키텍처 문서](docs/architecture.md)에 있어요.

- **AI는 두리 도구만 써요.** 에이전트의 셸·파일·웹 기능을 다시 켜는 변경은 받지 않아요.
- **돈 내기·연락하기는 사용자 허락 없이 실행되면 안 돼요.** 승인 게이트를 약하게 만들거나 그 테스트를 지우는 변경은 받지 않아요.
- **공식 프로그램은 고치지 않고 실행만 해요.** Claude Code의 로그인 정보나 토큰을 두리가 다루는 변경은 받지 않아요.
- **우회하지 않아요.** 캡차·본인인증·봇 탐지를 우회하는 코드나 스킬은 받지 않아요. 사람에게 넘겨요.
- **사용자가 쉽게 쓸 수 있어야 해요.** 사용자에게 터미널이나 개발 용어가 보이면 다시 설계해요.

## 코딩 에이전트와 함께 일한다면

Claude Code·Codex 같은 코딩 에이전트로 기여해도 좋아요. 에이전트는 [AGENTS.md](AGENTS.md)를 읽고 같은 규칙을 따라요. 결과물에 대한 책임은 PR을 올린 사람에게 있어요.

## 라이선스

기여하신 코드는 [Apache License 2.0](LICENSE)으로, 스킬 문서(`skills/`)는 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ko)으로 배포돼요.
