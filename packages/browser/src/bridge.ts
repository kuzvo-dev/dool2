// Browser bridge on the Dool2 daemon side. It opens a local socket (Unix socket on macOS and Linux, a named pipe
// on Windows), and the native messaging host Chrome starts (host.ts) connects to it. The host only relays messages.
//
// So that nobody else can connect: each start writes a new token to a file only the user can read,
// and the host must send that token as its first line.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type {
  BridgeNotice,
  BridgeReply,
  BridgeRequest,
  BrowserCommand,
  ExtensionStatus,
} from '@dool2/protocol'
import { BRIDGE_TEXT } from './locales/bridge.js'
import { LineReader } from './native.js'

/** The daemon matches these words, so they stay Korean until it matches error codes (see locales/bridge.ts) */
const T = BRIDGE_TEXT.ko

/** Name of the connection info file the host reads (in the data folder) */
export const BRIDGE_FILE = 'browser-bridge.json'

export interface BridgeInfo {
  socket: string
  token: string
}

/** Socket location. Unix socket paths only allow about 100 characters, so long ones move to the temp folder */
export function bridgeSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  if (platform === 'win32') return `\\\\.\\pipe\\dool2-browser-${hash}`
  const inData = posix.join(dataDir, 'browser.sock')
  return Buffer.byteLength(inData) <= 100 ? inData : posix.join(tmpdir(), `dool2-${hash}.sock`)
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

  /**
   * Runs before a command while the extension is not connected, and may throw what is wrong instead. The daemon opens
   * Chrome here when a call needs the browser (ADR 0006 follow-up)
   */
  whenOffline?: (cmd: BrowserCommand) => Promise<void>

  /** Sends the extension a command and waits for the answer */
  call(cmd: BrowserCommand, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if ((!this.conn || !this.hello) && this.whenOffline)
      return this.whenOffline(cmd).then(() => this.send(cmd, args, timeoutMs))
    return this.send(cmd, args, timeoutMs)
  }

  private send(cmd: BrowserCommand, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const conn = this.conn
    if (!conn || !this.hello) return Promise.reject(new BrowserError(T.notConnected))
    const id = ++this.seq
    const req: BridgeRequest = { id, cmd, args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserError(T.timeout))
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
    // Drop connections that hang on without sending the token
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
          // A new connection replaces the old one (the extension reconnected)
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
      p.reject(new BrowserError(T.closed))
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
