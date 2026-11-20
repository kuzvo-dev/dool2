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

describe('같은 사이트에 계정을 여러 번 넣었을 때', () => {
  it('가장 나중에 넣은 계정을 쓴다 (아이디를 잘못 쳤다가 고쳐 넣은 경우)', async () => {
    const v = new Vault(memorySecrets())
    await v.add({ url: 'https://shop.example', username: 'typo-id', password: 'pw1' })
    await v.add({ url: 'https://shop.example', username: 'right-id', password: 'pw2' })
    expect((await v.findForOrigin('https://shop.example'))?.username).toBe('right-id')
    // 예전 계정의 비밀번호를 다시 넣으면 그 계정이 가장 나중 것이 된다
    await v.add({ url: 'https://shop.example', username: 'typo-id', password: 'pw3' })
    expect(await v.findForOrigin('https://shop.example')).toMatchObject({
      username: 'typo-id',
      password: 'pw3',
    })
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

  it('연결을 이어받은 탭이면 같은 서비스의 다른 주소(login.사이트)에서도 그 계정으로 채운다', async () => {
    const vault = new Vault(memorySecrets())
    await vault.add({ url: 'https://www.shop.example', username: 'duri', password: 's3cret!' })
    const b = browserAt('https://login.shop.example/auth')
    const tools = new BrowserTools(b, vault)
    await tools.run('read', { tabId: 1 })
    // 이어받은 탭이 아니면 금고 주소와 달라 채우지 않는다
    expect((await tools.run('login', { tabId: 1, usernameRef: 'e1', passwordRef: 'e2' })).isError).toBe(true)
    const asked: [number, string][] = []
    tools.siteLogin = async (tabId, origin) => {
      asked.push([tabId, origin])
      return vault.findForOrigin('https://www.shop.example')
    }
    const r = await tools.run('login', { tabId: 1, usernameRef: 'e1', passwordRef: 'e2' })
    expect(r.isError).toBeUndefined()
    expect(asked).toEqual([[1, 'https://login.shop.example']])
    expect(JSON.stringify(r)).not.toContain('s3cret!')
    // 값은 지금 화면 주소로만 넘긴다 (확장이 주소를 다시 확인한다)
    expect(b.calls.filter((c) => c[0] === 'fill').at(-1)).toEqual([
      'fill',
      { tabId: 1, ref: 'e2', value: 's3cret!', origin: 'https://login.shop.example', password: true },
    ])
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

describe('금고 보기 (vault_find 도구)', () => {
  const cards = [
    { id: 'coupang', name: '쿠팡', site: 'coupang.com', connected: true },
    { id: 'yanolja', name: '야놀자', site: 'yanolja.com', connected: true, social: '카카오' },
    { id: 'yes24', name: 'YES24', site: 'yes24.com' },
  ]
  const fill = async () => {
    const secrets = memorySecrets()
    let t = Date.parse('2026-11-14T00:00:00Z')
    const v = new Vault(secrets, () => {
      t += 3600_000
      return new Date(t)
    })
    await v.add({ url: 'https://www.coupang.com/', username: 'duri1234', password: 'pw-secret-1' })
    await v.add({
      url: 'https://shop.example/login',
      username: 'felix990810@gmail.com',
      password: 'pw-secret-2',
    })
    const list = await v.list()
    await v.markUsed(list[0]?.id ?? '')
    return v
  }

  it('아이디는 가린다', async () => {
    const { maskUsername } = await import('./vault.js')
    expect(maskUsername('felix990810@gmail.com')).toBe('f***@gmail.com')
    expect(maskUsername('duri1234')).toBe('du******')
    expect(maskUsername('abc')).toBe('ab***')
    expect(maskUsername('ab')).toBe('a***')
  })

  it('비어 있으면 연결 카드로 가는 길을 알려 준다', async () => {
    const { vaultSitesText } = await import('./vault.js')
    const t = vaultSitesText([], { cards })
    expect(t).toContain('금고에 저장된 로그인이 없어요')
    expect(t).toContain('connect_ask')
    const one = vaultSitesText([], { query: '쿠팡', cards })
    expect(one).toContain('아니요, 쿠팡(coupang.com) 로그인은 금고에 없어요')
    expect(one).toContain('connect_ask("coupang")')
  })

  it('전부 보기: 사이트·가린 아이디·마지막 사용만, 비밀번호는 없다', async () => {
    const { vaultSitesText } = await import('./vault.js')
    const v = await fill()
    const t = vaultSitesText(await v.list(), { cards })
    expect(t).toContain('로그인이 저장된 사이트 2곳')
    expect(t).toContain('1. 쿠팡 · coupang.com · 아이디 du****** · 마지막 사용 2026-11-14')
    expect(t).toContain('2. shop.example · 아이디 f***@gmail.com · 아직 두리가 쓴 적 없음')
    expect(t).not.toMatch(/pw-secret|duri1234|felix990810/)
  })

  it('이름·주소로 있는지 확인한다 (예/아니요, 간편 로그인 연결은 따로 알려 준다)', async () => {
    const { vaultSitesText } = await import('./vault.js')
    const v = await fill()
    const list = await v.list()
    expect(vaultSitesText(list, { query: '쿠팡', cards })).toContain(
      '네, 쿠팡(coupang.com) 로그인이 금고에 저장돼 있어요',
    )
    expect(vaultSitesText(list, { query: 'https://login.coupang.com/login', cards })).toContain('네, 쿠팡')
    expect(vaultSitesText(list, { query: 'shop.example', cards })).toContain("네, 'shop.example'")
    const social = vaultSitesText(list, { query: '야놀자', cards })
    expect(social).toContain('아니요, 야놀자(yanolja.com) 로그인은 금고에 없어요')
    expect(social).toContain('야놀자는 카카오 간편 로그인으로 연결돼 있어')
    expect(social).toContain('금고에 저장된 사이트 2곳: 쿠팡(coupang.com), shop.example')
    expect(social).toContain('connect_ask("yanolja")가 카카오 간편 로그인으로 다시 로그인')
    const unknown = vaultSitesText(list, { query: 'naver.com', cards })
    expect(unknown).toContain('browser_request_login')
    for (const q of ['', '쿠팡', '야놀자', 'naver.com'])
      expect(vaultSitesText(list, { query: q, cards })).not.toMatch(/pw-secret|duri1234|felix990810/)
  })
})

describe('사용자가 금고를 보고 고치기 (ADR 0026)', () => {
  it('하나만 꺼내 보고, 아이디·비밀번호를 고치면 그 값으로 로그인한다 (빈 칸은 그대로)', async () => {
    const v = new Vault(memorySecrets(), () => new Date('2026-11-20T00:00:00Z'))
    const e = await v.add({ url: 'https://shop.example/login', username: 'duri', password: 'old-pw' })
    expect(await v.reveal(e.id)).toEqual({
      origin: 'https://shop.example',
      username: 'duri',
      password: 'old-pw',
    })
    expect(await v.reveal('없는 것')).toBeUndefined()
    await v.update(e.id, { password: 'new-pw' })
    expect(await v.findForOrigin('https://shop.example')).toMatchObject({
      username: 'duri',
      password: 'new-pw',
    })
    await v.update(e.id, { username: 'duri2' })
    expect(await v.findForOrigin('https://shop.example')).toMatchObject({
      username: 'duri2',
      password: 'new-pw',
    })
    expect(await v.update('없는 것', { password: 'x' })).toBeUndefined()
    // 목록에는 여전히 비밀번호가 없다
    expect(JSON.stringify(await v.list())).not.toContain('new-pw')
  })
})
