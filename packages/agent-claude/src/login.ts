// Claude sign-in button (ADR 0002).
// The official `claude auth login` signs in. Dool2 starts that program, shows the sign-in URL on screen, and
// passes the code the user pasted from the browser straight to that program.
// Dool2 never stores or logs the code or tokens. Whether sign-in worked is decided only by `claude auth status`.
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Lang } from '@dool2/i18n'
import type { ClaudeLoginStatus } from '@dool2/protocol'
import { CLAUDE_TEXT } from './locales/claude.js'

export interface LoginChild {
  stdout: Readable
  stderr: Readable
  stdin: Writable
  kill(): void
  once(event: 'exit', cb: (code: number | null) => void): unknown
}

export type SpawnLogin = (bin: string, args: string[], env: NodeJS.ProcessEnv) => LoginChild

const defaultSpawn: SpawnLogin = (bin, args, env) =>
  spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

// Terminal color codes (ESC [ … sequences)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const AUTH_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/
const REJECTED = /invalid|expired|error/i

/** Environment for the sign-in program, cleared so other Claude sessions or old tokens don't interfere */
export function loginEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

export interface ClaudeLoginOptions {
  bin: string
  /** Checks with the official `claude auth status` whether signed in */
  isLoggedIn(): Promise<boolean>
  spawn?: SpawnLogin
  /** How long to wait for the sign-in URL */
  urlWaitMs?: number
  /** Time limit for the whole sign-in */
  timeoutMs?: number
  /** Interval for checking again whether signed in */
  pollMs?: number
  /** How long to wait for the result after the code is entered */
  verifyMs?: number
  /** Language of the messages people see. Korean when not given */
  lang?: Lang
}

export class ClaudeLogin {
  private child: LoginChild | undefined
  private output = ''
  private snapshot: ClaudeLoginStatus = { state: 'idle' }
  private poll: ReturnType<typeof setInterval> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly opts: ClaudeLoginOptions) {}

  get status(): ClaudeLoginStatus {
    return this.snapshot
  }

  /** Starts signing in and returns the sign-in URL. Returns the current state if already running */
  async start(): Promise<ClaudeLoginStatus> {
    if (this.snapshot.state === 'waiting' && this.child) return this.snapshot
    this.stop()
    this.output = ''
    this.snapshot = { state: 'waiting' }

    const child = (this.opts.spawn ?? defaultSpawn)(
      this.opts.bin,
      ['auth', 'login', '--claudeai'],
      loginEnv(),
    )
    this.child = child
    const onData = (chunk: Buffer | string) => {
      if (this.child !== child) return
      this.output += chunk.toString().replace(ANSI, '')
      const url = this.output.match(AUTH_URL)?.[0]
      if (url && this.snapshot.state === 'waiting' && !this.snapshot.url)
        this.snapshot = { state: 'waiting', url }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      void this.check(true)
    })
    // Notices when sign-in finishes in the browser (even without pasting the code)
    this.poll = setInterval(() => void this.check(), this.opts.pollMs ?? 2_000)
    this.deadline = setTimeout(
      () => {
        if (this.snapshot.state !== 'waiting') return
        this.fail(this.t.loginTimeout)
      },
      this.opts.timeoutMs ?? 15 * 60_000,
    )

    const until = Date.now() + (this.opts.urlWaitMs ?? 30_000)
    while (Date.now() < until && this.snapshot.state === 'waiting' && !this.snapshot.url) await sleep(50)
    if (this.snapshot.state === 'waiting' && !this.snapshot.url) this.fail(this.t.loginNoWindow)
    return this.snapshot
  }

  /** Passes the code shown in the browser straight to the official sign-in program */
  async submitCode(code: string): Promise<ClaudeLoginStatus> {
    const trimmed = code.trim()
    const child = this.child
    if (!trimmed || !child || this.snapshot.state !== 'waiting') return this.snapshot
    const from = this.output.length
    child.stdin.write(`${trimmed}\n`)
    const until = Date.now() + (this.opts.verifyMs ?? 45_000)
    while (Date.now() < until && this.snapshot.state === 'waiting') {
      if (await this.check()) break
      if (REJECTED.test(this.output.slice(from))) {
        this.snapshot = { ...this.snapshot, codeRejected: true }
        break
      }
      await sleep(this.opts.pollMs ?? 1_000)
    }
    return this.snapshot
  }

  cancel() {
    this.stop()
    this.snapshot = { state: 'idle' }
  }

  /** Finishes when signed in. If `exited`, the program ended without signing in, so it counts as a failure */
  private async check(exited = false): Promise<boolean> {
    if (this.snapshot.state !== 'waiting') return this.snapshot.state === 'done'
    const ok = await this.opts.isLoggedIn().catch(() => false)
    // It may have been canceled or finished while waiting
    const now = this.status
    if (now.state !== 'waiting') return now.state === 'done'
    if (ok) {
      this.stop()
      this.snapshot = { state: 'done' }
      return true
    }
    if (exited) this.fail(this.t.loginUnfinished)
    return false
  }

  private get t() {
    return CLAUDE_TEXT[this.opts.lang ?? 'ko']
  }

  private fail(message: string) {
    this.stop()
    this.snapshot = { state: 'failed', message }
  }

  private stop() {
    if (this.poll) clearInterval(this.poll)
    if (this.deadline) clearTimeout(this.deadline)
    this.poll = undefined
    this.deadline = undefined
    const child = this.child
    this.child = undefined
    // Output from the sign-in (URLs and so on) is not kept
    this.output = ''
    child?.kill()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
