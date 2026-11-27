// A minimal DevTools protocol client over Chromium's pipe (--remote-debugging-pipe, ADR 0046).
// The browser reads commands on its fd 3 and writes answers and events on its fd 4; each message is one JSON text
// ended by a NUL byte. No port is opened, so nothing else on the PC can drive Dool2's browser.
// Page sessions are "flat": one pipe, and each message names its sessionId.
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: string }
  sessionId?: string
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

/** Splits NUL-ended messages out of a byte stream */
export class NulSplitter {
  private parts: Buffer[] = []

  push(chunk: Buffer, onMessage: (text: string) => void) {
    let from = 0
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, from)) {
      this.parts.push(chunk.subarray(from, i))
      onMessage(Buffer.concat(this.parts).toString('utf8'))
      this.parts = []
      from = i + 1
    }
    if (from < chunk.length) this.parts.push(chunk.subarray(from))
  }
}

export interface CdpPipeOptions {
  /** Default time a command may take before it fails (ms) */
  timeoutMs?: number
}

/**
 * The client: send(method, params, sessionId) answers with the result; events come out as
 * on('event', (method, params, sessionId)). Closing the pipe fails every command still waiting
 */
export class CdpPipe extends EventEmitter {
  private nextId = 0
  private readonly waiting = new Map<
    number,
    {
      method: string
      resolve: (r: Record<string, unknown>) => void
      reject: (e: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private closedWith: Error | undefined

  constructor(
    private readonly out: Writable,
    input: Readable,
    private readonly opts: CdpPipeOptions = {},
  ) {
    super()
    const split = new NulSplitter()
    input.on('data', (chunk: Buffer) => split.push(chunk, (text) => this.receive(text)))
    input.on('close', () => this.fail(new Error('The browser closed its DevTools pipe')))
    input.on('error', (err) => this.fail(err))
    out.on('error', (err) => this.fail(err))
  }

  get closed() {
    return this.closedWith !== undefined
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = this.opts.timeoutMs ?? 30_000,
  ): Promise<T> {
    if (this.closedWith) return Promise.reject(new CdpError(this.closedWith.message, method))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CdpError(`${method} did not answer within ${timeoutMs} ms`, method))
      }, timeoutMs)
      timer.unref?.()
      this.waiting.set(id, {
        method,
        resolve: resolve as (r: Record<string, unknown>) => void,
        reject,
        timer,
      })
      const msg: CdpMessage = { id, method, params, ...(sessionId ? { sessionId } : {}) }
      this.out.write(`${JSON.stringify(msg)}\0`)
    })
  }

  /** Waits for one event (optionally of one session and matching a test); rejects after timeoutMs */
  waitFor(
    method: string,
    opts: {
      sessionId?: string
      timeoutMs?: number
      test?: (params: Record<string, unknown>) => boolean
    } = {},
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const on = (m: string, params: Record<string, unknown>, sessionId?: string) => {
        if (m !== method || (opts.sessionId && sessionId !== opts.sessionId)) return
        if (opts.test && !opts.test(params)) return
        done()
        resolve(params)
      }
      const closed = () => {
        done()
        reject(new CdpError('The browser closed its DevTools pipe', method))
      }
      const timer = setTimeout(() => {
        done()
        reject(new CdpError(`No ${method} within ${opts.timeoutMs ?? 30_000} ms`, method))
      }, opts.timeoutMs ?? 30_000)
      timer.unref?.()
      const done = () => {
        clearTimeout(timer)
        this.off('event', on)
        this.off('close', closed)
      }
      this.on('event', on)
      this.once('close', closed)
    })
  }

  private receive(text: string) {
    let msg: CdpMessage
    try {
      msg = JSON.parse(text) as CdpMessage
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      clearTimeout(w.timer)
      if (msg.error) w.reject(new CdpError(msg.error.message, w.method, msg.error.code))
      else w.resolve(msg.result ?? {})
      return
    }
    if (msg.method) this.emit('event', msg.method, msg.params ?? {}, msg.sessionId)
  }

  private fail(err: Error) {
    if (this.closedWith) return
    this.closedWith = err
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer)
      w.reject(new CdpError(err.message, w.method))
      this.waiting.delete(id)
    }
    this.emit('close', err)
  }
}
