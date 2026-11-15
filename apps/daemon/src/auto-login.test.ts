import { describe, expect, it } from 'vitest'
import { autoLogin } from './auto-login.js'

/** 확장 대신: 화면 차례대로 돌려주고 부른 것을 적는다 */
function fakeBrowser(pages: { url: string; text: string; captcha?: boolean }[]) {
  const calls: [string, Record<string, unknown>][] = []
  let i = 0
  return {
    calls,
    async call(method: string, args: Record<string, unknown>) {
      calls.push([method, args])
      if (method === 'open') return { tabId: 7 }
      if (method === 'snapshot') return pages[Math.min(i, pages.length - 1)]
      if (method === 'click' || method === 'press') i++
      return {}
    },
  }
}
const card = { id: 'shop', name: '시험 가게', signedIn: ['로그아웃'] }
const home = { url: 'https://shop.test/', text: '[e1 링크 "로그인"] [e2 링크 "장바구니"]' }
const form = {
  url: 'https://login.shop.test/login',
  text: '[e5 입력칸 "아이디"] [e6 비밀번호칸 "비밀번호"] [e7 버튼 "로그인"]',
}

describe('autoLogin', () => {
  it('로그인 링크를 눌러 칸을 채우고 로그인한다', async () => {
    const b = fakeBrowser([home, form, { url: 'https://shop.test/', text: '홍길동님 [e9 링크 "로그아웃"]' }])
    const r = await autoLogin(
      b,
      { card, url: 'https://shop.test/', username: 'hong', password: 'pw' },
      { wait: 0 },
    )
    expect(r).toMatchObject({ status: 'ok', tabId: 7, loginOrigin: 'https://login.shop.test' })
    expect(b.calls.filter(([m]) => m === 'fill').map(([, a]) => [a.ref, a.value])).toEqual([
      ['e5', 'hong'],
      ['e6', 'pw'],
    ])
    expect(b.calls.some(([m, a]) => m === 'click' && a.ref === 'e7')).toBe(true)
  })

  it('보안 문자가 뜨면 사람에게', async () => {
    const b = fakeBrowser([form, { ...form, text: `${form.text} 자동입력 방지 문자를 입력해 주세요` }])
    const r = await autoLogin(b, { card, url: form.url, username: 'a', password: 'b' }, { wait: 0 })
    expect(r).toMatchObject({ status: 'human', reason: '로봇 확인(보안 문자)이 떴어요' })
  })

  it('비밀번호가 틀리면 알려 준다', async () => {
    const b = fakeBrowser([form, { ...form, text: `${form.text} 아이디 또는 비밀번호를 잘못 입력했습니다` }])
    const r = await autoLogin(b, { card, url: form.url, username: 'a', password: 'b' }, { wait: 0 })
    expect(r.status).toBe('wrong')
  })

  it('이미 로그인돼 있으면 바로 끝', async () => {
    const b = fakeBrowser([{ url: 'https://shop.test/', text: '[e1 링크 "로그아웃"]' }])
    const r = await autoLogin(
      b,
      { card, url: 'https://shop.test/', username: 'a', password: 'b' },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.some(([m]) => m === 'fill')).toBe(false)
  })
})

describe('두 단계 로그인', () => {
  it('아이디를 넣고 계속을 누른 뒤 비밀번호를 넣는다', async () => {
    const step1 = { url: 'https://acc.test/signin', text: '[e1 입력칸 "이메일 주소"] [e2 버튼 "계속"]' }
    const step2 = { url: 'https://acc.test/signin/pw', text: '[e3 비밀번호칸 "비밀번호"] [e4 버튼 "로그인"]' }
    const done = { url: 'https://acc.test/', text: '[e9 링크 "로그아웃"]' }
    const b = fakeBrowser([step1, step2, done])
    const r = await autoLogin(b, { card, url: step1.url, username: 'a@b.c', password: 'pw' }, { wait: 0 })
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'fill').map(([, a]) => a.ref)).toEqual(['e1', 'e3'])
  })
})
