import { describe, expect, it } from 'vitest'
import { autoLogin, probeLogin, socialLogin, socialProvidersIn } from './auto-login.js'

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

  it('카카오 동의 화면의 (필수) 칸만 고르고 동의한다 (실측 알라딘)', async () => {
    const consent = {
      url: 'https://kauth.kakao.com/oauth/authorize',
      text: '[e2 체크박스 "(필수) 카카오 개인정보 제3자 제공 동의"] [e5 체크박스 "(선택) 카카오 개인정보 제3자 제공 동의"] [e9 버튼 "동의하고 계속하기"]',
    }
    const checked = { ...consent, text: consent.text.replace('동의"]', '동의" 선택됨]') }
    const b = tabsBrowser({ 7: [login, signed], 8: [consent, checked] }, (tab, ref) =>
      tab === 7 && ref === 'e8' ? { newTabId: 8, advance: [] } : ref === 'e9' ? { advance: [7] } : {},
    )
    const r = await socialLogin(
      b,
      { card, url: login.url, provider: 'kakao', creds: async () => undefined },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toEqual(['e8', 'e2', 'e9'])
  })

  it('구글 계정이 여럿이면 한 번 묻고 기억해 둔 계정을 고른다', async () => {
    const gLogin = {
      url: login.url,
      text: login.text.replace('[e8 버튼 "카카오로 시작하기"]', '[e8 버튼 "구글 로그인"]'),
    }
    const chooser = {
      url: 'https://accounts.google.com/v3/signin/accountchooser',
      text: '# 계정을 선택하세요.\n[e2 링크 "회사 k***@gmail.com"]\n[e3 링크 "홍길동 m***@gmail.com"]\n[e4 링크 "다른 계정 사용"]',
    }
    const saved: Record<string, string> = {}
    const asked: string[][] = []
    const ask = {
      info: async (q: { options?: string[] }) => {
        asked.push(q.options ?? [])
        return '홍길동 m***@gmail.com'
      },
      account: {
        get: (p: string) => saved[p],
        set: (p: string, v: string) => {
          saved[p] = v
        },
      },
    }
    const run = async () => {
      const b = tabsBrowser({ 7: [gLogin, signed], 8: [chooser] }, (tab, ref) =>
        tab === 7 && ref === 'e8' ? { newTabId: 8, advance: [] } : ref === 'e3' ? { advance: [7] } : {},
      )
      const r = await socialLogin(
        b,
        { card, url: gLogin.url, provider: 'google', creds: async () => undefined, ask: ask as never },
        { wait: 0 },
      )
      return { r, clicks: b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref) }
    }
    const first = await run()
    expect(first.r.status).toBe('ok')
    expect(first.clicks).toEqual(['e8', 'e3'])
    expect(saved.google).toBe('홍길동 m***@gmail.com')
    // 두 번째는 묻지 않는다
    await run()
    expect(asked).toHaveLength(1)
  })

  it('"SSG 페이스북" 같은 회사 계정 링크는 간편 로그인 버튼이 아니다', () => {
    expect(
      socialProvidersIn('[e21 링크 "네이버 로그인"] [e39 링크 "SSG 페이스북"] [e40 링크 "kakao"]'),
    ).toEqual(['kakao', 'naver'])
  })

  it('MY를 누르는 순간 뜬 광고 팝업이 클릭을 가로채면 팝업을 닫고 다시 누른다', async () => {
    const home = {
      url: 'https://shop.test/',
      text: '[e1 링크 "홈"] [e2 링크 "저장"] [e3 버튼 "내 주변"] [e9 링크 "MY"]',
    }
    const popup = { url: home.url, text: `${home.text}\n1/3 [e20 버튼 "다시 보지 않기"] [e21 버튼 "닫기"]` }
    const ctLogin = {
      url: 'https://shop.test/ct/login',
      text: '5초만에 빠른 회원가입 [e30 버튼 "카카오로 시작"] [e31 버튼 "네이버로 시작"]',
    }
    const b = tabsBrowser({ 7: [home, popup, home, ctLogin, signed] })
    const r = await socialLogin(
      b,
      { card, url: home.url, provider: 'kakao', creds: async () => undefined },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toEqual(['e9', 'e20', 'e9', 'e30'])
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

describe('폰 입력 화면으로 묻기', () => {
  const login = {
    url: 'https://shop.test/login',
    text: '[e3 입력칸 "아이디"] [e4 비밀번호칸 "비밀번호"] [e5 버튼 "로그인"] [e8 버튼 "카카오로 시작하기"]',
  }
  const signed = { url: 'https://shop.test/', text: '[e1 링크 "로그아웃"]' }

  it('카카오 계정이 금고에 없으면 폰에서 받아 넣는다', async () => {
    const kakaoLogin = {
      url: 'https://accounts.kakao.com/login',
      text: '[e2 입력칸 "아이디"] [e3 비밀번호칸 "비밀번호"] [e4 버튼 "로그인"]',
    }
    const b = tabsBrowser({ 7: [login, kakaoLogin, signed] })
    const asked: string[] = []
    const r = await socialLogin(
      b,
      {
        card,
        url: login.url,
        provider: 'kakao',
        creds: async () => undefined,
        ask: {
          credentials: async (origin, site, _tab) => {
            asked.push(`${origin} ${site}`)
            return { username: 'me@kakao.com', password: 'pw' }
          },
        },
      },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(asked).toEqual(['https://accounts.kakao.com 카카오 계정'])
    expect(b.calls.filter(([m]) => m === 'fill').map(([, a]) => a.value)).toEqual(['me@kakao.com', 'pw'])
  })

  it('인증번호를 물으면 폰에서 받아 칸에 넣고 확인을 누른다', async () => {
    const otp = {
      url: 'https://login.shop.test/verify',
      text: '새로운 기기에서 로그인했어요. 문자로 보낸 인증번호를 입력해 주세요 [e7 입력칸 "인증번호 6자리"] [e8 버튼 "확인"]',
    }
    const b = fakeBrowser([form, otp, signed])
    const r = await autoLogin(
      b,
      {
        card,
        url: form.url,
        username: 'a',
        password: 'b',
        ask: { info: async (q) => (q.field === 'otp' ? '123456' : undefined) },
      },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.some(([m, a]) => m === 'type' && a.ref === 'e7' && a.text === '123456')).toBe(true)
    expect(b.calls.some(([m, a]) => m === 'click' && a.ref === 'e8')).toBe(true)
  })

  it('번호를 기다리는 사이 화면 표시가 바뀌어도 새로 읽어 맞는 확인을 누른다', async () => {
    const otp = {
      url: 'https://login.shop.test/verify',
      text: '인증번호를 입력해 주세요 [e7 입력칸 "인증번호"] [e8 버튼 "확인"]',
    }
    // 폰이 원격 화면으로 같은 화면을 다시 읽으면 표시 번호가 바뀐다
    const reread = {
      url: otp.url,
      text: '인증번호를 입력해 주세요 [e31 입력칸 "인증번호"] [e32 버튼 "확인"]',
    }
    const b = fakeBrowser([form, otp, signed])
    let asked = false
    const orig = b.call.bind(b)
    b.call = async (method, args) => {
      if (method === 'snapshot' && asked) {
        b.calls.push([method, args])
        return b.calls.some(([m]) => m === 'click' && (args as { tabId?: number }).tabId !== undefined) &&
          b.calls.filter(([m]) => m === 'click').at(-1)?.[1].ref === 'e32'
          ? signed
          : reread
      }
      return orig(method, args)
    }
    const r = await autoLogin(
      b,
      {
        card,
        url: form.url,
        username: 'a',
        password: 'b',
        ask: {
          info: async () => {
            asked = true
            return '123456'
          },
        },
      },
      { wait: 0 },
    )
    expect(b.calls.some(([m, a]) => m === 'type' && a.ref === 'e31')).toBe(true)
    expect(b.calls.some(([m, a]) => m === 'click' && a.ref === 'e32')).toBe(true)
    expect(r.status).toBe('ok')
  })

  it('휴대폰 앱에서 승인하라는 화면이면 카드에 알리고, 승인되면 이어서 끝낸다', async () => {
    const confirmPage = {
      url: 'https://login.shop.test/confirm',
      text: '카카오톡으로 로그인 확인 요청을 보냈어요. 카카오톡에서 확인을 눌러 주세요 [e3 버튼 "다시 보내기"]',
    }
    const done = { url: 'https://shop.test/', text: '홍길동님 [e9 링크 "로그아웃"]' }
    const calls: string[] = []
    let i = 0
    let seenConfirm = 0
    const pages = [form, confirmPage]
    const b = {
      async call(method: string, _args: Record<string, unknown>) {
        calls.push(method)
        if (method === 'open') return { tabId: 7 }
        if (method === 'snapshot') {
          const p = pages[Math.min(i, pages.length - 1)]
          // 승인 화면을 두 번 본 뒤 사용자가 휴대폰에서 눌렀다고 치고 로그인된 화면으로
          if (p === confirmPage && ++seenConfirm > 2) return done
          return p
        }
        if (method === 'click' || method === 'press') i++
        return {}
      },
    }
    const steps: { text: string; ask?: { kind: string } }[] = []
    const r = await autoLogin(
      b,
      {
        card,
        url: form.url,
        username: 'a',
        password: 'b',
        step: (text, ask) => steps.push({ text, ...(ask ? { ask } : {}) }),
      },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(steps.find((s) => s.ask?.kind === 'confirm')?.text).toBe('카카오톡에서 확인을 눌러 주세요')
  }, 15_000)

  it('아이디·비밀번호 연결 중 네이버 같은 간편 로그인 화면에 오면 절대 넣지 않는다', async () => {
    const naver = {
      url: 'https://nid.naver.com/oauth2.0/authorize?client_id=x',
      text: '[e5 입력칸 "아이디 또는 전화번호"] [e6 비밀번호칸 "비밀번호"] [e7 버튼 "로그인"]',
    }
    const b = fakeBrowser([home, naver])
    const r = await autoLogin(
      b,
      { card: { ...card, site: 'trip.com' }, url: home.url, username: 'a', password: 'b' },
      { wait: 0 },
    )
    expect(r.status).toBe('unknown')
    expect(b.calls.some(([m]) => m === 'fill')).toBe(false)
  })

  it('네이버 연결 카드는 네이버 로그인 화면에 넣는다', async () => {
    const naver = {
      url: 'https://nid.naver.com/nidlogin.login',
      text: '[e5 입력칸 "아이디 또는 전화번호"] [e6 비밀번호칸 "비밀번호"] [e7 버튼 "로그인"]',
    }
    const b = fakeBrowser([naver, { url: 'https://www.naver.com/', text: '[e1 링크 "로그아웃"]' }])
    const r = await autoLogin(
      b,
      { card: { ...card, id: 'naver', site: 'naver.com' }, url: naver.url, username: 'a', password: 'b' },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
  })

  it('공급자 계정이 곧 그 서비스 아이디인 곳(티켓링크 = PAYCO 아이디)은 넣는다', async () => {
    const payco = {
      url: 'https://id.payco.com/oauth2.0/authorize?serviceProviderCode=TKLINK',
      text: '[e5 입력칸 "이메일 또는 휴대폰 아이디"] [e6 비밀번호칸 "비밀번호"] [e7 버튼 "로그인"]',
    }
    const b = fakeBrowser([payco, { url: 'https://www.ticketlink.co.kr/', text: '[e1 링크 "로그아웃"]' }])
    const r = await autoLogin(
      b,
      {
        card: { ...card, site: 'ticketlink.co.kr', login: 'PAYCO 아이디' },
        url: payco.url,
        username: 'a',
        password: 'b',
      },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
  })

  it('인증번호를 안 넣으면 사람에게 넘긴다', async () => {
    const otp = {
      url: 'https://login.shop.test/verify',
      text: '인증번호를 입력해 주세요 [e7 입력칸 "인증번호"] [e8 버튼 "확인"]',
    }
    const b = fakeBrowser([form, otp])
    const r = await autoLogin(
      b,
      { card, url: form.url, username: 'a', password: 'b', ask: { info: async () => undefined } },
      { wait: 0 },
    )
    expect(r.status).toBe('human')
  })
})
