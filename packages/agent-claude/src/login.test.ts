import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ClaudeLogin, type LoginChild, loginEnv } from './login.js'

// 실제 `claude auth login` 출력 (Claude Code 2.1.x, 파이프로 실행했을 때). 값은 가렸다
const PROMPT =
  'Opening browser to sign in…\n' +
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s\n" +
  'Paste code here if prompted > '

class FakeChild extends EventEmitter implements LoginChild {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  written = ''
  killed = false
  args: string[] = []
  env: NodeJS.ProcessEnv = {}
  constructor() {
    super()
    this.stdin.on('data', (d: Buffer) => {
      this.written += d.toString()
    })
  }
  kill() {
    this.killed = true
  }
}

function setup(opts: { loggedIn?: () => boolean; printUrl?: boolean } = {}) {
  const child = new FakeChild()
  const login = new ClaudeLogin({
    bin: '/x/claude',
    isLoggedIn: async () => opts.loggedIn?.() ?? false,
    spawn: (_bin, args, env) => {
      child.args = args
      child.env = env
      if (opts.printUrl !== false) setTimeout(() => child.stdout.write(`\u001b[2m${PROMPT}\u001b[0m`), 5)
      return child
    },
    urlWaitMs: 300,
    pollMs: 10,
    verifyMs: 300,
  })
  return { child, login }
}

describe('Claude 로그인 버튼', () => {
  it('공식 로그인을 구독 모드로 띄우고 로그인 주소를 찾는다', async () => {
    const { child, login } = setup()
    const s = await login.start()
    expect(child.args).toEqual(['auth', 'login', '--claudeai'])
    expect(s).toEqual({ state: 'waiting', url: expect.stringContaining('/oauth/authorize?code=true') })
    login.cancel()
    expect(child.killed).toBe(true)
  })

  it('다른 Claude 세션이나 오래된 토큰을 넘기지 않는다', () => {
    const env = loginEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'old' })
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('붙여 넣은 코드를 그대로 넘기고, 로그인되면 끝낸다', async () => {
    let ok = false
    const { child, login } = setup({ loggedIn: () => ok })
    await login.start()
    child.stdin.on('data', () => {
      ok = true
    })
    const s = await login.submitCode('  abc#def  ')
    expect(child.written).toBe('abc#def\n')
    expect(s).toEqual({ state: 'done' })
    expect(child.killed).toBe(true)
  })

  it('틀린 코드면 다시 넣을 수 있게 알려 준다', async () => {
    const { child, login } = setup()
    await login.start()
    child.stdin.on('data', () =>
      child.stdout.write('OAuth error: Invalid code\nPaste code here if prompted > '),
    )
    const s = await login.submitCode('wrong')
    expect(s).toMatchObject({ state: 'waiting', codeRejected: true })
    expect(child.killed).toBe(false)
    login.cancel()
  })

  it('브라우저에서 로그인이 끝나면 코드 없이도 알아챈다', async () => {
    let ok = false
    const { login } = setup({ loggedIn: () => ok })
    await login.start()
    ok = true
    await new Promise((r) => setTimeout(r, 50))
    expect(login.status).toEqual({ state: 'done' })
  })

  it('주소가 나오지 않으면 실패로 알려 준다', async () => {
    const { login } = setup({ printUrl: false })
    const s = await login.start()
    expect(s).toEqual({ state: 'failed', message: expect.stringContaining('로그인 창을 열지 못했어요') })
  })

  it('로그인 없이 프로그램이 끝나면 실패로 본다', async () => {
    const { child, login } = setup()
    await login.start()
    child.emit('exit', 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(login.status.state).toBe('failed')
  })
})
