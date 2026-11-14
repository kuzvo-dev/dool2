// Codex 어댑터 (docs/architecture.md 3.3).
// 두리와 함께 배포하는 고정 버전 Codex를 `codex app-server`(stdio JSON-RPC)로 돌린다.
// CODEX_HOME을 두리 전용 폴더로 분리해 사용자 개인 Codex 설정과 섞지 않는다.
// 셸·웹 검색을 끄고 읽기 전용 샌드박스로 묶는다. 두리 도구(MCP)가 없으면 시작하지 않는다.
// TODO(M3): 로그인은 OpenAI "Sign in with ChatGPT"(오픈소스 앱 경로)로 바꾼다. M0은 `codex login`을 쓴다.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { type AgentRuntime, findExecutable, type McpServerSpec, runOnce, type TurnInput } from '@dool2/engine'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { resolveBundledCodex } from './bin.js'
import { CodexEventMapper, rateLimitEvents } from './map.js'
import { JsonRpcClient } from './rpc.js'

export { CODEX_VERSION, resolveBundledCodex } from './bin.js'
export { CodexEventMapper } from './map.js'
export { JsonRpcClient } from './rpc.js'

const toml = (v: unknown) => JSON.stringify(v)

/** `codex app-server` 실행 인자. 순수 함수라 테스트로 고정한다. */
export function buildCodexArgs(mcpServers: McpServerSpec[]): string[] {
  const args = [
    'app-server',
    // 셸 명령 도구를 끈다
    '-c',
    'features.shell_tool=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'approval_policy="never"',
  ]
  for (const s of mcpServers) {
    const base = `mcp_servers.${s.name}`
    args.push('-c', `${base}.command=${toml(s.command)}`, '-c', `${base}.args=${toml(s.args)}`)
    // 두리 도구가 뜨지 못하면 스레드 시작 자체를 실패시킨다
    args.push('-c', `${base}.required=true`)
    for (const [k, v] of Object.entries(s.env ?? {})) args.push('-c', `${base}.env.${k}=${toml(v)}`)
  }
  return args
}

export interface CodexRuntimeOptions {
  /** 두리 전용 CODEX_HOME (로그인·설정·세션이 여기에 남는다) */
  codexHome: string
  /** 지정하지 않으면 함께 설치된 고정 버전 → PATH 순서로 찾는다 */
  binPath?: string
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const
  private resolved: string | undefined

  constructor(private readonly opts: CodexRuntimeOptions) {}

  private async bin() {
    this.resolved ??= this.opts.binPath ?? resolveBundledCodex() ?? (await findExecutable('codex'))
    return this.resolved
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, CODEX_HOME: this.opts.codexHome }
  }

  async detect(): Promise<AgentStatus> {
    const path = await this.bin()
    if (!path) return { id: 'codex', installed: false, loggedIn: false, problem: 'Codex를 찾지 못했어요' }
    await mkdir(this.opts.codexHome, { recursive: true })
    const status: AgentStatus = { id: 'codex', installed: true, path, loggedIn: false }
    try {
      const v = await runOnce(path, ['--version'], { env: this.env() })
      const m = v.stdout.match(/\d+\.\d+\.\d+/)
      if (m) status.version = m[0]
      const s = await runOnce(path, ['login', 'status'], { env: this.env() })
      const out = `${s.stdout}\n${s.stderr}`
      status.loggedIn = s.code === 0 && !/not logged in/i.test(out)
      if (/chatgpt/i.test(out)) status.plan = 'chatgpt'
      if (!status.loggedIn) status.problem = 'ChatGPT 로그인이 필요해요'
    } catch (err) {
      status.problem = `Codex 상태를 확인하지 못했어요: ${(err as Error).message}`
    }
    return status
  }

  /** 공식 로그인 흐름을 연다 (브라우저에 OpenAI 로그인 창). 끝나면 종료 코드를 돌려준다. */
  async login(): Promise<number | null> {
    const path = await this.bin()
    if (!path) throw new Error('Codex를 찾지 못했어요')
    await mkdir(this.opts.codexHome, { recursive: true })
    const r = await runOnce(path, ['login'], { env: this.env(), timeoutMs: 10 * 60_000 })
    return r.code
  }

  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const path = await this.bin()
    if (!path) {
      yield { type: 'error', code: 'not_installed', message: 'Codex를 찾지 못했어요' }
      return
    }
    await mkdir(this.opts.codexHome, { recursive: true })
    // 로그인이 안 돼 있으면 Codex가 재시도하느라 오래 걸리므로 먼저 확인한다
    const login = await runOnce(path, ['login', 'status'], { env: this.env() }).catch(() => undefined)
    if (login && (login.code !== 0 || /not logged in/i.test(login.stdout + login.stderr))) {
      yield {
        type: 'error',
        code: 'not_logged_in',
        message: 'ChatGPT 로그인이 필요해요. PC에서 로그인해 주세요.',
      }
      return
    }

    const child = spawn(path, buildCodexArgs(input.mcpServers), {
      cwd: input.cwd,
      env: this.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderrTail = ''
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-4000)
    })
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', resolve)
      child.on('error', () => resolve(-1))
    })

    // 알림을 이벤트 큐로 모은다
    const queue: AgentEvent[] = []
    let wake: (() => void) | undefined
    let finished = false
    let mapper: CodexEventMapper | undefined
    const push = (evs: AgentEvent[]) => {
      queue.push(...evs)
      wake?.()
    }

    const rpc = new JsonRpcClient(
      {
        send: (line) => child.stdin.write(line),
        lines: readLines(child.stdout),
      },
      (method, params) => {
        if (method === 'account/rateLimits/updated' && !mapper)
          return push(rateLimitEvents(params.rateLimits))
        if (!mapper) return
        const r = mapper.map(method, params)
        push(r.events)
        if (r.abort || r.finished) {
          finished = true
          if (r.abort) child.kill()
          wake?.()
        }
      },
      // 셸·파일은 꺼 두었으므로 승인 요청은 두리 도구 외에는 모두 거절한다
      (method, params) => {
        if (method === 'mcpServer/elicitation/request' && params.serverName === 'dool2')
          return { action: 'accept', content: null }
        if (method.endsWith('requestApproval')) return { decision: 'decline' }
        throw new Error(`두리가 처리하지 않는 요청이에요: ${method}`)
      },
    )
    const pumping = rpc.pump().then(() => {
      finished = true
      wake?.()
    })

    const onAbort = () => child.kill()
    input.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'dool2', title: '두리', version: '0.0.0' },
        capabilities: null,
      })
      rpc.notify('initialized')

      const threadParams = {
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: input.systemPrompt,
      }
      const started = input.resumeId
        ? await rpc.request<{ thread: { id: string } }>('thread/resume', {
            threadId: input.resumeId,
            ...threadParams,
          })
        : await rpc.request<{ thread: { id: string }; model?: string }>('thread/start', threadParams)
      const threadId = started.thread.id
      mapper = new CodexEventMapper(threadId)
      yield { type: 'started', resumeId: threadId, tools: input.mcpServers.map((s) => `mcp__${s.name}__*`) }

      await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      })

      while (true) {
        while (queue.length) {
          const ev = queue.shift() as AgentEvent
          yield ev
        }
        if (finished) break
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
      while (queue.length) yield queue.shift() as AgentEvent
    } catch (err) {
      if (input.signal?.aborted) yield { type: 'error', code: 'aborted', message: '멈췄어요' }
      else {
        const msg = (err as Error).message
        const notLoggedIn = /auth|login|unauthorized/i.test(msg + stderrTail)
        yield notLoggedIn
          ? {
              type: 'error',
              code: 'not_logged_in',
              message: 'ChatGPT 로그인이 필요해요. PC에서 다시 로그인해 주세요.',
            }
          : { type: 'error', code: 'process_failed', message: `Codex가 일을 끝내지 못했어요: ${msg}` }
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      child.stdin.end()
      child.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))])
      await Promise.race([pumping, new Promise((r) => setTimeout(r, 100))])
    }
  }
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buf = ''
  stream.setEncoding('utf8')
  for await (const chunk of stream as AsyncIterable<string>) {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.trim()) yield line
      nl = buf.indexOf('\n')
    }
  }
  if (buf.trim()) yield buf
}
