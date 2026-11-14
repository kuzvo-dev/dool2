import { describe, expect, it } from 'vitest'
import { BrowserTools, classifyRisk, parseRefs } from './browser-tools.js'

const PAGE = `# 두리 시험 가게
검색어 [e1 입력칸 "검색어" 값="사과"] [e2 버튼 "검색"]
사과 1kg 9,900원 [e3 버튼 "장바구니 담기"] [e4 버튼 "바로 구매"]
[e5 링크 "리뷰 쓰기"] [e6 체크박스 "전체 동의" 선택됨] [e7 버튼]`

describe('위험한 동작 가리기', () => {
  it('돈·연락·되돌릴 수 없는 버튼을 알아본다', () => {
    expect(classifyRisk('버튼 바로 구매', 'https://shop.example/item/1')?.kind).toBe('money')
    expect(classifyRisk('버튼 결제하기', 'https://x')?.kind).toBe('money')
    expect(classifyRisk('버튼 예약 확정', 'https://x')?.kind).toBe('money')
    expect(classifyRisk('버튼 Place order', 'https://x')?.kind).toBe('money')
    expect(classifyRisk('버튼 보내기', 'https://x')?.kind).toBe('contact')
    expect(classifyRisk('버튼 등록', 'https://x')?.kind).toBe('contact')
    expect(classifyRisk('버튼 회원 탈퇴', 'https://x')?.kind).toBe('irreversible')
  })

  it('결제 단계 페이지에서는 무엇이든 위험으로 본다', () => {
    expect(classifyRisk('버튼 다음', 'https://order.example.com/checkout/step2')?.kind).toBe('money')
    expect(classifyRisk('버튼 확인', 'https://pay.naver.com/x')?.kind).toBe('money')
  })

  it('보통 조회는 막지 않는다', () => {
    expect(classifyRisk('버튼 검색', 'https://www.naver.com/')).toBeUndefined()
    expect(classifyRisk('링크 다음 페이지', 'https://shop.example/list?page=2')).toBeUndefined()
    expect(classifyRisk('버튼 장바구니 담기', 'https://shop.example/item/1')).toBeUndefined()
    expect(classifyRisk('링크 상품 등록일순', 'https://shop.example/list')).toBeUndefined()
    expect(classifyRisk('링크 결제 내역', 'https://x')?.kind).toBe('money') // 의심되면 막는다
  })

  it('페이지 글에서 표시를 모은다', () => {
    const refs = parseRefs(PAGE)
    expect(refs.get('e1')).toEqual({ role: '입력칸', name: '검색어' })
    expect(refs.get('e4')).toEqual({ role: '버튼', name: '바로 구매' })
    expect(refs.get('e6')).toEqual({ role: '체크박스', name: '전체 동의' })
    expect(refs.get('e7')).toEqual({ role: '버튼', name: '' })
  })
})

function fakeBrowser() {
  const calls: [string, Record<string, unknown> | undefined][] = []
  return {
    calls,
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      if (cmd === 'open') return { tabId: 3 }
      if (cmd === 'snapshot')
        return {
          tabId: 3,
          url: 'https://shop.example/item/1',
          title: '가게',
          text: PAGE,
          truncated: false,
          captcha: false,
        }
      return { tabId: 3 }
    },
  }
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('브라우저 도구 실행', () => {
  it('열면 바로 읽어 돌려준다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    const r = await tools.run('open', { url: 'https://shop.example' })
    expect(text(r)).toContain('[탭 3] 가게 — https://shop.example/item/1')
    expect(text(r)).toContain('[e4 버튼 "바로 구매"]')
    expect(b.calls.map((c) => c[0])).toEqual(['open', 'snapshot'])
  })

  it('구매 버튼은 누르지 않고 사람에게 넘기라고 한다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e4' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('"구매"')
    expect(text(r)).toContain('사용자가 직접')
    expect(b.calls.map((c) => c[0])).not.toContain('click')

    const ok = await tools.run('click', { tabId: 3, ref: 'e3' })
    expect(ok.isError).toBeUndefined()
    expect(b.calls.map((c) => c[0])).toContain('click')
  })

  it('읽지 않은 표시는 누르지 않는다', async () => {
    const tools = new BrowserTools(fakeBrowser())
    const r = await tools.run('click', { tabId: 3, ref: 'e2' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('먼저 페이지를 읽어')
  })

  it('캡차가 보이면 사람에게 부탁하라고 적는다', async () => {
    const b = fakeBrowser()
    b.call = async (cmd: string) =>
      cmd === 'snapshot'
        ? {
            tabId: 3,
            url: 'https://x/login',
            title: '로그인',
            text: '자동입력 방지',
            truncated: false,
            captcha: true,
          }
        : { tabId: 3 }
    const r = await new BrowserTools(b).run('read', { tabId: 3 })
    expect(text(r)).toContain('로봇 확인')
  })

  it('확장이 없으면 오류를 글로 돌려준다', async () => {
    const tools = new BrowserTools({
      call: async () => {
        throw new Error('Chrome의 두리 확장 프로그램과 연결돼 있지 않아요')
      },
    })
    const r = await tools.run('open', { url: 'https://x' })
    expect(r).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Chrome의 두리 확장 프로그램과 연결돼 있지 않아요' }],
    })
  })
})
