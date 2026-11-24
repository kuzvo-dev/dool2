// Resident Claude Code session (ADR 0035): one `claude -p --input-format stream-json` per conversation segment.
// Messages go in on stdin one JSON line at a time, and each turn ends at its `result` line. The program, the Dool2 tool
// server and the sign-in check start once per segment instead of once per message.
//
// Checked on the installed CLI (2.1.x, fixtures/stream-*.jsonl): several turns on one process keep the conversation;
// an `interrupt` control request ends the running turn with an `error_during_execution` result and the process takes
// the next message; `--resume <id>` with stream-json input continues the same session id; the tool server starts with
// the program, before the first message.

import { type AgentSession, type SessionInput, type StreamProcess, spawnStream } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { AgentEvent } from '@dool2/protocol'
import { CLAUDE_TEXT } from './locales/claude.js'
import { ClaudeStreamParser, DOOL2_TOOL_PREFIX } from './parse.js'

export type SpawnStream = (cmd: string, args: string[], opts: { cwd?: string }) => StreamProcess

export interface ClaudeSessionOptions {
  bin: string
  input: SessionInput
  /** Arguments for one program of this session (resumeId: the session to continue, when known) */
  args: (resumeId: string | undefined) => string[]
  lang?: Lang
  spawn?: SpawnStream
  /** Wait before starting again when the program came up without Dool2 tools (× attempt) */
  retryDelayMs?: number
  /** After the stop button, how long to wait for the turn to end before ending the program */
  interruptGraceMs?: number
}

/** The user's message as one stdin line */
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
}

/** The stop request as one stdin line (the CLI's control request) */
export function interruptLine(id: string): string {
  return JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })
}

export class ClaudeSession implements AgentSession {
  private proc: StreamProcess | undefined
  /** Turns sent to the current program */
  private sent = 0
  private busy = false
  private interrupted = false
  private closed = false
  private stops = 0
  private killTimer: ReturnType<typeof setTimeout> | undefined
  /** The CLI session id, learned from the stream; a program started again continues it */
  private resumeId: string | undefined

  constructor(private readonly o: ClaudeSessionOptions) {
    this.resumeId = o.input.resumeId
  }

  get alive(): boolean {
    return this.proc?.alive ?? false
  }

  /** Starts the program now (before the first message, so it and its tool server are ready when the message comes) */
  start() {
    if (this.closed || this.proc?.alive) return
    const spawn = this.o.spawn ?? spawnStream
    this.proc = spawn(this.o.bin, this.o.args(this.resumeId), { cwd: this.o.input.cwd })
    this.sent = 0
  }

  private get t() {
    return CLAUDE_TEXT[this.o.lang ?? 'ko']
  }

  async *send(text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (this.closed) throw new Error('This session is closed')
    if (this.busy) throw new Error('This session is still replying')
    this.busy = true
    this.interrupted = false
    const onAbort = () => this.interrupt()
    signal?.addEventListener('abort', onAbort, { once: true })
    let clean = false
    try {
      if (signal?.aborted) {
        yield { type: 'error', code: 'aborted', message: this.t.stopped }
        clean = true
        return
      }
      // If the program comes up without Dool2 tools (its tool server was late on a busy PC), the reply has no tools.
      // Start it once more after a short wait, as runTurn does (seen 11-21)
      for (let attempt = 0; ; attempt++) {
        this.start()
        const r = yield* this.turn(text, attempt < 2)
        clean = true
        if (r !== 'retry') return
        await new Promise((res) => setTimeout(res, (this.o.retryDelayMs ?? 1500) * (attempt + 1)))
        if (this.interrupted || signal?.aborted) {
          yield { type: 'error', code: 'aborted', message: this.t.stopped }
          return
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(this.killTimer)
      this.busy = false
      // A turn left before its end leaves its lines behind: end the program, the next message starts it again
      if (!clean) this.proc?.kill()
    }
  }

  /**
   * One turn on the current program. 'done': the turn ended (result line, or the program ended), 'retry': the program
   * came up without Dool2 tools and was ended. If the caller stops reading partway, the program is ended
   */
  private async *turn(text: string, canRetry: boolean): AsyncGenerator<AgentEvent, 'done' | 'retry'> {
    const proc = this.proc as StreamProcess
    const t = this.t
    const firstOnProgram = this.sent === 0
    if (!proc.write(userLine(text))) {
      // stdin closed under us: the program is ending. Start again
      proc.kill()
      await proc.exit.catch(() => undefined)
      if (canRetry) return 'retry'
      return yield* this.ended(proc, false)
    }
    this.sent++
    const parser = new ClaudeStreamParser(this.o.lang ?? 'ko')
    let finished = false
    let state: 'done' | 'open' = 'open'
    try {
      while (true) {
        const next = await proc.lines.next()
        if (next.done) break
        let isResult = false
        try {
          isResult = (JSON.parse(next.value) as { type?: unknown }).type === 'result'
        } catch {}
        for (const ev of parser.push(next.value)) {
          if (ev.type === 'started' && ev.resumeId) this.resumeId = ev.resumeId
          if (ev.type === 'done' && ev.resumeId) this.resumeId = ev.resumeId
          if (
            ev.type === 'started' &&
            canRetry &&
            firstOnProgram &&
            this.o.input.mcpServers.length > 0 &&
            !ev.tools.some((x) => x.startsWith(DOOL2_TOOL_PREFIX))
          ) {
            proc.kill()
            await proc.exit.catch(() => undefined)
            state = 'done'
            return 'retry'
          }
          // The stop button: the turn ends with an error result; tell it as stopped
          if (this.interrupted && ev.type === 'error') {
            if (!finished) yield { type: 'error', code: 'aborted', message: t.stopped }
            finished = true
            continue
          }
          if (finished && (ev.type === 'done' || ev.type === 'error')) continue
          yield ev
          if (ev.type === 'error' && ev.code === 'tools_unsafe') {
            proc.kill()
            await proc.exit.catch(() => undefined)
            state = 'done'
            return 'done'
          }
          if (ev.type === 'done' || ev.type === 'error') finished = true
        }
        if (isResult) {
          state = 'done'
          return 'done'
        }
      }
      state = 'done'
      return yield* this.ended(proc, finished)
    } finally {
      if (state === 'open') proc.kill()
    }
  }

  /** The program ended during a turn */
  private async *ended(proc: StreamProcess, finished: boolean): AsyncGenerator<AgentEvent, 'done'> {
    const { code, stderrTail } = await proc.exit
    if (this.interrupted) {
      if (!finished) yield { type: 'error', code: 'aborted', message: this.t.stopped }
    } else if (!finished) {
      yield {
        type: 'error',
        code: 'process_failed',
        message: this.t.crashed(code, stderrTail ? stderrTail.trim().slice(-200) : ''),
      }
    }
    return 'done'
  }

  interrupt() {
    const proc = this.proc
    if (!this.busy || this.interrupted || !proc?.alive) return
    this.interrupted = true
    proc.write(interruptLine(`stop-${++this.stops}`))
    // If the turn does not end soon, end the program (the next message starts it again with --resume)
    clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => proc.kill(), this.o.interruptGraceMs ?? 5000)
    this.killTimer.unref?.()
  }

  async close() {
    this.closed = true
    clearTimeout(this.killTimer)
    const proc = this.proc
    if (!proc?.alive) return
    // Closing stdin lets the CLI finish writing the session and exit on its own. Its last lines are read and dropped
    proc.end()
    void (async () => {
      while (!(await proc.lines.next()).done) {}
    })().catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([proc.exit, new Promise<void>((r) => (timer = setTimeout(r, 3000)))])
    clearTimeout(timer)
    proc.kill()
  }
}
