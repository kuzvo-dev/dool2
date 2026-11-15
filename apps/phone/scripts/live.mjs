// 폰 앱 끝-끝 확인용 판: 중계 서버(폰 앱 포함) + 두리 본체(진짜 AI) + 시험용 Chrome(두리 확장) + 시험 가게.
// 띄워 두고 폰 대신 브라우저로 /app/을 열어 시험한다. 사용자 Chrome·프로필은 건드리지 않는다.
//
//   pnpm build
//   DOOL2_TEST_CHROME=... node apps/phone/scripts/live.mjs     → /tmp/dool2-live.json 에 주소·토큰
//   DOOL2_LIVE_DIR=<폴더> 를 주면 그 폴더를 계속 쓴다 (다시 켜도 폰 연결이 남는다)
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '@dool2/daemon'
import { startRelay } from '@dool2/relay'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const chromeBin = process.env.DOOL2_TEST_CHROME
// DOOL2_LIVE_DIR를 주면 그 폴더를 다시 쓴다 (본체를 다시 켜도 폰 연결·대화가 남는다)
const keep = process.env.DOOL2_LIVE_DIR
const tmp = keep ?? mkdtempSync(join(tmpdir(), 'dool2-live-'))

const shop = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  // 로그인 페이지: 두리 금고에 없는 사이트라 사람에게 넘긴다 (원격 화면 시험용)
  if (req.url?.startsWith('/login')) {
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>두리 시험 가게 로그인</title>
<h1>로그인</h1><form onsubmit="event.preventDefault();document.body.innerHTML='<h1>로그인했어요</h1><p>'+this.id.value+'님 반가워요</p>'">
<p><input name="id" placeholder="아이디" style="font-size:20px;padding:8px"></p>
<p><input name="pw" type="password" placeholder="비밀번호" style="font-size:20px;padding:8px"></p>
<p><button style="font-size:20px;padding:8px 20px">로그인</button></p></form>`)
    return
  }
  res.end(`<!doctype html><title>두리 시험 가게</title><h1>두리 시험 가게</h1>
<p>오늘의 추천: 제주 귤 3kg <b>15,900원</b> (무료 배송, 배송 전 취소 가능)</p>
<button onclick="document.title='주문 완료';document.body.insertAdjacentHTML('beforeend','<h2>주문이 완료됐어요</h2>')">바로 구매</button>`)
})
await new Promise((r) => shop.listen(8790, '127.0.0.1', r))

const relay = await startRelay({
  port: 8787,
  appDir: join(root, 'apps', 'phone', 'dist'),
  log: (l) => console.log(`[중계] ${l}`),
})
const profile = join(tmp, 'profile')
const daemon = await startDaemon({
  dataDir: join(tmp, 'data'),
  relay: relay.url,
  pcName: '시험 PC',
  nativeHost: { defaultTargets: false, extraDirs: [join(profile, 'NativeMessagingHosts')] },
})
const chrome = chromeBin
  ? spawn(
      chromeBin,
      [
        `--user-data-dir=${profile}`,
        `--load-extension=${join(root, 'apps', 'extension', 'dist')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1200,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
  : undefined

writeFileSync(
  '/tmp/dool2-live.json',
  JSON.stringify({
    relay: relay.url,
    daemon: daemon.url,
    token: daemon.token,
    shop: 'http://127.0.0.1:8790/',
  }),
)
console.log(`준비됐어요: 폰 앱 ${relay.url}/app/ · 본체 ${daemon.url}`)

const stop = async () => {
  // 시험용 Chrome·열린 연결이 늦게 닫혀도 3초 안에는 끝낸다
  setTimeout(() => process.exit(0), 3000).unref()
  chrome?.kill()
  await daemon.close()
  await relay.close()
  shop.close()
  if (!keep) rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
