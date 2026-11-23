# Glossary

Use these terms in English docs, code and UI copy, and add new ones here when a term comes up more than once.
Japanese and Traditional Chinese columns will be filled in when those languages ship (ADR 0029).

Copy rules for every language:

- Use plain words that people already use for the thing ("approve", "encrypted"). Avoid invented metaphors.
- Do not use competitor product names.
- Brand and service names are not translated (Coupang, KakaoTalk, Naver, Gov24).

| Korean | English | Notes |
|---|---|---|
| 두리 | Dool2 | Product name. Code, package and domain names stay `dool2`. |
| 부탁 / 부탁하다 | request / ask | What the user sends from the phone. |
| 맡긴 일 / 일 | task | Work Dool2 does for a request. |
| 승인 / 승인하다 | approval / approve | Signed on the phone. Do not use "permission" or "allow". |
| 승인 카드 | approval card | |
| 승인 게이트 | approval gate | Code that blocks risky actions until approved. |
| 등급: 찾아보기 · 채워 두기 · 돈 내기 · 연락하기 | tiers: lookup · fill · pay · contact | Data keys `lookup`, `fill`, `pay`, `contact`. `pay` and `contact` need approval. |
| 연결 / 연결하다 | connection / connect | Linking a service account. |
| 연결 카드 (`connect.json`) | connect card | |
| 커넥터 / 서비스 도구 (`tools.json`) | connector / service tools | |
| 금고 | vault | Encrypted on the PC. Holds IDs and passwords. |
| 두리 본체 / 데몬 | Dool2 daemon | `apps/daemon` |
| PC 앱 | desktop app | `apps/desktop` |
| 폰 앱 | phone app | `apps/phone` |
| 확장 프로그램 | extension (Dool2 extension) | Chrome extension. |
| 중계 서버 | relay | Only forwards ciphertext. |
| 종단간 암호화 | end-to-end encryption | |
| 페어링 | pairing | QR once, phone ↔ PC. |
| 넘기기 / 이어받기 | hand off / take over | The person takes the screen (CAPTCHA, identity check), or Dool2 takes it back. |
| 본인인증 | identity verification | Korean phone or certificate check. Lives in `region/kr`. |
| 공동인증서 | joint certificate (Korean digital certificate) | `region/kr` |
| 대화 · 피드 · 아이디어 · 목표 · 보관함 | Chat · Feed · Ideas · Goals · Library | The five tabs. |
| 두리 화면 / 두리 패널 | assistant panel | |
| 먼저 챙기기 | proactive check | Looking at connected services twice a day (ADR 0019). |
| 기억 | memory | |
| 예약 실행 | scheduled run | |
| 문제 알리기 | report a problem | |
| 언어 / 지역 | language / region | Separate settings (ADR 0029). |
