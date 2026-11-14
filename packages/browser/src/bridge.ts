// 두리 본체 쪽 브라우저 다리. 로컬 소켓(맥·리눅스 유닉스 소켓, 윈도우 이름 있는 파이프)을 열어 두면
// Chrome이 띄운 native messaging 호스트(host.ts)가 붙는다. 호스트는 메시지를 그대로 옮기기만 한다.
//
// 아무나 붙지 못하게: 시작할 때마다 새 토큰을 만들어 사용자만 읽을 수 있는 파일에 적고,
// 호스트는 첫 줄로 그 토큰을 보내야 한다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BridgeNotice,
  BridgeReply,
  BridgeRequest,
  BrowserCommand,
  ExtensionStatus,
} from '@dool2/protocol'
import { LineReader } from './native.js'

/** 호스트가 읽는 연결 정보 파일 이름 (데이터 폴더 안) */
export const BRIDGE_FILE = 'browser-bridge.json'

export interface BridgeInfo {
  socket: string
  token: string
}

/** 소켓 위치. 유닉스 소켓 경로는 100자 남짓까지만 되므로 길면 임시 폴더로 옮긴다 */
export function bridgeSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  if (platform === 'win32') return `\\\\.\\pipe\\dool2-browser-${hash}`
  const inData = join(dataDir, 'browser.sock')
  return Buffer.byteLength(inData) <= 100 ? inData : join(tmpdir(), `dool2-${hash}.sock`)
}

export class BrowserError extends Error {
  override name = 'BrowserError'
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: NodeJS.Timeout
}

export interface BrowserBridgeEvents {
  status: [ExtensionStatus]
  notice: [BridgeNotice]
}

export class BrowserBridge extends EventEmitter<BrowserBridgeEvents> {
  private server?: Server
  private conn?: Socket
  private hello?: { version: string; browser?: string }
  private seq = 0
  private pending = new Map<number, Pending>()
  readonly token = randomBytes(32).toString('hex')
  readonly socketPath: string

  constructor(private readonly dataDir: string) {
    super()
    this.socketPath = bridgeSocketPath(dataDir)
  }

  get status(): ExtensionStatus {
    return this.conn && this.hello
      ? {
          connected: true,
          version: this.hello.version,
          ...(this.hello.browser ? { browser: this.hello.browser } : {}),
        }
      : { connected: false }
  }

  async listen(): Promise<void> {
    if (process.platform !== 'win32') await rm(this.socketPath, { force: true })
    const server = createServer((sock) => this.accept(sock))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => resolve())
    })
    if (process.platform !== 'win32') await chmod(this.socketPath, 0o600)
    this.server = server
    const info: BridgeInfo = { socket: this.socketPath, token: this.token }
    await writeFile(join(this.dataDir, BRIDGE_FILE), JSON.stringify(info), { mode: 0o600 })
  }

  /** 확장에 일을 시키고 답을 기다린다 */
  call(cmd: BrowserCommand, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const conn = this.conn
    if (!conn || !this.hello)
      return Promise.reject(new BrowserError('Chrome의 두리 확장 프로그램과 연결돼 있지 않아요'))
    const id = ++this.seq
    const req: BridgeRequest = { id, cmd, args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserError('브라우저가 제때 답하지 않았어요'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      conn.write(`${JSON.stringify(req)}\n`)
    })
  }

  async close(): Promise<void> {
    this.drop(this.conn)
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = undefined
    await rm(join(this.dataDir, BRIDGE_FILE), { force: true })
  }

  private accept(sock: Socket) {
    const reader = new LineReader()
    let authed = false
    // 토큰을 보내지 않고 버티는 연결은 끊는다
    const authTimer = setTimeout(() => sock.destroy(), 5_000)
    sock.on('data', (chunk) => {
      let messages: unknown[]
      try {
        messages = reader.push(chunk)
      } catch {
        return sock.destroy()
      }
      for (const msg of messages) {
        if (!authed) {
          clearTimeout(authTimer)
          if (!tokenMatches((msg as { token?: unknown })?.token, this.token)) return sock.destroy()
          authed = true
          // 새 연결이 오면 예전 연결은 끊는다 (확장이 다시 붙은 경우)
          if (this.conn && this.conn !== sock) this.drop(this.conn)
          this.conn = sock
          continue
        }
        this.receive(msg)
      }
    })
    const gone = () => {
      clearTimeout(authTimer)
      if (this.conn === sock) this.drop(sock)
    }
    sock.on('close', gone)
    sock.on('error', gone)
  }

  private receive(msg: unknown) {
    if (!msg || typeof msg !== 'object') return
    if ('event' in msg) {
      const notice = msg as BridgeNotice
      if (notice.event === 'hello') {
        this.hello = {
          version: String(notice.version),
          ...(notice.browser ? { browser: notice.browser } : {}),
        }
        this.emit('status', this.status)
      }
      this.emit('notice', notice)
      return
    }
    const reply = msg as BridgeReply
    const p = this.pending.get(reply.id)
    if (!p) return
    this.pending.delete(reply.id)
    clearTimeout(p.timer)
    if (reply.ok) p.resolve(reply.result)
    else p.reject(new BrowserError(reply.error))
  }

  private drop(sock: Socket | undefined) {
    if (!sock) return
    sock.destroy()
    if (this.conn !== sock) return
    this.conn = undefined
    const wasConnected = Boolean(this.hello)
    this.hello = undefined
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new BrowserError('브라우저 연결이 끊겼어요'))
      this.pending.delete(id)
    }
    if (wasConnected) this.emit('status', this.status)
  }
}

function tokenMatches(given: unknown, want: string) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}
