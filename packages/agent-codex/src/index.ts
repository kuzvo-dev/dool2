// Codex adapter (docs/architecture.md 3.3).
// Runs the pinned Codex version shipped with Dool2 as `codex app-server` (stdio JSON-RPC).
// CODEX_HOME is a Dool2-only folder so it never mixes with the user's own Codex settings.
// Shell and web search are off, inside a read-only sandbox. It doesn't start without Dool2 tools (MCP).
// TODO(M3): switch sign-in to OpenAI "Sign in with ChatGPT" (the open-source app path). M0 uses `codex login`.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import {
  type AgentRuntime,
  type McpServerSpec,
  runOnce,
  type SessionInput,
  type TurnInput,
} from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { AgentEvent, AgentStatus } from '@dool2/protocol'
import { resolveBundledCodex } from './bin.js'
import { writeOnlyDool2Catalog } from './catalog.js'
import { downloadedCodexBin } from './download.js'
import { CODEX_TEXT } from './locales/codex.js'
import { CodexSession, type SpawnCodex } from './session.js'

export { CODEX_VERSION, resolveBundledCodex } from './bin.js'
export { CATALOG_FILE, onlyDool2Catalog, writeOnlyDool2Catalog } from './catalog.js'
export * from './download.js'
export { CodexEventMapper } from './map.js'
export { JsonRpcClient } from './rpc.js'
export { CodexSession, type CodexSessionOptions, knownModel, type SpawnCodex } from './session.js'

const toml = (v: unknown) => JSON.stringify(v)

/**
 * Settings that leave Codex's own context out of a side job (checked on 0.169.0 with `codex debug prompt-input`: the
 * permission, environment, apps and collaboration-mode notes go; keys Codex does not know are warned about, so only
 * known ones are here). The side job's instructions replace Codex's own (`baseInstructions` of `thread/start`)
 */
export const SIDE_JOB_CONFIG = [
  'include_permissions_instructions=false',
  'include_environment_context=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
]

/**
 * Codex's own tools that are not shell, files or web, turned off for every thread (ADR 0003): a sub-agent works on its
 * own thread outside Dool2's work log; goals, the sleep timer, the image viewer (it reads any picture file on the PC)
 * and asking the user through Codex are not Dool2 tools. Checked on the pinned 0.169.0: the model is offered none of
 * them (fixtures/app-server-tools-0.169.0.json). The JavaScript tool and the per-model sub-agent tools go with Dool2's
 * model catalog (catalog.ts)
 */
export const ONLY_DOOL2_CONFIG = [
  'features.multi_agent=false',
  'features.multi_agent_v2.disable_native_tools=true',
  'features.goals=false',
  'features.sleep_tool=false',
  'features.view_image=false',
  'tools.experimental_request_user_input={enabled=false}',
]

/**
 * Arguments for `codex app-server`. A pure function, pinned by tests. sideJob: a tool-less side job (no MCP servers).
 * catalog: Dool2's model catalog (writeOnlyDool2Catalog), which the runtime always passes
 */
export function buildCodexArgs(
  mcpServers: McpServerSpec[],
  o: { sideJob?: boolean; catalog?: string } = {},
): string[] {
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
  for (const c of ONLY_DOOL2_CONFIG) args.push('-c', c)
  if (o.catalog) args.push('-c', `model_catalog_json=${toml(o.catalog)}`)
  if (o.sideJob) for (const c of SIDE_JOB_CONFIG) args.push('-c', c)
  for (const s of mcpServers) {
    const base = `mcp_servers.${s.name}`
    args.push('-c', `${base}.command=${toml(s.command)}`, '-c', `${base}.args=${toml(s.args)}`)
    // Fail the thread start itself if the Dool2 tools can't start
    args.push('-c', `${base}.required=true`)
    // Dool2 tools run without Codex's own approval step: Dool2 asks the person itself (approval cards, the phone
    // signature). Under approval_policy "never" Codex otherwise fails every call it would have asked about with
    // "MCP tool call requires approval" (checked on 0.169.0, fixtures/app-server-tool-approval.jsonl)
    args.push('-c', `${base}.default_tools_approval_mode="approve"`)
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
  /** For tests: starts the program (a fake app-server) */
  spawn?: SpawnCodex
  /** For tests: writes Dool2's model catalog and returns its path (writeOnlyDool2Catalog) */
  catalog?: (bin: string) => Promise<string>
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const
  private resolved: string | undefined
  /** Dool2's model catalog, written once per run of Dool2 (tried again after a failure) */
  private catalogPath: Promise<string> | undefined

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

  /** Whether Codex is signed in. Checked first, since Codex takes a long time retrying when signed out */
  private async signedIn(path: string): Promise<boolean> {
    const login = await runOnce(path, ['login', 'status'], { env: this.env() }).catch(() => undefined)
    return !(login && (login.code !== 0 || /not logged in/i.test(login.stdout + login.stderr)))
  }

  /**
   * Dool2's model catalog (no JavaScript tool, no sub-agents). Undefined when it cannot be written: Codex is then not
   * started at all, since its own catalog would offer those tools (fail closed)
   */
  private async catalog(path: string): Promise<string | undefined> {
    if (!this.catalogPath) {
      const write =
        this.opts.catalog ?? ((bin) => writeOnlyDool2Catalog(bin, this.opts.codexHome, this.env()))
      this.catalogPath = write(path)
      this.catalogPath.catch(() => {
        this.catalogPath = undefined
      })
    }
    return this.catalogPath.catch(() => undefined)
  }

  private session(
    path: string,
    catalog: string,
    input: SessionInput,
    sideJob = false,
    fork = false,
  ): CodexSession {
    return new CodexSession({
      ...(fork ? { fork } : {}),
      bin: path,
      args: buildCodexArgs(sideJob ? [] : input.mcpServers, { sideJob, catalog }),
      env: this.env(),
      input,
      sideJob,
      lang: this.lang(),
      ...(this.opts.spawn ? { spawn: this.opts.spawn } : {}),
    })
  }

  /**
   * A resident session (ADR 0035): `codex app-server`, its Dool2 tool server and the thread start now, so they are up
   * when the first message comes. Undefined when Codex is missing or signed out (runTurn tells the user)
   */
  async openSession(input: SessionInput): Promise<CodexSession | undefined> {
    const path = await this.bin()
    if (!path) return undefined
    await mkdir(this.opts.codexHome, { recursive: true })
    if (!(await this.signedIn(path))) return undefined
    // Without Dool2's catalog there is no session; runTurn then says why
    const catalog = await this.catalog(path)
    if (!catalog) return undefined
    const session = this.session(path, catalog, input)
    session.start().catch(() => {})
    return session
  }

  /** One message in a fresh program: the same session class, opened for one turn and closed */
  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    const path = await this.bin()
    if (!path) {
      yield { type: 'error', code: 'not_installed', message: CODEX_TEXT[this.lang()].notFound }
      return
    }
    await mkdir(this.opts.codexHome, { recursive: true })
    if (!(await this.signedIn(path))) {
      yield { type: 'error', code: 'not_logged_in', message: CODEX_TEXT[this.lang()].loginFirst }
      return
    }
    const catalog = await this.catalog(path)
    if (!catalog) {
      yield { type: 'error', code: 'tools_unsafe', message: CODEX_TEXT[this.lang()].notOnlyDool2 }
      return
    }
    const { text, signal, fork, sideJob, ...open } = input
    // A summary continues in a copy of the thread (a resident program may hold the original)
    const session = this.session(
      path,
      catalog,
      open,
      sideJob === true,
      fork === true && Boolean(open.resumeId),
    )
    try {
      yield* session.send(text, signal)
    } finally {
      await session.close()
    }
  }
}
