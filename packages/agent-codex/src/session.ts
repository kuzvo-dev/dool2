// Resident Codex session (ADR 0035 amendment): one `codex app-server` per conversation segment or running task.
// `thread/start` (or `thread/resume`) once, `turn/start` per message, `turn/interrupt` for the stop button. The program,
// its Dool2 tool server and the thread start once instead of on every message.
//
// Checked on the pinned Codex 0.169.0 without sign-in (fixtures/app-server-*.jsonl): two turns on one program; a
// `turn/interrupt` ends the running turn within a few ms with `turn/completed` status `interrupted`, and the same
// program takes the next `turn/start`; `thread/resume` in a new program continues the thread (its turns come back);
// `thread/fork` copies a saved thread with its turns (an ephemeral copy is refused for paginated threads).
//
// runTurn uses the same class for one message (open, send, close), so both paths read the protocol the same way.

import { type AgentSession, type SessionInput, type StreamProcess, spawnStream } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { AgentEvent } from '@dool2/protocol'
import { CODEX_TEXT } from './locales/codex.js'
import { CodexEventMapper, rateLimitEvents } from './map.js'
import { JsonRpcClient } from './rpc.js'

type Json = Record<string, unknown>

export type SpawnCodex = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => StreamProcess

export interface CodexSessionOptions {
  bin: string
  /** Arguments of `codex app-server` (buildCodexArgs) */
  args: string[]
  env: NodeJS.ProcessEnv
  input: SessionInput
  /** A tool-less side job: Codex's own instructions replaced, nothing saved, the lightest thinking */
  sideJob?: boolean
  /**
   * Continue in a copy of the resumed thread (`thread/fork`, summaries): the turn stays out of the thread the user
   * keeps talking in, which a resident program may hold at the same time
   */
  fork?: boolean
  lang?: Lang
  spawn?: SpawnCodex
  /** After the stop button, how long to wait for the turn to end before ending the program */
  interruptGraceMs?: number
}

/**
 * The model if this Codex knows it (`model/list`), else undefined so the thread runs on Codex's default model. The
 * profile table names models of the pinned version; a newer catalog without them must not make every call fail
 */
export async function knownModel(
  rpc: Pick<JsonRpcClient, 'request'>,
  model: string,
): Promise<string | undefined> {
  try {
    const r = await rpc.request<{ data?: { id?: unknown; model?: unknown }[] }>('model/list', {
      includeHidden: true,
    })
    return r.data?.some((m) => m.id === model || m.model === model) ? model : undefined
  } catch {
    return undefined
  }
}

/** The turn a notification belongs to, when it says */
function turnOf(params: Json): string | undefined {
  if (typeof params.turnId === 'string') return params.turnId
  const turn = params.turn
  if (turn && typeof turn === 'object' && typeof (turn as Json).id === 'string')
    return (turn as Json).id as string
  return undefined
}

export class CodexSession implements AgentSession {
  private proc: StreamProcess | undefined
  private rpc: JsonRpcClient | undefined
  /** The thread once the program is up (thread/start or thread/resume answered) */
  private ready: Promise<string> | undefined
  /** The Codex thread id; a program started again resumes it */
  private threadId: string | undefined
  private busy = false
  private interrupted = false
  private closed = false
  private turnId: string | undefined
  /** Turns that already ended: their late lines are dropped */
  private readonly endedTurns = new Set<string>()
  /** Where notifications of the running turn go */
  private onNote: ((method: string, params: Json) => void) | undefined
  /** The program ended: wakes the running turn */
  private onExit: (() => void) | undefined
  /** Usage that came between turns, told at the start of the next one */
  private usage: AgentEvent[] = []
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private stderrTail = ''
  /** The copy is made (a program started again resumes the copy, not the original) */
  private forked = false

  constructor(private readonly o: CodexSessionOptions) {
    this.threadId = o.input.resumeId
  }

  get alive(): boolean {
    return this.proc?.alive ?? false
  }

  private get t() {
    return CODEX_TEXT[this.o.lang ?? 'ko']
  }

  /** Starts the program and its thread now (before the first message, so the tool server is up when it comes) */
  start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('This session is closed'))
    if (this.ready && this.proc?.alive) return this.ready
    const spawn = this.o.spawn ?? spawnStream
    const proc = spawn(this.o.bin, this.o.args, { cwd: this.o.input.cwd, env: this.o.env })
    this.proc = proc
    const lines = proc.lines
    const rpc = new JsonRpcClient(
      { send: (line) => void proc.write(line), lines: { [Symbol.asyncIterator]: () => lines } },
      (method, params) => this.note(method, params),
      // Shell and files are off, so every approval request except for Dool2 tools is declined
      (method, params) => {
        if (method === 'mcpServer/elicitation/request' && params.serverName === 'dool2')
          return { action: 'accept', content: null }
        if (method.endsWith('requestApproval')) return { decision: 'decline' }
        throw new Error(`Request not handled by Dool2: ${method}`)
      },
    )
    this.rpc = rpc
    void rpc.pump().finally(() => {
      if (this.proc === proc) this.onExit?.()
    })
    void proc.exit.then((x) => {
      this.stderrTail = x.stderrTail
      if (this.proc === proc) this.onExit?.()
    })
    this.ready = this.handshake(rpc)
    this.ready.catch(() => proc.kill())
    return this.ready
  }

  private async handshake(rpc: JsonRpcClient): Promise<string> {
    await rpc.request('initialize', {
      clientInfo: { name: 'dool2', title: 'Dool2', version: '0.0.0' },
      capabilities: null,
    })
    rpc.notify('initialized')
    const { input, sideJob } = this.o
    const model = input.model ? await knownModel(rpc, input.model) : undefined
    const params = {
      cwd: input.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ...(model ? { model } : {}),
      // A side job's instructions replace Codex's own, and its thread is not saved (nothing resumes it)
      ...(sideJob
        ? { baseInstructions: input.systemPrompt, ephemeral: true }
        : { developerInstructions: input.systemPrompt }),
    }
    const method = !this.threadId
      ? 'thread/start'
      : this.o.fork && !this.forked
        ? 'thread/fork'
        : 'thread/resume'
    const started = await rpc.request<{ thread: { id: string } }>(
      method,
      this.threadId ? { threadId: this.threadId, ...params } : params,
    )
    if (method === 'thread/fork') this.forked = true
    this.threadId = started.thread.id
    return started.thread.id
  }

  private note(method: string, params: Json) {
    const turn = turnOf(params)
    if (turn && this.endedTurns.has(turn)) return
    if (this.onNote) return this.onNote(method, params)
    if (method === 'account/rateLimits/updated') this.usage = rateLimitEvents(params.rateLimits)
  }

  async *send(text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (this.closed) throw new Error('This session is closed')
    if (this.busy) throw new Error('This session is still replying')
    this.busy = true
    this.interrupted = false
    const onAbort = () => this.interrupt()
    signal?.addEventListener('abort', onAbort, { once: true })
    let clean = false
    const t = this.t
    try {
      if (signal?.aborted) {
        yield { type: 'error', code: 'aborted', message: t.stopped }
        clean = true
        return
      }
      let threadId: string
      try {
        threadId = await this.start()
      } catch (err) {
        this.proc?.kill()
        yield this.interrupted
          ? { type: 'error', code: 'aborted', message: t.stopped }
          : this.failure((err as Error).message)
        clean = true
        return
      }
      if (this.interrupted) {
        yield { type: 'error', code: 'aborted', message: t.stopped }
        clean = true
        return
      }
      const proc = this.proc as StreamProcess
      const rpc = this.rpc as JsonRpcClient
      yield {
        type: 'started',
        resumeId: threadId,
        tools: this.o.input.mcpServers.map((s) => `mcp__${s.name}__*`),
      }
      for (const ev of this.usage.splice(0)) yield ev

      const mapper = new CodexEventMapper(threadId, this.o.lang ?? 'ko', { sideJob: this.o.sideJob === true })
      const queue: AgentEvent[] = []
      let finished = false
      let wake: (() => void) | undefined
      const push = (evs: AgentEvent[]) => {
        queue.push(...evs)
        wake?.()
      }
      this.onNote = (method, params) => {
        const r = mapper.map(method, params)
        push(r.events)
        if (r.abort || r.finished) {
          finished = true
          // A tool Dool2 does not allow: end the program, the next message starts it again
          if (r.abort) proc.kill()
          wake?.()
        }
      }
      this.onExit = () => {
        if (finished) return
        finished = true
        push([
          this.interrupted
            ? { type: 'error', code: 'aborted', message: t.stopped }
            : this.failure(this.stderrTail.trim().slice(-200)),
        ])
      }
      try {
        const r = await rpc.request<{ turn?: { id?: string } }>('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          // A side job reads a few lines and answers one: the lightest thinking
          ...(this.o.sideJob ? { effort: 'low' } : {}),
        })
        this.turnId = r.turn?.id
        // The stop button came before Codex named the turn
        if (this.interrupted) this.sendInterrupt()
      } catch (err) {
        if (!finished) {
          finished = true
          push([
            this.interrupted
              ? { type: 'error', code: 'aborted', message: t.stopped }
              : this.failure((err as Error).message),
          ])
        }
      }
      while (true) {
        while (queue.length) yield queue.shift() as AgentEvent
        if (finished) break
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
      while (queue.length) yield queue.shift() as AgentEvent
      clean = true
    } finally {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(this.killTimer)
      if (this.turnId) this.endedTurns.add(this.turnId)
      this.turnId = undefined
      this.onNote = undefined
      this.onExit = undefined
      this.busy = false
      // A turn left before its end leaves its lines behind: end the program, the next message starts it again
      if (!clean) this.proc?.kill()
    }
  }

  /** An error the person can act on: signed out, or the turn did not finish */
  private failure(msg: string): AgentEvent {
    const t = this.t
    return /auth|login|unauthorized/i.test(`${msg}\n${this.stderrTail}`)
      ? { type: 'error', code: 'not_logged_in', message: t.loginAgain }
      : { type: 'error', code: 'process_failed', message: t.unfinished(msg) }
  }

  private sendInterrupt() {
    if (!this.threadId || !this.turnId) return
    void this.rpc?.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
  }

  interrupt() {
    const proc = this.proc
    if (!this.busy || this.interrupted) return
    this.interrupted = true
    if (!proc?.alive) return
    this.sendInterrupt()
    // If the turn does not end soon, end the program (the next message starts it again with thread/resume)
    clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => proc.kill(), this.o.interruptGraceMs ?? 5000)
    this.killTimer.unref?.()
  }

  async close() {
    this.closed = true
    clearTimeout(this.killTimer)
    const proc = this.proc
    if (!proc?.alive) return
    // Closing stdin lets Codex finish writing the thread and exit on its own
    proc.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([proc.exit, new Promise<void>((r) => (timer = setTimeout(r, 2000)))])
    clearTimeout(timer)
    proc.kill()
  }
}
