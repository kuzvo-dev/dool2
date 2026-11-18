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
    // 카드에 적은 말이 있으면 그 말로 본다
    const own = { ...card, signedIn: ['마이데모'] }
    expect(looksSignedIn(own, { url: 'https://demo.co.kr/', text: '로그아웃' })).toBe(false)
    expect(looksSignedIn(own, { url: 'https://demo.co.kr/', text: '마이데모 님' })).toBe(true)
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
