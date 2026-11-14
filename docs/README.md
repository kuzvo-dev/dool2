# 두리 문서

두리 개발과 운영에 관한 문서 목록이에요. 사용 설명서는 첫 릴리스(M5)와 함께 따로 만들어요.

## 설계

| 문서 | 내용 |
|---|---|
| [아키텍처](architecture.md) | 전체 구조, 에이전트 연동, 승인 게이트, 브라우저·PC 제어, 폰 연결, 설치, 로드맵, 위험 |
| [페르소나](persona.md) | 두리의 성격과 말투. 사용자에게 보이는 모든 문구의 기준 |
| [결정 기록 (ADR)](decisions/README.md) | 구조에 관한 결정과 그 이유 |
| [위협 모델](security/threat-model.md) | 무엇을 지키고, 무엇을 막고, 무엇은 못 막는지 |

## 운영

| 문서 | 내용 |
|---|---|
| [오픈소스 운영](open-source.md) | 공개 범위, 라이선스, 수익 구조, 거버넌스, 스킬 기여 |
| [상표 정책](../TRADEMARKS.md) | "두리" 이름과 로고를 쓸 수 있는 경우 |
| [보안 신고](../SECURITY.md) | 취약점 비공개 신고 방법 |

## 패키지

각 패키지 폴더의 README에 역할과 주요 API가 있어요: [desktop](../apps/desktop/README.md) · [daemon](../apps/daemon/README.md) · [protocol](../packages/protocol/README.md) · [engine](../packages/engine/README.md) · [agent-claude](../packages/agent-claude/README.md) · [agent-codex](../packages/agent-codex/README.md) · [mcp-tools](../packages/mcp-tools/README.md) · [browser](../packages/browser/README.md) · [store](../packages/store/README.md)

## 기여

| 문서 | 내용 |
|---|---|
| [기여 안내](../CONTRIBUTING.md) | 개발 환경, PR 절차, 커밋 서명 |
| [작업 규칙](../AGENTS.md) | 사람과 코딩 에이전트가 함께 따르는 규칙 |
| [행동 강령](../CODE_OF_CONDUCT.md) | 커뮤니티 기준 |

## 문서 쓰는 법

- 기본 언어는 한국어예요. 해외 기여자를 위해 [README.en.md](../README.en.md)를 함께 관리해요.
- 짧은 문장으로 쓰고, 결정에는 이유를 함께 적어요.
- 화면이 나오는 문서에는 개인정보가 없는 캡처를 써요. 데모 데이터는 `node apps/daemon/scripts/seed-demo.mjs <폴더>`로 만들 수 있어요.
