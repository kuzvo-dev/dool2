import type { ConnectCard } from '@dool2/protocol/connect'
import { describe, expect, it } from 'vitest'
import { LoginWatch, looksSignedIn } from './connect-watch.js'

const card = { id: 'demo', signedIn: undefined } as unknown as ConnectCard

describe('로그인 확인', () => {
  it('로그인한 사람에게만 보이는 말이 있으면 로그인한 것', () => {
    // 로그아웃이 숨은 메뉴에만 있는 사이트(컬리): 위쪽 이름 버튼으로
    expect(
      looksSignedIn(card, {
        url: 'https://mail.google.com/mail/u/0/#inbox',
        text: '[e14 버튼 "Google 계정: 쿠즈보 (a@b.com)"]\n[e18 버튼 "편지쓰기"]',
      }),
    ).toBe(true)
    expect(
      looksSignedIn(card, { url: 'https://www.kurly.com/main', text: '[e1 버튼 "주*돈 님"]\n고객센터' }),
    ).toBe(true)
    expect(looksSignedIn(card, { url: 'https://demo.co.kr/', text: '[e2 링크 "홍길동님"]' })).toBe(true)
    expect(
      looksSignedIn(card, { url: 'https://demo.co.kr/', text: '[e2 링크 "고객님"] [e3 링크 "로그인"]' }),
    ).toBe(false)
    expect(looksSignedIn(card, { url: 'https://demo.co.kr/', text: '[e3 링크 "로그아웃"] 마이페이지' })).toBe(
      true,
    )
    expect(looksSignedIn(card, { url: 'https://demo.co.kr/', text: '[e3 링크 "로그인"] 회원가입' })).toBe(
      false,
    )
    // 로그인 화면 주소에 비밀번호 칸이 있으면 글자가 있어도 아직 아니다
    expect(
      looksSignedIn(card, {
        url: 'https://demo.co.kr/member/login?next=/',
        text: '로그아웃 [e2 비밀번호칸 "비밀번호"]',
      }),
    ).toBe(false)
    // 주소가 그대로여도 비밀번호 칸이 사라지고 로그아웃이 보이면 로그인됐다
    expect(
      looksSignedIn(card, { url: 'https://demo.co.kr/member/login', text: '[e3 링크 "로그아웃"]' }),
    ).toBe(true)
    // 카드에 적은 말은 흔한 말(로그아웃)에 더한다
    const own = { ...card, signedIn: ['받은메일함'] }
    expect(looksSignedIn(own, { url: 'https://demo.co.kr/', text: '로그아웃' })).toBe(true)
    expect(looksSignedIn(own, { url: 'https://demo.co.kr/', text: '[e3 링크 "받은메일함 선택됨"]' })).toBe(
      true,
    )
    expect(looksSignedIn(own, { url: 'https://demo.co.kr/', text: '[e1 링크 "로그인"]' })).toBe(false)
  })

  it('로그인 화면을 거친 뒤 사이트로 돌아와 로그인 입구가 사라졌으면 로그인됨 (로그아웃이 숨은 사이트)', () => {
    const shop = { id: 'shop', site: 'shop.co.kr' } as unknown as ConnectCard
    const menu = Array.from({ length: 25 }, (_, i) => `[e${i + 10} 링크 "상품 ${i}"]`).join('\n')
    const home = { url: 'https://www.shop.co.kr/', text: `[e1 링크 "마이페이지"]\n${menu}` }
    // 로그인 화면을 보기 전(첫 화면부터 입구가 없는 사이트)은 모른다
    expect(looksSignedIn(shop, home)).toBe(false)
    expect(looksSignedIn(shop, home, { sawEntry: true })).toBe(true)
    // 입구가 아직 있으면 아니다 ("로그인/회원가입", "카카오 로그인")
    for (const entry of [
      '[e2 링크 "로그인/회원가입"]',
      '[e2 버튼 "카카오 로그인"]',
      '[e2 비밀번호칸 "비밀번호"]',
    ])
      expect(looksSignedIn(shop, { ...home, text: `${entry}\n${home.text}` }, { sawEntry: true })).toBe(false)
    // 다른 사이트(공급자 화면)·로그인 주소·덜 그려진 화면은 아니다
    expect(looksSignedIn(shop, { ...home, url: 'https://kauth.kakao.com/oauth' }, { sawEntry: true })).toBe(
      false,
    )
    expect(looksSignedIn(shop, { ...home, url: 'https://shop.co.kr/login' }, { sawEntry: true })).toBe(false)
    expect(looksSignedIn(shop, { ...home, text: '[e1 링크 "마이페이지"]' }, { sawEntry: true })).toBe(false)
  })

  it('지켜보다 로그인 화면이 사라지고 사이트 첫 화면이 되면 연결 (로그아웃 글자 없이)', async () => {
    const shop = { id: 'shop', site: 'shop.co.kr' } as unknown as ConnectCard
    const menu = Array.from({ length: 25 }, (_, i) => `[e${i + 10} 링크 "상품 ${i}"]`).join('\n')
    const pages = [
      { url: 'https://shop.co.kr/member/login', text: '[e1 입력칸 "아이디"] [e2 비밀번호칸 "비밀번호"]' },
      { url: 'https://shop.co.kr/', text: menu },
    ]
    let i = 0
    const done: string[] = []
    const watch = new LoginWatch(
      {
        snapshot: async () => pages[Math.min(i++, pages.length - 1)] as { url: string; text: string },
        connected: () => false,
        onSignedIn: (c) => done.push(c.id),
      },
      1,
    )
    watch.start(shop, 7)
    await new Promise((r) => setTimeout(r, 50))
    watch.stopAll()
    expect(done).toEqual(['shop'])
  })

  it('네이버 위쪽 줄의 "아이디 내정보 보기"는 로그인됨 (로그아웃은 메뉴 속)', () => {
    expect(
      looksSignedIn(card, {
        url: 'https://mail.naver.com/v2/folders/0/all',
        text: '[e4 링크 "wwd 내정보 보기"]',
      }),
    ).toBe(true)
    expect(looksSignedIn(card, { url: 'https://www.naver.com/', text: '[e4 링크 "내정보 보기"]' })).toBe(
      false,
    )
  })

  it('탭을 지켜보다 로그인하면 한 번 알리고 멈춘다', async () => {
    const pages = [
      { url: 'https://demo.co.kr/login', text: '로그인' },
      { url: 'https://demo.co.kr/', text: '홈 로그아웃' },
    ]
    const seen: string[] = []
    let i = 0
    const w = new LoginWatch(
      {
        snapshot: async () => pages[Math.min(i++, pages.length - 1)] ?? { url: '', text: '' },
        connected: () => false,
        onSignedIn: (c) => seen.push(c.id),
      },
      5,
      1_000,
    )
    w.start(card, 1)
    for (let t = 0; t < 100 && !seen.length; t++) await new Promise((r) => setTimeout(r, 5))
    expect(seen).toEqual(['demo'])
    expect(w.watching('demo')).toBe(false)
  })

  it('탭이 닫히거나 이미 연결됐으면 그만 본다', async () => {
    let calls = 0
    const closed = new LoginWatch(
      {
        snapshot: async () => {
          calls++
          throw new Error('탭이 닫혔어요')
        },
        connected: () => false,
        onSignedIn: () => {},
      },
      5,
      1_000,
    )
    closed.start(card, 1)
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toBe(1)
    expect(closed.watching('demo')).toBe(false)

    let reads = 0
    const done = new LoginWatch(
      {
        snapshot: async () => {
          reads++
          return { url: '', text: '' }
        },
        connected: () => true,
        onSignedIn: () => {},
      },
      5,
      1_000,
    )
    done.start(card, 1)
    await new Promise((r) => setTimeout(r, 40))
    expect(reads).toBe(0)
  })
})

describe('지켜보던 탭이 닫히면', () => {
  it('한 번만 알리고 그 탭은 더 지켜보지 않는다 (카카오 팝업이 확인 뒤 스스로 닫힘)', async () => {
    const closed: string[] = []
    const watch = new LoginWatch(
      {
        snapshot: async () => {
          throw new Error('탭이 없어요')
        },
        connected: () => false,
        onSignedIn: () => {},
        onClosed: (c) => closed.push(c.id),
      },
      1,
    )
    watch.start({ id: 'shop' } as unknown as ConnectCard, 9)
    await new Promise((r) => setTimeout(r, 30))
    expect(closed).toEqual(['shop'])
    expect(watch.tabOf('shop')).toBeUndefined()
  })
})
