// Starts the PC screen control helper (dool2-hands) and sends it one-line JSON requests (docs/architecture.md 5.2, ADR 0013).
// The helper is started on first use and started again on the next request if it died.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface HandsCaller {
  /** Whether screen control is available on this PC (whether the helper exists) */
  available(): boolean
  call(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export class HandsProcess implements HandsCaller {
  private child?: ChildProcessWithoutNullStreams
  private seq = 0
  private waiting = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >()

  constructor(private readonly bin: string | undefined) {}

  available() {
    return Boolean(this.bin && existsSync(this.bin))
  }

  private start() {
    if (this.child && this.child.exitCode === null) return this.child
    if (!this.bin || !existsSync(this.bin)) throw new Error('This PC has no screen control helper')
    const child = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let rest = ''
    child.stdout.on('data', (chunk: Buffer) => {
      rest += chunk.toString()
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.onLine(line)
    })
    child.stderr.on('data', () => {})
    child.on('exit', () => {
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer)
        w.reject(new Error('The screen control helper stopped'))
      }
      this.waiting.clear()
      if (this.child === child) this.child = undefined
    })
    this.child = child
    return child
  }

  private onLine(line: string) {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const w = msg.id !== undefined ? this.waiting.get(msg.id) : undefined
    if (!w || msg.id === undefined) return
    this.waiting.delete(msg.id)
    clearTimeout(w.timer)
    if (msg.ok) w.resolve(msg.result)
    else w.reject(new Error(msg.error ?? 'Screen control failed'))
  }

  call(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    const child = this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('The screen control helper is not responding'))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
    })
  }

  close() {
    this.child?.stdin.end()
    this.child?.kill()
    this.child = undefined
  }
}
