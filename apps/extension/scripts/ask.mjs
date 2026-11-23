// Run one request end to end with a test Chrome + the real Dool2 daemon + a real AI (for checking on real sites).
// The user's Chrome and profile are not touched. The AI uses that AI's login and usage.
//
//   DOOL2_TEST_CHROME=... node apps/extension/scripts/ask.mjs claude "Track CJ parcel 123456789012"
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '@dool2/daemon'

const [agent = 'claude', text] = process.argv.slice(2)
const chromeBin = process.env.DOOL2_TEST_CHROME
if (!chromeBin || !text) {
  console.error('Usage: DOOL2_TEST_CHROME=<Chrome for Testing> node ask.mjs <claude|codex> "<request>"')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'dool2-ask-'))
const profile = join(tmp, 'profile')
const daemon = await startDaemon({
  dataDir: join(tmp, 'data'),
  nativeHost: { defaultTargets: false, extraDirs: [join(profile, 'NativeMessagingHosts')] },
})
const chrome = spawn(
  chromeBin,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${join(root, 'dist')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
try {
  for (let i = 0; i < 150 && !daemon.browser.status.connected; i++)
    await new Promise((r) => setTimeout(r, 200))
  if (!daemon.browser.status.connected) throw new Error('The extension did not connect')
  const post = (path, body) =>
    fetch(`${daemon.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const { thread } = await (await post('/api/threads', { agent })).json()
  const res = await post(`/api/threads/${thread.id}/messages`, { text })
  const t0 = Date.now()
  let buf = ''
  console.log(`> ${text}`)
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString()
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.startsWith('data: ')) continue
      const ev = JSON.parse(p.slice(6))
      if (ev.event?.type === 'tool')
        console.log(`  tool: ${ev.event.name.replace('mcp__dool2__', '')} ${JSON.stringify(ev.event.input)}`)
      if (ev.event?.type === 'done') console.log(`Dool2: ${ev.event.text}`)
      if (ev.event?.type === 'error') console.log(`error: ${ev.event.message}`)
    }
  }
  console.log(`(${Math.round((Date.now() - t0) / 1000)}s)`)
} finally {
  chrome.kill()
  await daemon.close()
  await new Promise((r) => setTimeout(r, 500))
  rmSync(tmp, { recursive: true, force: true })
}
