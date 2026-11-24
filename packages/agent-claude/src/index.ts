// Claude Code adapter.
// Principle (ADR 0002): only run the official `claude` the user installed, unmodified.
// Sign-in is done by the official `claude auth login` too, and Dool2 never reads or stores tokens (login.ts).
// All built-in tools are turned off so only Dool2's MCP tools are used (ADR 0003).

import {
  type AgentRuntime,
  findExecutable,
  runOnce,
  type SessionInput,
  spawnLines,
  type TurnInput,
} from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { ClaudeInstall } from './install.js'
import { CLAUDE_TEXT } from './locales/claude.js'
import { ClaudeLogin, type ClaudeLoginOptions } from './login.js'
import { ClaudeSession } from './session.js'

export {
  CLAUDE_DOWNLOAD_BASE,
  ClaudeInstall,
  claudePlatform,
  type InstallClaudeOptions,
  InstallError,
  installClaudeCode,
} from './install.js'

import { ClaudeStreamParser, DOOL2_TOOL_PREFIX } from './parse.js'

export { ClaudeLogin, type ClaudeLoginOptions, type LoginChild, loginEnv, type SpawnLogin } from './login.js'
export { ClaudeStreamParser, DOOL2_TOOL_PREFIX } from './parse.js'
export {
  ClaudeSession,
  type ClaudeSessionOptions,
  interruptLine,
  type SpawnStream,
  userLine,
} from './session.js'

/** Default model Dool2 uses with Claude Code */
export const CLAUDE_DEFAULT_MODEL = 'sonnet'

/**
 * Arguments for `claude -p`. A pure function, pinned by tests.
 * stream: a resident session (ADR 0035) that takes one JSON line per message on stdin instead of one text and exit
 */
export function buildClaudeArgs(
  input: Pick<TurnInput, 'resumeId' | 'systemPrompt' | 'mcpServers' | 'model' | 'fork'>,
  o: { stream?: boolean } = {},
): string[] {
  const mcpConfig = {
    mcpServers: Object.fromEntries(
      input.mcpServers.map((s) => [
        s.name,
        { type: 'stdio', command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) },
      ]),
    ),
  }
  const args = [
    '-p',
    '--input-format',
    o.stream ? 'stream-json' : 'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Turn off every built-in tool (shell, files, web...). Only Dool2 tools (MCP) remain.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--allowedTools',
    `${DOOL2_TOOL_PREFIX}*`,
    // Don't read user or project settings (hooks, other MCP servers...)
    '--setting-sources',
    '',
    '--append-system-prompt',
    input.systemPrompt,
    // Sonnet by default: fast and smart enough (the user can change it in settings)
    '--model',
    input.model || CLAUDE_DEFAULT_MODEL,
  ]
  if (input.resumeId) args.push('--resume', input.resumeId)
  if (input.resumeId && input.fork) args.push('--fork-session')
  return args
}

interface AuthStatus {
  loggedIn?: boolean
  authMethod?: string
  subscriptionType?: string
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude' as const
  private resolvedPath: string | undefined

  /**
   * binPath: use that executable (tests, advanced settings).
   * lang: language of the status and error messages people see, read each time. Korean when not given
   */
  constructor(private readonly opts: { binPath?: string; lang?: () => Lang } = {}) {}

  private lang(): Lang {
    return this.opts.lang?.() ?? 'ko'
  }

  private async bin() {
    this.resolvedPath ??= this.opts.binPath ?? (await findExecutable('claude'))
    return this.resolvedPath
  }

  async detect(): Promise<AgentStatus> {
    const path = await this.bin()
    const t = CLAUDE_TEXT[this.lang()]
    if (!path) {
      return { id: 'claude', installed: false, loggedIn: false, problem: t.notInstalled }
    }
    const status: AgentStatus = { id: 'claude', installed: true, path, loggedIn: false }
    try {
      const v = await runOnce(path, ['--version'])
      const m = v.stdout.match(/\d+\.\d+\.\d+/)
      if (m) status.version = m[0]
      const a = await runOnce(path, ['auth', 'status'])
      const auth = JSON.parse(a.stdout || '{}') as AuthStatus
      status.loggedIn = auth.loggedIn === true && auth.authMethod !== 'none'
      if (auth.subscriptionType) status.plan = auth.subscriptionType
      if (!status.loggedIn) status.problem = t.needLogin
    } catch (err) {
      status.problem = t.statusFailed((err as Error).message)
    }
    return status
  }

  /** Makes a session for the sign-in button. Undefined when not installed */
  async createLogin(opts: Partial<ClaudeLoginOptions> = {}): Promise<ClaudeLogin | undefined> {
    const bin = await this.bin()
    if (!bin) return undefined
    return new ClaudeLogin({
      bin,
      isLoggedIn: async () => (await this.detect()).loggedIn,
      lang: this.lang(),
      ...opts,
    })
  }

  /** Makes a session for the install button. Looks for the executable again after installing */
  createInstall(downloadDir: string): ClaudeInstall {
    return new ClaudeInstall({
      downloadDir,
      lang: this.lang(),
      verify: async () => {
        this.resolvedPath = this.opts.binPath ?? (await findExecutable('claude'))
        return Boolean(this.resolvedPath)
      },
    })
  }

  /**
   * A resident session (ADR 0035): the program starts now, so it and the Dool2 tool server are up when the first
   * message comes. Undefined when Claude Code is not installed (runTurn tells the user)
   */
  async openSession(input: SessionInput): Promise<ClaudeSession | undefined> {
    const bin = await this.bin()
    if (!bin) return undefined
    const session = new ClaudeSession({
      bin,
      input,
      lang: this.lang(),
      args: (resumeId) => buildClaudeArgs({ ...input, ...(resumeId ? { resumeId } : {}) }, { stream: true }),
    })
    session.start()
    return session
  }

  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const path = await this.bin()
    if (!path) {
      yield { type: 'error', code: 'not_installed', message: CLAUDE_TEXT[this.lang()].notInstalled }
      return
    }
    // If the Dool2 tool server (MCP) isn't attached at start (it comes up late when the PC is busy), the reply has no tools:
    // it got "No such tool" and ended with "the tools won't load" (seen 11-21, once every few turns).
    // If the start event lists no Dool2 tool, drop that run and start once more after a short wait
    for (let attempt = 0; ; attempt++) {
      const retry = yield* this.runOnce(path, input, attempt < 2)
      if (!retry) return
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }

  /** One run. Returns true without emitting anything if it started without Dool2 tools and may retry */
  private async *runOnce(
    path: string,
    input: TurnInput,
    canRetry: boolean,
  ): AsyncGenerator<AgentEvent, boolean> {
    const proc = spawnLines(path, buildClaudeArgs(input), {
      cwd: input.cwd,
      stdin: input.text,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const t = CLAUDE_TEXT[this.lang()]
    const parser = new ClaudeStreamParser(this.lang())
    let finished = false
    for await (const line of proc.lines) {
      for (const ev of parser.push(line)) {
        if (
          ev.type === 'started' &&
          canRetry &&
          input.mcpServers.length > 0 &&
          !ev.tools.some((t) => t.startsWith(DOOL2_TOOL_PREFIX))
        ) {
          proc.kill()
          await proc.exit.catch(() => undefined)
          return true
        }
        yield ev
        if (ev.type === 'error' && ev.code === 'tools_unsafe') {
          proc.kill()
          return false
        }
        if (ev.type === 'done' || ev.type === 'error') finished = true
      }
    }
    const { code, stderrTail } = await proc.exit
    if (input.signal?.aborted) {
      yield { type: 'error', code: 'aborted', message: t.stopped }
      return false
    }
    if (!finished) {
      yield {
        type: 'error',
        code: 'process_failed',
        message: t.crashed(code, stderrTail ? stderrTail.trim().slice(-200) : ''),
      }
    }
    return false
  }
}
