import { describe, expect, it } from 'vitest'
import { BrowserTools } from './browser-tools.js'
import { memorySecrets } from './index.js'
import { Vault, vaultOrigin } from './vault.js'

describe('두리 금고', () => {
  it('사이트는 origin만, https만 저장한다', () => {
    expect(vaultOrigin('https://nid.naver.com/nidlogin.login?mode=form')).toBe('https://nid.naver.com')
    expect(vaultOrigin('www.coupang.com')).toBe('https://www.coupang.com')
    expect(vaultOrigin('http://127.0.0.1:3000/login')).toBe('http://127.0.0.1:3000')
    expect(() => vaultOrigin('http://shop.example')).toThrow('https')
    expect(() => vaultOrigin('javascript:alert(1)')).toThrow()
  })

  it('목록에는 비밀번호가 없고, 같은 사이트·아이디면 바꾼다', async () => {
    const secrets = memorySecrets()
    const v = new Vault(secrets, () => new Date('2026-11-14T00:00:00Z'))
    await v.add({ url: 'https://shop.example/login', username: 'duri', password: 'pw1' })
    await v.add({ url: 'https://shop.example/', username: 'duri', password: 'pw2' })
    const list = await v.list()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain('pw')
    expect((await v.findForOrigin('https://shop.example'))?.password).toBe('pw2')
    expect(await v.findForOrigin('https://shop.example.evil.com')).toBeUndefined()
    expect(await v.remove(list[0]?.id ?? '')).toBe(true)
    expect(await secrets.get('vault.entries')).toBeUndefined()
  })
})

const LOGIN = `# 로그인
아이디 [e1 입력칸 "아이디"] 비밀번호 [e2 비밀번호칸 "비밀번호"] [e3 버튼 "로그인"]`

function browserAt(url: string) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  return {
    calls,
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      if (cmd === 'snapshot')
        return { tabId: 1, url, title: '로그인', text: LOGIN, truncated: false, captcha: false }
      return { tabId: 1 }
    },
  }
}

describe('금고로 로그인 칸 채우기', () => {
  it('지금 주소와 같은 사이트일 때만, 값은 확장에만 넘기고 AI에게는 돌려주지 않는다', async () => {
    const vault = new Vault(memorySecrets())
    await vault.add({ url: 'https://shop.example', username: 'duri', password: 's3cret!' })
    const b = browserAt('https://shop.example/login')
    const tools = new BrowserTools(b, vault)
    await tools.run('read', { tabId: 1 })
    const r = await tools.run('login', { tabId: 1, usernameRef: 'e1', passwordRef: 'e2' })
    expect(r.isError).toBeUndefined()
    const out = JSON.stringify(r)
    expect(out).not.toContain('s3cret!')
    expect(out).not.toContain('duri')
    expect(b.calls.filter((c) => c[0] === 'fill')).toEqual([
      ['fill', { tabId: 1, ref: 'e1', value: 'duri', origin: 'https://shop.example' }],
      ['fill', { tabId: 1, ref: 'e2', value: 's3cret!', origin: 'https://shop.example', password: true }],
    ])
    expect((await vault.list())[0]?.lastUsedAt).toBeDefined()
  })

  it('다른 사이트(비슷한 주소 포함)면 채우지 않고 사람에게 넘기라고 한다', async () => {
    const vault = new Vault(memorySecrets())
    await vault.add({ url: 'https://shop.example', username: 'duri', password: 's3cret!' })
    const b = browserAt('https://shop.example.phish.io/login')
    const tools = new BrowserTools(b, vault)
    await tools.run('read', { tabId: 1 })
    const r = await tools.run('login', { tabId: 1, usernameRef: 'e1', passwordRef: 'e2' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toContain('browser_request_login')
    expect(b.calls.map((c) => c[0])).not.toContain('fill')
  })

  it('비밀번호칸이 아닌 곳에는 채우지 않는다', async () => {
    const vault = new Vault(memorySecrets())
    await vault.add({ url: 'https://shop.example', username: 'duri', password: 's3cret!' })
    const tools = new BrowserTools(browserAt('https://shop.example/login'), vault)
    await tools.run('read', { tabId: 1 })
    const r = await tools.run('login', { tabId: 1, passwordRef: 'e1' })
    expect(r.isError).toBe(true)
  })
})
