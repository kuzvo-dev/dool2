---
name: naver
description: 네이버(*.naver.com) — 로그인, 메일, 그 밖의 네이버 서비스를 사용자 세션으로 돕는다.
site: [naver.com]
autoInject:
  url: ['*.naver.com', '*.naver.com/*']
  keywords: [네이버, 로그인, 메일, 쪽지, 카페]
regions: [kr]
login:
  username:
    name: 아이디
    role: textbox
  password:
    name: 비밀번호
    role: textbox
  submit:
    name: 로그인
    role: button
  totp:
    name: 인증번호
    role: textbox
---

# 네이버 (naver.com)

로그인과 메일 등 네이버 서비스를 돕는 팁.

- **데이터 경로를 먼저 찾는다.** 로그인 상태라면 메일 목록·쪽지 같은 내부 조회 요청을 사용자 세션으로 직접 부른다. 화면 조작은 그다음이다.
- 이미 로그인돼 있으면 다시 로그인하지 않는다. 여러 계정이 있으면 URL의 `authuser=`로 계정을 구분한다.
- 로그인이 필요하면 로그인은 `nid.naver.com`에서 한다. 위 `login` 힌트가 아이디·비밀번호·로그인 버튼 필드를 짚어 주고, 금고가 그 필드에 비밀을 직접 채운다(AI는 비밀을 보지 않는다).
- 로그인이 필요하고 캡차·2단계 인증이 뜨면 우회하지 말고 사용자에게 넘긴다(hand-off).
- 메일 본문·첨부를 읽을 때는 개인정보가 보일 수 있으니 필요한 범위만 읽는다.
