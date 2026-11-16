# @dool2/relay

두리 **중계 서버**예요. 폰과 PC가 서로 다른 네트워크에 있어도 이어 주지만, **암호문 봉투만 옮겨요**. 내용은 볼 수 없어요([ADR 0012](../../docs/decisions/0012-phone-link.md)).

```bash
pnpm build
pnpm --filter @dool2/relay start      # http://127.0.0.1:8787 (폰 앱: /app/)
```

| 환경 변수         | 설명                                           |
| ----------------- | ---------------------------------------------- |
| `PORT`, `HOST`    | 기본 `8787`, `127.0.0.1`                       |
| `DOOL2_PHONE_APP` | 폰 앱(PWA) 파일 폴더 (기본: `apps/phone/dist`) |

## 하는 일

- 연결하면 먼저 **Ed25519 서명**으로 "이 기기"임을 증명해요. 기기 id는 서명 공개키의 해시라서 남의 id를 쓸 수 없어요.
- 봉투의 `from`은 증명한 기기여야 해요. 아니면 연결을 끊어요.
- PC 방마다 PC 하나와 폰 여럿을 이어요. 폰은 자기 방의 PC에게만 보낼 수 있어요.
- 받는 쪽이 꺼져 있으면 **7일까지, 500개까지** 쌓아 두었다가 켜지면 넘겨요. 메시지 하나는 512KB까지예요.
- 누가 페어링된 폰인지는 몰라요. 그건 PC가 판단해서 나머지는 버려요.
- 연결마다 1초에 30개까지만 받아요.

## 알 수 있는 것과 없는 것

| 중계 서버가 아는 것                                      | 모르는 것                      |
| -------------------------------------------------------- | ------------------------------ |
| 기기 id, 메시지 크기, 시각, 봉투 종류(`ask`, `reply` 등) | 부탁 내용, 답, 승인 내용, 화면 |

## 공식 서버 (Cloudflare)

공식 중계 서버는 **Cloudflare Workers + Durable Objects**에서 돌아요(`src/worker.ts`). 규칙은 Node 버전과 같은 `src/core.ts`를 써요.

- PC 방(PC id)마다 Durable Object 하나. 접속 주소는 `wss://relay.dool2.com/link?room=<PC id>`예요.
- WebSocket Hibernation으로 메시지가 없을 때는 잠들어 있어요(요금 없음).
- 꺼진 기기로 가는 봉투는 그 방의 SQLite에 **암호문 그대로** 7일까지 쌓아 둬요. 서버를 다시 켜도 남아요.
- 폰 앱은 내려주지 않아요. 폰 앱은 스토어 앱으로만 배포해요(서버가 앱 코드를 바꿔치기할 수 없게).

```bash
pnpm --filter @dool2/relay dev:cf                     # 내 컴퓨터에서 Cloudflare 환경으로 띄우기
node apps/relay/scripts/smoke.mjs http://127.0.0.1:8787 # 전달·쌓아 두기·서명 확인
pnpm --filter @dool2/relay deploy                     # 배포 (wrangler login 필요)
node apps/relay/scripts/smoke.mjs https://relay.dool2.com
```

## 직접 운영 (Node)

`src/main.ts`는 자체 호스팅·개발용이에요. 같은 규약이라 PC 앱 설정에서 주소만 바꾸면 돼요. 쌓아 둔 봉투는 메모리에만 있어서 서버를 다시 켜면 사라져요.
