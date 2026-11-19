import { describe, expect, it } from 'vitest'
import {
  autoLogin,
  certScreen,
  dormantScreen,
  joinScreen,
  keepSignedIn,
  probeLogin,
  said,
  sameAccount,
  socialLogin,
  socialProvidersIn,
} from './auto-login.js'

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

describe('이미 로그인된 메일함 (실측 네이버 메일 2026-11-19)', () => {
  // 로그아웃은 메뉴 속에 숨어 있고, 받은메일함 제목에 "새로운 환경에서 로그인 되었습니다."가 있다
  const inbox = {
    url: 'https://mail.naver.com/v2/folders/0/all',
    text: [
      '[e1 링크 "본문으로 바로가기"]',
      '# [e2 링크 "NAVER"] [e3 링크 "메일"]',
      '[e4 링크 "wwd 내정보 보기"]',
      '[e16 링크 "받은메일함 선택됨"]',
      '[e40 링크 "새로운 환경에서 로그인 되었습니다."]',
      '[e41 링크 "Google 계정 복구가 완료되었습니다"]',
    ].join('\n'),
  }
  it('메일 제목을 2단계 인증으로 읽지 않고 로그인됨으로 끝낸다', async () => {
    const b = fakeBrowser([inbox])
    const r = await autoLogin(
      b,
      { card: { id: 'naver-mail', name: '네이버 메일' }, url: inbox.url, username: 'a', password: 'b' },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
  })
  it('링크 글자를 뺀 말만 본다', () => {
    expect(said(inbox.text)).not.toMatch(/새로운 환경/)
    expect(said('[e3 버튼 "인증번호 받기"] 인증번호를 입력해 주세요')).toMatch(/인증번호/)
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

  describe('동의 전에 로그인된 카카오 계정 확인 (실측 알라딘: 평소 계정이 아닌 f***@gmail.com)', () => {
    const consent = {
      url: 'https://kauth.kakao.com/oauth/authorize',
      text: '# 카카오계정으로 로그인\n로그인된 계정 f***@gmail.com [e1 링크 "계정 변경"]\n[e9 버튼 "동의하고 계속하기"]',
    }
    const run = (answer: string | undefined, known: string[] = []) => {
      const b = tabsBrowser({ 7: [login, signed], 8: [consent] }, (tab, ref) =>
        tab === 7 && ref === 'e8' ? { newTabId: 8, advance: [] } : ref === 'e9' ? { advance: [7] } : {},
      )
      const asked: string[] = []
      const added: string[] = []
      const p = socialLogin(
        b,
        {
          card,
          url: login.url,
          provider: 'kakao',
          creds: async () => undefined,
          ask: {
            info: async (q) => {
              asked.push(q.label)
              return answer
            },
            known: { has: (_p, l) => known.includes(l), add: (_p, l) => added.push(l) },
          },
        },
        { wait: 0 },
      )
      return { b, asked, added, p }
    }
    it('처음 보는 계정이면 묻고, 맞다고 하면 기억하고 동의한다', async () => {
      const { b, asked, added, p } = run('f***@gmail.com(으)로 할게요')
      expect((await p).status).toBe('ok')
      expect(asked[0]).toContain('f***@gmail.com')
      expect(added).toEqual(['f***@gmail.com'])
      expect(b.calls.some(([m, a]) => m === 'click' && a.ref === 'e9')).toBe(true)
    })
    it('다른 계정이라고 하면 동의하지 않고 계정 변경을 열어 넘긴다', async () => {
      const { b, p } = run('다른 계정이에요')
      const r = await p
      expect(r.status).toBe('human')
      const clicks = b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)
      expect(clicks).toContain('e1')
      expect(clicks).not.toContain('e9')
    })
    it('전에 확인한 계정이면 묻지 않는다', async () => {
      const { asked, p } = run(undefined, ['f***@gmail.com'])
      expect((await p).status).toBe('ok')
      expect(asked).toEqual([])
    })
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

  it('기억한 이메일(전체 주소)로 가린 계정 줄을 고른다', async () => {
    const gLogin = {
      url: login.url,
      text: login.text.replace('[e8 버튼 "카카오로 시작하기"]', '[e8 버튼 "구글 로그인"]'),
    }
    const chooser = {
      url: 'https://accounts.google.com/v3/signin/accountchooser',
      text: '# 계정을 선택하세요.\n[e2 링크 "회사 k***@gmail.com"]\n[e3 링크 "홍길동 m***@gmail.com"]',
    }
    const b = tabsBrowser({ 7: [gLogin, signed], 8: [chooser] }, (tab, ref) =>
      tab === 7 && ref === 'e8' ? { newTabId: 8, advance: [] } : ref === 'e3' ? { advance: [7] } : {},
    )
    const ask = { info: async () => undefined, account: { get: () => 'mdjoo0810@gmail.com', set: () => {} } }
    const r = await socialLogin(
      b,
      { card, url: gLogin.url, provider: 'google', creds: async () => undefined, ask: ask as never },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toEqual(['e8', 'e3'])
  })

  it('카카오톡 확인을 기다리기 전에 "이 브라우저에서 2단계 인증 사용 안 함"을 고른다', async () => {
    const twoFa = {
      url: 'https://accounts.kakao.com/login/',
      text: '## 2단계 인증을 진행해 주세요.\n카카오톡으로 로그인 확인 메시지가 전송되었습니다. 전송된 카카오톡 메시지에서 확인 버튼을 눌러 주세요.\n[e15 체크박스 "이 브라우저에서 2단계 인증 사용 안 함"]',
    }
    const b = tabsBrowser(
      { 7: [login, signed], 8: [twoFa, { url: 'https://kauth.kakao.com/x', text: '' }] },
      (tab, ref) =>
        tab === 7 && ref === 'e8' ? { newTabId: 8, advance: [] } : ref === 'e15' ? { advance: [7, 8] } : {},
    )
    await socialLogin(
      b,
      { card, url: login.url, provider: 'kakao', creds: async () => undefined },
      { wait: 0, tries: 3 },
    )
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toContain('e15')
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

describe('간편 로그인 뒤 가입 화면', () => {
  it('필수 약관만 있는 간편 가입은 두리가 고르고 누른다 (실측 예스24 페이스북)', () => {
    const t = `# 페이스북 계정 연동
예스24 회원님이신가요?
[e3 링크 "로그인"]
아직 예스24 회원이 아니시라면 회원가입을 해주세요.
[e4 체크박스 "모두 동의"] 모두 동의
[e5 체크박스 "예스24 이용약관 동의 (필수)"] 예스24 이용약관 동의 (필수) [e6 링크 "보기"]
상품구매 등 본인인증(휴대폰인증, 아이핀인증)이 필요한 서비스는 본인인증 이후 이용 가능합니다.
[e8 링크 "간편 회원가입"]`
    expect(joinScreen(t)).toEqual({ kind: 'auto', submit: 'e8', required: ['e5'] })
  })

  it('이 사이트에 이미 되는 계정이 있으면(join 아님) 새로 가입하지 않고 알린다', async () => {
    const login = {
      url: 'https://shop.test/login',
      text: '[e3 입력칸 "아이디"] [e4 비밀번호칸 "비밀번호"] [e5 버튼 "로그인"] [e8 버튼 "카카오로 시작하기"]',
    }
    const join = {
      url: 'https://shop.test/sns/join',
      text: '이미 회원이신가요? [e2 링크 "로그인"] 아직 회원이 아니시라면 [e5 체크박스 "이용약관 동의 (필수)"] [e8 링크 "간편 회원가입"]',
    }
    const run = (allow: boolean) => {
      const b = tabsBrowser({ 7: [login, join] }, () => ({}))
      return socialLogin(
        b,
        { card, url: login.url, provider: 'kakao', creds: async () => undefined, join: allow },
        { wait: 0, tries: 3 },
      ).then((r) => ({ r, clicks: b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref) }))
    }
    const no = await run(false)
    expect(no.r.status).toBe('human')
    expect(no.clicks).toEqual(['e8'])
    const yes = await run(true)
    expect(yes.clicks).toEqual(['e8', 'e5', 'e8'])
  })

  it('가입하려니 이미 가입된 계정이 있으면 그 아이디를 알려 준다 (실측 교보)', () => {
    const t = `[e6 링크 "카카오로 회원가입"]\n기존 계정 안내\n회원님께서는 이미 가입된 정보가 있습니다.\n아래 교보문고 아이디를 통해 로그인하시면 kakao 아이디와 자동으로 연동됩니다.\n[e13 라디오 "coffeeplan" 선택됨] [e14 버튼 "coffeeplan"]\n[e15 버튼 "로그인"]`
    expect(joinScreen(t)).toEqual({ kind: 'existing', account: 'coffeeplan' })
  })

  it('가입에 본인인증이 필요하면 사람 차례, 로그인 화면은 가입 화면이 아니다', () => {
    const t = `## 회원가입을 하시겠습니까?\n[e7 링크 "회원가입"]\n휴대폰 본인인증 [e8 버튼 "인증번호 받기"]`
    expect(joinScreen(t)).toMatchObject({ kind: 'human' })
    expect(joinScreen('[e3 입력칸 "아이디"] [e9 링크 "회원가입"]')).toBeUndefined()
  })
})

describe('본인인증 창', () => {
  it('토스 인증 창은 무엇을 하면 되는지 알려 준다 (실측 SSG)', () => {
    const t =
      'SSG.COM에 로그인하려면 휴대폰 번호를 입력해주세요 [e1 입력칸 "이름 입력"] [e2 입력칸 "휴대폰번호 입력"] [e3 입력칸 "생년월일 6자리 혹은 8자리 입력"] 토스로 인증하기'
    const r = certScreen(t)
    expect(r).toContain('본인인증')
    expect(r).toContain('토스')
  })
  it('로그인 폼은 본인인증 창이 아니다', () => {
    expect(certScreen('[e3 입력칸 "아이디"] [e4 비밀번호칸 "비밀번호"] [e5 버튼 "로그인"]')).toBeUndefined()
  })
})

describe('휴면 계정 깨우기 (실측 11번가 2026-11-19)', () => {
  const dormant = {
    url: 'https://member.11st.co.kr/auth/dormants/cert',
    text: [
      '# [e1 링크 "11번가"] 본인확인',
      '장기 미사용 계정으로 본인확인 및 약관동의가 필요합니다.',
      '## 약관동의',
      '[e2 체크박스 "(필수) 개인정보 수집/이용 동의"] (필수) 개인정보 수집/이용 동의 [e3 링크 "약관보기"]',
      '[e4 링크 "로그인 완료"]',
    ].join('\n'),
  }
  it('(필수) 동의만 있으면 고르고 [로그인 완료]', () => {
    expect(dormantScreen(dormant.text)).toEqual({ kind: 'auto', submit: 'e4', required: ['e2'] })
  })
  it('휴대폰 본인인증 칸이 있으면 사람 차례', () => {
    const t = `${dormant.text}\n휴대폰 본인인증 [e5 입력칸 "휴대폰 번호"] [e6 버튼 "인증번호 받기"]`
    expect(dormantScreen(t)?.kind).toBe('human')
  })
  it('휴면 말이 없으면 아니다', () => {
    expect(dormantScreen('[e2 체크박스 "(필수) 약관"] [e4 버튼 "확인"]')).toBeUndefined()
  })
  it('간편 로그인 뒤 휴면 화면이 나오면 동의하고 눌러 로그인까지 간다', async () => {
    const login = { url: 'https://shop.test/login', text: '[e8 버튼 "카카오로 시작하기"]' }
    const signed = { url: 'https://shop.test/', text: '[e1 링크 "로그아웃"]' }
    const d = { ...dormant, url: 'https://shop.test/auth/dormants/cert' }
    const b = tabsBrowser({ 7: [login, d, signed] }, (_tab, ref) =>
      ref === 'e8' ? { advance: [7] } : ref === 'e4' ? { advance: [7] } : {},
    )
    const r = await socialLogin(
      b,
      {
        card: { id: 'shop', name: '시험 가게' },
        url: login.url,
        provider: 'kakao',
        creds: async () => undefined,
      },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toEqual(['e8', 'e2', 'e4'])
  })
})

describe('같은 계정 맞추기 (카카오는 같은 계정을 가려서도, 전부도 보여 줌)', () => {
  it('가린 이메일과 전체 이메일', () => {
    expect(sameAccount('f***@gmail.com', 'felix990810@gmail.com')).toBe(true)
    expect(sameAccount('felix990810@gmail.com', 'f***@gmail.com')).toBe(true)
    expect(sameAccount('f***@gmail.com', 'mdjoo@gmail.com')).toBe(false)
    expect(sameAccount('f***@gmail.com', 'felix@naver.com')).toBe(false)
    expect(sameAccount('Felix@Gmail.com', 'felix@gmail.com')).toBe(true)
  })
})

describe('카카오 동의의 (필수) 칸이 눌러지지 않으면 (실측 올리브영 CJ ONE)', () => {
  const login = { url: 'https://shop.test/login', text: '[e8 버튼 "카카오로 시작하기"]' }
  const signed = { url: 'https://shop.test/', text: '[e1 링크 "로그아웃"]' }
  const consent = {
    url: 'https://kauth.kakao.com/oauth/authorize',
    text: [
      '로그인된 계정 f***@gmail.com [e1 링크 "계정 변경"]',
      '[e2 체크박스 "(필수) 선불전자지급수단 서비스 이용약관"] [e3 버튼 "(필수) 선불전자지급수단 서비스 이용약관"]',
      '[e9 버튼 "동의하고 계속하기"]',
    ].join('\n'),
  }
  const checked = { ...consent, text: consent.text.replace('이용약관"]', '이용약관" 선택됨]') }
  it('칸이 안 먹으면 같은 이름의 글자 줄을 누르고, 체크되면 동의한다', async () => {
    // 칸(e2)을 눌러도 그대로, 글자 줄(e3)을 누르면 체크된다
    const b = tabsBrowser({ 7: [login, signed], 8: [consent, checked] }, (tab, ref) =>
      tab === 7 && ref === 'e8'
        ? { newTabId: 8, advance: [] }
        : ref === 'e3'
          ? { advance: [8] }
          : ref === 'e9'
            ? { advance: [7] }
            : { advance: [] },
    )
    const r = await socialLogin(
      b,
      {
        card: { id: 'shop', name: '시험 가게' },
        url: login.url,
        provider: 'kakao',
        creds: async () => undefined,
        ask: { known: { has: () => true, add: () => {} } },
      },
      { wait: 0 },
    )
    expect(r.status).toBe('ok')
    expect(b.calls.filter(([m]) => m === 'click').map(([, a]) => a.ref)).toEqual(['e8', 'e2', 'e3', 'e9'])
  })
})

describe('로그인 상태 유지 (서비스마다 카카오 로그인·카톡 확인을 또 하지 않게)', () => {
  it('안 켜져 있으면 그 칸, 켜져 있으면 없음', () => {
    expect(keepSignedIn('[e7 체크박스 "로그인 상태 유지"] [e8 버튼 "로그인 상태 유지"]')).toBe('e7')
    expect(keepSignedIn('[e7 체크박스 "로그인 상태 유지" 선택됨]')).toBeUndefined()
    expect(keepSignedIn('[e3 체크박스 "Stay signed in"]')).toBe('e3')
    expect(keepSignedIn('[e2 체크박스 "(필수) 약관"]')).toBeUndefined()
  })
})
