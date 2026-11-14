// 폰 앱 끝-끝 확인용 판: 중계 서버(폰 앱 포함) + 두리 본체(진짜 AI) + 시험용 Chrome(두리 확장) + 시험 가게.
// 띄워 두고 폰 대신 브라우저로 /app/을 열어 시험한다. 사용자 Chrome·프로필은 건드리지 않는다.
//
//   pnpm build
//   DOOL2_TEST_CHROME=... node apps/phone/scripts/live.mjs     → /tmp/dool2-live.json 에 주소·토큰
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
const tmp = mkdtempSync(join(tmpdir(), 'dool2-live-'))

const shop = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
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
  chrome?.kill()
  await daemon.close()
  await relay.close()
  shop.close()
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
