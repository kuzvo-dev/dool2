import { describe, expect, it } from 'vitest'
import {
  BrowserTools,
  checkoutScreen,
  classifyDialogRisk,
  classifyRisk,
  confirmedScreen,
  isCheckoutEntry,
  nearlyEmpty,
  PAY_FLOW_TTL_MS,
  parseRefs,
  payScreen,
  type SiteDialog,
  scopeLines,
} from './browser-tools.js'

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

  it('주소가 그대로인 결제 화면에서는 "다음"·"확인"도 막는다', () => {
    const map = 'https://app.catchtable.co.kr/ct/map/search-map?keyword=성수'
    const pay = payScreen(
      '## 예약금 결제 방법 선택\n[e454 라디오 "예약금 0원 결제" 선택됨]\n[e456 버튼 "이전"] [e457 버튼 "다음"]',
    )
    expect(pay).toBe('결제 방법')
    expect(classifyRisk('버튼 다음', map, pay)?.kind).toBe('money')
    expect(classifyRisk('버튼 확인', map, pay)?.kind).toBe('money')
    expect(classifyRisk('버튼 이전', map, pay)).toBeUndefined()
    // 방식 고르기 라디오는 확정이 아니라서 막지 않는다 (마지막 버튼에서 승인)
    expect(classifyRisk('라디오 예약금 결제예약금 40,000원', map, pay)).toBeUndefined()
    expect(classifyRisk('체크박스 결제 진행 필수 동의', map, pay)).toBeUndefined()
    // 예약금 안내(결제 방법 고르기 전)의 "다음"은 막지 않는다
    expect(payScreen('## 예약금 안내\n1인당 예약금 10,000원\n총 예약금 40,000원')).toBeUndefined()
    expect(classifyRisk('버튼 다음', map, undefined)).toBeUndefined()
    // 실제 캐치테이블 화면: "결제 방식 선택"과 팝업의 "이 방식으로 예약"
    const pay2 = payScreen(
      '## 결제 방식 선택\n[e206 라디오 "예약금 0원 + 자동결제" 선택됨]\n[e210 버튼 "다음"]',
    )
    expect(classifyRisk('버튼 다음', map, pay2)?.kind).toBe('money')
    expect(classifyRisk('버튼 최대 혜택 이 방식으로 예약', map)?.kind).toBe('money')
    expect(classifyRisk('버튼 바로 예약', map)?.kind).toBe('money')
    expect(classifyRisk('버튼 예약', map)).toBeUndefined() // 검색 화면의 '예약' 탭
    expect(classifyRisk('버튼 11.27 (금) 예약 가능', map)).toBeUndefined()
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

  it('구매 버튼은 누르지 않고 승인을 요청하라고 한다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e4' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('"구매"')
    expect(text(r)).toContain('browser_request_approval')
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

describe('사이트 알림창', () => {
  it('확인 창 글로 결제·보내기·삭제가 되는 [확인]을 알아본다', () => {
    const at = 'https://shop.example/item/1'
    expect(classifyDialogRisk('사과 1kg을 주문하시겠습니까?', at)?.kind).toBe('money')
    expect(classifyDialogRisk('예약하시겠습니까?', at)?.kind).toBe('money')
    expect(classifyDialogRisk('결제를 진행할까요?', at)?.kind).toBe('money')
    expect(classifyDialogRisk('메시지를 보내시겠습니까?', at)?.kind).toBe('contact')
    expect(classifyDialogRisk('선택한 상품을 삭제할까요?', at)?.kind).toBe('irreversible')
    expect(classifyDialogRisk('예약을 취소하시겠습니까?', at)).toBeDefined()
    // 결제 단계 페이지의 확인 창은 무엇이든
    expect(classifyDialogRisk('쿠폰을 적용할까요?', 'https://shop.example/checkout')?.kind).toBe('money')
    // 보통 확인은 막지 않는다
    expect(classifyDialogRisk('장바구니로 이동할까요?', at)).toBeUndefined()
    expect(classifyDialogRisk('로그인이 필요합니다. 로그인 페이지로 이동할까요?', at)).toBeUndefined()
    expect(classifyDialogRisk('예약 내역을 보시겠어요?', at)).toBeUndefined()
  })

  function dialogBrowser(dialog?: SiteDialog, notes?: SiteDialog[]) {
    const state = { dialog, notes }
    const calls: [string, Record<string, unknown> | undefined][] = []
    return {
      calls,
      state,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot') {
          const s = {
            tabId: 3,
            url: 'https://shop.example/item/1',
            title: '가게',
            text: state.dialog ? '' : PAGE,
            truncated: false,
            captcha: false,
            ...(state.dialog ? { dialog: state.dialog } : {}),
            ...(state.notes ? { dialogNotes: state.notes } : {}),
          }
          state.notes = undefined
          return s
        }
        if (cmd === 'dialog') state.dialog = undefined
        if (cmd === 'click' && state.dialog)
          return { tabId: 3, url: 'https://shop.example/item/1', dialog: state.dialog }
        return { tabId: 3, url: 'https://shop.example/item/1', title: '가게' }
      },
    }
  }

  it('바로 닫은 알림창 글을 페이지와 함께 알린다', async () => {
    const b = dialogBrowser(undefined, [
      { type: 'alert', message: '아이디 또는 비밀번호가 틀렸어요', url: 'https://shop.example/' },
      { type: 'beforeunload', message: '', url: 'https://shop.example/' },
    ])
    const r = text(await new BrowserTools(b).run('read', { tabId: 3 }))
    expect(r).toContain('💬 사이트 알림창: "아이디 또는 비밀번호가 틀렸어요"')
    expect(r).toContain('떠날지 묻는 창')
    expect(r).toContain('[e4 버튼 "바로 구매"]')
  })

  it('떠 있는 확인 창은 AI가 고르고, 페이지가 멈춰 있으니 다시 읽지 않는다', async () => {
    const b = dialogBrowser({
      type: 'confirm',
      message: '장바구니로 이동할까요?',
      url: 'https://shop.example/',
    })
    const tools = new BrowserTools(b)
    const r = text(await tools.run('read', { tabId: 3 }))
    expect(r).toContain('⚠ 사이트 확인 창이 떠 있어요: "장바구니로 이동할까요?"')
    expect(r).toContain('browser_dialog')
    // 빈 화면이라고 1.5초 기다려 다시 읽지 않는다
    expect(b.calls.filter((c) => c[0] === 'snapshot')).toHaveLength(1)
    const done = await tools.run('dialog', { tabId: 3, accept: false })
    expect(done.isError).toBeUndefined()
    expect(b.calls.find((c) => c[0] === 'dialog')?.[1]).toEqual({
      tabId: 3,
      accept: false,
      expect: '장바구니로 이동할까요?',
    })
    expect(text(done)).toContain('[취소]')
    expect(text(done)).toContain('[e4 버튼 "바로 구매"]')
  })

  it('입력 창은 넣을 글을 함께 넘긴다', async () => {
    const b = dialogBrowser({ type: 'prompt', message: '수량', url: 'https://x/', defaultPrompt: '1' })
    const tools = new BrowserTools(b)
    expect(text(await tools.run('read', { tabId: 3 }))).toContain('미리 적힌 글: "1"')
    await tools.run('dialog', { tabId: 3, accept: true, text: '3' })
    expect(b.calls.find((c) => c[0] === 'dialog')?.[1]).toMatchObject({ accept: true, text: '3' })
  })

  it('떠 있는 창이 없으면 고르지 않는다', async () => {
    const r = await new BrowserTools(dialogBrowser()).run('dialog', { tabId: 3, accept: true })
    expect(r.isError).toBe(true)
  })

  it('주문이 되는 [확인]은 승인을 받아야 두리가 누른다', async () => {
    const b = dialogBrowser({
      type: 'confirm',
      message: '9,900원을 결제하시겠습니까?',
      url: 'https://shop.example/',
    })
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const blocked = await tools.run('dialog', { tabId: 3, accept: true })
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toContain('dialog: true')
    expect(b.calls.map((c) => c[0])).not.toContain('dialog')
    // [취소]는 막지 않는다
    expect(tools.approvals.list()).toHaveLength(0)
    const asked = await tools.run('request_approval', {
      tabId: 3,
      dialog: true,
      what: '사과 결제',
      where: '가게',
    })
    expect(asked.isError).toBeUndefined()
    const [rec] = tools.approvals.list()
    expect(rec).toMatchObject({ role: '확인 창', kind: 'money', label: '확인 — 9,900원을 결제하시겠습니까?' })
    // 화면이 멈춰 있어 캡처를 찍으려 기다리지 않는다
    expect(b.calls.map((c) => c[0])).not.toContain('screenshot')
    const ok = await tools.approve(rec?.id as string)
    expect(ok.ok).toBe(true)
    expect(b.calls.find((c) => c[0] === 'dialog')?.[1]).toEqual({
      tabId: 3,
      accept: true,
      expect: '9,900원을 결제하시겠습니까?',
    })
  })

  it('승인한 버튼을 누르자 뜬 "정말 하시겠어요?" 창은 함께 확인한다', async () => {
    const b = dialogBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e4', what: '사과', where: '가게' })
    const [rec] = tools.approvals.list()
    b.state.dialog = { type: 'confirm', message: '구매하시겠습니까?', url: 'https://shop.example/' }
    const real = b.call
    // 누르기 직전 다시 읽을 때는 창이 없고, 누른 뒤에 뜬다
    let clicked = false
    b.call = async (cmd, args) => {
      if (cmd === 'snapshot' && !clicked) {
        const keep = b.state.dialog
        b.state.dialog = undefined
        const r = await real(cmd, args)
        b.state.dialog = keep
        return r
      }
      if (cmd === 'click') clicked = true
      return real(cmd, args)
    }
    const ok = await tools.approve(rec?.id as string)
    expect(ok.ok).toBe(true)
    expect(ok.message).toContain('구매하시겠습니까?')
    expect(b.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['click', 'dialog']))
  })
})

describe('여러 동작 한 번에', () => {
  const FORM = `# 회원 정보\n가입하려면 아래 칸을 채워 주세요.
[e1 입력칸 "이름"] [e2 입력칸 "휴대폰 번호"] [e3 체크박스 "약관 동의"] [e4 버튼 "다음"] [e5 버튼 "바로 구매"]`
  function formBrowser(
    after?: (cmd: string, args?: Record<string, unknown>) => Record<string, unknown> | undefined,
  ) {
    const calls: [string, Record<string, unknown> | undefined][] = []
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://shop.example/join',
            title: '가입',
            text: FORM,
            truncated: false,
            captcha: false,
          }
        return after?.(cmd, args) ?? { tabId: 3, url: 'https://shop.example/join', title: '가입' }
      },
    }
  }

  it('칸 여러 개를 채우고 누른 뒤 한 번만 읽는다', async () => {
    const b = formBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('steps', {
      tabId: 3,
      steps: [
        { do: 'type', ref: 'e1', text: '김두리' },
        { do: 'type', ref: 'e2', text: '01012345678' },
        { do: 'click', ref: 'e3' },
        { do: 'click', ref: 'e4' },
      ],
    })
    expect(r.isError).toBeUndefined()
    expect(b.calls.map((c) => c[0])).toEqual(['snapshot', 'type', 'type', 'click', 'click', 'snapshot'])
    expect(text(r)).toContain('1. "이름"에 입력했어요.')
    expect(text(r)).toContain('4. 버튼 "다음"을(를) 눌렀어요.')
  })

  it('다른 화면으로 넘어가면 남은 동작은 하지 않는다', async () => {
    const b = formBrowser((cmd, args) =>
      cmd === 'click' && args?.ref === 'e4' ? { tabId: 3, url: 'https://shop.example/join/2' } : undefined,
    )
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('steps', {
      tabId: 3,
      steps: [
        { do: 'click', ref: 'e4' },
        { do: 'type', ref: 'e1', text: '옛 화면의 칸' },
      ],
    })
    expect(b.calls.map((c) => c[0])).toEqual(['snapshot', 'click', 'snapshot'])
    expect(text(r)).toContain('다른 화면으로 넘어가서 남은 1개 동작은 하지 않았어요')
  })

  it('확인 창이 뜨면 멈추고 알린다', async () => {
    const b = formBrowser((cmd) =>
      cmd === 'click'
        ? {
            tabId: 3,
            url: 'https://shop.example/join',
            dialog: { type: 'confirm', message: '다음으로 갈까요?', url: '' },
          }
        : undefined,
    )
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('steps', {
      tabId: 3,
      steps: [
        { do: 'click', ref: 'e4' },
        { do: 'wait', ms: 100 },
      ],
    })
    expect(text(r)).toContain('사이트 확인 창이 떠서 남은 1개 동작은 하지 않았어요')
  })

  it('위험한 버튼은 하나씩 부를 때처럼 막고, 그 앞까지만 한다', async () => {
    const b = formBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('steps', {
      tabId: 3,
      steps: [
        { do: 'type', ref: 'e1', text: '김두리' },
        { do: 'click', ref: 'e5' },
        { do: 'click', ref: 'e4' },
      ],
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('2. 멈췄어요')
    expect(text(r)).toContain('browser_request_approval')
    expect(text(r)).toContain('남은 1개 동작은 하지 않았어요')
    expect(b.calls.filter((c) => c[0] === 'click')).toHaveLength(0)
  })

  it('올려 두기는 누르지 않으니 위험한 버튼에도 막지 않는다', async () => {
    const b = formBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('hover', { tabId: 3, ref: 'e5' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('버튼 "바로 구매"에 마우스를 올렸어요.')
    expect(b.calls.map((c) => c[0])).toEqual(['snapshot', 'hover', 'snapshot'])
  })

  it('정해진 동작만, 먼저 읽은 화면에서만 한다', async () => {
    const tools = new BrowserTools(formBrowser())
    expect((await tools.run('steps', { tabId: 3, steps: [{ do: 'wait' }] })).isError).toBe(true)
    await tools.run('read', { tabId: 3 })
    const bad = await tools.run('steps', { tabId: 3, steps: [{ do: 'eval', code: 'alert(1)' }] })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('모르는 동작')
    const many = await tools.run('steps', {
      tabId: 3,
      steps: Array.from({ length: 13 }, () => ({ do: 'wait' })),
    })
    expect(text(many)).toContain('12개까지')
  })
})

describe('필요한 부분만 읽기', () => {
  it('view·from·skip을 확장에 넘기고 어디를 읽었는지 알린다', async () => {
    const calls: Record<string, unknown>[] = []
    const tools = new BrowserTools({
      call: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'snapshot') {
          calls.push(args ?? {})
          return {
            tabId: 3,
            url: 'https://shop.example/list',
            title: '목록',
            text: '상품 150 사과 9,900원 [e150 버튼 "담기"]',
            truncated: true,
            captcha: false,
            skipped: 41_000,
          }
        }
        return { tabId: 3 }
      },
    })
    const r = text(await tools.run('read', { tabId: 3, from: '상품 150' }))
    expect(calls[0]).toEqual({ tabId: 3, maxChars: 8000, from: '상품 150' })
    expect(r).toContain('앞 41,000자는 건너뛰고 읽었어요')
    // 잘렸으면 이어 읽을 자리를 알려 준다
    expect(r).toMatch(/skip: \d+/)
    // 일부만 읽을 때는 글이 적어도 빈 화면으로 보고 다시 읽지 않는다
    expect(calls).toHaveLength(1)
    expect(text(await tools.run('click', { tabId: 3, ref: 'e150' }))).not.toContain('몰라요')
  })

  it('보이는 부분만 읽으면 위·아래에 남은 글을 알린다', () => {
    expect(scopeLines({ around: { above: 1200, below: 0 } }, { view: true })).toEqual([
      '(지금 화면에 보이는 부분만 읽었어요. ↑ 위에 글 1,200자쯤)',
    ])
    expect(scopeLines({ fromMissing: true }, { from: '없는 말' })[0]).toContain('찾지 못해 처음부터')
  })

  it('스크롤하면 보이는 부분을 읽어 돌려준다', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const tools = new BrowserTools({
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://x/',
            title: 'x',
            text: '보이는 줄',
            truncated: false,
            captcha: false,
            around: { above: 900, below: 3000 },
          }
        return { tabId: 3 }
      },
    })
    const r = text(await tools.run('scroll', { tabId: 3, direction: 'down' }))
    expect(calls.map((c) => c[0])).toEqual(['scroll', 'snapshot'])
    expect(calls[1]?.[1]).toMatchObject({ view: true })
    expect(r).toContain('↓ 화면 아래에 글이 3,000자쯤 더 있어요')
  })
})

describe('원격 화면 (폰)', () => {
  it('두리가 사람에게 넘긴 탭만, 30분 동안 보고 누를 수 있다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    // 넘기기 전에는 안 된다
    await expect(tools.remoteScreen(3)).rejects.toThrow('원격 화면으로 볼 수 없어요')
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('handoff', { tabId: 3, reason: '로그인해 주세요' })
    expect(tools.remoteAllowed(3)).toBe(true)
    expect(tools.remoteAllowed(4)).toBe(false)
    expect(tools.remoteAllowed(3, Date.now() + 31 * 60_000)).toBe(false)
  })

  it('누른 자리(사진 비율)를 페이지 좌표로 바꾸고, 화면 밖은 거절한다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('handoff', { tabId: 3, reason: '로그인해 주세요' })
    await tools.remoteInput(3, { action: 'tap', x: 0.5, y: 0.25 }, { width: 1200, height: 800 })
    expect(b.calls.at(-1)).toEqual(['input', { tabId: 3, action: 'tap', x: 600, y: 200 }])
    await expect(
      tools.remoteInput(3, { action: 'tap', x: 1.5, y: 0 }, { width: 1200, height: 800 }),
    ).rejects.toThrow('화면 밖')
    await tools.remoteInput(3, { action: 'text', text: 'a'.repeat(900) }, { width: 1, height: 1 })
    expect(String(b.calls.at(-1)?.[1]?.text)).toHaveLength(500)
  })

  it('폰 너비로 그리기·손가락 스크롤: 크기와 끈 만큼을 넘기고, 스크롤 자리는 페이지 좌표로 바꾼다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('handoff', { tabId: 3, reason: '본인인증해 주세요' })
    await tools.remoteInput(3, { action: 'view', w: 370, h: 640 }, { width: 1200, height: 800 })
    expect(b.calls.at(-1)).toEqual(['input', { tabId: 3, action: 'view', w: 370, h: 640 }])
    await tools.remoteInput(3, { action: 'scroll', dy: 240, x: 0.5, y: 0.5 }, { width: 370, height: 640 })
    expect(b.calls.at(-1)).toEqual(['input', { tabId: 3, action: 'scroll', dy: 240, x: 185, y: 320 }])
    // 예전 폰: ±1은 한 화면씩
    await tools.remoteInput(3, { action: 'scroll', dy: -1 }, { width: 370, height: 640 })
    expect(b.calls.at(-1)).toEqual(['input', { tabId: 3, action: 'scroll', dy: -1 }])
    // 너무 크게 끈 건 잘라서
    await tools.remoteInput(3, { action: 'scroll', dy: 99999 }, { width: 370, height: 640 })
    expect(b.calls.at(-1)?.[1]).toMatchObject({ dy: 3000 })
    await tools.remoteInput(3, { action: 'leave' }, { width: 370, height: 640 })
    expect(b.calls.at(-1)).toEqual(['input', { tabId: 3, action: 'leave' }])
  })
})

describe('원격 화면 필요한 칸만', () => {
  it('넘긴 탭만, 값은 잘라서 넘기고 버튼 id도 함께', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://card.example/verify' })
    // 두리가 다룬 적 없는 탭은 안 된다
    await expect(tools.remoteForm(99)).rejects.toThrow('두리가 넘긴 탭만')
    await tools.run('handoff', { tabId: 3, reason: '본인인증해 주세요' })
    await tools.remoteForm(3)
    expect(b.calls.at(-1)).toEqual(['form', { tabId: 3 }])
    await tools.remoteFill(
      3,
      [
        { id: 'f1', value: 'x'.repeat(500) },
        { id: 'f2', pick: 'f9' },
        { id: 'f3', checked: true },
        { id: 'f4', value: 1 as unknown as string },
      ],
      'f7',
    )
    const [cmd, args] = b.calls.at(-1) ?? []
    expect(cmd).toBe('form-fill')
    expect(args).toMatchObject({ tabId: 3, press: 'f7' })
    const values = (args as { values: Record<string, unknown>[] }).values
    expect(String(values[0]?.value)).toHaveLength(200)
    expect(values[1]).toEqual({ id: 'f2', pick: 'f9' })
    expect(values[2]).toEqual({ id: 'f3', checked: true })
    // 글자가 아닌 값은 버린다
    expect(values[3]).toEqual({ id: 'f4' })
  })
})

describe('로그인 카드', () => {
  it('금고에 없는 사이트면 로그인 요청을 만들고, 있으면 browser_login을 쓰게 한다', async () => {
    const b = fakeBrowser()
    let saved: { id: string; username: string; password: string } | undefined
    const vault = {
      findForOrigin: async (origin: string) => (origin === 'https://shop.example' ? saved : undefined),
      markUsed: async () => {},
    }
    const tools = new BrowserTools(b, vault)
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('request_login', { tabId: 3, site: '시험 가게' })
    expect(text(r)).toContain('로그인 카드를 띄웠어요')
    expect(text(r)).not.toMatch(/password|비밀번호:/)
    const req = tools.logins.list()[0]
    expect(req).toMatchObject({
      tabId: 3,
      origin: 'https://shop.example',
      site: '시험 가게',
      status: 'pending',
    })
    // 사용자가 카드에 넣으면 금고에 들어가고, 요청은 "저장됨"
    saved = { id: 'v1', username: 'dool2', password: 'pw' }
    expect(tools.logins.finish(req?.id ?? '', 'saved', 'dool2')).toBe(true)
    expect(tools.logins.get(req?.id ?? '')).toMatchObject({ status: 'saved', username: 'dool2' })
    expect(JSON.stringify(tools.logins.list())).not.toContain('"pw"')
    // 한 번만
    expect(tools.logins.finish(req?.id ?? '', 'saved')).toBe(false)
    expect(text(await tools.run('request_login', { tabId: 3, site: '시험 가게' }))).toContain('browser_login')
  })

  it('https가 아닌 사이트는 로그인 정보를 받지 않는다', async () => {
    const b = fakeBrowser()
    b.call = (async (cmd: string) =>
      cmd === 'snapshot'
        ? {
            tabId: 3,
            url: 'http://shop.example/login',
            title: '',
            text: PAGE,
            truncated: false,
            captcha: false,
          }
        : { tabId: 3 }) as typeof b.call
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'http://shop.example/login' })
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('request_login', { tabId: 3, site: '가게' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('https')
    expect(tools.logins.list()).toHaveLength(0)
  })
})

describe('사이트 요령·빈 화면', () => {
  const EMPTY = '[e1 링크] [e2 링크] [e3 링크] [e4 링크]'
  const browserWith = (texts: string[]) => {
    let n = 0
    return {
      call: async (cmd: string) => {
        if (cmd === 'open') return { tabId: 3 }
        if (cmd === 'snapshot') {
          const t = texts[Math.min(n++, texts.length - 1)]
          return {
            tabId: 3,
            url: 'https://app.catchtable.co.kr/ct/x',
            title: '캐치테이블',
            text: t,
            truncated: false,
            captcha: false,
          }
        }
        return { tabId: 3 }
      },
    }
  }

  it('표시만 있는 화면을 빈 화면으로 본다', () => {
    expect(nearlyEmpty(EMPTY)).toBe(true)
    expect(nearlyEmpty(PAGE)).toBe(false)
  })

  it('서비스 도구가 있는 사이트를 처음 열면 그 도구를 쓰라고 한 번만 알린다', async () => {
    const tools = new BrowserTools(browserWith([PAGE]))
    tools.siteConnector = async (url) =>
      url.includes('catchtable')
        ? { id: 'catchtable', name: '캐치테이블', tools: ['catchtable_search'] }
        : undefined
    const first = text(await tools.run('open', { url: 'https://app.catchtable.co.kr/' }))
    expect(first).toContain('두리 서비스 도구가 있어요: catchtable_search')
    const again = text(await tools.run('read', { tabId: 3 }))
    expect(again).not.toContain('서비스 도구')
  })

  it('막 연 화면이 비어 있으면 한 번 기다렸다 다시 읽는다', async () => {
    const r = text(await new BrowserTools(browserWith([EMPTY, PAGE])).run('read', { tabId: 3 }))
    expect(r).toContain('사과 1kg')
    expect(r).not.toContain('글이 거의 없어요')
  })

  it('계속 비어 있으면 주소가 틀렸을 수 있다고 다른 길을 알린다', async () => {
    const r = text(await new BrowserTools(browserWith([EMPTY])).run('read', { tabId: 3 }))
    expect(r).toContain('글이 거의 없어요')
    expect(r).toContain('홈')
  })
})

describe('글자로 누르기', () => {
  const marking = () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://shop.example/list',
            title: '가게',
            text: PAGE,
            truncated: false,
            captcha: false,
          }
        if (cmd === 'mark-text') {
          const text = String(args?.text)
          return { ok: true, ref: 'e90', name: text === '결제' ? '결제하기' : `${text} 4.6 (394)` }
        }
        return { tabId: 3 }
      },
    }
  }

  it('표시가 없는 상자는 화면 글자로 표시를 붙인 뒤 누른다', async () => {
    const b = marking()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, text: 'ACENO 아세누' })
    expect(r.isError).toBeUndefined()
    expect(b.calls.map((c) => c[0])).toEqual(['snapshot', 'mark-text', 'click', 'snapshot'])
    expect(b.calls[2]?.[1]).toMatchObject({ ref: 'e90' })
  })

  it('글자로 눌러도 승인 게이트를 똑같이 거친다', async () => {
    const b = marking()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, text: '결제' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('멈췄어요')
    expect(b.calls.map((c) => c[0])).not.toContain('click')
  })
})

// 실측 (2026-11-18, 호텔스닷컴): 객실 목록의 [예약하기]는 결제 화면(/checkout/…)을 열 뿐이고,
// 결제 화면은 '체크인 고객 정보'·'요금 세부 정보'가 먼저 보이고 결제 수단은 아래에 있다
const ROOMS = `### 슈피리어 더블룸
총 요금: ₩519,720
[e58 링크 "예약하기 예약"]
[e9 버튼 "로그인"]
[e60 버튼 "바로 예약"]`
const CHECKOUT = `요금 세부 정보
총 금액 ₩519,720
안전한 보안 예약
체크인 고객 정보
[e3 입력칸 "성 *"] [e4 입력칸 "이름 *"]
[e9 버튼 "예약하기"] [e10 버튼 "예약 완료하기"]`

function payBrowser(pages: { url: string; text: string }[]) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  let i = 0
  return {
    calls,
    next: () => {
      i = Math.min(i + 1, pages.length - 1)
    },
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      const page = pages[i] ?? { url: '', text: '' }
      if (cmd === 'snapshot')
        return { tabId: 3, url: page.url, title: '호텔', text: page.text, truncated: false, captcha: false }
      if (cmd === 'click') i = Math.min(i + 1, pages.length - 1)
      return { tabId: 3 }
    },
  }
}

describe('결제 흐름 (돈 내기 표준 순서)', () => {
  const room = { url: 'https://kr.hotels.com/ho480371/?chkin=2027-04-10', text: ROOMS }
  const checkout = { url: 'https://kr.hotels.com/checkout/session/abc', text: CHECKOUT }

  it('결제 화면을 여는 버튼과 결제 화면을 알아본다', () => {
    expect(isCheckoutEntry('예약하기 예약')).toBe(true)
    expect(isCheckoutEntry('구매하기')).toBe(true)
    expect(isCheckoutEntry('바로 구매')).toBe(true)
    expect(isCheckoutEntry('예약 완료하기')).toBe(false)
    expect(isCheckoutEntry('0원 결제로 예약')).toBe(false)
    expect(isCheckoutEntry('결제하기')).toBe(false)
    expect(checkoutScreen(ROOMS, room.url)).toBeUndefined()
    // 상세 화면의 안내 문장 속 '결제 수단'은 결제 화면 표시가 아니다 (실측 문장)
    const notice = `${ROOMS}\n이 숙박 시설에서 사용 가능한 결제 수단은 신용카드, 현금입니다.\n결제 가능한 신용카드: Visa, Mastercard`
    expect(checkoutScreen(notice, room.url)).toBeUndefined()
    expect(payScreen(notice)).toBeUndefined()
    expect(checkoutScreen('## 결제 수단\n[e1 라디오 "신용카드"]', room.url)).toBe('결제 수단')
    expect(checkoutScreen(CHECKOUT, 'https://kr.hotels.com/x')).toBe('체크인 고객 정보')
    expect(checkoutScreen('주문 상품', 'https://shop.example/order/sheet')).toBe('결제 단계 주소')
    expect(confirmedScreen('예약이 완료되었습니다. 예약 번호: HC12345678')).toBeTruthy()
    expect(confirmedScreen('예약 완료하기')).toBeUndefined()
  })

  it('결제 흐름이 아니면 [예약하기]는 지금처럼 승인을 요구한다', async () => {
    const b = payBrowser([room, checkout])
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e58' })
    expect(r.isError).toBe(true)
    expect(b.calls.map((c) => c[0])).not.toContain('click')
  })

  it('결제 흐름에서는 [예약하기]를 승인 없이 눌러 결제 화면까지 가고, 승인은 결제 화면에서 받는다', async () => {
    const b = payBrowser([room, checkout])
    const tools = new BrowserTools(b)
    tools.startPayFlow(3, 'hotels-com.prepare_booking')
    await tools.run('read', { tabId: 3 })

    // 결제 화면을 여는 버튼에 승인을 받으려 하면 막는다 (이번 실패: 객실 목록에서 승인을 받았다)
    const early = await tools.run('request_approval', { tabId: 3, ref: 'e58', what: '예약', where: '호텔' })
    expect(early.isError).toBe(true)
    expect(text(early)).toContain('browser_click')

    // '바로 예약'은 그 자리에서 확정될 수 있어 그대로 승인을 요구한다
    expect((await tools.run('click', { tabId: 3, ref: 'e60' })).isError).toBe(true)

    const r = await tools.run('click', { tabId: 3, ref: 'e58' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('승인 없이 눌렀어요')
    expect(text(r)).toContain('결제 화면이에요')

    // 결제 화면에서는 같은 [예약하기]도 마지막 버튼일 수 있어 승인을 받는다
    const again = await tools.run('click', { tabId: 3, ref: 'e9' })
    expect(again.isError).toBe(true)
    const ok = await tools.run('request_approval', {
      tabId: 3,
      ref: 'e10',
      what: '슈피리어 더블룸 3박',
      where: '호텔스닷컴',
      amount: '₩519,720',
    })
    expect(ok.isError).toBeUndefined()
    expect(tools.approvals.list().filter((a) => a.status === 'pending')).toHaveLength(1)
  })

  it('들어가는 버튼이 바로 확정해 버린 화면이면 숨기지 않고 알린다', async () => {
    const done = { url: 'https://kr.hotels.com/trip/1', text: '예약이 완료되었습니다. 예약 번호: HC12345678' }
    const b = payBrowser([room, done])
    const tools = new BrowserTools(b)
    tools.startPayFlow(3, 'hotels-com.prepare_booking')
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e58' })
    expect(text(r)).toContain('이미 확정됐을 수 있어요')
  })

  it('같은 서비스 사이트를 새 탭으로 다시 열어도 결제 흐름이다', async () => {
    const b = payBrowser([room, checkout])
    const tools = new BrowserTools(b)
    tools.startPayFlow(9, 'hotels-com.prepare_booking', ['hotels.com'])
    await tools.run('read', { tabId: 3 }) // 새 탭 3에서 kr.hotels.com을 읽었다
    expect(tools.payFlow(3)).toBe('hotels-com.prepare_booking')
    const r = await tools.run('click', { tabId: 3, ref: 'e58' })
    expect(r.isError).toBeUndefined()
  })

  it('탭을 닫거나 한 시간이 지나면 결제 흐름을 잊는다', () => {
    const tools = new BrowserTools(payBrowser([room]))
    tools.startPayFlow(3, 'x.prepare', [], 0)
    expect(tools.payFlow(3, 1000)).toBe('x.prepare')
    expect(tools.payFlow(3, PAY_FLOW_TTL_MS + 1)).toBeUndefined()
    tools.startPayFlow(4, 'x.prepare')
    tools.forgetTab(4)
    expect(tools.payFlow(4)).toBeUndefined()
  })
})
