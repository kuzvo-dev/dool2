import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { CdpPipe, NulSplitter } from './cdp-pipe.js'
import { ChromiumInstall, chromiumPaths } from './chromium.js'
import { chromiumArgs, HIDDEN_WINDOW, launchChromium } from './chromium-launch.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'dool2-launch-'))
  dirs.push(d)
  return d
}

describe('chromiumArgs', () => {
  it('own profile, pipe, no window at start, never the automation flag', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const a = chromiumArgs({ profileDir: '/p', platform })
      expect(a).toContain('--user-data-dir=/p')
      expect(a).toContain('--remote-debugging-pipe')
      expect(a).toContain('--no-first-run')
      expect(a).toContain('--no-default-browser-check')
      expect(a).toContain('--no-startup-window')
      expect(a.some((x) => x.startsWith('--remote-debugging-port'))).toBe(false)
      expect(a.some((x) => x.includes('enable-automation'))).toBe(false)
      expect(a.some((x) => x.includes('headless'))).toBe(false)
    }
  })

  it('macOS keeps the OS keychain out (no login-password prompt)', () => {
    const mac = chromiumArgs({ profileDir: '/p', platform: 'darwin' })
    expect(mac).toContain('--use-mock-keychain')
    expect(mac).toContain('--password-store=basic')
    expect(chromiumArgs({ profileDir: 'C:\\p', platform: 'win32' })).not.toContain('--use-mock-keychain')
  })
})

describe('CdpPipe', () => {
  it('splits NUL-ended messages across chunks', () => {
    const got: string[] = []
    const s = new NulSplitter()
    s.push(Buffer.from('{"a":1}\0{"b"'), (t) => got.push(t))
    s.push(Buffer.from(':2}\0'), (t) => got.push(t))
    expect(got).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('matches answers to commands, passes events and fails what waits when the pipe closes', async () => {
    const toBrowser = new PassThrough()
    const fromBrowser = new PassThrough()
    const cdp = new CdpPipe(toBrowser, fromBrowser)
    const sent: string[] = []
    toBrowser.on('data', (c: Buffer) => sent.push(c.toString()))
    const events: unknown[] = []
    cdp.on('event', (m, p, s) => events.push([m, p, s]))
    const a = cdp.send('Browser.getVersion')
    const b = cdp.send('Runtime.evaluate', { expression: '1' }, 'S1')
    await new Promise((r) => setImmediate(r))
    expect(sent.join('')).toBe(
      '{"id":1,"method":"Browser.getVersion","params":{}}\0{"id":2,"method":"Runtime.evaluate","params":{"expression":"1"},"sessionId":"S1"}\0',
    )
    fromBrowser.write(
      '{"id":2,"error":{"code":-32000,"message":"nope"}}\0{"method":"Page.x","params":{"k":1},"sessionId":"S1"}\0',
    )
    fromBrowser.write('{"id":1,"result":{"product":"Chrome/1"}}\0')
    expect(await a).toEqual({ product: 'Chrome/1' })
    await expect(b).rejects.toThrow('nope')
    expect(events).toEqual([['Page.x', { k: 1 }, 'S1']])
    const c = cdp.send('Target.getTargets')
    fromBrowser.end()
    await expect(c).rejects.toThrow(/closed/)
    await expect(cdp.send('Target.getTargets')).rejects.toThrow(/closed/)
  })

  it('a command that is not answered times out', async () => {
    const cdp = new CdpPipe(new PassThrough(), new PassThrough())
    await expect(cdp.send('Page.navigate', {}, undefined, 20)).rejects.toThrow(/did not answer within 20 ms/)
  })
})

/** A stand-in browser: speaks the pipe protocol on fd 3/4 like Chromium does */
const FAKE = `
const { Socket } = require('node:net')
const out = new Socket({ fd: 4, readable: false, writable: true })
const send = (m) => out.write(JSON.stringify(m) + '\\0')
let buf = ''
let polls = 0
new Socket({ fd: 3, readable: true, writable: false }).on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    const r = (result) => send({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) })
    if (m.method === 'Browser.getVersion') r({ product: 'Chrome/1.0', args: process.argv.slice(2) })
    else if (m.method === 'Target.createTarget') { globalThis.last = m.params; r({ targetId: 'T1' }) }
    else if (m.method === 'Fake.lastCreate') r(globalThis.last)
    else if (m.method === 'Target.attachToTarget') r({ sessionId: 'S1' })
    else if (m.method === 'Runtime.evaluate' && m.params.expression.includes('includes')) r({ result: { value: ++polls >= 3 } })
    else if (m.method === 'Runtime.evaluate' && m.params.expression === 'throw') r({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } })
    else if (m.method === 'Runtime.evaluate') r({ result: { value: 'Fake' } })
    else if (m.method === 'Browser.close') { r({}); setTimeout(() => process.exit(0), 10) }
    else r({})
  }
})
`

// The stand-in opens fd 3/4 as sockets, which works on macOS and Linux
describe.skipIf(process.platform === 'win32')('launchChromium (stand-in browser)', () => {
  it('starts over the pipe, opens a hidden page, waits for text, evaluates and closes when idle', async () => {
    const dir = await tmp()
    const fake = join(dir, 'fake-browser.cjs')
    await writeFile(fake, FAKE)
    const profileDir = join(dir, 'profile')
    let seenArgs: string[] = []
    const browser = await launchChromium({
      executable: fake,
      profileDir,
      platform: 'darwin',
      idleMs: 300,
      spawn: (_cmd, args, opts) => {
        seenArgs = args
        return spawn(process.execPath, [fake, ...args], opts as never)
      },
    })
    expect(browser.product).toBe('Chrome/1.0')
    expect(seenArgs).toEqual(chromiumArgs({ profileDir, platform: 'darwin' }))
    if (process.platform !== 'win32') expect((await stat(profileDir)).mode & 0o777).toBe(0o700)

    const page = await browser.openPage('https://example.com/')
    expect(page.sessionId).toBe('S1')
    // Its own window, created inactive, off screen
    expect(await browser.send('Fake.lastCreate')).toEqual({
      url: 'https://example.com/',
      newWindow: true,
      background: true,
      ...HIDDEN_WINDOW,
    })
    expect(await page.waitForText('Example Domain', 5_000, 10)).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate('document.title')).toBe('Fake')
    await expect(page.evaluate('throw')).rejects.toThrow('Error: boom')
    expect(browser.running).toBe(true)
    // Idle: it closes itself
    expect(await browser.exited).toBe(0)
    expect(browser.running).toBe(false)
  })

  it('page windows open inactive and off screen', () => {
    expect(HIDDEN_WINDOW.left).toBeLessThan(-10_000)
    expect(HIDDEN_WINDOW.top).toBeGreaterThan(10_000)
  })

  it('says why when the program does not start', async () => {
    const dir = await tmp()
    await expect(
      launchChromium({ executable: join(dir, 'missing'), profileDir: join(dir, 'p'), startMs: 2_000 }),
    ).rejects.toThrow(/did not start|exited/)
  })
})

// Opt-in: downloads the pinned Chromium (~180 MB) into DOOL2_CHROMIUM_IT_DIR (or a temp folder), starts it hidden and
// reads example.com. Off in CI: DOOL2_CHROMIUM_IT=1 pnpm --filter @dool2/browser test
describe.skipIf(!process.env.DOOL2_CHROMIUM_IT)('built-in Chromium, for real', () => {
  it('downloads, launches hidden and reads example.com', { timeout: 15 * 60_000 }, async () => {
    const dataDir = process.env.DOOL2_CHROMIUM_IT_DIR ?? (await tmp())
    const t0 = Date.now()
    const executable = await new ChromiumInstall({ dataDir }).ensure('en')
    const downloadMs = Date.now() - t0
    const t1 = Date.now()
    const browser = await launchChromium({
      executable,
      profileDir: chromiumPaths(dataDir).profile,
      idleMs: 0,
    })
    try {
      const page = await browser.openPage('https://example.com/')
      await page.waitForText('documentation', 30_000)
      const firstPageMs = Date.now() - t1
      expect(await page.evaluate<string>('document.title')).toBe('Example Domain')
      expect(await page.evaluate<boolean>('navigator.webdriver')).toBe(false)
      console.log(JSON.stringify({ product: browser.product, downloadMs, firstPageMs }))
    } finally {
      await browser.close()
    }
  })
})
