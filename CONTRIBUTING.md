# 기여 안내

두리에 관심 가져 주셔서 고마워요.

- 이슈와 Pull Request 모두 환영해요.
- `main` 브랜치에 바로 push할 수 없어요. 포크한 뒤 Pull Request를 보내 주세요.
- 머지는 메인테이너(@kuzvo-dev)가 리뷰한 뒤에 해요. 머지는 squash 방식만 써요.
- 처음 기여하시는 분의 PR은 메인테이너가 승인해야 CI가 돌아요.
- 보안 문제는 이슈 대신 [SECURITY.md](SECURITY.md)의 안내를 따라 주세요.

## 작업 방식

작은 단위로 PR을 올리고, 화면이 바뀌면 캡처를 붙여 주세요. 자세한 규칙은 [AGENTS.md](AGENTS.md)에 있어요.

## 커밋 서명 (DCO)

모든 커밋에 `Signed-off-by` 한 줄이 있어야 해요. "이 코드를 기여할 권리가 있다"는 [Developer Certificate of Origin](https://developercertificate.org/)에 동의한다는 뜻이에요. `git commit -s`로 커밋하면 자동으로 붙어요. CI가 확인해요.

## 개발 환경

```bash
corepack enable
pnpm install
pnpm build && pnpm test
pnpm lint        # Biome
```

- 테스트는 실제 AI를 부르지 않아요. Claude Code·Codex 출력은 `fixtures/`의 실제 출력으로 고정해서 시험해요.
- 보안 핵심 경로(승인 게이트, 에이전트 도구 제한, 암호화)는 더 꼼꼼히 리뷰해요. 큰 변경은 이슈로 설계부터 이야기해 주세요.

## 라이선스

기여하신 코드는 [Apache License 2.0](LICENSE)으로, 스킬 문서(`skills/`)는 CC BY-SA 4.0으로 배포돼요.
