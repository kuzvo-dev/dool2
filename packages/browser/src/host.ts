// native messaging 호스트. Chrome이 두리 확장 요청으로 띄우는 작은 프로그램이다.
// 판단은 하지 않는다: Chrome(stdin/stdout, 길이+JSON) ↔ 두리 본체(로컬 소켓, 줄 단위 JSON)를 옮기기만 한다.
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { BRIDGE_FILE, type BridgeInfo } from './bridge.js'
import { encodeFrame, FrameReader, LineReader } from './native.js'

export interface HostOptions {
  dataDir: string
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  /** 두리 본체가 아직 안 떠 있으면 이만큼 기다린다 */
  waitMs?: number
  log?: (line: string) => void
}

/** 끝나면(어느 한쪽이 닫히면) 돌아온다 */
export async function runHost(opts: HostOptions): Promise<void> {
  const log = opts.log ?? (() => {})
  const sock = await connectDaemon(opts.dataDir, opts.waitMs ?? 10_000)
  if (!sock) {
    log('두리 본체에 연결하지 못했어요')
    // 확장에 알려 주고 끝낸다. 확장은 잠시 뒤 다시 시도한다
    opts.stdout.write(encodeFrame({ event: 'daemon-offline' }))
    return
  }
  log('두리 본체에 연결했어요')

  await new Promise<void>((resolve) => {
    const fromBrowser = new FrameReader()
    const fromDaemon = new LineReader()
    const finish = () => {
      sock.destroy()
      resolve()
    }
    opts.stdin.on('data', (chunk: Buffer) => {
      try {
        for (const msg of fromBrowser.push(chunk)) sock.write(`${JSON.stringify(msg)}\n`)
      } catch (e) {
        log(`브라우저 메시지를 읽지 못했어요: ${(e as Error).message}`)
        finish()
      }
    })
    sock.on('data', (chunk) => {
      try {
        for (const msg of fromDaemon.push(chunk)) opts.stdout.write(encodeFrame(msg))
      } catch (e) {
        log(`본체 메시지를 옮기지 못했어요: ${(e as Error).message}`)
        finish()
      }
    })
    opts.stdin.on('end', finish)
    sock.on('close', finish)
    sock.on('error', finish)
  })
}

async function connectDaemon(dataDir: string, waitMs: number): Promise<Socket | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    const sock = await tryConnect(dataDir)
    if (sock) return sock
    if (Date.now() >= until) return undefined
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function tryConnect(dataDir: string): Promise<Socket | undefined> {
  let info: BridgeInfo
  try {
    info = JSON.parse(await readFile(join(dataDir, BRIDGE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  return new Promise((resolve) => {
    const sock = connect(info.socket)
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({ token: info.token })}\n`)
      resolve(sock)
    })
    sock.once('error', () => resolve(undefined))
  })
}
