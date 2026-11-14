// Claude 로그인 버튼 (ADR 0002).
// 로그인은 공식 `claude auth login`이 한다. 두리는 그 프로그램을 띄우고, 로그인 주소를 화면에 보여 주고,
// 사용자가 브라우저에서 받은 코드를 붙여 넣으면 그대로 그 프로그램에 전달만 한다.
// 두리는 코드·토큰을 저장하거나 기록하지 않는다. 로그인 성공 여부는 `claude auth status`로만 판단한다.
import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { ClaudeLoginStatus } from '@dool2/protocol'

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

// 터미널 색 코드 (ESC [ … 문자)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const AUTH_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/
const REJECTED = /invalid|expired|error/i

/** 로그인 프로그램에 넘길 환경. 다른 Claude 세션이나 오래된 토큰이 끼어들지 않게 지운다 */
export function loginEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

export interface ClaudeLoginOptions {
  bin: string
  /** 공식 `claude auth status`로 로그인됐는지 확인한다 */
  isLoggedIn(): Promise<boolean>
  spawn?: SpawnLogin
  /** 로그인 주소가 나오기를 기다리는 시간 */
  urlWaitMs?: number
  /** 로그인 전체 제한 시간 */
  timeoutMs?: number
  /** 로그인됐는지 다시 확인하는 간격 */
  pollMs?: number
  /** 코드를 넣은 뒤 결과를 기다리는 시간 */
  verifyMs?: number
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

  /** 로그인을 시작하고 로그인 주소를 돌려준다. 이미 진행 중이면 그 상태를 돌려준다 */
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
    // 브라우저 쪽에서 로그인이 끝나면 (코드를 붙여 넣지 않아도) 알아챈다
    this.poll = setInterval(() => void this.check(), this.opts.pollMs ?? 2_000)
    this.deadline = setTimeout(
      () => {
        if (this.snapshot.state !== 'waiting') return
        this.fail('시간이 지나서 로그인을 멈췄어요. 다시 해 주세요.')
      },
      this.opts.timeoutMs ?? 15 * 60_000,
    )

    const until = Date.now() + (this.opts.urlWaitMs ?? 30_000)
    while (Date.now() < until && this.snapshot.state === 'waiting' && !this.snapshot.url) await sleep(50)
    if (this.snapshot.state === 'waiting' && !this.snapshot.url)
      this.fail('로그인 창을 열지 못했어요. 잠시 뒤 다시 해 주세요.')
    return this.snapshot
  }

  /** 브라우저에 나온 코드를 공식 로그인 프로그램에 그대로 넘긴다 */
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

  /** 로그인됐으면 끝낸다. exited면 프로그램이 끝났는데도 로그인이 안 된 것이니 실패로 본다 */
  private async check(exited = false): Promise<boolean> {
    if (this.snapshot.state !== 'waiting') return this.snapshot.state === 'done'
    const ok = await this.opts.isLoggedIn().catch(() => false)
    // 기다리는 사이에 취소·완료됐을 수 있다
    const now = this.status
    if (now.state !== 'waiting') return now.state === 'done'
    if (ok) {
      this.stop()
      this.snapshot = { state: 'done' }
      return true
    }
    if (exited) this.fail('로그인이 끝나지 않았어요. 다시 해 주세요.')
    return false
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
    // 로그인 과정의 출력(주소 등)은 남기지 않는다
    this.output = ''
    child?.kill()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
