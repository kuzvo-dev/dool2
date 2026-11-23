// Pay-as-you-go runner (ADR 0010): runs OpenCode v2 with the user's API key, limited to Dool2 tools.
// Each turn starts `opencode serve --stdio` in a Dool2-only folder (random password, 127.0.0.1)
// and turns its event stream (SSE) into the common AgentEvent. Closing stdin also stops the server.
// Claude Pro/Max subscription sign-in is never used here (Anthropic policy). Subscriptions go only through the official Claude Code.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { type AgentRuntime, runOnce, type TurnInput } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { buildOpenCodeConfig, buildOpenCodeEnv, DOOL2_AGENT, PROVIDER_ENV } from './config.js'
import { OPENCODE_VERSION, openCodeBin } from './install.js'
import { OPENCODE_TEXT } from './locales/opencode.js'
import { type OpenCodeEvent, OpenCodeEventMapper } from './map.js'

export * from './config.js'
export * from './install.js'
export * from './map.js'

/** The provider and model the user picked, and the API key */
export interface OpenCodeAccount {
  provider: string
  model: string
  apiKey: string
}

export interface OpenCodeRuntimeOptions {
  /** Dool2's OpenCode folder (the install and OpenCode's own data) */
  dir: string
  /** The key lives in the OS keychain. Taken out only when running, and passed as an environment variable */
  account(): Promise<OpenCodeAccount | undefined>
  binPath?: string
  /** Language of the status and error messages people see, read each time. Korean when not given */
  lang?: () => Lang
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly id = 'opencode' as const

  constructor(private readonly opts: OpenCodeRuntimeOptions) {}

  private lang(): Lang {
    return this.opts.lang?.() ?? 'ko'
  }

  private bin() {
    const p = this.opts.binPath ?? openCodeBin(this.opts.dir)
    return existsSync(p) ? p : undefined
  }

  async detect(): Promise<AgentStatus> {
    const bin = this.bin()
    const t = OPENCODE_TEXT[this.lang()]
    if (!bin) return { id: 'opencode', installed: false, loggedIn: false, problem: t.notReady }
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
    } else status.problem = t.needKey
    return status
  }

  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const bin = this.bin()
    const t = OPENCODE_TEXT[this.lang()]
    if (!bin) {
      yield { type: 'error', code: 'not_installed', message: t.notReady }
      return
    }
    const account = await this.opts.account().catch(() => undefined)
    if (!account?.apiKey) {
      yield { type: 'error', code: 'not_logged_in', message: t.needKey }
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
          () => reject(new Error(`OpenCode didn't start ${stderr.slice(-200)}`)),
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
          reject(new Error(`OpenCode exited (exit code ${code}) ${stderr.slice(-200)}`)),
        )
      })
      const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      const call = async <T>(path: string, body?: unknown): Promise<T> => {
        const res = await fetch(url + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!res.ok) throw new Error(`OpenCode request failed ${res.status} ${path}`)
        return (await res.json()) as T
      }

      // Open the event stream before sending the request (so the start isn't missed)
      const abort = new AbortController()
      const stream = await fetch(`${url}/api/event`, {
        headers: { authorization: auth },
        signal: abort.signal,
      })
      if (!stream.ok || !stream.body)
        throw new Error(`Couldn't open the OpenCode event stream (${stream.status})`)

      let sessionId = input.resumeId
      if (!sessionId) {
        const created = await call<{ data: { id: string } }>('/api/session', {
          agent: DOOL2_AGENT,
          model: { providerID: account.provider, id: account.model },
        })
        sessionId = created.data.id
      }
      const mapper = new OpenCodeEventMapper(sessionId, this.lang())
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
      if (input.signal?.aborted) yield { type: 'error', code: 'aborted', message: t.stopped }
      else yield { type: 'error', code: 'process_failed', message: (err as Error).message }
    } finally {
      stop()
    }
  }
}

/** Takes event objects one by one out of an SSE body */
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
    // Ends up here when we close the stream
    if ((err as Error).name !== 'AbortError') throw err
  }
}
