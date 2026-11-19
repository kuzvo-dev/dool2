import { describe, expect, it } from 'vitest'
import { checkSignedIn, judgeHome, judgeMyPage } from './signin-check.js'

const card = { id: 'shop', site: 'shop.co.kr' }

describe('로그인 상태 확인 (실측 2026-11-19)', () => {
  it('첫 화면: 확실한 표시면 로그인됨, 입구면 풀림, 둘 다 없으면 모름', () => {
    expect(judgeHome(card, { url: 'https://shop.co.kr/', text: '[e1 버튼 "주명돈님"]' })?.state).toBe('in')
    expect(
      judgeHome(card, { url: 'https://shop.co.kr/', text: '[e1 링크 "로그인"] [e2 링크 "회원가입"]' })?.state,
    ).toBe('out')
    expect(judgeHome(card, { url: 'https://shop.co.kr/', text: '[e1 링크 "마이페이지"]' })).toBeUndefined()
  })
  it('마이페이지를 눌러 로그인 화면이면 풀림, 화면이 그대로면 모름, 넘어가면 로그인됨 (중고나라·지그재그·티빙)', () => {
    const home = { url: 'https://shop.co.kr/', text: '[e1 링크 "마이"]' }
    expect(
      judgeMyPage(card, home, { url: 'https://web.shop.co.kr/signin?callbackUrl=%2Fmy', text: '' }).state,
    ).toBe('out')
    expect(judgeMyPage(card, home, home).state).toBe('unknown')
    expect(
      judgeMyPage(card, home, { url: 'https://shop.co.kr/my-page', text: '[e3 링크 "주문 내역"]' }).state,
    ).toBe('in')
  })
  it('브라우저로: 첫 화면에 표시가 없으면 마이를 눌러 보고 탭은 닫는다', async () => {
    const calls: string[] = []
    const pages: Record<number, { url: string; text: string }> = {
      1: { url: 'https://shop.co.kr/', text: '[e4 링크 "마이"] [e5 링크 "상품"]' },
      2: { url: 'https://shop.co.kr/login?next=/my', text: '[e1 비밀번호칸 "비밀번호"]' },
    }
    const browser = {
      async call(m: string, a: Record<string, unknown>) {
        calls.push(m)
        if (m === 'open') return { tabId: 1 }
        if (m === 'click') return { newTabId: 2 }
        if (m === 'snapshot') return pages[Number(a.tabId)]
        return {}
      },
    }
    const r = await checkSignedIn(browser, card, { wait: 0 })
    expect(r.state).toBe('out')
    expect(calls.filter((c) => c === 'close')).toHaveLength(2)
  })
})
