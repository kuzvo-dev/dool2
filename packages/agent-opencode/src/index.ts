// 종량제 실행기 (ADR 0010): OpenCode v2를 사용자의 API 키로, 두리 도구만 쓰게 묶어 실행한다.
// 한 턴마다 `opencode serve --stdio`를 두리 전용 폴더에서 띄우고(무작위 비밀번호, 127.0.0.1),
// 사건 흐름(SSE)을 공통 AgentEvent로 바꾼다. 표준 입력을 닫으면 서버도 꺼진다.
// Claude Pro/Max 구독 로그인은 여기서 쓰지 않는다 (Anthropic 정책). 구독은 공식 Claude Code로만.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { type AgentRuntime, runOnce, type TurnInput } from '@dool2/engine'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { buildOpenCodeConfig, buildOpenCodeEnv, DOOL2_AGENT, PROVIDER_ENV } from './config.js'
import { OPENCODE_VERSION, openCodeBin } from './install.js'
import { type OpenCodeEvent, OpenCodeEventMapper } from './map.js'

export * from './config.js'
export * from './install.js'
export * from './map.js'

/** 사용자가 고른 제공자·모델과 API 키 */
export interface OpenCodeAccount {
  provider: string
  model: string
  apiKey: string
}

export interface OpenCodeRuntimeOptions {
  /** 두리의 OpenCode 폴더 (설치 파일과 OpenCode 자체 데이터) */
  dir: string
  /** 키는 OS 키체인에 있다. 실행할 때만 꺼내 환경 변수로 넘긴다 */
  account(): Promise<OpenCodeAccount | undefined>
  binPath?: string
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly id = 'opencode' as const

  constructor(private readonly opts: OpenCodeRuntimeOptions) {}

  private bin() {
    const p = this.opts.binPath ?? openCodeBin(this.opts.dir)
    return existsSync(p) ? p : undefined
  }

  async detect(): Promise<AgentStatus> {
    const bin = this.bin()
    if (!bin)
      return {
        id: 'opencode',
        installed: false,
        loggedIn: false,
        problem: '종량제 모드를 아직 준비하지 않았어요',
      }
    const status: AgentStatus = {
      id: 'opencode',
      installed: true,
      path: bin,
      loggedIn: false,
      version: OPENCODE_VERSION,
    }
    const r = await runOnce(bin, ['--version']).catch(() => undefined)
    const v = r?.stdout.match(/\d+\.\d+\.\d+/)?.[0]
    if (v) status.version = v
    const account = await this.opts.account().catch(() => undefined)
    if (account?.apiKey && PROVIDER_ENV[account.provider]) {
      status.loggedIn = true
      status.plan = `${account.provider} · ${account.model}`
    } else status.problem = 'API 키를 넣어 주세요'
    return status
  }

  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const bin = this.bin()
    if (!bin) {
      yield { type: 'error', code: 'not_installed', message: '종량제 모드를 아직 준비하지 않았어요' }
      return
    }
    const account = await this.opts.account().catch(() => undefined)
    if (!account?.apiKey) {
      yield { type: 'error', code: 'not_logged_in', message: 'API 키를 넣어 주세요' }
      return
    }

    const home = `${this.opts.dir}/home`
    await mkdir(home, { recursive: true })
    const password = randomBytes(24).toString('hex')
    const env = buildOpenCodeEnv({
      home,
      password,
      provider: account.provider,
      apiKey: account.apiKey,
      config: buildOpenCodeConfig({ mcpServers: input.mcpServers, systemPrompt: input.systemPrompt }),
    })
    const child = spawn(bin, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    const stop = () => {
      child.stdin.end()
      setTimeout(() => child.kill(), 3000).unref()
    }

    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(
          () => reject(new Error(`OpenCode가 시작되지 않았어요 ${stderr.slice(-200)}`)),
          30_000,
        )
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString()
          const m = buf.match(/\{[^\n]*"url"[^\n]*\}/)
          if (m) {
            clearTimeout(timer)
            resolve((JSON.parse(m[0]) as { url: string }).url)
          }
        })
        child.once('exit', (code) =>
          reject(new Error(`OpenCode가 꺼졌어요 (종료 코드 ${code}) ${stderr.slice(-200)}`)),
        )
      })
      const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      const call = async <T>(path: string, body?: unknown): Promise<T> => {
        const res = await fetch(url + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!res.ok) throw new Error(`OpenCode 요청 실패 ${res.status} ${path}`)
        return (await res.json()) as T
      }

      // 사건 흐름을 먼저 열어 두고 부탁을 보낸다 (앞부분을 놓치지 않게)
      const abort = new AbortController()
      const stream = await fetch(`${url}/api/event`, {
        headers: { authorization: auth },
        signal: abort.signal,
      })
      if (!stream.ok || !stream.body) throw new Error(`OpenCode 사건 흐름을 열지 못했어요 (${stream.status})`)

      let sessionId = input.resumeId
      if (!sessionId) {
        const created = await call<{ data: { id: string } }>('/api/session', {
          agent: DOOL2_AGENT,
          model: { providerID: account.provider, id: account.model },
        })
        sessionId = created.data.id
      }
      const mapper = new OpenCodeEventMapper(sessionId)
      const onAbort = () => void call(`/api/session/${sessionId}/interrupt`, {}).catch(() => {})
      input.signal?.addEventListener('abort', onAbort, { once: true })
      await call(`/api/session/${sessionId}/prompt`, { text: input.text })

      try {
        for await (const ev of readSse(stream.body)) {
          const r = mapper.map(ev)
          for (const e of r.events) yield e
          if (r.abort) onAbort()
          if (r.finished) break
        }
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        abort.abort()
      }
    } catch (err) {
      if (input.signal?.aborted) yield { type: 'error', code: 'aborted', message: '멈췄어요' }
      else yield { type: 'error', code: 'process_failed', message: (err as Error).message }
    } finally {
      stop()
    }
  }
}

/** SSE 본문을 사건 객체로 하나씩 꺼낸다 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<OpenCodeEvent> {
  const dec = new TextDecoder()
  let buf = ''
  try {
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true })
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!data) continue
        try {
          yield JSON.parse(data) as OpenCodeEvent
        } catch {}
      }
    }
  } catch (err) {
    // 우리가 흐름을 닫으면 여기로 온다
    if ((err as Error).name !== 'AbortError') throw err
  }
}
