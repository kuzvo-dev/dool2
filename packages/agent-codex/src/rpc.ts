// `codex app-server` stdio JSON-RPC (한 줄에 메시지 하나).
type Json = Record<string, unknown>

export interface RpcTransport {
  send(line: string): void
  lines: AsyncIterable<string>
}

export type NotificationHandler = (method: string, params: Json) => void
/** 서버가 앱에 묻는 요청(승인 등). 응답 result를 돌려준다. */
export type ServerRequestHandler = (method: string, params: Json) => Promise<unknown> | unknown

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export class JsonRpcClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false

  constructor(
    private readonly transport: RpcTransport,
    private readonly onNotification: NotificationHandler,
    private readonly onServerRequest: ServerRequestHandler,
  ) {}

  /** 메시지 읽기를 시작한다. 연결이 끊기면 끝난다. */
  async pump(): Promise<void> {
    for await (const line of this.transport.lines) {
      let msg: Json
      try {
        msg = JSON.parse(line) as Json
      } catch {
        continue
      }
      void this.dispatch(msg)
    }
    this.closed = true
    for (const p of this.pending.values()) p.reject(new RpcError('Codex 연결이 끊겼어요'))
    this.pending.clear()
  }

  private async dispatch(msg: Json) {
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string'
    if (typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Json
      if (!hasId) return this.onNotification(msg.method, params)
      try {
        const result = await this.onServerRequest(msg.method, params)
        this.write({ id: msg.id, result: result ?? {} })
      } catch (err) {
        this.write({ id: msg.id, error: { code: -32000, message: (err as Error).message } })
      }
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as { message?: string; code?: number }
        p.reject(new RpcError(e.message ?? 'Codex 요청 실패', e.code))
      } else p.resolve(msg.result)
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('Codex 연결이 끊겼어요'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params })
  }

  private write(msg: Json) {
    this.transport.send(`${JSON.stringify(msg)}\n`)
  }
}
