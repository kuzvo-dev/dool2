import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_FILE, BrowserBridge, bridgeSocketPath } from './bridge.js'
import { runHost } from './host.js'
import { encodeFrame, FrameReader, LineReader } from './native.js'

let dir: string | undefined
let bridge: BrowserBridge | undefined
afterEach(async () => {
  await bridge?.close()
  bridge = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('native messaging 형식', () => {
  it('길이 4바이트 + JSON으로 싸고, 조각나도 다시 모은다', () => {
    const frame = Buffer.concat([encodeFrame({ a: '두리' }), encodeFrame({ b: 2 })])
    const r = new FrameReader()
    expect(r.push(frame.subarray(0, 5))).toEqual([])
    expect(r.push(frame.subarray(5))).toEqual([{ a: '두리' }, { b: 2 }])
  })

  it('브라우저로 1MB가 넘는 메시지는 보내지 않는다', () => {
    expect(() => encodeFrame({ x: 'a'.repeat(1024 * 1024) })).toThrow('too large')
  })

  it('줄 단위 JSON을 나눠 읽는다', () => {
    const r = new LineReader()
    expect(r.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }])
    expect(r.push(':2}\n')).toEqual([{ b: 2 }])
  })
})

describe('소켓 위치', () => {
  it('윈도우는 이름 있는 파이프, 경로가 길면 임시 폴더', () => {
    expect(bridgeSocketPath('C:\\Users\\u\\AppData\\Roaming\\dool2', 'win32')).toMatch(
      /^\\\\\.\\pipe\\dool2-browser-[0-9a-f]{12}$/,
    )
    expect(bridgeSocketPath('/Users/u/Library/Application Support/dool2', 'darwin')).toBe(
      '/Users/u/Library/Application Support/dool2/browser.sock',
    )
    expect(bridgeSocketPath(`/x/${'a'.repeat(120)}`, 'darwin')).toMatch(/dool2-[0-9a-f]{12}\.sock$/)
  })
})

/** Chrome 쪽을 흉내 낸다: 호스트의 stdin/stdout을 잡고 확장처럼 답한다 */
function fakeExtension(dataDir: string) {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const reader = new FrameReader()
  const received: unknown[] = []
  fromHost.on('data', (chunk: Buffer) => {
    for (const msg of reader.push(chunk)) {
      received.push(msg)
      const req = msg as { id: number; cmd: string; args: { url?: string } }
      if (req.cmd === 'open')
        toHost.write(encodeFrame({ id: req.id, ok: true, result: { tabId: 7, url: req.args.url } }))
      if (req.cmd === 'click') toHost.write(encodeFrame({ id: req.id, ok: false, error: '그런 칸이 없어요' }))
    }
  })
  const done = runHost({ dataDir, stdin: toHost, stdout: fromHost, waitMs: 2_000 })
  return {
    received,
    done,
    send: (m: unknown) => toHost.write(encodeFrame(m)),
    quit: () => toHost.end(),
  }
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20))
  expect(check()).toBe(true)
}

describe('브라우저 다리', () => {
  it('호스트를 거쳐 확장에 일을 시키고 답을 받는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-bridge-'))
    bridge = new BrowserBridge(dir)
    await bridge.listen()
    const info = JSON.parse(await readFile(join(dir, BRIDGE_FILE), 'utf8'))
    expect(info.token).toBe(bridge.token)

    expect(bridge.status).toEqual({ connected: false })
    await expect(bridge.call('open', {})).rejects.toThrow('연결돼 있지 않아요')

    const ext = fakeExtension(dir)
    ext.send({ event: 'hello', version: '0.1.0', browser: 'Chrome 157' })
    await waitFor(() => bridge?.status.connected === true)
    expect(bridge.status).toEqual({ connected: true, version: '0.1.0', browser: 'Chrome 157' })

    await expect(bridge.call('open', { url: 'https://example.com' })).resolves.toEqual({
      tabId: 7,
      url: 'https://example.com',
    })
    await expect(bridge.call('click', { ref: 'e9' })).rejects.toThrow('그런 칸이 없어요')

    // 확장이 꺼지면 연결이 끊긴 것으로 본다
    ext.quit()
    await ext.done
    await waitFor(() => bridge?.status.connected === false)
  })

  it('토큰이 틀린 연결은 끊는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-bridge-'))
    bridge = new BrowserBridge(dir)
    await bridge.listen()
    const sock = connect(bridge.socketPath)
    await new Promise((r) => sock.once('connect', r))
    sock.write(`${JSON.stringify({ token: 'x'.repeat(64) })}\n`)
    sock.write(`${JSON.stringify({ event: 'hello', version: '9' })}\n`)
    await new Promise((r) => sock.once('close', r))
    expect(bridge.status.connected).toBe(false)
  })

  it('본체가 없으면 호스트가 확장에 알리고 끝난다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-bridge-'))
    const ext = fakeExtension(dir)
    await ext.done
    expect(ext.received).toEqual([{ event: 'daemon-offline' }])
  })
})

describe('Bridge while the extension is not connected', () => {
  it('asks whenOffline first and passes on what it throws (no extension needed)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-bridge-'))
    bridge = new BrowserBridge(dir)
    const asked: string[] = []
    bridge.whenOffline = async (cmd) => {
      asked.push(cmd)
      throw new Error('Chrome is closed')
    }
    await expect(bridge.call('open', { url: 'https://example.com' })).rejects.toThrow('Chrome is closed')
    // Nothing thrown: the call goes on and meets the plain "not connected"
    bridge.whenOffline = async (cmd) => {
      asked.push(cmd)
    }
    await expect(bridge.call('snapshot')).rejects.toThrow()
    expect(asked).toEqual(['open', 'snapshot'])
  })
})
