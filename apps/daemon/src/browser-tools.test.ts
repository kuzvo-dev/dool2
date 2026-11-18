import { describe, expect, it } from 'vitest'
import {
  askedForAccount,
  BrowserTools,
  checkoutScreen,
  classifyDialogRisk,
  classifyRisk,
  confirmedScreen,
  cookieReject,
  isCheckoutEntry,
  makePassword,
  matchOption,
  nearlyEmpty,
  optionFields,
  PAY_FLOW_TTL_MS,
  parseRefs,
  payScreen,
  promoClose,
  type SiteDialog,
  sameFinal,
  scopeLines,
  siteKey,
} from './browser-tools.js'
import { ProfileStore } from './profile.js'

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
    // 결제 단계 주소에서도 결제가 될 수 없는 이름은 누른다 (닫기·이전·자세히 보기)
    expect(classifyRisk('버튼 close', 'https://kr.hotels.com/checkout/s')).toBeUndefined()
    expect(classifyRisk('버튼 자세히 보기', 'https://order.example.com/checkout/step2')).toBeUndefined()
    expect(classifyRisk('버튼 예약 계속하기', 'https://kr.hotels.com/checkout/s')?.kind).toBe('money')
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
    // 실측 이름 변형: 화면 읽기가 겹쳐 읽은 이름, 대상이 붙은 이름
    expect(isCheckoutEntry('예약 예약하기')).toBe(true)
    expect(isCheckoutEntry('상품 예약하기')).toBe(true)
    expect(isCheckoutEntry('바로 예약하기')).toBe(false)
    expect(isCheckoutEntry('지금 예약하기')).toBe(false)
    expect(isCheckoutEntry('바로 구매')).toBe(true)
    expect(isCheckoutEntry('예약 완료하기')).toBe(false)
    expect(isCheckoutEntry('0원 결제로 예약')).toBe(false)
    expect(isCheckoutEntry('결제하기')).toBe(false)
    expect(checkoutScreen(ROOMS, room.url)).toBeUndefined()
    // 상세 화면의 안내 문장 속 '결제 수단'은 결제 화면 표시가 아니다 (실측 문장)
    const notice = `${ROOMS}\n이 숙박 시설에서 사용 가능한 결제 수단은 신용카드, 현금입니다.\n결제 가능한 신용카드: Visa, Mastercard`
    expect(checkoutScreen(notice, room.url)).toBeUndefined()
    expect(payScreen(notice)).toBeUndefined()
    expect(checkoutScreen('## 결제 수단\n[e1 라디오 "신용카드"]\n## 배송지 정보', room.url)).toBe(
      '결제 수단·예약자 정보',
    )
    // 상품·상세 화면의 '결제' 한 줄이나 버튼 이름으로는 결제 화면이 아니다 (실측: 11번가·지마켓·무신사·트립닷컴)
    expect(checkoutScreen('여부 및 배송비 결제 방법 선택\n총 상품금액 12,900원', room.url)).toBeUndefined()
    expect(
      checkoutScreen(
        '46,200원결제할인가 [e39 버튼 "결제수단 즉시 할인 안내창 열기"]\n[e40 버튼 "결제 정보"]',
        room.url,
      ),
    ).toBeUndefined()
    expect(checkoutScreen(CHECKOUT, 'https://kr.hotels.com/x')).toBe('결제 금액·예약자 정보')
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
    // 같은 버튼에 또 요청하면 카드가 두 장이 되지 않고 새 것 하나만 남는다
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e10',
      what: '슈피리어 더블룸 3박',
      where: '호텔스닷컴',
    })
    expect(tools.approvals.list().filter((a) => a.status === 'pending')).toHaveLength(1)
    expect(tools.approvals.list().filter((a) => a.status === 'expired')).toHaveLength(1)
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

  it('돈 내기 도구가 있는 서비스 사이트면 도구를 거치지 않고 연 탭도 결제 흐름이다', async () => {
    const tools = new BrowserTools(payBrowser([room, checkout]))
    tools.setPayServiceSites(['hotels.com'])
    await tools.run('read', { tabId: 3 })
    expect(tools.payFlow(3)).toBe('site:hotels.com')
    expect((await tools.run('click', { tabId: 3, ref: 'e58' })).isError).toBeUndefined()
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

// 실측 (2026-11-18, 사용자 Chrome의 호텔스닷컴): 쿠키 동의 창의 어두운 막이 [예약하기]를 덮고 있었다
const COOKIE = `우리는 소셜 미디어 기능의 제공과 데이터 분석 및 본 사이트가 올바로 동작하고 개인화된 콘텐츠와 광고를 제공하기 위해 쿠키를 사용하고 있습니다.
[e36 버튼 "모든 쿠키 허용"] [e37 버튼 "모두 거부"] [e38 버튼 "쿠키 설정, 기본 설정 센터 대화 상자를 엽니다."]`

describe('쿠키 동의 창', () => {
  it('쿠키 안내 바로 뒤의 거부 버튼만 고른다', () => {
    expect(cookieReject(`${ROOMS}\n${COOKIE}`)).toBe('e37')
    expect(cookieReject('This site uses cookies. [e2 버튼 "Accept all"] [e3 버튼 "Reject all"]')).toBe('e3')
    expect(cookieReject('쿠키 안내 [e5 버튼 "필수 쿠키만 허용"] [e6 버튼 "동의"]')).toBe('e5')
    // 동의만 있는 창은 건드리지 않는다
    expect(cookieReject('쿠키를 사용합니다 [e1 버튼 "동의"]')).toBeUndefined()
    // 쿠키 이야기가 없는 화면의 '모두 거부'(알림 설정 등)는 누르지 않는다
    expect(cookieReject('마케팅 알림 받기 [e7 버튼 "모두 거부"]')).toBeUndefined()
  })

  it('광고·앱 설치·재촉 팝업은 닫지만, 결제·로그인·진짜 할 일은 건드리지 않는다', () => {
    expect(promoClose('앱으로 보면 10% 더 저렴해요 [e2 버튼 "앱에서 열기"] [e3 버튼 "나중에"]')).toBe('e3')
    expect(promoClose('예약 완료까지 얼마 안 남았어요! 서두르세요 [e5 버튼 "닫기"]')).toBe('e5')
    expect(promoClose('첫 구매 할인 쿠폰 받고 뉴스레터 구독 [e7 버튼 "괜찮아요"]')).toBe('e7')
    expect(promoClose('알림을 받으시겠어요? 푸시 허용 [e9 버튼 "다음에 할게요"]')).toBe('e9')
    // 광고 말이 없는 그냥 '닫기'는 건드리지 않는다
    expect(promoClose('주문 내역 [e1 버튼 "닫기"]')).toBeUndefined()
    // 결제·로그인·본인인증 같은 진짜 단계가 섞인 창은 닫지 않는다
    expect(promoClose('서두르세요! 결제를 완료해 주세요 [e2 버튼 "닫기"]')).toBeUndefined()
    expect(promoClose('지금 가입하고 혜택 받기, 비밀번호를 입력하세요 [e3 버튼 "나중에"]')).toBeUndefined()
    // 쿠키 창은 promoClose가 아니라 cookieReject가 본다
    expect(promoClose('쿠키를 사용합니다 [e4 버튼 "닫기"]')).toBeUndefined()
  })

  it('읽을 때 거부로 닫고 다시 읽으며, 같은 탭·사이트에서는 한 번만 한다', async () => {
    const calls: string[] = []
    let closed = false
    const b = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.ref ? ` ${args.ref}` : ''}`)
        if (cmd === 'click') closed = true
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://kr.hotels.com/ho480371/',
            title: '호텔',
            text: closed ? ROOMS : `${ROOMS}\n${COOKIE}`,
            truncated: false,
            captcha: false,
          }
        return { tabId: 3 }
      },
    }
    const tools = new BrowserTools(b)
    const r = text(await tools.run('read', { tabId: 3 }))
    expect(r).toContain('[모두 거부]로 닫았어요')
    expect(r).not.toContain('모든 쿠키 허용')
    expect(calls).toEqual(['snapshot', 'click e37', 'snapshot'])
    closed = false // 사이트가 창을 다시 띄워도 되풀이하지 않는다
    await tools.run('read', { tabId: 3 })
    expect(calls.filter((c) => c.startsWith('click'))).toHaveLength(1)
  })
})

describe('승인한 버튼이 실제로 눌렸는지', () => {
  // 결제 화면: 마지막 버튼 [결제하기]
  const PAY = '## 결제 수단\n[e1 라디오 "카드"]\n총 결제 금액 9,900원\n[e2 버튼 "결제하기"]'
  function stuckBrowser(click: Record<string, unknown>, changes = false) {
    let clicked = false
    return {
      call: async (cmd: string) => {
        if (cmd === 'click') {
          clicked = true
          return { tabId: 3, url: 'https://shop.example/pay', ...click }
        }
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://shop.example/pay',
            title: '결제',
            text: changes && clicked ? `${PAY}\n결제 창을 여는 중이에요` : PAY,
            truncated: false,
            captcha: false,
          }
        return { tabId: 3 }
      },
    }
  }
  async function approveOnce(b: ReturnType<typeof stuckBrowser>) {
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e2',
      what: '사과 결제',
      where: '가게',
      amount: '9,900원',
    })
    const [rec] = tools.approvals.list()
    return { tools, result: await tools.approve(rec?.id as string), rec }
  }

  it('눌렀는데 화면이 그대로면 "눌렀어요" 대신 실패로 알린다 (덮은 창이 있으면 그것도)', async () => {
    const { tools, result, rec } = await approveOnce(stuckBrowser({ coveredBy: '쿠키 설정' }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('화면이 그대로예요')
    expect(result.message).toContain('"쿠키 설정"이(가) 그 자리를 덮고')
    expect(tools.approvals.get(rec?.id as string)?.status).toBe('failed')
  })

  it('화면 글이 바뀌거나 새 창이 뜨면 눌린 것이다', async () => {
    expect((await approveOnce(stuckBrowser({}, true))).result.ok).toBe(true)
    expect((await approveOnce(stuckBrowser({ newTabId: 9 }))).result.ok).toBe(true)
  })
})

describe('내 정보로 예약자 칸 채우기', () => {
  const FORM = `체크인 고객 정보
[e3 입력칸 "성 *"] [e4 입력칸 "이름 *"] [e5 입력칸 "이메일 주소 *"] [e6 입력칸 "전화번호 *"] [e7 버튼 "예약 완료하기"]`
  function formBrowser2() {
    const calls: [string, Record<string, unknown> | undefined][] = []
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://kr.hotels.com/checkout/s',
            title: '결제',
            text: FORM,
            truncated: false,
            captcha: false,
          }
        return { tabId: 3 }
      },
    }
  }
  function store(p: Record<string, string>) {
    const m = new Map<string, string>([['profile.v1', JSON.stringify(p)]])
    return new ProfileStore({
      get: async (k) => m.get(k),
      set: async (k, v) => void (v ? m.set(k, v) : m.delete(k)),
    })
  }

  it('칸과 항목만 받아 본체가 채우고, AI에게는 가린 값만 돌려준다', async () => {
    const b = formBrowser2()
    const tools = new BrowserTools(b)
    tools.profile = store({
      name_en_last: 'HONG',
      name_en_first: 'GILDONG',
      email: 'hong.gd@example.com',
      phone: '010-1234-5678',
    })
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('fill_profile', {
      tabId: 3,
      fields: [
        { ref: 'e3', key: 'name_en_last' },
        { ref: 'e4', key: 'name_en_first' },
        { ref: 'e5', key: 'email' },
        { ref: 'e6', key: 'phone_local' },
      ],
    })
    expect(r.isError).toBeUndefined()
    const fills = b.calls.filter((c) => c[0] === 'fill').map((c) => c[1])
    expect(fills).toEqual([
      { tabId: 3, ref: 'e3', value: 'HONG', origin: 'https://kr.hotels.com' },
      { tabId: 3, ref: 'e4', value: 'GILDONG', origin: 'https://kr.hotels.com' },
      { tabId: 3, ref: 'e5', value: 'hong.gd@example.com', origin: 'https://kr.hotels.com' },
      { tabId: 3, ref: 'e6', value: '1012345678', origin: 'https://kr.hotels.com' },
    ])
    const t = text(r)
    expect(t).toContain('내 정보로 채웠어요')
    expect(t).toContain('ho*****@example.com')
    expect(t).not.toContain('hong.gd@')
    expect(t).not.toContain('1234-5678')
  })

  it('없는 항목은 채우지 않고 내 정보 카드를 띄우라고 한다', async () => {
    const b = formBrowser2()
    const tools = new BrowserTools(b)
    tools.profile = store({ name_en_last: 'HONG' })
    const asked: string[][] = []
    tools.requestProfile = (fields) => {
      asked.push(fields)
      return 'req-1'
    }
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('fill_profile', {
      tabId: 3,
      fields: [
        { ref: 'e3', key: 'name_en_last' },
        { ref: 'e5', key: 'email' },
      ],
    })
    expect(text(r)).toContain('이메일이(가) 없어요')
    expect(text(r)).toContain('browser_request_profile')
    expect(b.calls.filter((c) => c[0] === 'fill')).toHaveLength(1)
    const card = await tools.run('request_profile', { fields: ['email', 'phone'], reason: '호텔 예약자 칸' })
    expect(card.isError).toBeUndefined()
    expect(asked).toEqual([['email', 'phone']])
    // 버튼에는 채우지 않는다
    expect(
      (await tools.run('fill_profile', { tabId: 3, fields: [{ ref: 'e7', key: 'name' }] })).isError,
    ).toBe(true)
  })
})

describe('승인 카드에서 결제 수단 고르기', () => {
  // 실측(호텔스닷컴): 결제 수단을 바꾸면 마지막 버튼 이름도 '네이버페이로 예약하기' ↔ '카드로 예약하기'로 바뀐다
  function payPage() {
    let method = '네이버페이'
    const calls: string[] = []
    const text = () =>
      `## 결제 수단\n[e1 라디오 "네이버페이"${method === '네이버페이' ? ' 선택됨' : ''}] [e2 라디오 "카드"${method === '카드' ? ' 선택됨' : ''}]\n총 금액 ₩519,720\n[e9 버튼 "${method}로 예약하기"]`
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.ref ? ` ${args.ref}` : ''}`)
        if (cmd === 'click' && args?.ref === 'e2') method = '카드'
        if (cmd === 'click' && args?.ref === 'e1') method = '네이버페이'
        if (cmd === 'click' && args?.ref === 'e9') method = '완료'
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://kr.hotels.com/checkout/s',
            title: '결제',
            text: method === '완료' ? '예약 정보를 확인하고 있어요' : text(),
            truncated: false,
            captcha: false,
          }
        return { tabId: 3, url: 'https://kr.hotels.com/checkout/s' }
      },
    }
  }

  it('사용자가 고른 수단을 먼저 누르고, 이름이 바뀐 마지막 버튼을 누른다. 다음엔 그 수단이 기본값', async () => {
    const b = payPage()
    const tools = new BrowserTools(b)
    const remembered: string[] = []
    tools.onChoice = (host, label) => remembered.push(`${host} ${label}`)
    await tools.run('read', { tabId: 3 })
    const asked = await tools.run('request_approval', {
      tabId: 3,
      ref: 'e9',
      what: '슈피리어 더블룸 3박',
      where: '호텔스닷컴',
      amount: '₩519,720',
      choices: ['e1', 'e2'],
    })
    expect(asked.isError).toBeUndefined()
    const [rec] = tools.approvals.list()
    expect(rec?.choices).toEqual([
      { id: 'c1', label: '네이버페이' },
      { id: 'c2', label: '카드' },
    ])
    expect(rec?.choice).toBe('c1')
    const done = await tools.approve(rec?.id as string, 'c2')
    expect(done.ok).toBe(true)
    expect(done.message).toContain('결제 수단 "카드"')
    expect(done.message).toContain('"카드로 예약하기" 버튼을 눌렀어요')
    expect(b.calls.filter((c) => c.startsWith('click'))).toEqual(['click e2', 'click e9'])
    expect(remembered).toEqual(['kr.hotels.com 카드'])

    // 다음 결제에서는 카드가 기본값
    const b2 = payPage()
    const tools2 = new BrowserTools(b2)
    tools2.loadChoices({ 'kr.hotels.com': '카드' })
    await tools2.run('read', { tabId: 3 })
    await tools2.run('request_approval', {
      tabId: 3,
      ref: 'e9',
      what: 'x',
      where: 'y',
      choices: ['e1', 'e2'],
    })
    expect(tools2.approvals.list()[0]?.choice).toBe('c2')
  })

  it('AI가 선택지를 안 넘겨도 결제 화면의 결제 수단 칸을 승인 카드에 싣는다', async () => {
    const tools = new BrowserTools(payPage())
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e9', what: 'x', where: 'y' })
    expect(tools.approvals.list()[0]?.choices?.map((c) => c.label)).toEqual(['네이버페이', '카드'])
    // 마지막으로 쓴 수단이 없으면 화면에서 지금 골라진 수단이 기본값
    expect(tools.approvals.list()[0]?.choice).toBe('c1')
  })

  it('결제·확정 버튼은 선택지로 넣을 수 없다', async () => {
    const tools = new BrowserTools(payPage())
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('request_approval', {
      tabId: 3,
      ref: 'e9',
      what: 'x',
      where: 'y',
      choices: ['e9'],
    })
    expect(r.isError).toBe(true)
  })

  // 실측(쿠팡 결제 화면 2026-11-18): 결제 수단 버튼에 이름이 없고 다음 줄에 글이 있다. 카드·할부는 펼침 목록
  function coupangPage(start = '쿠페이') {
    let method = start
    let months = '일시불'
    const calls: string[] = []
    const text = () =>
      `결제수단 [e7 버튼 "구매안전 서비스"]\n[e8 버튼]\n쿠페이 머니: 0원\n[e9 버튼]\n신용/체크카드\n` +
      (method === '카드'
        ? `신한카드 / 515594******336*\n[e10 선택 상자]\n${months}\n[e11 선택 상자]\n`
        : '') +
      `[e12 버튼] 기본 결제 수단으로 사용\n총 결제 금액 12,900원\n[e21 버튼 "결제하기"]`
    const selects: Record<string, string[]> = {
      e10: ['신한카드 / 515594******336*', '국민카드 / 940915******123*', 'KB국민카드', '삼성카드'],
      e11: ['일시불', '2개월(무이자)', '3개월(무이자)'],
    }
    return {
      calls,
      get months() {
        return months
      },
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.ref ? ` ${args.ref}` : ''}${args?.label ? ` ${args.label}` : ''}`)
        if (cmd === 'click' && args?.ref === 'e9') method = '카드'
        if (cmd === 'click' && args?.ref === 'e21') method = '완료'
        if (cmd === 'options') {
          const o = method === '카드' ? selects[String(args?.ref)] : undefined
          return {
            tabId: 3,
            options: o?.map((label, i) => ({
              label,
              selected: args?.ref === 'e11' ? label === months : i === 0,
            })),
          }
        }
        if (cmd === 'choose') months = String(args?.label)
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://checkout.coupang.com/ssr/desktop/checkout/1',
            title: '주문/결제',
            text: method === '완료' ? '주문이 완료됐어요' : text(),
            truncated: false,
            captcha: false,
          }
        return { tabId: 3, url: 'https://checkout.coupang.com/ssr/desktop/checkout/1' }
      },
    }
  }

  it('이름 없는 결제 수단 버튼은 바로 뒤 글로 싣고, 카드·할부 펼침 목록은 아래 줄로 싣는다', async () => {
    const b = coupangPage()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    // 처음엔 쿠페이 머니가 골라져 있어 카드 목록이 없다
    await tools.run('request_approval', { tabId: 3, ref: 'e21', what: '세제 1개', where: '쿠팡' })
    expect(tools.approvals.list()[0]?.choices).toEqual([
      { id: 'c1', label: '쿠페이 머니' },
      { id: 'c2', label: '신용/체크카드' },
    ])
    expect(tools.approvals.list()[0]?.subChoices).toBeUndefined()
  })

  it('카드가 골라진 결제 화면이면 등록 카드·할부를 같이 싣고, 고른 할부로 바꾼 뒤 결제한다', async () => {
    const b = coupangPage('카드')
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e21', what: '세제 1개', where: '쿠팡' })
    const rec = tools.approvals.list()[0]
    expect(rec?.subChoices).toEqual([
      {
        key: 's1',
        title: '카드',
        options: [
          { id: 's1o1', label: '신한카드 / 515594******336*' },
          { id: 's1o2', label: '국민카드 / 940915******123*' },
        ],
        choice: 's1o1',
        when: 'c2',
      },
      {
        key: 's2',
        title: '할부',
        options: [
          { id: 's2o1', label: '일시불' },
          { id: 's2o2', label: '2개월(무이자)' },
          { id: 's2o3', label: '3개월(무이자)' },
        ],
        choice: 's2o1',
        when: 'c2',
      },
    ])
    // 고른 수단 버튼에 표시가 없어도, 카드·할부 목록 바로 위의 '신용/체크카드'가 지금 골라진 것이다
    expect(rec?.choice).toBe('c2')
    const done = await tools.approve(rec?.id as string, 'c2,s1o1,s2o3')
    expect(done.ok).toBe(true)
    expect(b.months).toBe('3개월(무이자)')
    expect(done.message).toContain('"3개월(무이자)"')
    // 이미 골라진 카드는 다시 고르지 않는다
    expect(b.calls.filter((c) => c.startsWith('choose'))).toEqual(['choose e11 3개월(무이자)'])
    expect(b.calls.at(-2)).toBe('click e21')
  })

  it('고른 등록 카드·할부를 사이트별로 기억해 다음 승인 카드의 기본값으로 (설정에서 잊으면 다시 화면 기본값)', async () => {
    const saved: Record<string, string> = {}
    const b = coupangPage('카드')
    const tools = new BrowserTools(b)
    tools.onSubChoice = (k, v) => {
      saved[k] = v
    }
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e21', what: '세제 1개', where: '쿠팡' })
    const rec = tools.approvals.list()[0]
    expect((await tools.approve(rec?.id as string, 'c2,s1o2,s2o3')).ok).toBe(true)
    expect(saved).toEqual({
      'checkout.coupang.com|카드': '국민카드 / 940915******123*',
      'checkout.coupang.com|할부': '3개월(무이자)',
    })
    // 다음 주문: 본체를 다시 켜도 설정에서 불러와 기본값이 지난번 것
    const b2 = coupangPage('카드')
    const next = new BrowserTools(b2)
    next.loadSubChoices(saved)
    await next.run('read', { tabId: 3 })
    await next.run('request_approval', { tabId: 3, ref: 'e21', what: '세제 1개', where: '쿠팡' })
    const r2 = next.approvals.list()[0]
    expect(r2?.subChoices?.map((g) => g.choice)).toEqual(['s1o2', 's2o3'])
    // 설정에서 그 사이트를 잊으면 화면에 골라진 것으로
    next.forgetChoice('checkout.coupang.com')
    await next.run('request_approval', { tabId: 3, ref: 'e21', what: '세제 1개', where: '쿠팡' })
    expect(
      next.approvals
        .list()
        .at(-1)
        ?.subChoices?.map((g) => g.choice),
    ).toEqual(['s1o1', 's2o1'])
  })

  it('카드에 딸린 할부 목록은 다른 결제 수단을 고르면 쓰지 않는다', async () => {
    let method = '카드'
    const calls: string[] = []
    const b = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.ref ? ` ${args.ref}` : ''}`)
        if (cmd === 'click' && args?.ref === 'e2') method = '네이버페이'
        if (cmd === 'click' && args?.ref === 'e9') method = '완료'
        if (cmd === 'options')
          return {
            tabId: 3,
            options:
              method === '카드'
                ? ['일시불', '3개월'].map((label, i) => ({ label, selected: i === 0 }))
                : null,
          }
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://shop.example/checkout',
            title: '결제',
            text:
              method === '완료'
                ? '주문 완료'
                : `[e1 라디오 "카드"${method === '카드' ? ' 선택됨' : ''}] [e2 라디오 "네이버페이"${method === '카드' ? '' : ' 선택됨'}]\n` +
                  `${method === '카드' ? '할부 [e5 선택 상자 "일시불 3개월" 값="일시불"]\n' : ''}[e9 버튼 "결제하기"]`,
            truncated: false,
            captcha: false,
          }
        return { tabId: 3, url: 'https://shop.example/checkout' }
      },
    }
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e9', what: 'x', where: 'y' })
    const rec = tools.approvals.list()[0]
    expect(rec?.subChoices?.[0]).toMatchObject({ title: '할부', when: 'c1' })
    const done = await tools.approve(rec?.id as string, 'c2,s1o2')
    expect(done.ok).toBe(true)
    expect(calls.some((c) => c.startsWith('choose'))).toBe(false)
  })

  it('승인 때 없던 선택은 받지 않는다', async () => {
    const tools = new BrowserTools(coupangPage())
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e21', what: 'x', where: 'y' })
    const id = tools.approvals.list()[0]?.id as string
    const r = await tools.approve(id, 'c2,s9o1')
    expect(r.ok).toBe(false)
  })

  it('결제 수단 이름만 다른 같은 마지막 버튼을 알아본다', () => {
    expect(sameFinal('네이버페이로 예약하기', '카드로 예약하기')).toBe(true)
    expect(sameFinal('카카오페이로 결제하기', '토스페이로 결제하기')).toBe(true)
    expect(sameFinal('네이버페이로 예약하기', '예약 취소하기')).toBe(false)
    expect(sameFinal('결제하기', '결제하기')).toBe(false) // 같은 이름은 sameControl이 본다
  })
})

describe('새 비밀번호 만들기', () => {
  it('강한 비밀번호를 만든다 (대·소문자·숫자·특수문자, 16자, 매번 다름)', () => {
    const a = makePassword()
    const b = makePassword()
    expect(a).toHaveLength(16)
    expect(a).not.toBe(b)
    expect(a).toMatch(/[A-Z]/)
    expect(a).toMatch(/[a-z]/)
    expect(a).toMatch(/[0-9]/)
    expect(a).toMatch(/[!@#$%^&*]/)
  })

  /** 가입 화면 흉내: snapshot은 page.now를 돌려주고, fill은 maxLen만큼만 들어간 길이를 알린다 */
  function signupBench(o: { maxLen?: number; ask?: 'ok' | 'asked' } = {}) {
    const saved: { origin: string; username: string; password: string }[] = []
    const fills: { ref: string; value: string }[] = []
    const form = {
      url: 'https://www.shop.example/signup',
      title: '회원가입',
      text: '가입 완료 시 쿠폰을 드려요. 이미 가입된 회원이신가요? [e1 입력칸 "이메일"] [e2 비밀번호칸 "비밀번호"] [e3 비밀번호칸 "비밀번호 확인"] [e4 버튼 "가입하기"]',
    }
    const page = { now: form }
    const b = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'snapshot') return { tabId: 3, ...page.now, truncated: false, captcha: false }
        if (cmd === 'fill') {
          const value = String(args?.value)
          fills.push({ ref: String(args?.ref), value })
          return { tabId: 3, filled: true, length: Math.min(value.length, o.maxLen ?? 999) }
        }
        return { tabId: 3, url: page.now.url }
      },
    }
    const tools = new BrowserTools(b, {
      findForOrigin: async () => undefined,
      markUsed: async () => {},
      savePassword: async (origin: string, username: string, password: string) =>
        void saved.push({ origin, username, password }),
    })
    const asked: string[] = []
    if (o.ask)
      tools.askSignup = (site) => {
        asked.push(site)
        return o.ask
      }
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    return { tools, saved, fills, page, form, asked, text }
  }

  it('가입 화면에서 만들어 넣되, 금고에는 완료 화면을 본 뒤에 넣고 값은 돌려주지 않는다', async () => {
    const t = signupBench()
    t.tools.allowSignup('shop.example')
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('new_password', {
      tabId: 3,
      password: 'e2',
      confirm: 'e3',
      username: 'me@example.com',
    })
    expect(r.isError).toBeUndefined()
    expect(t.fills).toHaveLength(2)
    expect(t.fills[0]?.value).toBe(t.fills[1]?.value)
    expect(t.fills[0]?.value).toHaveLength(16)
    // 가입 화면에 원래 있던 "가입 완료 시"·"이미 가입된 회원" 글로는 저장하지 않는다
    expect(t.saved).toHaveLength(0)
    await t.tools.run('read', { tabId: 3 })
    expect(t.saved).toHaveLength(0)
    // 완료 화면이 보이면 저장
    t.page.now = { ...t.form, title: '가입 완료', text: '가입이 완료됐어요 me@example.com' }
    const done = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(t.saved).toHaveLength(1)
    expect(t.saved[0]).toMatchObject({ origin: 'https://www.shop.example', username: 'me@example.com' })
    expect(t.saved[0]?.password).toBe(t.fills[0]?.value)
    expect(done).toContain('금고에 저장')
    expect(t.text(r)).not.toContain(t.saved[0]?.password as string)
    expect(done).not.toContain(t.saved[0]?.password as string)
  })

  it('칸이 글자 수를 막으면(maxlength 15) 그 길이로 다시 만들어 금고 값과 사이트 값이 같게 한다', async () => {
    const t = signupBench({ maxLen: 15 })
    t.tools.allowSignup('www.shop.example')
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('new_password', {
      tabId: 3,
      password: 'e2',
      confirm: 'e3',
      username: 'me@example.com',
    })
    expect(r.isError).toBeUndefined()
    const last = t.fills.at(-1)?.value as string
    expect(last).toHaveLength(15)
    expect(t.fills.filter((f) => f.ref === 'e2').at(-1)?.value).toBe(last)
    t.page.now = {
      ...t.form,
      url: 'https://www.shop.example/welcome',
      title: '환영해요',
      text: '회원가입을 축하해요',
    }
    await t.tools.run('read', { tabId: 3 })
    expect(t.saved[0]?.password).toBe(last)
  })

  it('칸이 8자보다 적게 받으면 넣었다고 하지 않고 사람에게 넘기게 한다', async () => {
    const t = signupBench({ maxLen: 6 })
    t.tools.allowSignup('shop.example')
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    expect(r.isError).toBe(true)
    expect(t.text(r)).toContain('browser_handoff')
  })

  it('"이미 가입된 이메일"이 새로 뜨면 만든 비밀번호를 버리고 로그인으로 바꾸라고 한다', async () => {
    const t = signupBench()
    t.tools.allowSignup('shop.example')
    await t.tools.run('read', { tabId: 3 })
    await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    t.page.now = { ...t.form, text: `${t.form.text} 이미 가입된 이메일이에요. 로그인해 주세요.` }
    const out = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(out).toContain('버렸어요')
    // 그 뒤 완료처럼 보이는 글이 와도 저장할 것이 없다
    t.page.now = { ...t.form, title: '가입 완료', text: '가입이 완료됐어요' }
    await t.tools.run('read', { tabId: 3 })
    expect(t.saved).toHaveLength(0)
  })

  it('사용자가 고르지 않은 사이트면 아무것도 넣지 않고 폰에 먼저 묻는다', async () => {
    const t = signupBench({ ask: 'asked' })
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    expect(r.isError).toBeUndefined()
    expect(t.fills).toHaveLength(0)
    expect(t.asked).toEqual(['shop.example'])
    expect(t.text(r)).toContain('물었어요')
    // 묻는 길이 없으면 거절
    const t2 = signupBench()
    await t2.tools.run('read', { tabId: 3 })
    expect(
      (await t2.tools.run('new_password', { tabId: 3, password: 'e2', username: 'a@b.com' })).isError,
    ).toBe(true)
    expect(t2.fills).toHaveLength(0)
  })

  it('대화에서 이미 가입을 부탁했으면(ok) 묻지 않고 넣는다', async () => {
    const t = signupBench({ ask: 'ok' })
    await t.tools.run('read', { tabId: 3 })
    await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    expect(t.fills).toHaveLength(1)
  })

  it('askedForAccount: 주소 안의 /signup은 가입 부탁이 아니다', () => {
    expect(askedForAccount('http://127.0.0.1:8790/signup 열어서 칸 채워 줘', 'signup')).toBe(false)
    expect(askedForAccount('shop.example.com/join 들어가서 봐 줘', 'signup')).toBe(false)
    expect(askedForAccount('알라딘 회원가입해서 이어서 해 줘', 'signup')).toBe(true)
    expect(askedForAccount('거기 계정 하나 만들어 줘', 'signup')).toBe(true)
    expect(askedForAccount('쿠팡 비밀번호 찾아서 바꿔 줘', 'reset')).toBe(true)
    expect(askedForAccount('쿠팡 가입해 줘', 'reset')).toBe(false)
  })

  it('siteKey: 같은 사이트의 다른 주소를 묶는다', () => {
    expect(siteKey('https://member.ssg.com/login')).toBe('ssg.com')
    expect(siteKey('www.aladin.co.kr')).toBe('aladin.co.kr')
    expect(siteKey('https://mmbr.kyobobook.co.kr')).toBe('kyobobook.co.kr')
    expect(siteKey('http://127.0.0.1:8787/signup')).toBe('127.0.0.1')
  })

  it('로그인 화면의 비밀번호 칸이 아니라 비밀번호 칸만 받는다', async () => {
    const b = {
      call: async (cmd: string) =>
        cmd === 'snapshot'
          ? {
              tabId: 3,
              url: 'https://shop.example/x',
              title: 'x',
              text: '[e1 입력칸 "쿠폰 코드"]',
              truncated: false,
              captcha: false,
            }
          : { tabId: 3, url: 'https://shop.example/x' },
    }
    const tools = new BrowserTools(b, {
      findForOrigin: async () => undefined,
      markUsed: async () => {},
      savePassword: async () => {},
    })
    await tools.run('read', { tabId: 3 })
    expect((await tools.run('new_password', { tabId: 3, password: 'e1', username: 'a@b.com' })).isError).toBe(
      true,
    )
  })
})

describe('상품 옵션 고르기 (browser_select)', () => {
  it('matchOption: 같은 글 → 품절·가격 뗀 글 → 하나뿐인 시작·포함', () => {
    expect(matchOption(['S', 'M', 'L'], 'm')).toBe('M')
    expect(matchOption(['옵션01 블랙 89,000 원', '옵션02 화이트 95,200 원'], '블랙')).toBe(
      '옵션01 블랙 89,000 원',
    )
    expect(matchOption(['아이보리(SF-V넥)', '올리브(SF-V넥)'], '올리브')).toBe('올리브(SF-V넥)')
    expect(matchOption(['M (품절)', 'L'], 'M')).toBe('M (품절)')
    // 여러 개와 비슷하면 고르지 않는다
    expect(matchOption(['블랙 S', '블랙 M'], '블랙')).toBeUndefined()
    expect(matchOption(['250', '260', '270'], '26')).toBeUndefined()
  })

  it('optionFields: 옵션 칸만 짚는다', () => {
    const refs = new Map([
      ['e1', { role: '버튼', name: '옵션 열기' }],
      ['e2', { role: '버튼', name: '장바구니' }],
      ['e3', { role: '선택 상자', name: '색상' }],
      ['e4', { role: '버튼', name: '선택해 주세요.' }],
      ['e5', { role: '입력칸', name: '사이즈' }],
      ['e6', { role: '버튼', name: '사이즈 가이드' }],
    ])
    expect(optionFields(refs).map((x) => x.split(' ')[0])).toEqual(['[e1', '[e3', '[e4', '[e5'])
  })

  /** 상품 화면 흉내: options는 목록을, choose는 고른 글을 남긴다 */
  function shop(list: string[], dialog?: string) {
    const chosen: string[] = []
    let notes = dialog ? [{ type: 'alert', message: dialog }] : []
    const b = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'snapshot') {
          const r = {
            tabId: 3,
            url: 'https://shop.example/products/1',
            title: '니트',
            text: '[e1 버튼 "옵션 열기"] [e2 버튼 "구매하기"] [e3 결제 버튼 없음]',
            truncated: false,
            captcha: false,
            dialogNotes: notes,
          }
          notes = []
          return r
        }
        if (cmd === 'options') return { tabId: 3, options: list.map((label) => ({ label, selected: false })) }
        if (cmd === 'choose') {
          chosen.push(String(args?.label))
          return { tabId: 3, label: args?.label }
        }
        return { tabId: 3, url: 'https://shop.example/products/1' }
      },
    }
    const tools = new BrowserTools(b)
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    return { tools, chosen, text }
  }

  it('choose 없이 부르면 목록(품절 표시)을 보여 주고, 말한 옵션을 고른다', async () => {
    const t = shop(['S', 'M (품절)', 'L'])
    await t.tools.run('read', { tabId: 3 })
    const listed = t.text(await t.tools.run('select', { tabId: 3, ref: 'e1' }))
    expect(listed).toContain('2. M (품절) — 고를 수 없음')
    const r = await t.tools.run('select', { tabId: 3, ref: 'e1', choose: 'l' })
    expect(r.isError).toBeUndefined()
    expect(t.chosen).toEqual(['L'])
    // 품절은 고르지 않는다
    const sold = await t.tools.run('select', { tabId: 3, ref: 'e1', choose: 'M' })
    expect(sold.isError).toBe(true)
    expect(t.chosen).toEqual(['L'])
  })

  it('결제 수단·할부 목록은 고르지 않고 승인 카드로 돌린다', async () => {
    const t = shop(['신용카드', '네이버페이', '카카오페이'])
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('select', { tabId: 3, ref: 'e1', choose: '네이버페이' })
    expect(r.isError).toBe(true)
    expect(t.text(r)).toContain('choices')
    expect(t.chosen).toHaveLength(0)
  })

  it('"옵션을 선택해 주세요" 알림이 뜨면 옵션 칸을 짚어 알린다', async () => {
    const t = shop(['S'], '옵션을 선택해 주세요.')
    const out = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(out).toContain('🧩 옵션을 먼저 골라야 해요')
    expect(out).toContain('[e1 버튼 "옵션 열기"]')
    const again = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(again).not.toContain('🧩')
  })
})
