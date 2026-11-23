// Codex adapter (docs/architecture.md 3.3).
// Runs the pinned Codex version shipped with Dool2 as `codex app-server` (stdio JSON-RPC).
// CODEX_HOME is a Dool2-only folder so it never mixes with the user's own Codex settings.
// Shell and web search are off, inside a read-only sandbox. It doesn't start without Dool2 tools (MCP).
// TODO(M3): switch sign-in to OpenAI "Sign in with ChatGPT" (the open-source app path). M0 uses `codex login`.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { type AgentRuntime, type McpServerSpec, runOnce, type TurnInput } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { resolveBundledCodex } from './bin.js'
import { downloadedCodexBin } from './download.js'
import { CODEX_TEXT } from './locales/codex.js'
import { CodexEventMapper, rateLimitEvents } from './map.js'
import { JsonRpcClient } from './rpc.js'

export { CODEX_VERSION, resolveBundledCodex } from './bin.js'
export * from './download.js'
export { CodexEventMapper } from './map.js'
export { JsonRpcClient } from './rpc.js'

const toml = (v: unknown) => JSON.stringify(v)

/** Arguments for `codex app-server`. A pure function, pinned by tests. */
export function buildCodexArgs(mcpServers: McpServerSpec[]): string[] {
  const args = [
    'app-server',
    // Turn off the shell command tool
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
    // Fail the thread start itself if the Dool2 tools can't start
    args.push('-c', `${base}.required=true`)
    for (const [k, v] of Object.entries(s.env ?? {})) args.push('-c', `${base}.env.${k}=${toml(v)}`)
  }
  return args
}

export interface CodexRuntimeOptions {
  /** Dool2-only CODEX_HOME (sign-in, settings and sessions live here) */
  codexHome: string
  /** When not given: the copy downloaded on first use (installDir), then the pinned version in node_modules during development */
  binPath?: string
  /** Folder Codex is downloaded to on first use (download.ts) */
  installDir?: string
  /** Language of the status and error messages people see, read each time. Korean when not given */
  lang?: () => Lang
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const
  private resolved: string | undefined

  constructor(private readonly opts: CodexRuntimeOptions) {}

  private lang(): Lang {
    return this.opts.lang?.() ?? 'ko'
  }

  private async bin() {
    // Never use another codex version from the user's PATH (only the pinned one, since the app-server protocol changes)
    if (this.resolved) return this.resolved
    const downloaded = this.opts.installDir ? downloadedCodexBin(this.opts.installDir) : undefined
    this.resolved =
      this.opts.binPath ??
      (downloaded && existsSync(downloaded) ? downloaded : undefined) ??
      resolveBundledCodex()
    return this.resolved
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, CODEX_HOME: this.opts.codexHome }
  }

  async detect(): Promise<AgentStatus> {
    const path = await this.bin()
    const t = CODEX_TEXT[this.lang()]
    if (!path) return { id: 'codex', installed: false, loggedIn: false, problem: t.notDownloaded }
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
      if (!status.loggedIn) status.problem = t.needLogin
    } catch (err) {
      status.problem = t.statusFailed((err as Error).message)
    }
    return status
  }

  /** Opens the official sign-in flow (an OpenAI sign-in window in the browser). Returns the exit code when done. */
  async login(): Promise<number | null> {
    const path = await this.bin()
    if (!path) throw new Error(CODEX_TEXT[this.lang()].notFound)
    await mkdir(this.opts.codexHome, { recursive: true })
    const r = await runOnce(path, ['login'], { env: this.env(), timeoutMs: 10 * 60_000 })
    return r.code
  }

  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const path = await this.bin()
    if (!path) {
      yield { type: 'error', code: 'not_installed', message: CODEX_TEXT[this.lang()].notFound }
      return
    }
    const t = CODEX_TEXT[this.lang()]
    await mkdir(this.opts.codexHome, { recursive: true })
    // Check sign-in first, since Codex takes a long time retrying when signed out
    const login = await runOnce(path, ['login', 'status'], { env: this.env() }).catch(() => undefined)
    if (login && (login.code !== 0 || /not logged in/i.test(login.stdout + login.stderr))) {
      yield {
        type: 'error',
        code: 'not_logged_in',
        message: t.loginFirst,
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

    // Collect notifications into the event queue
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
      // Shell and files are off, so every approval request except for Dool2 tools is declined
      (method, params) => {
        if (method === 'mcpServer/elicitation/request' && params.serverName === 'dool2')
          return { action: 'accept', content: null }
        if (method.endsWith('requestApproval')) return { decision: 'decline' }
        throw new Error(`Request not handled by Dool2: ${method}`)
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
        clientInfo: { name: 'dool2', title: 'Dool2', version: '0.0.0' },
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
      mapper = new CodexEventMapper(threadId, this.lang())
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
      if (input.signal?.aborted) yield { type: 'error', code: 'aborted', message: t.stopped }
      else {
        const msg = (err as Error).message
        const notLoggedIn = /auth|login|unauthorized/i.test(msg + stderrTail)
        yield notLoggedIn
          ? {
              type: 'error',
              code: 'not_logged_in',
              message: t.loginAgain,
            }
          : { type: 'error', code: 'process_failed', message: t.unfinished(msg) }
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
