import { describe, expect, it } from 'vitest'
import {
  askedForAccount,
  BrowserTools,
  checkoutScreen,
  classifyDialogRisk,
  classifyRisk,
  confirmedScreen,
  cookieReject,
  coverLine,
  keypadLabels,
  makeKeypadPassword,
  makePassword,
  matchOption,
  nearlyEmpty,
  optionFields,
  PAGE_READ_CHARS,
  PAY_FLOW_TTL_MS,
  parseRefs,
  payNow,
  payOptions,
  payWhatLine,
  promoClose,
  type SiteDialog,
  sameFinal,
  scopeLines,
  siteKey,
  siteName,
} from './browser-tools.js'
import { waitsForPerson } from './hand-back.js'
import { ProfileStore } from './profile.js'

const PAGE = `# 두리 시험 가게
검색어 [e1 입력칸 "검색어" 값="사과"] [e2 버튼 "검색"]
사과 1kg 9,900원 [e3 버튼 "장바구니 담기"] [e4 버튼 "바로 구매"]
[e5 링크 "리뷰 쓰기"] [e6 체크박스 "전체 동의" 선택됨] [e7 버튼]`

describe('위험한 동작 가리기', () => {
  it('돈·연락·되돌릴 수 없는 버튼을 알아본다', () => {
    expect(classifyRisk('버튼 바로 구매')?.kind).toBe('money')
    expect(classifyRisk('버튼 결제하기')?.kind).toBe('money')
    expect(classifyRisk('버튼 예약 확정')?.kind).toBe('money')
    expect(classifyRisk('버튼 Place order')?.kind).toBe('money')
    expect(classifyRisk('버튼 보내기')?.kind).toBe('contact')
    // 맡긴 일인 리뷰·글 올리기·등록은 승인 없이 (11-20), 판매자 문의는 사람에게 보내는 말이라 승인
    expect(classifyRisk('버튼 등록')).toBeUndefined()
    expect(classifyRisk('버튼 리뷰 등록')).toBeUndefined()
    expect(classifyRisk('버튼 올리기')).toBeUndefined()
    expect(classifyRisk('버튼 문의하기')?.kind).toBe('contact')
    // 신청서·응모 양식을 내는 것도 보내기 (실측: 공공기관 퀴즈 응모가 승인 없이 제출됐다, 11-20)
    expect(classifyRisk('버튼 제출')?.kind).toBe('contact')
    expect(classifyRisk('버튼 응모하기')?.kind).toBe('contact')
    expect(classifyRisk('링크 제출 서류 안내')).toBeUndefined()
    expect(classifyRisk('버튼 회원 탈퇴')?.kind).toBe('irreversible')
  })

  it('지난 주문·결제를 보는 링크는 막지 않고, 같이 적힌 동작 말은 그대로 본다', () => {
    expect(classifyRisk('링크 주문상세')).toBeUndefined()
    expect(classifyRisk('버튼 결제 내역 보기')).toBeUndefined()
    expect(classifyRisk('링크 예약 조회')).toBeUndefined()
    expect(classifyRisk('버튼 주문내역에서 다시 주문하기')?.kind).toBe('money')
    expect(classifyRisk('버튼 구매확정')?.kind).toBe('money')
  })

  it('주소로는 막지 않는다: 결제 단계 주소의 [다음]·[확인]·[닫기]는 버튼 글자로만 본다 (실측 11-20 G마켓)', () => {
    expect(classifyRisk('버튼 다음')).toBeUndefined()
    expect(classifyRisk('버튼 확인')).toBeUndefined()
    expect(classifyRisk('버튼 close')).toBeUndefined()
    expect(classifyRisk('버튼 배송지 추가')).toBeUndefined()
    expect(classifyRisk('버튼')).toBeUndefined()
    expect(classifyRisk('버튼 예약 계속하기')).toBeUndefined()
    expect(classifyRisk('버튼 결제하기')?.kind).toBe('money')
  })

  it('결제 방식 화면의 [다음]도 글자로만 본다. 그 자체로 확정되는 이름은 그대로 막는다', () => {
    expect(classifyRisk('버튼 다음')).toBeUndefined()
    // 방식 고르기 라디오는 확정이 아니라서 막지 않는다 (마지막 버튼에서 승인)
    expect(classifyRisk('라디오 예약금 결제예약금 40,000원')).toBeUndefined()
    expect(classifyRisk('체크박스 결제 진행 필수 동의')).toBeUndefined()
    // 실제 캐치테이블 화면: 팝업의 "이 방식으로 예약"
    expect(classifyRisk('버튼 최대 혜택 이 방식으로 예약')?.kind).toBe('money')
    expect(classifyRisk('버튼 바로 예약')?.kind).toBe('money')
    expect(classifyRisk('버튼 예약')).toBeUndefined() // 검색 화면의 '예약' 탭
    expect(classifyRisk('버튼 11.27 (금) 예약 가능')).toBeUndefined()
  })

  it('지금 돈이 나가는 이름은 opens_checkout으로도 넘기지 않는다 (안전장치)', () => {
    expect(payNow('결제하기')).toBe(true)
    expect(payNow('16,500원 결제하기')).toBe(true)
    expect(payNow('카카오페이로 결제')).toBe(true)
    expect(payNow('Place order')).toBe(true)
    expect(payNow('예약 확정')).toBe(true)
    expect(payNow('주문하기')).toBe(false)
    expect(payNow('총 5개 상품 구매하기')).toBe(false)
    expect(payNow('예약하기 예약')).toBe(false)
  })

  it('보통 조회는 막지 않는다', () => {
    expect(classifyRisk('버튼 검색')).toBeUndefined()
    expect(classifyRisk('링크 다음 페이지')).toBeUndefined()
    expect(classifyRisk('버튼 장바구니 담기')).toBeUndefined()
    expect(classifyRisk('링크 상품 등록일순')).toBeUndefined()
    // 지난 결제를 보는 링크는 돈이 나가지 않는다 (승인 줄이기, 11-20). 결제 단계 주소의 다른 버튼은 그대로 막는다
    expect(classifyRisk('링크 결제 내역')).toBeUndefined()
    expect(classifyRisk('버튼 다음')).toBeUndefined()
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

describe('단계 자세히 (일한 과정 시트)', () => {
  it('연 주소(물음표 뒤 빼고)·누른 버튼 이름·넣은 칸 이름만, 넣은 값은 절대 안 싣는다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://shop.example' })
    expect(
      tools.stepDetail('mcp__dool2__browser_open', { url: 'https://shop.example/item/1?token=abc' }),
    ).toEqual([{ k: 'url', v: 'shop.example/item/1' }])
    expect(tools.stepDetail('mcp__dool2__browser_click', { tabId: 3, ref: 'e4' })).toEqual([
      { k: 'press', v: '바로 구매' },
    ])
    const steps = tools.stepDetail('mcp__dool2__browser_steps', {
      tabId: 3,
      steps: [
        { do: 'type', ref: 'e4', text: '비밀번호1234' },
        { do: 'click', ref: 'e4' },
      ],
    })
    expect(steps).toEqual([
      { k: 'field', v: '바로 구매' },
      { k: 'press', v: '바로 구매' },
    ])
    expect(JSON.stringify(steps)).not.toContain('비밀번호1234')
    expect(
      tools.stepDetail('mcp__dool2__service_call', {
        tool: 'catchtable_search',
        input: { query: '성수 오마카세', date: '2026-12-01' },
      }),
    ).toEqual([{ k: 'query', v: '성수 오마카세 · 2026-12-01' }])
    expect(tools.stepDetail('mcp__dool2__memory_save', { text: 'x' })).toBeUndefined()
  })
})

describe('브라우저 도구 실행', () => {
  it('browser_eval returns the value, says when a script tried to act, and keeps cookies out (ADR 0045)', async () => {
    const b = fakeBrowser()
    const call = b.call
    const evals: string[] = []
    b.call = async (cmd, args) => {
      if (cmd === 'eval') evals.push(String(args?.expression))
      if (cmd === 'eval')
        return String(args?.expression).includes('click')
          ? { error: 'EvalError: Possible side-effect in debug-evaluate' }
          : { type: 'object', value: [{ row: 1, price: 9900 }] }
      return call(cmd, args)
    }
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://shop.example' })
    const ok = await tools.run('eval', { tabId: 3, expression: '[...document.rows].map(r => r.price)' })
    expect(text(ok)).toContain('"price": 9900')
    const act = await tools.run('eval', { tabId: 3, expression: 'document.querySelector("button").click()' })
    expect(act.isError).toBe(true)
    expect(text(act)).toContain('browser_click')
    const jar = await tools.run('eval', { tabId: 3, expression: 'document.cookie' })
    expect(jar.isError).toBe(true)
    expect(evals).toHaveLength(2)
  })

  it('browser_cdp takes only the read-or-produce list and keeps files it makes', async () => {
    const b = fakeBrowser()
    const call = b.call
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4_000, 32)]).toString('base64')
    const cdps: string[] = []
    b.call = async (cmd, args) => {
      if (cmd === 'cdp') cdps.push(String(args?.method))
      if (cmd === 'cdp')
        return args?.method === 'Page.printToPDF' ? { data: pdf } : { frameTree: { frame: { id: 'f' } } }
      return call(cmd, args)
    }
    const tools = new BrowserTools(b)
    const kept: string[] = []
    tools.savePdf = async (name) => {
      kept.push(name)
      return `~/두리/${name}.pdf`
    }
    await tools.run('open', { url: 'https://shop.example' })
    const r = await tools.run('cdp', { tabId: 3, method: 'Page.printToPDF', name: '증명서' })
    expect(text(r)).toContain('~/두리/증명서.pdf')
    expect(kept).toEqual(['증명서'])
    expect(text(await tools.run('cdp', { tabId: 3, method: 'Page.getResourceTree' }))).toContain('frameTree')
    const no = await tools.run('cdp', { tabId: 3, method: 'Network.getCookies' })
    expect(no.isError).toBe(true)
    expect(cdps).toEqual(['Page.printToPDF', 'Page.getResourceTree'])
  })

  it('an extension too old to print a PDF: says what else to try, and the daemon hears to come back', async () => {
    const b = fakeBrowser()
    const call = b.call
    b.call = async (cmd, args) => {
      if (cmd === 'pdf') throw new Error('Unknown command: pdf')
      return call(cmd, args)
    }
    const tools = new BrowserTools(b)
    tools.savePdf = async () => '/x.pdf'
    const told: number[] = []
    tools.pdfTooOld = (tabId) => told.push(tabId)
    await tools.run('open', { url: 'https://shop.example' })
    const r = await tools.run('save_pdf', { tabId: 3 })
    expect(r.isError).toBe(true)
    // It used to say "tell them you will save it once the extension updates", and Dool2 stopped there (11-27)
    expect(text(r)).toContain('Do not stop at this')
    expect(text(r)).toContain('download, save or PDF button')
    // The certificate run sent the person to chrome://extensions developer mode, and said Documents blocked saving
    expect(text(r)).toContain('never send them to chrome://extensions')
    expect(text(r)).toContain('needs no folder permission')
    expect(told).toEqual([3])
  })

  it('열면 바로 읽어 돌려준다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    const r = await tools.run('open', { url: 'https://shop.example' })
    expect(text(r)).toContain('[탭 3] 가게 — https://shop.example/item/1')
    expect(text(r)).toContain('[e4 버튼 "바로 구매"]')
    expect(b.calls.map((c) => c[0])).toEqual(['open', 'snapshot'])
  })

  it('a lookup beside another task opens its tab behind and leaves the live view where it was', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    const opened: [number, string][] = []
    tools.onOpen = (tabId, viewer) => opened.push([tabId, viewer])
    tools.lastTabId = 1
    // An older extension ignores background: the daemon learns it from the answer
    await tools.run('open', { url: 'https://weather.example' }, { ai: true, viewer: 'tw', background: true })
    expect(b.calls[0]).toEqual(['open', { url: 'https://weather.example', background: true }])
    expect(tools.backgroundOpens).toBe(false)
    expect(tools.lastTabId).toBe(1)
    expect(opened).toEqual([[3, 'tw']])
    const ext = fakeBrowser()
    const call = ext.call
    ext.call = async (cmd, args) => (cmd === 'open' ? { tabId: 4, background: true } : call(cmd, args))
    const t2 = new BrowserTools(ext)
    await t2.run('open', { url: 'https://weather.example' }, { ai: true, viewer: 'tw', background: true })
    expect(t2.backgroundOpens).toBe(true)
    expect(t2.lastTabId).toBeUndefined()
    // The task that drives the browser opens in front as before
    await t2.run('open', { url: 'https://shop.example' }, { ai: true, viewer: 'ta' })
    expect(t2.lastTabId).toBe(4)
  })

  it('구매 버튼은 누르지 않고 승인을 요청하라고 한다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e4' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('"구매"')
    expect(text(r)).toContain('browser_checkout')
    expect(b.calls.map((c) => c[0])).not.toContain('click')

    const ok = await tools.run('click', { tabId: 3, ref: 'e3' })
    expect(ok.isError).toBeUndefined()
    expect(b.calls.map((c) => c[0])).toContain('click')
  })

  it('폰 키패드로 받은 비밀번호대로 화면 키패드를 한 번씩·둘레 글 검사 없이 누른다', async () => {
    // 누를 때마다 '●○○○○○ (1/6자리)'가 바뀌어 둘레 글 검사가 둘째 숫자부터 막았다 (시험 가게 결제 창)
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    const keys = { '1': 'e11', '2': 'e12', '3': 'e13' }
    expect(await tools.pressPin(3, keys, '312')).toBe(true)
    const clicks = b.calls.filter((c) => c[0] === 'click').map((c) => c[1])
    // 빠르게(quick) 누르고, 화면 아래 키패드로 늘린 화면 높이는 마지막 숫자에서만 되돌린다(keepTall)
    expect(clicks).toEqual(
      ['e13', 'e11', 'e12'].map((ref, i) => ({
        tabId: 3,
        ref,
        once: true,
        force: true,
        quick: true,
        keepTall: i < 2,
      })),
    )
    // 짚지 않은 숫자가 있으면 거기서 멈춘다
    expect(await tools.pressPin(3, keys, '19')).toBe(false)
  })

  it('읽지 않은 표시는 누르지 않는다', async () => {
    const tools = new BrowserTools(fakeBrowser())
    const r = await tools.run('click', { tabId: 3, ref: 'e2' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('Read the page first')
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
    expect(text(r)).toContain('robot check')
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
    expect(classifyDialogRisk('사과 1kg을 주문하시겠습니까?')?.kind).toBe('money')
    expect(classifyDialogRisk('예약하시겠습니까?')?.kind).toBe('money')
    expect(classifyDialogRisk('결제를 진행할까요?')?.kind).toBe('money')
    expect(classifyDialogRisk('메시지를 보내시겠습니까?')?.kind).toBe('contact')
    expect(classifyDialogRisk('선택한 상품을 삭제할까요?')?.kind).toBe('irreversible')
    expect(classifyDialogRisk('예약을 취소하시겠습니까?')).toBeDefined()
    // 결제 단계 주소라도 창 글로만 본다
    expect(classifyDialogRisk('쿠폰을 적용할까요?')).toBeUndefined()
    // 보통 확인은 막지 않는다
    expect(classifyDialogRisk('장바구니로 이동할까요?')).toBeUndefined()
    expect(classifyDialogRisk('로그인이 필요합니다. 로그인 페이지로 이동할까요?')).toBeUndefined()
    expect(classifyDialogRisk('예약 내역을 보시겠어요?')).toBeUndefined()
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
    expect(r).toContain('💬 Site alert: "아이디 또는 비밀번호가 틀렸어요"')
    expect(r).toContain('whether to leave the page')
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
    expect(r).toContain('⚠ A site confirm dialog is open: "장바구니로 이동할까요?"')
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
    expect(text(done)).toContain('[Cancel]')
    expect(text(done)).toContain('[e4 버튼 "바로 구매"]')
  })

  it('입력 창은 넣을 글을 함께 넘긴다', async () => {
    const b = dialogBrowser({ type: 'prompt', message: '수량', url: 'https://x/', defaultPrompt: '1' })
    const tools = new BrowserTools(b)
    expect(text(await tools.run('read', { tabId: 3 }))).toContain('prefilled text: "1"')
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
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e4',
      what: '사과',
      where: '가게',
      final_here: true,
    })
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

describe('여러 개 한 번에 승인', () => {
  function calBrowser() {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const page = { tabId: 3, url: 'https://cal.example/day', title: '캘린더' }
    let left = 3
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        // 지우면 화면이 바뀐다 (남은 일정 수)
        if (cmd === 'click') left--
        if (cmd === 'snapshot')
          return { ...page, text: `# 일정 ${left}개\n[e4 버튼 "삭제"]\n[e6 버튼 "일정 삭제"]` }
        return { ...page, url: `${page.url}?left=${left}` }
      },
    }
  }

  it('개수를 적어 한 번 승인받으면 같은 사이트의 같은 종류 버튼은 남은 개수만큼 묻지 않는다', async () => {
    const b = calBrowser()
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    expect((await tools.run('click', { tabId: 3, ref: 'e4' })).isError).toBe(true)
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e4',
      what: '일정 2개 지우기',
      where: '캘린더',
      count: 2,
    })
    const [rec] = tools.approvals.list()
    expect(rec?.what).toBe('[2개 모두] 일정 2개 지우기')
    const ok = await tools.approve(rec?.id as string)
    expect(ok.ok).toBe(true)
    expect(ok.message).toContain('남은 1개')
    await tools.run('read', { tabId: 3 })
    expect((await tools.run('click', { tabId: 3, ref: 'e6' })).isError).toBeFalsy()
    // 남은 개수를 다 쓰면 다시 묻는다 (사이트 통째로 30분 통과는 없다)
    await tools.run('read', { tabId: 3 })
    expect((await tools.run('click', { tabId: 3, ref: 'e4' })).isError).toBe(true)
  }, 30_000)
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
    expect(text(r)).toContain('1. Typed in "이름".')
    expect(text(r)).toContain('4. Pressed 버튼 "다음".')
  })

  it('편집기가 그린 자리에 넣으면 눌러 넣었다고, 글이 안 보이면 다시 하라고 알린다 (사람에게 넘기지 않는다)', async () => {
    let seen = true
    const b = formBrowser((cmd) =>
      cmd === 'type' ? { tabId: 3, url: 'https://shop.example/join', drawn: true, seen } : undefined,
    )
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const ok = await tools.run('type', { tabId: 3, ref: 'e1', text: '제주 바다 여행' })
    expect(text(ok)).toContain('Clicked the "이름" spot and typed (the typed text shows on screen).')
    seen = false
    const miss = await tools.run('type', { tabId: 3, ref: 'e1', text: '제주 바다 여행' })
    expect(text(miss)).toContain('the typed text does not show on screen')
    expect(text(miss)).toContain('browser_click')
    expect(text(miss)).not.toMatch(/copy|paste/i)
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
    expect(text(r)).toContain('Because it moved to another screen, the remaining 1 actions were not done')
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
    expect(text(r)).toContain('Because a site confirm dialog appeared, the remaining 1 actions were not done')
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
    expect(text(r)).toContain('2. Stopped')
    expect(text(r)).toContain('browser_checkout')
    expect(text(r)).toContain('the remaining 1 actions were not done')
    expect(b.calls.filter((c) => c[0] === 'click')).toHaveLength(0)
  })

  it('올려 두기는 누르지 않으니 위험한 버튼에도 막지 않는다', async () => {
    const b = formBrowser()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('hover', { tabId: 3, ref: 'e5' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('Hovered over 버튼 "바로 구매".')
    expect(b.calls.map((c) => c[0])).toEqual(['snapshot', 'hover', 'snapshot'])
  })

  it('정해진 동작만, 먼저 읽은 화면에서만 한다', async () => {
    const tools = new BrowserTools(formBrowser())
    expect((await tools.run('steps', { tabId: 3, steps: [{ do: 'wait' }] })).isError).toBe(true)
    await tools.run('read', { tabId: 3 })
    const bad = await tools.run('steps', { tabId: 3, steps: [{ do: 'eval', code: 'alert(1)' }] })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('Unknown action')
    const many = await tools.run('steps', {
      tabId: 3,
      steps: Array.from({ length: 13 }, () => ({ do: 'wait' })),
    })
    expect(text(many)).toContain('Up to 12 actions')
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
    expect(calls[0]).toEqual({ tabId: 3, maxChars: PAGE_READ_CHARS, from: '상품 150' })
    expect(r).toContain('Skipped the first 41,000 characters')
    // 잘렸으면 이어 읽을 자리를 알려 준다
    expect(r).toMatch(/skip: \d+/)
    // 일부만 읽을 때는 글이 적어도 빈 화면으로 보고 다시 읽지 않는다
    expect(calls).toHaveLength(1)
    expect(text(await tools.run('click', { tabId: 3, ref: 'e150' }))).not.toContain('몰라요')
  })

  it('보이는 부분만 읽으면 위·아래에 남은 글을 알린다', () => {
    expect(scopeLines({ around: { above: 1200, below: 0 } }, { view: true })).toEqual([
      '(Read only the part visible on screen. ↑ about 1,200 characters above)',
    ])
    expect(scopeLines({ fromMissing: true }, { from: '없는 말' })[0]).toContain('so read from the start')
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
    expect(r).toContain('↓ About 3,000 more characters are below the screen')
  })
})

describe('hand-off needs what was tried', () => {
  it('is never made while the extension is not connected (that is a PC state, not a task for the person)', async () => {
    const b = { ...fakeBrowser(), status: { connected: false } }
    const tools = new BrowserTools(b)
    for (let i = 0; i < 2; i++) {
      const r = await tools.run('handoff', { tabId: 3, reason: 'sign in', tried: 'x', emergency: true })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('Not handed off')
      expect(text(r)).toContain('extension is not connected')
    }
    expect(tools.handoffsSince(0)).toEqual([])
    expect(b.calls.map((c) => c[0])).not.toContain('focus')
  })

  it('a site with service tools is not handed off with nothing tried; with what was tried it goes on', async () => {
    const tools = new BrowserTools(fakeBrowser())
    tools.siteConnector = async () => ({ id: 'shop', name: 'Shop', tools: ['shop_orders'] })
    await tools.run('open', { url: 'https://shop.example/login' })
    const r = await tools.run('handoff', {
      tabId: 3,
      reason: 'sign in',
      blocker: 'other',
      tried: 'nothing',
      emergency: true,
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('Not handed off: nothing was tried yet')
    expect(text(r)).toContain('shop_orders')
    expect(tools.handoffsSince(0)).toEqual([])
    const args = {
      tabId: 3,
      reason: 'sign in',
      blocker: 'identity_check',
      tried: 'shop_orders stopped at a sign-in check',
      emergency: true,
    }
    await tools.run('handoff', args)
    const done = await tools.run('handoff', args)
    expect(done.isError).toBeFalsy()
    expect(text(done)).toContain('⏸ Waiting for the person.')
    expect(tools.handoffsSince(0)).toEqual([{ tabId: 3, blocker: 'identity_check', tried: args.tried }])
  })
})

describe('원격 화면 (폰)', () => {
  it('두리가 사람에게 넘긴 탭만, 30분 동안 보고 누를 수 있다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    // 넘기기 전에는 안 된다
    await expect(tools.remoteScreen(3)).rejects.toThrow('원격 화면으로 볼 수 없어요')
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('handoff', { tabId: 3, reason: '로그인해 주세요', emergency: true })
    await tools.run('handoff', { tabId: 3, reason: '로그인해 주세요', emergency: true })
    expect(tools.remoteAllowed(3)).toBe(true)
    expect(tools.remoteAllowed(4)).toBe(false)
    expect(tools.remoteAllowed(3, Date.now() + 31 * 60_000)).toBe(false)
  })

  it('사람에게 넘긴 탭은 30분 동안 탭 정리에서 빼 달라고 확장에 알린다 (도구를 쓸 때마다는 아니다)', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://shop.example/pay' })
    expect(b.calls.some((c) => c[0] === 'hold')).toBe(false)
    await tools.run('handoff', { tabId: 3, reason: '결제 버튼을 눌러 주세요', emergency: true })
    await tools.run('handoff', { tabId: 3, reason: '결제 버튼을 눌러 주세요', emergency: true })
    expect(b.calls.find((c) => c[0] === 'hold')).toEqual(['hold', { tabId: 3, ms: 30 * 60_000 }])
  })

  it('누른 자리(사진 비율)를 페이지 좌표로 바꾸고, 화면 밖은 거절한다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('handoff', { tabId: 3, reason: '로그인해 주세요', emergency: true })
    await tools.run('handoff', { tabId: 3, reason: '로그인해 주세요', emergency: true })
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
    await tools.run('handoff', { tabId: 3, reason: '본인인증해 주세요', emergency: true })
    await tools.run('handoff', { tabId: 3, reason: '본인인증해 주세요', emergency: true })
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
    await tools.run('handoff', { tabId: 3, reason: '본인인증해 주세요', emergency: true })
    await tools.run('handoff', { tabId: 3, reason: '본인인증해 주세요', emergency: true })
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
    expect(text(r)).toContain('Showed a login card')
    expect(text(r)).not.toMatch(/password:|비밀번호:/)
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

  it('연결해 둔 서비스(금고 계정·간편 로그인)면 카드를 띄우지 않고 connect_ask로 다시 로그인하게 한다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b, { findForOrigin: async () => undefined, markUsed: async () => {} })
    tools.reloginFor = async (origin) => (origin === 'https://shop.example' ? 'korean-air' : undefined)
    await tools.run('open', { url: 'https://shop.example/login' })
    await tools.run('read', { tabId: 3 })
    const r = text(await tools.run('request_login', { tabId: 3, site: '대한항공' }))
    expect(r).toContain('connect_ask("korean-air")')
    expect(tools.logins.list()).toHaveLength(0)
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
    expect(first).toContain('has Dool2 service tools: catchtable_search')
    const again = text(await tools.run('read', { tabId: 3 }))
    expect(again).not.toContain('service tools')
  })

  it('막 연 화면이 비어 있으면 한 번 기다렸다 다시 읽는다', async () => {
    const r = text(await new BrowserTools(browserWith([EMPTY, PAGE])).run('read', { tabId: 3 }))
    expect(r).toContain('사과 1kg')
    expect(r).not.toContain('almost no text')
  })

  it('계속 비어 있으면 주소가 틀렸을 수 있다고 다른 길을 알린다', async () => {
    const r = text(await new BrowserTools(browserWith([EMPTY])).run('read', { tabId: 3 }))
    expect(r).toContain('almost no text')
    expect(r).toContain('home')
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
    expect(text(r)).toContain('승인이 필요해요')
    expect(text(r)).toContain('browser_checkout')
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

  it('결제 화면 표시(힌트)와 확정 화면을 알아본다', () => {
    expect(checkoutScreen(ROOMS, room.url)).toBeUndefined()
    // 상세 화면의 안내 문장 속 '결제 수단'은 결제 화면 표시가 아니다 (실측 문장)
    const notice = `${ROOMS}\n이 숙박 시설에서 사용 가능한 결제 수단은 신용카드, 현금입니다.\n결제 가능한 신용카드: Visa, Mastercard`
    expect(checkoutScreen(notice, room.url)).toBeUndefined()
    expect(checkoutScreen('## 결제 수단\n[e1 라디오 "신용카드"]\n## 배송지 정보', room.url)).toBe(
      'payment method·booker details',
    )
    expect(checkoutScreen('여부 및 배송비 결제 방법 선택\n총 상품금액 12,900원', room.url)).toBeUndefined()
    expect(checkoutScreen(CHECKOUT, 'https://kr.hotels.com/x')).toBe('payment amount·booker details')
    expect(checkoutScreen('주문 상품', 'https://shop.example/order/sheet')).toBe('checkout URL')
    expect(confirmedScreen('예약이 완료되었습니다. 예약 번호: HC12345678')).toBeTruthy()
    expect(confirmedScreen('예약 완료하기')).toBeUndefined()
  })

  it('결제 흐름이어도 [예약하기]를 몰래 통과시키지 않는다: AI가 opens_checkout으로 판단해야 누른다', async () => {
    const b = payBrowser([room, checkout])
    const tools = new BrowserTools(b)
    tools.startPayFlow(3, 'hotels-com.prepare_booking')
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e58' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('opens_checkout')
    expect(b.calls.map((c) => c[0])).not.toContain('click')
    const ok = await tools.run('click', { tabId: 3, ref: 'e58', opens_checkout: true })
    expect(ok.isError).toBeUndefined()
    expect(text(ok)).toContain('This is a checkout screen')
  })

  it('승인 요청은 어느 단계의 버튼이든 받는다. 같은 버튼에 또 요청하면 새 카드 하나만 남는다', async () => {
    const b = payBrowser([room, checkout])
    const tools = new BrowserTools(b)
    tools.startPayFlow(3, 'hotels-com.prepare_booking')
    await tools.run('read', { tabId: 3 })
    // 결제 화면을 여는 버튼에 승인을 받겠다고 해도 거절하지 않는다 (묻는 건 안전하다)
    const early = await tools.run('request_approval', { tabId: 3, ref: 'e58', what: '예약', where: '호텔' })
    expect(early.isError).toBeUndefined()
    await tools.run('click', { tabId: 3, ref: 'e58', opens_checkout: true })
    const ok = await tools.run('request_approval', {
      tabId: 3,
      ref: 'e10',
      what: '슈피리어 더블룸 3박',
      where: '호텔스닷컴',
      amount: '₩519,720',
    })
    expect(ok.isError).toBeUndefined()
    expect(tools.approvals.list().filter((a) => a.status === 'pending')).toHaveLength(1)
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e10',
      what: '슈피리어 더블룸 3박',
      where: '호텔스닷컴',
    })
    expect(tools.approvals.list().filter((a) => a.status === 'pending')).toHaveLength(1)
  })

  it('들어가는 버튼이 바로 확정해 버린 화면이면 숨기지 않고 알린다', async () => {
    const done = { url: 'https://kr.hotels.com/trip/1', text: '예약이 완료되었습니다. 예약 번호: HC12345678' }
    const b = payBrowser([room, done])
    const tools = new BrowserTools(b)
    tools.startPayFlow(3, 'hotels-com.prepare_booking')
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e58', opens_checkout: true })
    expect(text(r)).toContain('may already be confirmed')
  })

  it('같은 서비스 사이트를 새 탭으로 다시 열어도 결제 흐름이다', async () => {
    const b = payBrowser([room, checkout])
    const tools = new BrowserTools(b)
    tools.startPayFlow(9, 'hotels-com.prepare_booking', ['hotels.com'])
    await tools.run('read', { tabId: 3 }) // 새 탭 3에서 kr.hotels.com을 읽었다
    expect(tools.payFlow(3)).toBe('hotels-com.prepare_booking')
  })

  it('돈 내기 도구가 있는 서비스 사이트면 도구를 거치지 않고 연 탭도 결제 흐름이다', async () => {
    const tools = new BrowserTools(payBrowser([room, checkout]))
    tools.setPayServiceSites(['hotels.com'])
    await tools.run('read', { tabId: 3 })
    expect(tools.payFlow(3)).toBe('site:hotels.com')
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

  it('읽을 때 몰래 닫지 않고, 덮은 창의 닫기 버튼만 한 줄로 알린다', async () => {
    const calls: string[] = []
    const b = {
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.ref ? ` ${args.ref}` : ''}`)
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://kr.hotels.com/ho480371/',
            title: '호텔',
            text: `${ROOMS}\n${COOKIE}`,
            truncated: false,
            captcha: false,
          }
        return { tabId: 3 }
      },
    }
    const tools = new BrowserTools(b)
    const r = text(await tools.run('read', { tabId: 3 }))
    expect(r).toContain('🪟 Covering window: [e37 버튼 "모두 거부"]')
    expect(calls).toEqual(['snapshot'])
    expect(coverLine('앱으로 보면 10% 더 저렴해요 [e2 버튼 "앱에서 열기"] [e3 버튼 "나중에"]')).toContain(
      '[e3 버튼 "나중에"]',
    )
    expect(coverLine(PAGE)).toBeUndefined()
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
    const fills = b.calls
      .filter((c) => c[0] === 'fill')
      .map((c) => {
        const { trust, ...rest } = c[1] as Record<string, unknown>
        expect(trust).toContain('yeskey.or.kr')
        return rest
      })
    expect(fills).toEqual([
      { tabId: 3, ref: 'e3', value: 'HONG', origin: 'https://kr.hotels.com' },
      { tabId: 3, ref: 'e4', value: 'GILDONG', origin: 'https://kr.hotels.com' },
      { tabId: 3, ref: 'e5', value: 'hong.gd@example.com', origin: 'https://kr.hotels.com' },
      { tabId: 3, ref: 'e6', value: '1012345678', origin: 'https://kr.hotels.com' },
    ])
    const t = text(r)
    expect(t).toContain('Filled from my info')
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
    expect(text(r)).toContain('My info has no 이메일')
    expect(text(r)).toContain('browser_request_profile')
    expect(b.calls.filter((c) => c[0] === 'fill')).toHaveLength(1)
    // Not shown before looking where the values may already be
    const blind = await tools.run('request_profile', { fields: ['email', 'phone'], reason: '호텔 예약자 칸' })
    expect(blind.isError).toBe(true)
    expect(text(blind)).toContain('profile_view')
    expect(asked).toEqual([])
    const card = await tools.run('request_profile', {
      fields: ['email', 'phone'],
      reason: '호텔 예약자 칸',
      looked: ['profile_view', 'mail'],
    })
    expect(card.isError).toBeUndefined()
    expect(asked).toEqual([['email', 'phone']])
    // A wait for the person: the task stays open and carries on when the card is saved (11-26 it ended first)
    expect(waitsForPerson(card)).toBe(true)
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
    // 결제 버튼을 누른 뒤 늦게 뜬 결제 창(popup)도 한 번 찾는다
    expect(b.calls).toContain('click e21')
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

  // 실측(야놀자 레저 결제 2026-11-19): 결제 수단이 '○○ 혜택' 버튼이고, 골라진 수단만 펼쳐져 있다.
  // AI가 앞의 넷만 choices로 넘겨 '다른 결제 수단'(일반 결제·다른 페이)이 승인 카드에서 빠졌다
  function nolPage() {
    let method = '카카오페이'
    const calls: string[] = []
    const open = (m: string) => (method === m ? ' 펼침' : '')
    const text = () =>
      '결제 수단\nNOL 머니 결제 시\n' +
      `[e10 버튼 "NOL 머니 2% 포인트 적립"${open('NOL 머니')}]\nNOL 머니로 결제하면, 최대 1,110P 적립\n` +
      `[e11 버튼 "NOL 카드 페이"${open('NOL 카드 페이')}]\n` +
      `[e12 버튼 "카카오페이 혜택"${open('카카오페이')}]\n` +
      `[e13 버튼 "토스페이 혜택"${open('토스페이')}]\n` +
      `[e14 버튼 "다른 결제 수단 혜택"${open('다른 결제 수단')}]\n` +
      '[e15 버튼 "결제 수단별 혜택 전체 보기"]\n[e16 체크박스 선택됨]\n약관 동의\n' +
      '[e7 버튼 "NOL 카드 50% 쿠폰 X 5매 받기"]\n' +
      '[e22 버튼 "NOL 카드 페이 전용 50% 할인 쿠폰X5장(최대 14.5만원)"]\n' +
      `결제 금액\n총 결제 금액\n결제수단${method}\n[e24 버튼 "55,500원 결제하기"]`
    const pick: Record<string, string> = {
      e10: 'NOL 머니',
      e11: 'NOL 카드 페이',
      e12: '카카오페이',
      e13: '토스페이',
      e14: '다른 결제 수단',
    }
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(`${cmd}${args?.ref ? ` ${args.ref}` : ''}`)
        if (cmd === 'click' && pick[String(args?.ref)]) method = pick[String(args?.ref)] as string
        if (cmd === 'click' && args?.ref === 'e24') method = '완료'
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://platform-site.yanolja.com/domestic/order',
            title: 'NOL',
            text: method === '완료' ? '결제창을 여는 중' : text(),
            truncated: false,
            captcha: false,
          }
        return { tabId: 3, url: 'https://platform-site.yanolja.com/domestic/order' }
      },
    }
  }

  it('AI가 결제 수단 몇 개만 넘겨도 화면의 다른 결제 수단까지 싣고, 혜택 안내는 떼고, 펼쳐진 수단이 기본값', async () => {
    const b = nolPage()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('request_approval', {
      tabId: 3,
      ref: 'e24',
      what: '롯데월드 아쿠아리움 2인권',
      where: '야놀자',
      choices: ['e10', 'e11', 'e12', 'e13'],
    })
    expect(r.isError).toBeUndefined()
    const [rec] = tools.approvals.list()
    expect(rec?.choices?.map((c) => c.label)).toEqual([
      'NOL 머니 2% 포인트 적립',
      'NOL 카드 페이',
      '카카오페이',
      '토스페이',
      '다른 결제 수단',
    ])
    // 화면에서 펼쳐져 있는(골라진) 카카오페이가 기본값
    expect(rec?.choice).toBe('c3')
    const done = await tools.approve(rec?.id as string, 'c5')
    expect(done.ok).toBe(true)
    expect(b.calls.filter((c) => c.startsWith('click'))).toEqual(['click e14', 'click e24'])
  })

  // 내 결제 수단 (ADR 0023)
  const NOW = '2026-11-19T00:00:00.000Z'
  it('내 결제 수단 중 사이트가 받는 첫 번째를 기본으로 골라 두고, 맞는 칩에 표시한다', async () => {
    const b = nolPage()
    const tools = new BrowserTools(b)
    tools.payMethods = () => [
      { id: 'a', kind: 'naverpay', inner: '신한카드(1234)', addedAt: NOW },
      { id: 'b', kind: 'tosspay', inner: '토스머니', addedAt: NOW },
      { id: 'c', kind: 'kakaopay', addedAt: NOW },
    ]
    // 이 사이트에서 지난번에 고른 것보다 내 결제 수단이 먼저
    tools.loadChoices({ 'platform-site.yanolja.com': 'NOL 카드 페이' })
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e24', what: 'x', where: 'y' })
    const rec = tools.approvals.list()[0]
    // 주 결제 수단(네이버페이)은 야놀자에 없어서 다음인 토스페이
    expect(rec?.choice).toBe('c4')
    expect(rec?.choices?.filter((c) => c.mine).map((c) => [c.label, c.mine])).toEqual([
      ['카카오페이', '카카오페이'],
      ['토스페이', '토스페이 · 토스머니'],
    ])
    // 승인하면 결제 창에서 그 안의 것을 고르라고 AI에게 알린다
    const done = await tools.approve(rec?.id as string, 'c4')
    expect(done.ok).toBe(true)
    expect(done.message).toContain('"토스머니"')
  })

  it('내 결제 수단이 사이트에 없으면 지금처럼 지난번 것 → 화면에 골라진 것', async () => {
    const tools = new BrowserTools(nolPage())
    tools.payMethods = () => [{ id: 'a', kind: 'naverpay', addedAt: NOW }]
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e24', what: 'x', where: 'y' })
    expect(tools.approvals.list()[0]?.choice).toBe('c3')
    expect(tools.approvals.list()[0]?.choices?.some((c) => c.mine)).toBe(false)
  })

  it('등록한 카드면 카드 칸을 고르고, 카드 목록에서 그 카드사를 기본으로', async () => {
    const tools = new BrowserTools(coupangPage('카드'))
    tools.payMethods = () => [{ id: 'a', kind: 'card', issuer: 'KB국민카드', addedAt: NOW }]
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', { tabId: 3, ref: 'e21', what: '세제 1개', where: '쿠팡' })
    const rec = tools.approvals.list()[0]
    expect(rec?.choice).toBe('c2')
    expect(rec?.subChoices?.find((g) => g.title === '카드')?.choice).toBe('s1o2')
  })

  it('결제 시점처럼 결제 수단이 아닌 선택지에는 화면의 결제 수단을 섞지 않는다', async () => {
    const tools = new BrowserTools(nolPage())
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e24',
      what: 'x',
      where: 'y',
      choices: ['e10', 'e11'],
      choiceTitle: '결제 시점',
    })
    expect(tools.approvals.list()[0]?.choices?.length).toBe(2)
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

  it('사용자가 폰에서 직접 정한 비밀번호가 있으면 그걸 넣고, 칸에 다 안 들어가면 다시 묻게 한다', async () => {
    const t = signupBench()
    t.tools.allowSignup('shop.example')
    t.tools.setOwnPassword('shop.example', 'MyOwn!pass2026')
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('new_password', {
      tabId: 3,
      password: 'e2',
      confirm: 'e3',
      username: 'me@example.com',
    })
    expect(r.isError).toBeUndefined()
    expect(t.fills.map((f) => f.value)).toEqual(['MyOwn!pass2026', 'MyOwn!pass2026'])
    expect(t.text(r)).toContain('the password the user set')
    expect(t.text(r)).not.toContain('MyOwn!pass2026')
    // 한 번 쓰면 지운다: 다음엔 두리가 만든다
    await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    expect(t.fills.at(-1)?.value).toHaveLength(16)
    // 칸이 글자 수를 막으면 사용자 값은 바꾸지 않고 다시 묻는다
    const short = signupBench({ maxLen: 10, ask: 'asked' })
    short.tools.allowSignup('shop.example')
    short.tools.setOwnPassword('shop.example', 'MyOwn!pass2026')
    await short.tools.run('read', { tabId: 3 })
    const bad = await short.tools
      .run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }))
    expect(short.text(bad as never)).toContain('call browser_new_password again')
    const again = short.text(
      await short.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' }),
    )
    expect(again).toContain("on the user's phone")
    expect(short.asked).toHaveLength(1)
  })

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
    expect(done).toContain('saved it in the vault')
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

  it('칸이 8자보다 적게 받으면 넣었다고 하지 않고, 사람에게 넘기지 않고 폰에서 다시 묻게 한다', async () => {
    const t = signupBench({ maxLen: 6 })
    t.tools.allowSignup('shop.example')
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    expect(r.isError).toBe(true)
    expect(t.text(r)).not.toContain('browser_handoff')
    expect(t.text(r)).toContain('call browser_new_password again')
  })

  it('"이미 가입된 이메일"이 새로 뜨면 만든 비밀번호를 버리고 로그인으로 바꾸라고 한다', async () => {
    const t = signupBench()
    t.tools.allowSignup('shop.example')
    await t.tools.run('read', { tabId: 3 })
    await t.tools.run('new_password', { tabId: 3, password: 'e2', username: 'me@example.com' })
    t.page.now = { ...t.form, text: `${t.form.text} 이미 가입된 이메일이에요. 로그인해 주세요.` }
    const out = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(out).toContain('discarded')
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
    expect(t.text(r)).toContain("Asked on the user's phone")
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
    expect(listed).toContain('2. M (품절) — cannot be chosen')
    const r = await t.tools.run('select', { tabId: 3, ref: 'e1', choose: 'l' })
    expect(r.isError).toBeUndefined()
    expect(t.chosen).toEqual(['L'])
    // 품절은 고르지 않는다
    const sold = await t.tools.run('select', { tabId: 3, ref: 'e1', choose: 'M' })
    expect(sold.isError).toBe(true)
    expect(t.chosen).toEqual(['L'])
  })

  it('결제 수단·할부 목록도 거절하지 않는다 (사용자가 이미 골랐는지는 AI가 판단)', async () => {
    const t = shop(['신용카드', '네이버페이', '카카오페이'])
    await t.tools.run('read', { tabId: 3 })
    const r = await t.tools.run('select', { tabId: 3, ref: 'e1', choose: '네이버페이' })
    expect(r.isError).toBeUndefined()
    expect(t.chosen).toEqual(['네이버페이'])
  })

  it('"옵션을 선택해 주세요" 알림이 뜨면 옵션 칸을 짚어 알린다', async () => {
    const t = shop(['S'], '옵션을 선택해 주세요.')
    const out = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(out).toContain('🧩 An option must be chosen first')
    expect(out).toContain('[e1 버튼 "옵션 열기"]')
    const again = t.text(await t.tools.run('read', { tabId: 3 }))
    expect(again).not.toContain('🧩')
  })
})

describe('간편인증 기다리기 (폰 [인증 완료했어요])', () => {
  it('사용자가 카드를 누르기 전에는 [인증 완료]를 누르지 않고, 누르면 한 번 눌러 넘어간 화면을 돌려준다', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    let done = false
    const b = {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'click') done = true
        if (cmd === 'snapshot')
          return done
            ? { tabId: 3, url: 'https://gov.example/home', title: '홈', text: '# 홈\n[e1 링크 "로그아웃"]' }
            : {
                tabId: 3,
                url: 'https://gov.example/login',
                title: '로그인',
                text: '# 간편인증\n카카오톡으로 인증 요청을 보냈어요\n[e9 버튼 "인증 완료"]',
              }
        return { tabId: 3, url: done ? 'https://gov.example/home' : 'https://gov.example/login', title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    let press: (v: string) => void = () => {}
    const asked: string[] = []
    tools.askAuthDone = (_host, label) => {
      asked.push(label)
      return { answer: new Promise<string | undefined>((r) => (press = r)), cancel: () => {} }
    }
    await tools.run('read', { tabId: 3 })
    const waiting = tools.run('wait_auth', { tabId: 3, ref: 'e9', message: '카카오톡에서 승인해 주세요' })
    await new Promise((r) => setTimeout(r, 7_000))
    // 7초 동안 지켜보기만 했다 (미리 누르면 인증 창을 닫는 사이트가 있다)
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(0)
    expect(asked).toEqual(['카카오톡에서 승인해 주세요'])
    press('인증 완료했어요')
    const r = await waiting
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(1)
    expect(r.isError).toBeFalsy()
    // 됐는지는 AI가 넘어간 화면을 보고 판단한다
    const t = r.content[0]?.type === 'text' ? r.content[0].text : ''
    expect(t).toContain('Judge from the screen below yourself')
    expect(t).toContain('로그아웃')
  }, 40_000)

  it('one plain notification per verification: the app, the site by name, and what happens next', async () => {
    const b = {
      call: async (cmd: string) =>
        cmd === 'snapshot'
          ? {
              tabId: 3,
              url: 'https://efamily.scourt.go.kr/pt/apply',
              title: '신청인 정보 조회 | 증명서발급 | 전자가족관계등록시스템',
              text: '# 간편인증\n[e9 버튼 "인증 완료"]',
            }
          : { tabId: 3 },
    }
    const tools = new BrowserTools(b as never)
    const pushed: [string, string][] = []
    tools.notifyUser = (title, body) => pushed.push([title, body])
    let card: unknown[] = []
    tools.askAuthDone = (...args) => {
      card = args
      return { answer: Promise.resolve('인증 완료했어요'), cancel: () => {} }
    }
    await tools.run('read', { tabId: 3 })
    await tools.run('wait_auth', {
      tabId: 3,
      message: '카카오톡에서 가족관계증명서 간편인증을 승인해 주세요',
    })
    expect(pushed).toEqual([
      ['카카오톡에서 승인해 주세요', '전자가족관계등록시스템 본인 확인이에요. 승인하면 바로 이어서 할게요.'],
    ])
    expect(card[2]).toBe('카카오톡에 온 알림에서 승인한 다음, 아래 버튼을 눌러 주세요.')
    expect(card[3]).toBe('전자가족관계등록시스템')
    expect(siteName({ url: 'https://www.shop.example/a', title: '' })).toBe('shop.example')
  }, 40_000)

  it('two approvals that come back to the same page: says the site refused an input, and does not ask a third time', async () => {
    // Test PC 11-27: a family member's name typed wrong, three KakaoTalk approvals, the page never moved
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://gov.example/apply?step=1',
            title: '신청인 정보',
            text: '# 신청인 정보\n[e9 버튼 "인증 완료"]',
          }
        return { tabId: 3, url: 'https://gov.example/apply?step=1', title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    let asked = 0
    tools.askAuthDone = () => {
      asked++
      return { answer: Promise.resolve('인증 완료했어요'), cancel: () => {} }
    }
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => c.text ?? '').join('\n')
    await tools.run('read', { tabId: 3 })
    const first = text(await tools.run('wait_auth', { tabId: 3, ref: 'e9' }))
    expect(first).toContain('the one the request was sent from')
    const second = text(await tools.run('wait_auth', { tabId: 3, ref: 'e9' }))
    expect(second).toContain('refused something sent with the request')
    const third = await tools.run('wait_auth', { tabId: 3, ref: 'e9' })
    expect(third.isError).toBe(true)
    expect(asked).toBe(2)
  }, 40_000)

  it('누르지 않아도 화면이 바뀌면(확인 창·인증 창 닫힘) 바로 AI에게 넘기고, 아무 변화가 없어도 카드를 누르면 3분 기다리지 않는다', async () => {
    // ① 승인 뒤 사이트가 확인 창을 띄운다 (내보험찾아줌: "최근 접수건이 있어요. 재신청할까요?") ② 인증 팝업이 닫힌다 ③ 그대로
    for (const kind of ['dialog', 'popup', 'same'] as const) {
      let t0 = Date.now()
      const late = () => Date.now() - t0 > 3_500
      const b = {
        call: async (cmd: string, args?: { tabId?: number }) => {
          if (cmd === 'snapshot') {
            if (args?.tabId === 5) {
              if (kind === 'popup' && late()) throw new Error('탭이 없어요')
              return {
                tabId: 5,
                url: 'https://cert.example/popup',
                title: '인증',
                text: '[e1 버튼 "인증 요청"]',
              }
            }
            return {
              tabId: 3,
              url: 'https://ins.example/raon/loadModule.do',
              title: '인증',
              text: '# 간편인증\n[e9 버튼 "인증 완료"]',
              ...(kind === 'dialog' && late()
                ? { dialog: { type: 'confirm', message: '최근 접수건이 있으며, 재신청도 가능합니다.' } }
                : {}),
            }
          }
          return { tabId: args?.tabId ?? 3, url: 'https://ins.example/raon/loadModule.do', title: '' }
        },
      }
      const tools = new BrowserTools(b as never)
      let press: (v: string) => void = () => {}
      tools.askAuthDone = () => ({
        answer: new Promise<string | undefined>((r) => (press = r)),
        cancel: () => {},
      })
      await tools.run('read', { tabId: 5 })
      await tools.run('read', { tabId: 3 })
      t0 = Date.now()
      const started = Date.now()
      const waiting = tools.run('wait_auth', { tabId: 3 })
      if (kind === 'same') {
        await new Promise((r) => setTimeout(r, 4_000))
        press('인증 완료했어요')
      }
      const out = await waiting
      const text = out.content[0]?.type === 'text' ? out.content[0].text : ''
      expect(Date.now() - started).toBeLessThan(30_000)
      expect(text).toContain('Judge from the screen below yourself')
      if (kind === 'dialog') expect(text).toContain('confirm dialog')
      if (kind === 'popup') expect(text).toContain('the verification window closed')
    }
  }, 80_000)
})

describe('간편인증 기다리기는 대화를 붙잡지 않는다', () => {
  const site = () => {
    let done = false
    return {
      approve: () => {
        done = true
      },
      call: async (cmd: string) => {
        if (cmd === 'snapshot')
          return done
            ? { tabId: 3, url: 'https://gov.example/home', title: '홈', text: '# 홈\n[e1 링크 "로그아웃"]' }
            : {
                tabId: 3,
                url: 'https://gov.example/login',
                title: '로그인',
                text: '# 간편인증\n[e9 버튼 "인증 완료"]',
              }
        return { tabId: 3, url: done ? 'https://gov.example/home' : 'https://gov.example/login', title: '' }
      },
    }
  }

  it('바로 답을 끝내게 하고, 화면이 바뀌면 그 화면을 새 메시지로 보낸다', async () => {
    const b = site()
    const tools = new BrowserTools(b as never)
    let cancelled = false
    tools.askAuthDone = () => ({ answer: new Promise(() => {}), cancel: () => (cancelled = true) })
    const delivered: string[] = []
    tools.afterAuth = () => ({ signal: new AbortController().signal, deliver: (t) => delivered.push(t) })
    await tools.run('read', { tabId: 3 })
    const t0 = Date.now()
    const r = await tools.run('wait_auth', { tabId: 3 })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(r.content[0]?.type === 'text' ? r.content[0].text : '').toContain('⏸ Waiting for the person.')
    b.approve()
    for (let i = 0; i < 100 && !delivered.length; i++) await new Promise((r) => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('Judge from the screen below yourself')
    expect(delivered[0]).toContain('로그아웃')
    expect(cancelled).toBe(true)
  }, 20_000)

  it('멈추면 지켜보기를 그만두고 아무것도 보내지 않는다', async () => {
    const b = site()
    const tools = new BrowserTools(b as never)
    let cancelled = false
    tools.askAuthDone = () => ({ answer: new Promise(() => {}), cancel: () => (cancelled = true) })
    const ac = new AbortController()
    const delivered: string[] = []
    tools.afterAuth = () => ({ signal: ac.signal, deliver: (t) => delivered.push(t) })
    await tools.run('read', { tabId: 3 })
    await tools.run('wait_auth', { tabId: 3 })
    ac.abort()
    b.approve()
    await new Promise((r) => setTimeout(r, 4_500))
    expect(delivered).toEqual([])
    expect(cancelled).toBe(true)
  }, 20_000)
})

describe('PC 화면 넘기기 관문', () => {
  it('같은 화면에서 처음 부르면 넘기지 않고 화면을 다시 읽어 돌려주고, 두 번째에만 넘긴다', async () => {
    const b = fakeBrowser()
    const tools = new BrowserTools(b)
    await tools.run('open', { url: 'https://bank.example/login' })
    const first = await tools.run('handoff', {
      tabId: 3,
      reason: '휴대폰번호를 넣어 주세요',
      emergency: true,
    })
    const t = first.content[0]?.type === 'text' ? first.content[0].text : ''
    expect(t).toContain('Not handed off yet')
    expect(b.calls.some((c) => c[0] === 'focus' || c[0] === 'hold')).toBe(false)
    await tools.run('handoff', { tabId: 3, reason: '휴대폰번호를 넣어 주세요', emergency: true })
    expect(b.calls.some((c) => c[0] === 'focus')).toBe(true)
  })
})

describe('로그인 카드 값은 로그인에 성공해야 금고에 남는다', () => {
  it('됐는지는 AI가 화면을 보고 알린다: 안 됐다고 하면 카드 값은 지우고, 예전 값은 두되 카드를 다시 띄울 수 있게', async () => {
    let page = {
      url: 'https://pass.example/login',
      title: '로그인',
      text: '[e1 입력칸 "아이디"] [e2 비밀번호칸 "비밀번호"] [e3 버튼 "로그인"]',
    }
    const entries = [{ id: 'v1', username: 'me', password: 'wrong' }]
    const removed: string[] = []
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'snapshot') return { tabId: 3, ...page, truncated: false, captcha: false }
        return { tabId: 3, url: page.url }
      },
    }
    const tools = new BrowserTools(b as never, {
      findForOrigin: async () => entries.find((e) => !removed.includes(e.id)),
      markUsed: async () => {},
      remove: async (id: string) => {
        removed.push(id)
        return true
      },
    })
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    tools.markUnverified('https://pass.example')
    await tools.run('read', { tabId: 3 })
    await tools.run('login', { tabId: 3, usernameRef: 'e1', passwordRef: 'e2' })
    // 어떤 문구든 규칙으로 가리지 않는다: 로그인 화면 그대로면 AI에게 판단을 맡긴다
    page = { ...page, text: `회원님의 입력 정보를 찾을 수 없어요. ${page.text}` }
    const seen = text(await tools.run('read', { tabId: 3 }))
    expect(seen).toContain('failed: true')
    expect(removed).toEqual([])
    const out = text(
      await tools.run('login', { tabId: 3, failed: true, reason: '입력 정보를 찾을 수 없어요' }),
    )
    expect(out).toContain('removed from the vault')
    expect(removed).toEqual(['v1'])
    expect(text(await tools.run('request_login', { tabId: 3, site: '패스' }))).toContain(
      'Showed a login card',
    )
    // 성공해서 확인된 값은 지우지 않지만, 바뀐 것 같다고 하면 카드를 다시 띄울 수 있다
    entries.splice(0, 1, { id: 'v2', username: 'me', password: 'right' })
    removed.length = 0
    page = { ...page, text: '[e1 입력칸 "아이디"] [e2 비밀번호칸 "비밀번호"] [e3 버튼 "로그인"]' }
    await tools.run('read', { tabId: 3 })
    await tools.run('login', { tabId: 3, usernameRef: 'e1', passwordRef: 'e2' })
    page = { url: 'https://pass.example/my', title: '내 정보', text: '[e9 버튼 "로그아웃"]' }
    expect(text(await tools.run('read', { tabId: 3 }))).not.toContain('failed: true')
    page = { url: 'https://pass.example/login', title: '로그인', text: '[e2 비밀번호칸 "비밀번호"]' }
    await tools.run('read', { tabId: 3 })
    await tools.run('login', { tabId: 3, passwordRef: 'e2' })
    const stale = text(await tools.run('login', { tabId: 3, failed: true }))
    expect(stale).toContain('seems to have changed')
    expect(removed).toEqual([])
    expect(text(await tools.run('request_login', { tabId: 3, site: '패스' }))).toContain(
      'Showed a login card',
    )
  }, 30_000)
})

describe('인증 완료 판단은 AI가', () => {
  it('사용자가 [인증 완료했어요]를 누르면 화면 안내 문구("…진행해주세요")를 아직으로 보지 않고 화면을 AI에게 넘긴다', async () => {
    let clicked = 0
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'click') clicked++
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://pass.example/cert/member_check.html',
            title: '본인확인',
            text: '# 본인확인\n카카오톡에서 인증을 진행해주세요\n인증이 완료되었습니다\n[e9 버튼 "인증 완료하기"]',
          }
        return { tabId: 3, url: 'https://pass.example/cert/member_check.html', title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    let press: (v: string) => void = () => {}
    let cards = 0
    tools.askAuthDone = () => {
      cards++
      return { answer: new Promise<string | undefined>((r) => (press = r)), cancel: () => {} }
    }
    await tools.run('read', { tabId: 3 })
    const waiting = tools.run('wait_auth', { tabId: 3 })
    await new Promise((r) => setTimeout(r, 4_000))
    press('인증 완료했어요')
    const out = await waiting
    const text = out.content[0]?.type === 'text' ? out.content[0].text : ''
    expect(text).toContain('Judge from the screen below yourself')
    expect(text).toContain('인증이 완료되었습니다')
    // 짚어 준 버튼이 없으면 본체는 아무것도 누르지 않는다 (버튼 이름 규칙으로 고르지 않는다)
    expect(clicked).toBe(0)
    // 카드를 다시 띄우지 않았다
    expect(cards).toBe(1)
  }, 40_000)
})

describe('보안문자는 AI가 그림을 골라 폰 카드로', () => {
  it('pick 없이 부르면 칸 둘레 그림 후보를 보여 주고, pick으로 고른 그림을 카드에 붙인다', async () => {
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://cert.example/check',
            title: '본인확인',
            text: '보안문자를 입력해 주세요 [e4 입력칸 "보안문자"] [e5 버튼 "확인"]',
          }
        if (cmd === 'captcha-candidates')
          return {
            shots: [
              { what: '칸 둘레 그림', data: 'LOGO' },
              { what: '칸을 품은 상자', data: 'CAPTCHA' },
            ],
          }
        return { tabId: 3, url: 'https://cert.example/check' }
      },
    }
    const tools = new BrowserTools(b as never)
    const got: { kind?: string; image?: string }[] = []
    tools.requestCode = (_t, _f, _l, _h, _host, kind, _ref, image) => {
      got.push({ kind, image })
      return 'q1'
    }
    await tools.run('read', { tabId: 3 })
    const first = await tools.run('request_code', { tabId: 3, ref: 'e4', kind: 'captcha' })
    expect(first.content.filter((c) => c.type === 'image')).toHaveLength(2)
    expect(got).toHaveLength(0)
    await tools.run('request_code', { tabId: 3, ref: 'e4', kind: 'captcha', pick: 2 })
    expect(got).toEqual([{ kind: 'captcha', image: 'CAPTCHA' }])
  })
})

describe('승인 게이트는 화면을 열기만 하는 링크를 막지 않는다', () => {
  it('결제 쪽 주소의 진짜 링크는 누르고, 같은 이름의 버튼·지우기 링크는 막는다', async () => {
    const clicks: string[] = []
    const b = {
      call: async (cmd: string, args?: { ref?: string }) => {
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://new-m.pay.naver.com/home',
            title: '네이버페이',
            text: '[e1 링크 "포인트 받기"] [e2 버튼 "결제하기"] [e3 링크 "카드 삭제"]',
          }
        if (cmd === 'link-navigates') return { navigates: args?.ref !== 'e2' }
        if (cmd === 'click') clicks.push(String(args?.ref))
        return { tabId: 3, url: 'https://new-m.pay.naver.com/home', title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    const ok = await tools.run('click', { tabId: 3, ref: 'e1' })
    expect(ok.isError).toBeFalsy()
    expect(clicks).toEqual(['e1'])
    const pay = await tools
      .run('click', { tabId: 3, ref: 'e2' })
      .catch((e: Error) => ({ isError: true, err: e.message }))
    expect(JSON.stringify(pay)).toMatch(/승인|request_approval/)
    const del = await tools
      .run('click', { tabId: 3, ref: 'e3' })
      .catch((e: Error) => ({ isError: true, err: e.message }))
    expect(JSON.stringify(del)).toMatch(/승인|request_approval/)
    expect(clicks).toEqual(['e1'])
  })
})

describe('승인은 돈이 나가는 마지막 한 번만', () => {
  it('장바구니의 "총 5개 상품 구매하기"는 AI가 opens_checkout으로 판단하면 누르고, 결제 화면의 결제하기는 opens_checkout이어도 막는다', async () => {
    const clicks: string[] = []
    let page = {
      url: 'https://cart.coupang.com/cartView.pg',
      title: '장바구니',
      text: '장바구니 총 결제 예정 금액 17,270원 배송지 [e9 버튼 "총 5개 상품 구매하기"]',
    }
    const b = {
      call: async (cmd: string, args?: { ref?: string }) => {
        if (cmd === 'snapshot') return { tabId: 3, ...page }
        if (cmd === 'click') clicks.push(String(args?.ref))
        return { tabId: 3, url: page.url, title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    // 장바구니 주소라고 몰래 통과시키지 않는다 (판단은 AI가 opens_checkout으로)
    expect((await tools.run('click', { tabId: 3, ref: 'e9' })).isError).toBe(true)
    const r = await tools.run('click', { tabId: 3, ref: 'e9', opens_checkout: true })
    expect(r.isError).toBeFalsy()
    expect(clicks).toEqual(['e9'])
    page = {
      url: 'https://checkout.coupang.com/cart/checkout/1795156558444',
      title: '주문/결제',
      text: '결제수단 신용/체크카드 최종 결제 금액 17,270원 [e54 버튼 "결제하기"]',
    }
    await tools.run('read', { tabId: 3 })
    const pay = await tools
      .run('click', { tabId: 3, ref: 'e54', opens_checkout: true })
      .catch((e: Error) => ({ isError: true, err: e.message }))
    expect(JSON.stringify(pay)).toMatch(/승인|browser_checkout/)
    expect(clicks).toEqual(['e9'])
  })
})

describe('결제 승인 한 장에서 받는 곳도 고른다', () => {
  it('다른 배송지를 고르고 승인하면 결제는 누르지 않고 바꾸라고 알리며, 바꾼 뒤 그 결제 버튼은 다시 묻지 않고 한 번 누른다', async () => {
    const clicks: string[] = []
    const b = {
      call: async (cmd: string, args?: { ref?: string }) => {
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://checkout.coupang.com/cart/checkout/1',
            title: '주문/결제',
            text: '배송지 집 [e39 버튼 "배송지 변경"] 최종 결제 금액 17,270원 [e54 버튼 "결제하기"]',
          }
        if (cmd === 'click') clicks.push(String(args?.ref))
        return { tabId: 3, url: 'https://checkout.coupang.com/cart/checkout/1', title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e54',
      what: '장보기 5개',
      where: '쿠팡',
      amount: '17,270원',
      ship_to: '집 · 용인시 수지구',
      ship_options: ['회사 · 서울 강남구'],
    })
    const [rec] = tools.approvals.list()
    expect(rec?.shipOptions).toEqual([
      { id: 'a0', label: '집 · 용인시 수지구' },
      { id: 'a1', label: '회사 · 서울 강남구' },
    ])
    const r = await tools.approve(rec?.id as string, 'a1')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('회사 · 서울 강남구')
    expect(clicks).toEqual([])
    // 배송지를 바꾼 뒤 결제하기: 다시 묻지 않고 한 번만
    const ok = await tools.run('click', { tabId: 3, ref: 'e54' })
    expect(ok.isError).toBeFalsy()
    expect(clicks).toEqual(['e54'])
    const again = await tools
      .run('click', { tabId: 3, ref: 'e54' })
      .catch((e: Error) => ({ isError: true, err: e.message }))
    expect(JSON.stringify(again)).toMatch(/승인|request_approval/)
  })
})

describe('결제 비밀번호 키패드는 폰 보안 키패드로', () => {
  it('AI가 숫자마다 버튼을 짚어야 카드를 띄우고, 비밀번호는 AI에게 가지 않는다', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `[e2000${i < 9 ? `0${i + 1}` : i + 1} 링크]`).join(' ')
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://checkout.coupang.com/cart/checkout/1',
            title: '결제',
            text: `결제 비밀번호 6자리를 입력해주세요 ${keys}`,
          }
        return { tabId: 3, url: 'https://checkout.coupang.com/cart/checkout/1' }
      },
    }
    const tools = new BrowserTools(b as never)
    const asked: { keys: Record<string, string>; length: number }[] = []
    tools.requestPin = (_t, _l, _h, k, length) => {
      asked.push({ keys: k, length })
      return 'p1'
    }
    await tools.run('read', { tabId: 3 })
    const bad = await tools
      .run('request_code', { tabId: 3, ref: 'e20001', kind: 'pin' })
      .catch((e: Error) => e.message)
    expect(String(JSON.stringify(bad))).toContain('key_refs')
    const map = Object.fromEntries(
      '1234567890'.split('').map((d, i) => [d, `e2000${i < 9 ? `0${i + 1}` : i + 1}`]),
    )
    const dup = await tools
      .run('request_code', { tabId: 3, ref: 'e20001', kind: 'pin', keys: { ...map, '0': map['1'] } })
      .catch((e: Error) => e.message)
    expect(String(JSON.stringify(dup))).toContain('The same button')
    const ok = await tools.run('request_code', { tabId: 3, ref: 'e20001', kind: 'pin', keys: map })
    expect(ok.isError).toBeFalsy()
    expect(asked).toEqual([{ keys: map, length: 6 }])
  })
})

describe('받는 곳이 내 정보 주소와 다르면 승인 카드에서 알린다', () => {
  it('번지·동·호수가 다르면 경고와 함께 내 정보 주소를 고를 수 있게 넣는다', async () => {
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://www.food.example/checkout/',
            title: '결제',
            text: '배달 주소 신봉동 33 최종 결제 금액 18,000원 [e9 버튼 "결제하기"]',
          }
        return { tabId: 3, url: 'https://www.food.example/checkout/' }
      },
    }
    const tools = new BrowserTools(b as never)
    tools.profile = {
      get: async () => ({ address: '경기 용인시 수지구 신봉동 905', address_detail: '506동 1303호' }),
    } as never
    await tools.run('read', { tabId: 3 })
    await tools.run('request_approval', {
      tabId: 3,
      ref: 'e9',
      what: '등심카츠 정식',
      where: '배달 앱',
      amount: '18,000원',
      ship_to: '경기도 용인시 수지구 신봉동 33',
    })
    const [rec] = tools.approvals.list()
    expect(rec?.shipWarn).toContain('내 정보 주소와 달라요')
    expect(rec?.shipOptions?.[1]?.label).toContain('신봉동 905 506동 1303호')
    // 같은 주소면 경고가 없다
    const t2 = new BrowserTools(b as never)
    t2.profile = tools.profile
    await t2.run('read', { tabId: 3 })
    await t2.run('request_approval', {
      tabId: 3,
      ref: 'e9',
      what: '등심카츠 정식',
      where: '배달 앱',
      ship_to: '경기도 용인시 수지구 신봉동 905 506동 1303호',
    })
    expect(t2.approvals.list()[0]?.shipWarn).toBeUndefined()
  })
})

describe('장바구니·주문표에 담기는 결제가 아니다', () => {
  it('"주문표에 추가"·"장바구니 담기"는 승인 없이, "주문하기"는 그대로 막는다', async () => {
    const { classifyRisk } = await import('./browser-tools.js')
    expect(classifyRisk('버튼 주문표에 추가')).toBeUndefined()
    expect(classifyRisk('버튼 장바구니 담기')).toBeUndefined()
    expect(classifyRisk('버튼 주문하기')?.kind).toBe('money')
  })
})

describe('결제 화면으로 넘어가는 버튼은 AI 판단으로 승인 없이', () => {
  it('opens_checkout이면 결제 화면이 아닌 곳의 [주문하기]를 누르고, 결제 화면의 마지막 버튼은 그대로 막는다', async () => {
    const clicks: string[] = []
    let page = {
      url: 'https://www.food.example/shop/1',
      title: '가게',
      text: '주문표 우동 세트 11,500원 [e5 버튼 "주문하기"]',
    }
    const b = {
      call: async (cmd: string, args?: { ref?: string }) => {
        if (cmd === 'snapshot') return { tabId: 3, ...page }
        if (cmd === 'click') clicks.push(String(args?.ref))
        return { tabId: 3, url: page.url, title: '' }
      },
    }
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    const blocked = await tools.run('click', { tabId: 3, ref: 'e5' }).catch((e: Error) => e.message)
    expect(String(JSON.stringify(blocked))).toContain('opens_checkout')
    const ok = await tools.run('click', { tabId: 3, ref: 'e5', opens_checkout: true })
    expect(ok.isError).toBeFalsy()
    expect(clicks).toEqual(['e5'])
    page = {
      url: 'https://www.food.example/checkout/',
      title: '결제',
      text: '결제수단 신용카드 최종 결제 금액 15,500원 [e9 버튼 "결제하기"]',
    }
    await tools.run('read', { tabId: 3 })
    const pay = await tools
      .run('click', { tabId: 3, ref: 'e9', opens_checkout: true })
      .catch((e: Error) => ({ isError: true, err: e.message }))
    expect(JSON.stringify(pay)).toMatch(/승인|request_approval/)
    expect(clicks).toEqual(['e5'])
  })
})

describe('결제 카드 (browser_checkout)', () => {
  const PAY = `# 주문/결제
전복솥밥 1개 13,500원 배달료 3,000원 총 결제 금액 16,500원
[e1 버튼 "배송지 변경"] [e2 버튼 "16,500원 결제하기"]`
  function payBrowser(url: string) {
    const calls: [string, Record<string, unknown> | undefined][] = []
    return {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return { tabId: 3, url, title: '주문', text: PAY, truncated: false, captcha: false }
        if (cmd === 'screenshot') return { data: 'SHOT', mime: 'image/jpeg', url, title: '주문' }
        return { tabId: 3, url, title: '주문' }
      },
    }
  }

  it('결제 화면의 마지막 버튼에 상품·금액·정보를 담은 카드 하나로 승인받는다', async () => {
    const tools = new BrowserTools(payBrowser('https://shop.example/order/checkout') as never)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('checkout', {
      tabId: 3,
      ref: 'e2',
      title: '호호솥밥',
      where: '요기요',
      total: '16,500원',
      goods: [
        { name: '전복솥밥', qty: '1개', price: '13,500원', image: 'javascript:alert(1)' },
        { name: '' },
      ],
      lines: [
        { label: '상품', value: '13,500원' },
        { label: '배달료', value: '3,000원', kind: 'fee' },
        { label: '쿠폰', value: '-0원', kind: 'weird' },
      ],
      info: [
        { label: '도착', value: '26~41분' },
        { label: '연락처', value: '01012345678' },
      ],
    })
    expect(r.isError).toBeUndefined()
    const [rec] = tools.approvals.list()
    expect(rec).toMatchObject({
      kind: 'money',
      title: '호호솥밥',
      amount: '16,500원',
      goods: [{ name: '전복솥밥', qty: '1개', price: '13,500원' }],
      info: [
        { label: '도착', value: '26~41분' },
        { label: '연락처', value: '010-****-5678' },
      ],
    })
    // 이상한 그림 주소·이름 없는 상품·모르는 줄 종류는 거른다
    expect(rec?.goods?.[0]).not.toHaveProperty('image')
    expect(rec?.lines?.[1]).toEqual({ label: '배달료', value: '3,000원', kind: 'fee' })
    expect(rec?.lines?.[2]).not.toHaveProperty('kind')
  })

  it("the payment card's what names the title and the goods once each", () => {
    expect(payWhatLine('제주 귤 3kg (로열과)', ['제주 귤 3kg (로열과)'])).toBe('제주 귤 3kg (로열과)')
    expect(payWhatLine('제주 귤 3kg', ['제주 귤 3kg (로열과)'])).toBe('제주 귤 3kg (로열과)')
    expect(payWhatLine('호호솥밥', ['전복솥밥', ''])).toBe('호호솥밥 · 전복솥밥')
    expect(payWhatLine('', ['사과', '배'])).toBe('사과·배')
    expect(payWhatLine('', [])).toBe('')
  })

  it('결제 화면 표시가 없어도 카드를 띄운다 (결제 화면인지는 AI가 판단, final_here 없어도)', async () => {
    const tools = new BrowserTools(payBrowser('https://shop.example/item/1') as never)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('checkout', { tabId: 3, ref: 'e2', total: '16,500원' })
    expect(r.isError).toBeUndefined()
    expect(tools.approvals.list()).toHaveLength(1)
    expect(tools.approvals.list()[0]?.kind).toBe('money')
  })

  it('승인 요청은 거절하지 않는다: 결제 화면 전 단계의 돈 버튼·돈 말이 없는 버튼·동의 버튼 모두 카드로', async () => {
    const tools = new BrowserTools(payBrowser('https://shop.example/item/1') as never)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('request_approval', { tabId: 3, ref: 'e2', what: '솥밥', where: '가게' })
    expect(r.isError).toBeUndefined()
    const plain = await tools.run('request_approval', { tabId: 3, ref: 'e1', what: '배송지', where: '가게' })
    expect(plain.isError).toBeUndefined()
    const kinds = tools.approvals.list().map((a) => [a.label, a.kind, a.status])
    expect(kinds).toEqual([
      ['16,500원 결제하기', 'money', 'expired'],
      ['배송지 변경', 'irreversible', 'pending'],
    ])
  })
})

describe('없는 페이지 안내', () => {
  it('짐작한 깊은 주소가 404면 첫 화면부터 찾아가게 알린다', async () => {
    const b = {
      call: async (cmd: string) => {
        if (cmd === 'open') return { tabId: 3 }
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://pay.example/attend/daily',
            title: '404',
            text: '# 요청하신 페이지를 찾을 수 없습니다',
            truncated: false,
            captcha: false,
          }
        return { tabId: 3 }
      },
    }
    const tools = new BrowserTools(b as never)
    const r = text(await tools.run('open', { url: 'https://pay.example/attend/daily' }))
    expect(r).toContain('home page (https://pay.example/)')
  })
})

describe('그림 키패드 결제 비밀번호 (request_code pin + box)', () => {
  it('키패드 상자를 잘라 보여 주고, 짚은 숫자 자리를 폰 키패드로 받아 화면 자리를 누른다', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const rect = { x: 100, y: 400, w: 300, h: 400 }
    const b = {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://pay.example/charge',
            title: '간편충전',
            text: '# 비밀번호를 입력해 주세요',
            truncated: false,
            captcha: false,
          }
        if (cmd === 'element-shots') return { shots: [{ data: 'PAD', rect }] }
        return { tabId: 3 }
      },
    }
    const tools = new BrowserTools(b as never)
    let pinArgs: unknown[] = []
    tools.requestPin = (...args) => {
      pinArgs = args
      return 'pin-1'
    }
    await tools.run('read', { tabId: 3 })
    const box = { x: 100, y: 500, w: 800, h: 400 }
    const first = await tools.run('request_code', { tabId: 3, kind: 'pin', box })
    expect(first.content.some((c) => c.type === 'image')).toBe(true)
    expect(text(first)).toContain('keys_at')
    // 0~9 자리 (3열 그리드 + 0)
    const keys_at: Record<string, number[]> = {}
    for (const d of '123456789') {
      const i = Number(d) - 1
      keys_at[d] = [150 + (i % 3) * 350, 125 + Math.floor(i / 3) * 250]
    }
    keys_at['0'] = [500, 875]
    // 같은 자리 두 번은 거절
    expect(
      (
        await tools.run('request_code', {
          tabId: 3,
          kind: 'pin',
          box,
          keys_at: { ...keys_at, '0': keys_at['1'] },
        })
      ).isError,
    ).toBe(true)
    const ok = await tools.run('request_code', { tabId: 3, kind: 'pin', box, keys_at })
    expect(text(ok)).toContain('secure keypad card')
    const points = pinArgs[3] as Record<string, { x: number; y: number }>
    expect(points['1']).toEqual({ x: 100 + Math.round(0.15 * 300), y: 400 + Math.round(0.125 * 400) })
    // 사용자가 넣은 번호대로 그 자리를 누른다
    expect(await tools.pressPin(3, points, '10')).toBe(true)
    const taps = calls.filter((c) => c[0] === 'input').map((c) => c[1])
    expect(taps).toEqual([
      { tabId: 3, action: 'tap', ...points['1'] },
      { tabId: 3, action: 'tap', ...points['0'] },
    ])
  })
})

describe('그림 눌러 풀기 (browser_request_tap)', () => {
  it('로봇 확인 상자를 잘라 폰 카드로 보내고, 너무 작거나 없는 표시는 거절한다', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    let rect = { x: 100, y: 200, w: 300, h: 240 }
    const b = {
      calls,
      call: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args])
        if (cmd === 'snapshot')
          return {
            tabId: 3,
            url: 'https://accounts.kakao.com/login',
            title: '카카오계정',
            text: '# 지도에서 그림 위치 누르기\n[e7 버튼 "보안 확인"] [e8 버튼 "답변 제출"]',
            truncated: false,
            captcha: true,
          }
        if (cmd === 'element-shots') return { shots: [{ ref: 'e7', data: 'IMG', rect }] }
        return { tabId: 3 }
      },
    }
    const tools = new BrowserTools(b as never)
    const asked: unknown[][] = []
    tools.requestTap = (...args) => {
      asked.push(args)
      return 'tap-1'
    }
    await tools.run('read', { tabId: 3 })
    const ok = await tools.run('request_tap', {
      tabId: 3,
      ref: 'e7',
      say: '지도에서 이 그림의 위치를 눌러 주세요',
    })
    expect(text(ok)).toContain('Showed an image card')
    expect(asked[0]).toEqual([
      3,
      '지도에서 이 그림의 위치를 눌러 주세요',
      'accounts.kakao.com',
      'IMG',
      rect,
      1,
    ])
    expect((await tools.run('request_tap', { tabId: 3, ref: 'e99', say: 'x' })).isError).toBe(true)
    // 표시가 없는 그림: 화면 사진에서 짚은 상자로
    expect(text(await tools.run('request_tap', { tabId: 3, say: 'x' }))).toContain('box')
    const byBox = await tools.run('request_tap', {
      tabId: 3,
      box: { x: 300, y: 200, w: 400, h: 500 },
      say: 'x',
    })
    expect(text(byBox)).toContain('Showed an image card')
    expect(
      calls.find((c) => c[0] === 'element-shots' && (c[1] as { boxes?: unknown }).boxes)?.[1],
    ).toMatchObject({
      boxes: [{ x: 300, y: 200, w: 400, h: 500 }],
    })
    rect = { x: 0, y: 0, w: 20, h: 20 }
    expect((await tools.run('request_tap', { tabId: 3, ref: 'e7', say: 'x' })).isError).toBe(true)
  })
})

describe('넘긴 화면 지켜보기', () => {
  it('사람이 마쳐 화면이 바뀌면 "다 했어요" 없이 본체에 알린다 (칸에 글만 넣는 건 바뀐 게 아니다)', async () => {
    let page = '# 로그인\n[e1 입력칸 "아이디"] [e2 버튼 "로그인"]'
    let url = 'https://x.example/login'
    const b = {
      call: async (cmd: string) =>
        cmd === 'snapshot'
          ? { tabId: 3, url, title: '로그인', text: page, truncated: false, captcha: false }
          : { tabId: 3 },
    }
    const tools = new BrowserTools(b as never)
    tools.handoffEveryMs = 20
    const seen: string[] = []
    tools.onHandoffChanged = (_tab, why) => seen.push(why)
    await tools.run('read', { tabId: 3 })
    await tools.run('handoff', { tabId: 3, reason: '로봇 확인', emergency: true })
    const r = await tools.run('handoff', { tabId: 3, reason: '로봇 확인', emergency: true })
    expect(text(r)).toContain('notices')
    await new Promise((res) => setTimeout(res, 80))
    // 값만 바뀐 화면 (칸 이름 그대로)
    page = '# 로그인\n[e1 입력칸 "아이디" 값="duri"] [e2 버튼 "로그인"]'
    await new Promise((res) => setTimeout(res, 80))
    expect(seen).toEqual([])
    url = 'https://x.example/home'
    page = '# 홈\n[e5 버튼 "로그아웃"]'
    await new Promise((res) => setTimeout(res, 120))
    expect(seen).toEqual(['the screen moved to the next step'])
  })
})

describe('받는 곳이 내 정보 주소와 같은지', () => {
  it('도로명 주소와 지번 주소로 달리 적혀도 동네·동호수가 같으면 경고하지 않는다', async () => {
    const page = `# 주문/결제\n[e2 버튼 "17,500원 결제하기"]`
    const b = {
      call: async (cmd: string) =>
        cmd === 'snapshot'
          ? {
              tabId: 3,
              url: 'https://shop.example/checkout',
              title: '결제',
              text: page,
              truncated: false,
              captcha: false,
            }
          : cmd === 'screenshot'
            ? { data: 'S', mime: 'image/jpeg', url: 'https://shop.example/checkout', title: '결제' }
            : { tabId: 3 },
    }
    const tools = new BrowserTools(b as never)
    tools.profile = {
      get: async () => ({ address: '경기 용인시 수지구 신봉1로 27', address_detail: '506동 1303호' }),
    } as never
    await tools.run('read', { tabId: 3 })
    await tools.run('checkout', {
      tabId: 3,
      ref: 'e2',
      total: '17,500원',
      ship_to: '경기도 용인시 수지구 신봉동 905 · 506동 1303호',
    })
    expect(tools.approvals.list().at(-1)?.shipWarn).toBeUndefined()
    await tools.run('checkout', {
      tabId: 3,
      ref: 'e2',
      total: '17,500원',
      ship_to: '경기도 용인시 수지구 신봉동 33',
    })
    expect(tools.approvals.list().at(-1)?.shipWarn).toBeTruthy()
  })
})

describe('PC 화면 넘기기 금지 (사용자 결정 11-20)', () => {
  it('비상(emergency)이 아니면 몇 번을 불러도 넘기지 않고 폰 카드 길을 알려 준다', async () => {
    const tools = new BrowserTools(fakeBrowser())
    await tools.run('read', { tabId: 3 })
    for (let i = 0; i < 3; i++) {
      const r = await tools.run('handoff', { tabId: 3, reason: '비밀번호를 넣어 주세요' })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('browser_request_code')
    }
  })
})

describe('결제 화면의 준비 버튼', () => {
  it('배송지·쿠폰·수량·주소 줄·이름 없는 버튼은 승인 없이, 결제 말이 있는 버튼만 막는다', () => {
    expect(classifyRisk('버튼 배송지 추가')).toBeUndefined()
    expect(classifyRisk('버튼 쿠폰 적용')).toBeUndefined()
    expect(classifyRisk('버튼 수량 변경')).toBeUndefined()
    expect(classifyRisk('링크 신봉1로 27 (서홍마을 우남퍼스트빌)')).toBeUndefined()
    expect(classifyRisk('항목 경기 용인시 수지구 신봉동 905')).toBeUndefined()
    expect(classifyRisk('버튼 결제하기')?.kind).toBe('money')
    expect(classifyRisk('버튼 다음')).toBeUndefined()
    expect(classifyRisk('버튼')).toBeUndefined()
  })
})

// 실측 11-20 G마켓: 주문서 → 배송지 추가(액자) → 주소 찾기 Enter → 결제하기 → 늦게 뜬 카드 결제 창 → 카드사 [다음]·[결제하기]
const ORDER = `# 주문/결제
배송지 집 [e1 버튼 "배송지 추가"] [e2 검색칸 "도로명, 지번 검색"] [e3 입력칸 "쿠폰 번호"]
최종 결제 금액 9,900원 [e4 버튼 "결제하기"] [e5 버튼 "다음"] [e100001 버튼 "카드 결제하기"]`
const PG = `# 카드 결제 (KG이니시스)
결제 금액 9,900원 · 카드사를 고른 뒤 다음을 눌러 주세요
[e1 버튼 "카드사 선택"] [e2 버튼 "다음"] [e3 버튼 "9,900원 결제하기"]`
const DONE = '# 주문 완료\n주문이 완료되었습니다. 주문번호 4012345678'

function payTabs(opts: { popup?: number; tabs?: unknown } = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const pages: Record<number, { url: string; text: string }> = {
    3: { url: 'https://checkout.gmarket.co.kr/ko/pc/checkout?chid=1', text: ORDER },
    9: { url: 'https://pg.inicis.com/pay/card', text: PG },
    12: { url: 'https://pg.inicis.com/pay/card2', text: PG },
  }
  let clicked = false
  return {
    calls,
    pages,
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      const tab = Number(args?.tabId ?? 3)
      const p = pages[tab] ?? pages[3]
      if (cmd === 'snapshot')
        return {
          tabId: tab,
          url: p?.url,
          title: '결제',
          text: tab === 3 && clicked ? `${ORDER}\n결제 창을 여는 중이에요` : p?.text,
          truncated: false,
          captcha: false,
        }
      if (cmd === 'click') {
        if (tab === 3 && args?.ref === 'e4') clicked = true
        return {
          tabId: tab,
          url: p?.url,
          ...(tab === 3 && args?.ref === 'e4' && opts.popup ? { newTabId: opts.popup } : {}),
        }
      }
      if (cmd === 'tabs') return opts.tabs ?? { tabs: [] }
      if (cmd === 'screenshot') return { data: 'SHOT', mime: 'image/jpeg', url: p?.url, title: '결제' }
      return { tabId: tab, url: p?.url }
    },
  }
}

async function paid(opts: { popup?: number; tabs?: unknown } = {}) {
  const b = payTabs(opts)
  const tools = new BrowserTools(b as never)
  tools.payPopupWaits = [0]
  await tools.run('read', { tabId: 3 })
  await tools.run('checkout', { tabId: 3, ref: 'e4', title: '사과', where: 'G마켓', total: '9,900원' })
  const [rec] = tools.approvals.list()
  const r = await tools.approve(rec?.id as string)
  return { b, tools, rec, r }
}

describe('돈 게이트: 마지막 버튼만 막고 카드로 돌린다 (11-20 개편)', () => {
  it('돈 말이 있는 버튼은 짧게 결제 카드를 쓰라고 한다', async () => {
    const b = payTabs()
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e4' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('승인이 필요해요')
    expect(text(r)).toContain('browser_checkout(ref: "e4")')
    expect(text(r)).not.toContain('browser_handoff')
    expect(b.calls.map((c) => c[0])).not.toContain('click')
  })

  it('결제 주소에서도 준비 버튼·Enter는 막지 않는다', async () => {
    const b = payTabs()
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    expect((await tools.run('click', { tabId: 3, ref: 'e1' })).isError).toBeUndefined()
    expect((await tools.run('click', { tabId: 3, ref: 'e5' })).isError).toBeUndefined()
    expect(
      (await tools.run('type', { tabId: 3, ref: 'e2', text: '신봉1로 27', submit: true })).isError,
    ).toBeUndefined()
    expect(
      (await tools.run('type', { tabId: 3, ref: 'e3', text: 'A1', submit: true })).isError,
    ).toBeUndefined()
    expect((await tools.run('press', { tabId: 3, key: 'Enter' })).isError).toBeUndefined()
    expect(b.calls.filter((c) => c[0] === 'click').map((c) => c[1]?.ref)).toEqual(['e1', 'e5'])
  })

  it('AI가 final로 선언한 버튼은 돈 말이 없어도 막는다', async () => {
    const tools = new BrowserTools(payTabs() as never)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('click', { tabId: 3, ref: 'e5', final: true })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('final')
    expect(text(r)).toContain('browser_checkout')
  })

  it('확인 창 승인 요청도 거절하지 않는다', async () => {
    const b = {
      call: async (cmd: string) =>
        cmd === 'snapshot'
          ? {
              tabId: 3,
              url: 'https://shop.example/',
              title: '',
              text: '',
              dialog: { type: 'confirm', message: '다음 단계로 갈까요?', url: 'https://shop.example/' },
            }
          : { tabId: 3 },
    }
    const tools = new BrowserTools(b as never)
    await tools.run('read', { tabId: 3 })
    const r = await tools.run('request_approval', {
      tabId: 3,
      dialog: true,
      what: '다음 단계',
      where: '가게',
    })
    expect(r.isError).toBeUndefined()
    expect(tools.approvals.list()).toHaveLength(1)
  })
})

describe('결제 묶음: 승인한 결제부터 주문 완료까지', () => {
  it('승인 한 번 = 버튼 한 번: 결제한 뒤 같은 가게의 결제 버튼은 다시 승인받는다 (사이트 30분 통과 없음)', async () => {
    const { b, tools, r } = await paid()
    expect(r.ok).toBe(true)
    expect(b.calls.filter((c) => c[0] === 'click')).toHaveLength(1)
    await tools.run('read', { tabId: 3 })
    const again = await tools.run('click', { tabId: 3, ref: 'e4' })
    expect(again.isError).toBe(true)
    expect(b.calls.filter((c) => c[0] === 'click')).toHaveLength(1)
  })

  it('승인 결과는 주문 완료까지가 할 일이라고 알리고, 승인은 결제 중(approved)으로 둔다', async () => {
    const { tools, rec, r } = await paid({ popup: 9 })
    expect(r.message).toContain('주문 완료 화면까지')
    expect(r.message).toContain('browser_order_done')
    expect(r.message).toContain('탭 9(결제 창)')
    expect(r.message).not.toContain('browser_handoff')
    expect(tools.approvals.get(rec?.id as string)?.status).toBe('approved')
    expect(tools.isPaying(3)).toBe(true)
    expect(tools.isPaying(9)).toBe(true)
  })

  it('결제 창(새 탭)·화면 안 액자의 [다음]·[결제하기]는 다시 막지 않고, 결제 중인 탭은 옮기지 않는다', async () => {
    const { b, tools } = await paid({ popup: 9 })
    await tools.run('read', { tabId: 9 })
    expect(text(await tools.run('read', { tabId: 9 }))).toContain('💳 Paying')
    const next = await tools.run('click', { tabId: 9, ref: 'e2' })
    expect(next.isError).toBeUndefined()
    const pay = await tools.run('click', { tabId: 9, ref: 'e3' })
    expect(pay.isError).toBeUndefined()
    expect(text(pay)).toContain('without asking approval again')
    await tools.run('read', { tabId: 3 })
    expect((await tools.run('click', { tabId: 3, ref: 'e100001' })).isError).toBeUndefined()
    expect((await tools.run('navigate', { tabId: 9, url: 'https://x' })).isError).toBe(true)
    expect((await tools.run('back', { tabId: 3 })).isError).toBe(true)
    expect(b.calls.filter((c) => c[0] === 'click').map((c) => `${c[1]?.tabId}:${c[1]?.ref}`)).toEqual([
      '3:e4',
      '9:e2',
      '9:e3',
      '3:e100001',
    ])
  })

  it('결제 중인 탭이 연 창은 탭 목록으로 알아보고 같은 묶음에 넣는다', async () => {
    const { tools } = await paid({
      tabs: { tabs: [{ id: 12, openerTabId: 3, url: 'https://pg.inicis.com' }] },
    })
    expect(tools.isPaying(12)).toBe(false)
    await tools.run('read', { tabId: 12 })
    expect(tools.isPaying(12)).toBe(true)
    expect((await tools.run('click', { tabId: 12, ref: 'e3' })).isError).toBeUndefined()
  })

  it('browser_order_done: 묶음을 닫고, 승인을 주문번호와 함께 끝내고, 결과 보여 주기·저장하기를 알린다', async () => {
    const { b, tools, rec } = await paid({ popup: 9 })
    const changed: string[] = []
    tools.approvals.onChange = (x) => changed.push(x.status)
    b.pages[9] = { url: 'https://www.gmarket.co.kr/order/complete', text: DONE }
    const seen = text(await tools.run('read', { tabId: 9 }))
    expect(seen).toContain('browser_order_done')
    const need = await tools.run('order_done', { tabId: 9 })
    expect(need.isError).toBe(true)
    const r = await tools.run('order_done', { tabId: 9, order_no: '4012345678', summary: '사과 9,900원' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('show_result')
    expect(text(r)).toContain('know_save')
    const done = tools.approvals.get(rec?.id as string)
    expect(done?.status).toBe('done')
    expect(done?.result).toContain('4012345678')
    expect(changed).toEqual(['done'])
    expect(tools.isPaying(3)).toBe(false)
    expect(tools.isPaying(9)).toBe(false)
    // 잡아 둔 탭을 푼다
    expect(b.calls.filter((c) => c[0] === 'hold' && c[1]?.ms === 0).map((c) => c[1]?.tabId)).toEqual([3, 9])
    // 이제 결제 탭도 옮길 수 있다
    expect(
      (await tools.run('navigate', { tabId: 3, url: 'https://www.gmarket.co.kr/' })).isError,
    ).toBeUndefined()
  })

  it('결제가 안 되면 failed로 묶음을 닫고 다른 길을 찾게 한다 (사람에게 넘기지 않는다)', async () => {
    const { tools, rec } = await paid()
    const r = await tools.run('order_done', { tabId: 3, failed: true, reason: '카드 한도 초과' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('another payment method')
    expect(text(r)).not.toContain('browser_handoff')
    expect(tools.approvals.get(rec?.id as string)?.status).toBe('failed')
    expect(tools.isPaying(3)).toBe(false)
  })

  it('같은 결제 수단이 라디오·버튼으로 두 번 나오면 승인 카드에는 하나만 (고르는 라디오를 남긴다)', () => {
    // 실측 11-20 G마켓 주문서: "일반 결제 혜택"이 라디오와 버튼으로 둘 다 있어 카드에 "일반 결제"가 두 번 떴다
    const refs = parseRefs(
      [
        '[e78 라디오 "스마일페이간편결제"]',
        '[e79 버튼 "스마일페이 간편결제"]',
        '[e80 버튼 "스마일페이 간편결제 설정"]',
        '[e103 라디오 "일반 결제 혜택" 선택됨]',
        '[e104 버튼 "일반 결제 혜택"]',
        '[e174 라디오 "신용/체크카드" 선택됨]',
      ].join('\n'),
    )
    expect(payOptions({ refs })).toEqual(['e78', 'e103', 'e174'])
    // 버튼이 먼저 나와도 라디오를 남긴다
    const flipped = parseRefs(
      ['[e1 버튼 "카카오페이"]', '[e2 라디오 "카카오페이"]', '[e3 라디오 "신용카드"]'].join('\n'),
    )
    expect(payOptions({ refs: flipped })).toEqual(['e2', 'e3'])
  })

  it('보안 키패드(이름표 붙은 버튼)로 비밀번호를 누른다: 특수문자 줄로 바꿨다가 돌아온다', async () => {
    // 신한카드 가입 키패드 모양: 숫자·"소문자 x"·"알파벳/특수문자" ↔ 특수 줄("느낌표"·"소문자")
    let layer = 'letters'
    const letters = () =>
      [
        ...'0123456789'.split('').map((d, i) => `[e${10 + i} 버튼 "${d}"]`),
        ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c, i) => `[e${30 + i} 버튼 "소문자 ${c}"]`),
        '[e70 버튼 "알파벳/특수문자"]',
        '[e73 버튼 "확인"]',
      ].join(' ')
    const special = () => '[e106 버튼 "느낌표"] [e107 버튼 "골뱅이"] [e136 버튼 "소문자"] [e139 버튼 "확인"]'
    const clicks: string[] = []
    const browser = {
      async call(cmd: string, args?: Record<string, unknown>) {
        if (cmd === 'snapshot') return { text: layer === 'letters' ? letters() : special() }
        if (cmd === 'click') {
          const ref = String(args?.ref)
          clicks.push(ref)
          if (ref === 'e70') layer = 'special'
          if (ref === 'e136') layer = 'letters'
        }
        return {}
      },
    }
    const tools = new BrowserTools(browser as never)
    expect(await tools.keypadType(3, 'e27', 'a1!b')).toBe(true)
    // 칸 열기 → a → 1 → 특수 줄 → ! → 글자 줄 → b → 확인
    expect(clicks).toEqual(['e27', 'e30', 'e11', 'e70', 'e106', 'e136', 'e31', 'e73'])
    expect(keypadLabels('q')).toContain('소문자 q')
    expect(keypadLabels('@')).toContain('골뱅이')
    const kp = makeKeypadPassword()
    expect(kp).toMatch(/^[a-z0-9!@]{12}$/)
    expect(kp).toMatch(/[!@]/)
    expect(kp).toMatch(/\d/)
  })
})

describe('pages read, per chat (finish check evidence, ADR 0038)', () => {
  it("a chat's evidence has only its own reads (and reads no chat claimed)", () => {
    const tools = new BrowserTools(fakeBrowser())
    let chat: string | undefined = 'task-a'
    tools.chatOf = () => chat
    const note = (url: string, title: string) =>
      (tools as unknown as { noteRead(s: { url: string; title: string; text: string }) }).noteRead({
        url,
        title,
        text: '',
      })
    note('https://a.example/order/complete', 'Order complete')
    chat = 'task-b'
    note('https://b.example/list', 'List')
    expect(tools.readsSince(0, 'task-b')).toEqual({
      lastPage: { title: 'List', url: 'https://b.example/list' },
      donePage: false,
    })
    expect(tools.readsSince(0, 'task-a').donePage).toBe(true)
    expect(tools.readsSince(0).lastPage?.title).toBe('List')
  })
})
