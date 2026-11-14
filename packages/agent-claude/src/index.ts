// Claude Code 어댑터.
// 원칙 (ADR 0002): 사용자가 설치한 공식 `claude`를 수정 없이 실행만 한다.
// 로그인도 공식 `claude auth login`이 하고, 두리는 토큰을 읽거나 저장하지 않는다 (login.ts).
// 내장 도구는 모두 끄고 두리 MCP 도구만 쓰게 한다 (ADR 0003).

import { type AgentRuntime, findExecutable, runOnce, spawnLines, type TurnInput } from '@dool2/engine'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { ClaudeInstall } from './install.js'
import { ClaudeLogin, type ClaudeLoginOptions } from './login.js'

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

/** `claude -p` 인자. 순수 함수라 테스트로 고정한다. */
export function buildClaudeArgs(
  input: Pick<TurnInput, 'resumeId' | 'systemPrompt' | 'mcpServers'>,
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
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // 셸·파일·웹 등 내장 도구를 전부 끈다. 두리 도구(MCP)만 남는다.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--allowedTools',
    `${DOOL2_TOOL_PREFIX}*`,
    // 사용자·프로젝트 설정(훅, 다른 MCP 등)을 읽지 않는다
    '--setting-sources',
    '',
    '--append-system-prompt',
    input.systemPrompt,
  ]
  if (input.resumeId) args.push('--resume', input.resumeId)
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

  /** binPath를 주면 그 실행 파일을 쓴다 (테스트·고급 설정용) */
  constructor(private readonly opts: { binPath?: string } = {}) {}

  private async bin() {
    this.resolvedPath ??= this.opts.binPath ?? (await findExecutable('claude'))
    return this.resolvedPath
  }

  async detect(): Promise<AgentStatus> {
    const path = await this.bin()
    if (!path) {
      return { id: 'claude', installed: false, loggedIn: false, problem: 'Claude Code가 설치돼 있지 않아요' }
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
      if (!status.loggedIn) status.problem = 'Claude 로그인이 필요해요'
    } catch (err) {
      status.problem = `Claude Code 상태를 확인하지 못했어요: ${(err as Error).message}`
    }
    return status
  }

  /** 로그인 버튼용 세션을 만든다. 설치돼 있지 않으면 undefined */
  async createLogin(opts: Partial<ClaudeLoginOptions> = {}): Promise<ClaudeLogin | undefined> {
    const bin = await this.bin()
    if (!bin) return undefined
    return new ClaudeLogin({ bin, isLoggedIn: async () => (await this.detect()).loggedIn, ...opts })
  }

  /** 설치 버튼용 세션을 만든다. 설치가 끝나면 실행 파일을 다시 찾는다 */
  createInstall(downloadDir: string): ClaudeInstall {
    return new ClaudeInstall({
      downloadDir,
      verify: async () => {
        this.resolvedPath = this.opts.binPath ?? (await findExecutable('claude'))
        return Boolean(this.resolvedPath)
      },
    })
  }

  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const path = await this.bin()
    if (!path) {
      yield { type: 'error', code: 'not_installed', message: 'Claude Code가 설치돼 있지 않아요' }
      return
    }
    const proc = spawnLines(path, buildClaudeArgs(input), {
      cwd: input.cwd,
      stdin: input.text,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const parser = new ClaudeStreamParser()
    let finished = false
    for await (const line of proc.lines) {
      for (const ev of parser.push(line)) {
        yield ev
        if (ev.type === 'error' && ev.code === 'tools_unsafe') {
          proc.kill()
          return
        }
        if (ev.type === 'done' || ev.type === 'error') finished = true
      }
    }
    const { code, stderrTail } = await proc.exit
    if (input.signal?.aborted) {
      yield { type: 'error', code: 'aborted', message: '멈췄어요' }
      return
    }
    if (!finished) {
      yield {
        type: 'error',
        code: 'process_failed',
        message: `Claude Code가 중간에 멈췄어요 (종료 코드 ${code})${stderrTail ? `: ${stderrTail.trim().slice(-200)}` : ''}`,
      }
    }
  }
}
