import { describe, expect, it } from 'vitest'
import { autoLogin, probeLogin, socialLogin } from './auto-login.js'

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

describe('로그인 방법 고르기 화면', () => {
  it('위쪽 "로그인/회원가입"을 또 누르지 않고 "이메일 로그인"으로 들어간다', async () => {
    const chooser = {
      url: 'https://auth.shop.test/login',
      text: '[e6 버튼 "로그인/회원가입"] [e16 버튼 "카카오로 계속하기"] [e17 버튼 "Apple로 계속하기"] [e21 버튼 "네이버 로그인"] [e22 버튼 "이메일 로그인"]',
    }
    const b = fakeBrowser([chooser, form, { url: 'https://shop.test/', text: '[e9 링크 "로그아웃"]' }])
    const r = await autoLogin(b, { card, url: chooser.url, username: 'a', password: 'b' }, { wait: 0 })
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)[0]).toBe('e22')
  })

  it('"메일로 시작하기"·"이메일 주소" 같은 이름도 아이디 로그인으로 본다', async () => {
    for (const name of ['메일로 시작하기', '이메일 주소', '이메일']) {
      const chooser = {
        url: 'https://acc.test/login',
        text: `[e1 버튼 "카카오로 시작하기"] [e2 버튼 "파트너 로그인"] [e5 버튼 "${name}"]`,
      }
      const b = fakeBrowser([chooser, form, { url: 'https://shop.test/', text: '[e9 링크 "로그아웃"]' }])
      const r = await autoLogin(b, { card, url: chooser.url, username: 'a', password: 'b' }, { wait: 0 })
      expect(r.status).toBe('ok')
      expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)[0]).toBe('e5')
    }
  })

  it('첫 화면을 덮은 팝업("오늘은 그만 보기")을 먼저 닫는다', async () => {
    const withPopup = {
      url: 'https://shop.test/',
      text: '[e1 링크 "로그인"] 이벤트! [e30 버튼 "오늘은 그만 보기"] [e31 버튼 "닫기"]',
    }
    const b = fakeBrowser([
      withPopup,
      home,
      form,
      { url: 'https://shop.test/', text: '[e9 링크 "로그아웃"]' },
    ])
    const r = await autoLogin(b, { card, url: home.url, username: 'a', password: 'b' }, { wait: 0 })
    expect(r.status).toBe('ok')
    expect(
      b.calls
        .filter(([m]) => m === 'click')
        .map(([, a]) => a.ref)
        .slice(0, 2),
    ).toEqual(['e30', 'e1'])
  })

  it('점검은 지나온 화면의 간편 로그인도 모은다', async () => {
    const chooser = {
      url: 'https://auth.shop.test/login',
      text: '[e16 버튼 "카카오로 계속하기"] [e21 버튼 "네이버 로그인"] [e22 버튼 "이메일 로그인"] [e30 링크 "google playstore"] [e31 링크 "facebook"]',
    }
    const b = fakeBrowser([chooser, form])
    const r = await probeLogin(b, { card, url: chooser.url }, { wait: 0 })
    expect(r.status).toBe('found')
    expect(r.social?.sort()).toEqual(['kakao', 'naver'])
  })
})

/** 탭이 여럿인 가짜 브라우저: 탭마다 화면 차례, 누르면 다음 화면 (새 창이 열리는 버튼도) */
function tabsBrowser(
  tabs: Record<number, { url: string; text: string }[]>,
  onClick: (tabId: number, ref: string) => { newTabId?: number; advance?: number[] } = () => ({}),
) {
  const at: Record<number, number> = {}
  const calls: [string, Record<string, unknown>][] = []
  return {
    calls,
    async call(method: string, args: Record<string, unknown>) {
      calls.push([method, args])
      const tabId = Number(args.tabId)
      if (method === 'open') return { tabId: 7 }
      if (method === 'snapshot') {
        const list = tabs[tabId]
        if (!list) throw new Error('닫힌 탭')
        return list[Math.min(at[tabId] ?? 0, list.length - 1)]
      }
      if (method === 'click') {
        const r = onClick(tabId, String(args.ref))
        for (const t of r.advance ?? [tabId]) at[t] = (at[t] ?? 0) + 1
        return r.newTabId ? { newTabId: r.newTabId } : {}
      }
      if (method === 'press') at[tabId] = (at[tabId] ?? 0) + 1
      return {}
    },
  }
}

describe('간편 로그인', () => {
  const login = {
    url: 'https://shop.test/login',
    text: '[e3 입력칸 "아이디"] [e4 비밀번호칸 "비밀번호"] [e5 버튼 "로그인"] [e8 버튼 "카카오로 시작하기"] [e9 버튼 "네이버 로그인"]',
  }
  const signed = { url: 'https://shop.test/', text: '홍길동님 [e1 링크 "로그아웃"]' }

  it('카카오가 이미 로그인돼 있으면 동의만 누르고 끝낸다 (새 창)', async () => {
    const consent = { url: 'https://kauth.kakao.com/oauth/authorize', text: '[e2 버튼 "동의하고 계속하기"]' }
    const b = tabsBrowser({ 7: [login, signed], 8: [consent] }, (tab, ref) =>
      tab === 7 && ref === 'e8' ? { newTabId: 8, advance: [] } : ref === 'e2' ? { advance: [7] } : {},
    )
    const creds = async () => undefined
    const r = await socialLogin(b, { card, url: login.url, provider: 'kakao', creds }, { wait: 0 })
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toEqual(['e8', 'e2'])
    expect(b.calls.some(([m]) => m === 'fill')).toBe(false)
  })

  it('카카오 로그인 화면이 나오면 금고 값을 넣는다', async () => {
    const kakaoLogin = {
      url: 'https://accounts.kakao.com/login',
      text: '[e2 입력칸 "카카오메일 아이디, 이메일, 전화번호"] [e3 비밀번호칸 "비밀번호"] [e4 버튼 "로그인"]',
    }
    const b = tabsBrowser({ 7: [login, kakaoLogin, signed] }, (_t, ref) =>
      ref === 'e8' || ref === 'e4' ? {} : {},
    )
    const creds = async (origin: string) =>
      origin === 'https://accounts.kakao.com' ? { username: 'me@kakao.com', password: 'pw' } : undefined
    const r = await socialLogin(b, { card, url: login.url, provider: 'kakao', creds }, { wait: 0 })
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'fill').map(([, a]) => [a.ref, a.value, a.origin])).toEqual([
      ['e2', 'me@kakao.com', 'https://accounts.kakao.com'],
      ['e3', 'pw', 'https://accounts.kakao.com'],
    ])
  })

  it('공급자 로그인이 필요한데 금고에 없으면 사람에게 넘긴다', async () => {
    const naverLogin = {
      url: 'https://nid.naver.com/nidlogin.login',
      text: '[e2 입력칸 "아이디"] [e3 비밀번호칸 "비밀번호"] [e4 버튼 "로그인"]',
    }
    const b = tabsBrowser({ 7: [login, naverLogin] })
    const r = await socialLogin(
      b,
      { card, url: login.url, provider: 'naver', creds: async () => undefined },
      { wait: 0 },
    )
    expect(r).toMatchObject({ status: 'human', tabId: 7 })
    if (r.status === 'human') expect(r.reason).toContain('네이버 로그인이 필요해요')
  })

  it('버튼이 없으면 알려 준다', async () => {
    const b = tabsBrowser({ 7: [form] })
    const r = await socialLogin(
      b,
      { card, url: form.url, provider: 'apple', creds: async () => undefined },
      { wait: 0 },
    )
    expect(r.status).toBe('unknown')
  })
})
