// PC 화면 제어 도우미(dool2-hands)를 띄우고 한 줄 JSON으로 부탁한다 (docs/architecture.md 5.2, ADR 0013).
// 도우미는 처음 쓸 때 띄우고, 죽으면 다음 부탁 때 다시 띄운다.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface HandsCaller {
  /** 이 PC에서 화면 제어를 쓸 수 있는지 (도우미가 있는지) */
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
    if (!this.bin || !existsSync(this.bin)) throw new Error('이 PC에는 화면 제어 도우미가 없어요')
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
        w.reject(new Error('화면 제어 도우미가 멈췄어요'))
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
    else w.reject(new Error(msg.error ?? '화면 제어에 실패했어요'))
  }

  call(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    const child = this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('화면 제어 도우미가 답하지 않아요'))
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
