// 두리 브라우저 도구의 본체 쪽 실행기. AI(MCP 도구 서버)는 여기로 부탁만 하고, 해도 되는지는 여기서 정한다.
// 확장은 판단하지 않는 손이라서, 위험한 클릭을 막는 것도 여기서 한다 (docs/architecture.md 4.2, 위협 모델 T2·T3).
//
// 돈이 나가거나·연락이 가거나·되돌릴 수 없는 버튼은 AI가 누를 수 없다. AI는 승인을 요청하고(request_approval),
// 사용자가 승인하면 본체가 그 버튼 하나만 누른다(approvals.ts). "항상 직접 누르기"면 사람에게 넘긴다.
import type { BrowserCommand, RemoteForm, RemoteFormValue, RemoteInfo } from '@dool2/protocol'
import { type ApprovalRecord, Approvals } from './approvals.js'
import { LoginRequests } from './logins.js'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
  /** 서비스 도구(커넥터)의 구조화된 결과 (MCP structuredContent) */
  structuredContent?: Record<string, unknown>
}

export interface BrowserCaller {
  call(cmd: BrowserCommand, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export const BROWSER_TOOLS = [
  'open',
  'navigate',
  'read',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'back',
  'close',
  'handoff',
  'login',
  'request_login',
  'request_approval',
] as const
export type BrowserTool = (typeof BROWSER_TOOLS)[number]

export type RiskKind = 'money' | 'contact' | 'irreversible'
export interface Risk {
  kind: RiskKind
  /** 위험하다고 본 근거 (버튼 글자나 주소) */
  reason: string
}

// 버튼 글자로 보는 위험. 하나라도 걸리면 위험으로 본다 (AI가 "조회예요"라고 해도 바뀌지 않는다)
const RISK_WORDS: [RiskKind, RegExp][] = [
  [
    'money',
    /결제|구매|주문|구독|충전|송금|이체|입금|예약\s*(?:확정|완료|하기)|\S(?:으로|로)\s*예약$|바로\s*예약$|예매\s*하기|후원|기부|계좌\s*등록|\b(?:pay|checkout|purchase|buy\s*now|place\s*order)\b/i,
  ],
  [
    'contact',
    /보내기|전송|발송|게시|올리기|작성\s*완료|등록\s*하기|(?:^|\s)등록$|댓글\s*등록|리뷰\s*등록|문의\s*(?:하기|등록)|신청\s*(?:하기|완료)|\b(?:send|post|publish|submit)\b/i,
  ],
  ['irreversible', /삭제|탈퇴|해지|비우기|초기화|\b(?:delete|remove\s*account|unsubscribe)\b/i],
]

// 결제 단계 페이지 (주소로 보는 위험)
const RISK_URL =
  /\/(?:checkout|payment|payments|pay|order\/?(?:sheet|form|confirm)|orderform|ordersheet)(?:[/?#.]|$)|(?:^|\.)(?:pay\.naver\.com|kakaopay\.com|tosspayments\.com|toss\.im|inicis\.com|nicepay\.co\.kr|kcp\.co\.kr|danal\.co\.kr|payco\.com|paypal\.com)/i

// 결제 화면 (주소는 그대로인 창 안 단계: 캐치테이블은 검색 지도 주소 위에서 결제 방법 고르기까지 간다)
// (실측: 제목이 '결제 방법 선택'일 때도, '결제 방식 선택'일 때도 있다)
const PAY_SCREEN = /결제\s*(?:방법|방식|수단)|최종\s*결제|총\s*결제\s*금액|결제\s*금액|결제\s*동의/
// 그런 화면에서 다음 단계로 넘기는 버튼은 결제·확정일 수 있다
const ADVANCE = /(?:^|\s)(?:다음|확인|완료|진행|계속|예약|신청|제출|동의하고\s*\S+|next|continue|confirm)$/i

/** 화면 글에 결제 단계 표시가 있으면 그 말 (없으면 undefined) */
export function payScreen(text: string): string | undefined {
  return PAY_SCREEN.exec(text)?.[0]
}

export function classifyRisk(label: string, url: string, pay?: string): Risk | undefined {
  // 라디오·체크박스는 고르기만 하고 확정하지 않는다 ('예약금 결제' 방식 라디오에 승인을 따로 받던 것)
  if (/^(?:라디오|체크박스|스위치|선택지)\s/.test(label)) return undefined
  for (const [kind, re] of RISK_WORDS) {
    const m = re.exec(label)
    if (m) return { kind, reason: `"${m[0]}"` }
  }
  const name = label.replace(/^(?:버튼|링크|메뉴|항목)\s*/, '').trim()
  if (pay && ADVANCE.test(name)) return { kind: 'money', reason: `'${pay}' 화면의 "${name}"` }
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname
    path = u.pathname
  } catch {}
  if (RISK_URL.test(path) || RISK_URL.test(host)) return { kind: 'money', reason: '결제 단계 페이지' }
  return undefined
}

const RISK_TEXT: Record<RiskKind, string> = {
  money: '돈이 나가는 일',
  contact: '다른 사람에게 무언가 보내거나 올리는 일',
  irreversible: '되돌릴 수 없는 일',
}

interface PageInfo {
  url: string
  refs: Map<string, { role: string; name: string }>
  /** 결제 단계 화면이면 그 표시 말 (예: '결제 방법 선택') */
  pay?: string
}

interface Snapshot {
  tabId: number
  url: string
  title: string
  text: string
  truncated: boolean
  captcha: boolean
}

/** 스냅샷 글에서 [e12 버튼 "검색"] 표시를 모은다 */
export function parseRefs(text: string): Map<string, { role: string; name: string }> {
  const refs = new Map<string, { role: string; name: string }>()
  // 확장은 이름 안의 큰따옴표를 작은따옴표로 바꿔 보낸다
  const roles = '링크|버튼|입력칸|검색칸|비밀번호칸|체크박스|라디오|스위치|탭|메뉴|선택지|선택 상자|항목'
  const re = new RegExp(`\\[(e\\d+) (${roles})(?: "([^"]*)")?[^\\]]*\\]`, 'g')
  for (const m of text.matchAll(re)) {
    refs.set(m[1] as string, { role: (m[2] ?? '').trim(), name: m[3] ?? '' })
  }
  return refs
}

/** 금고에서 지금 사이트의 로그인 정보를 찾는다 (값은 본체 밖으로 나가지 않는다) */
export interface VaultLookup {
  findForOrigin(origin: string): Promise<{ id: string; username: string; password: string } | undefined>
  markUsed(id: string): Promise<void>
}

/** 사람에게 넘긴 탭을 폰 원격 화면으로 다룰 수 있는 시간 */
export const REMOTE_TTL_MS = 30 * 60_000

export class BrowserTools {
  private pages = new Map<number, PageInfo>()
  /** 사람에게 넘긴 탭 → 넘긴 시각. 이 탭만 폰 원격 화면으로 보고 누를 수 있다 */
  private handedOff = new Map<number, number>()

  readonly approvals: Approvals
  readonly logins: LoginRequests

  constructor(
    private readonly browser: BrowserCaller,
    private readonly vault?: VaultLookup,
    /** 마지막 버튼을 승인받아 두리가 누를지(approve), 항상 사용자가 누를지(self) */
    private readonly finalStep: () => 'approve' | 'self' = () => 'approve',
    approvals?: Approvals,
    logins?: LoginRequests,
  ) {
    this.approvals = approvals ?? new Approvals()
    this.logins = logins ?? new LoginRequests()
  }

  /** 두리가 마지막으로 다룬 탭 (폰의 "두리 화면 보기"가 실시간으로 본다) */
  private _lastTabId?: number
  get lastTabId(): number | undefined {
    return this._lastTabId
  }
  set lastTabId(id: number | undefined) {
    const changed = id !== this._lastTabId
    this._lastTabId = id
    if (changed && id !== undefined) this.onActiveTab?.(id)
  }
  /** 두리가 다루는 탭이 바뀌었을 때 (폰 대화에 일하는 화면을 띄운다) */
  onActiveTab?: (tabId: number) => void
  /**
   * 서비스 도구가 지금부터 이 탭에서 일한다: 폰이 그 화면을 볼 수 있게 하고 바로 알린다.
   * 같은 탭을 다시 써도 알린다 (서비스마다 탭 하나를 계속 쓰는데, 폰은 일을 시작할 때마다 알아야 화면을 띄운다)
   */
  watchTab(tabId: number) {
    this.allowRemote(tabId)
    this._lastTabId = tabId
    this.onActiveTab?.(tabId)
  }
  /** 주소의 사이트에 서비스 도구(커넥터)가 있으면 그 서비스와 도구 이름 (ADR 0018) */
  siteConnector?: (url: string) => Promise<{ id: string; name: string; tools: string[] } | undefined>
  /** 탭마다 요령을 알린 사이트 (같은 사이트 안에서 옮길 때는 다시 알리지 않는다) */
  private guided = new Map<number, string>()

  async run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.tabId === 'number') this.allowRemote(args.tabId)
    try {
      const r = await this.dispatch(tool, args)
      // 잘 다룬 탭만 "지금 두리가 보는 탭"으로 (틀린 번호로 부른 도구는 빼야 실시간 화면이 엉뚱한 탭을 찍지 않는다)
      if (!r.isError && typeof args.tabId === 'number') this.lastTabId = args.tabId
      return r
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const tabId = Number(a.tabId)
    switch (tool as BrowserTool) {
      case 'open': {
        const r = (await this.browser.call('open', { url: a.url }, 40_000)) as { tabId: number }
        this.lastTabId = r.tabId
        this.allowRemote(r.tabId)
        return this.read(r.tabId, undefined, '새 탭을 열었어요.')
      }
      case 'navigate': {
        await this.browser.call('navigate', { tabId, url: a.url }, 40_000)
        return this.read(tabId, undefined, '주소를 열었어요.')
      }
      case 'read':
        return this.read(tabId, a.maxChars)
      case 'click': {
        // 표시가 없는 상자(가게 카드 등)는 화면 글자로 찾아 표시를 붙인 뒤 누른다. 승인 게이트는 그 글자로 똑같이 거친다
        if (!a.ref && typeof a.text === 'string' && a.text.trim()) {
          a.ref = (await this.markText(tabId, a.text)).ref
        }
        const ref = String(a.ref ?? '')
        const page = this.pages.get(tabId)
        const target = page?.refs.get(ref)
        if (!page || !target)
          throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어(browser_read) 표시를 확인해 주세요`)
        this.guard(`${target.role} ${target.name}`, page.url, true, page.pay)
        const r = (await this.browser.call('click', { tabId, ref }, 30_000)) as {
          newTabId?: number
          coveredBy?: string
        }
        const note = [
          `${target.role} "${target.name}"을(를) 눌렀어요.`,
          r.coveredBy ? `(그 자리를 "${r.coveredBy}"이(가) 덮고 있었어요. 팝업이면 먼저 닫아 주세요.)` : '',
        ]
          .filter(Boolean)
          .join(' ')
        if (r.newTabId) return this.read(r.newTabId, undefined, `${note} 새 탭이 열려서 그 탭을 읽었어요.`)
        return this.read(tabId, undefined, note)
      }
      case 'type': {
        const ref = String(a.ref ?? '')
        const page = this.pages.get(tabId)
        if (!page?.refs.has(ref)) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
        if (a.submit) this.guard('', page.url, false, page.pay)
        await this.browser.call('type', { tabId, ref, text: String(a.text ?? ''), submit: Boolean(a.submit) })
        return this.read(tabId, undefined, a.submit ? '입력하고 Enter를 눌렀어요.' : '입력했어요.')
      }
      case 'press': {
        const key = String(a.key ?? '')
        const page = this.pages.get(tabId)
        if (/^(enter|return|엔터)$/i.test(key) && page) this.guard('', page.url)
        await this.browser.call('press', { tabId, key })
        return this.read(tabId, undefined, `${key} 키를 눌렀어요.`)
      }
      case 'scroll': {
        await this.browser.call('scroll', { tabId, direction: a.direction === 'up' ? 'up' : 'down' })
        return {
          content: [{ type: 'text', text: '스크롤했어요. 화면을 보려면 browser_screenshot을 써 주세요.' }],
        }
      }
      case 'screenshot': {
        const r = (await this.browser.call('screenshot', { tabId })) as {
          data: string
          mime: string
          url: string
          title: string
        }
        return {
          content: [
            { type: 'text', text: `[탭 ${tabId}] ${r.title} — ${r.url}` },
            { type: 'image', data: r.data, mimeType: r.mime },
          ],
        }
      }
      case 'back': {
        await this.browser.call('back', { tabId })
        return this.read(tabId, undefined, '뒤로 갔어요.')
      }
      case 'close': {
        await this.browser.call('close', { tabId })
        this.pages.delete(tabId)
        return { content: [{ type: 'text', text: `탭 ${tabId}을(를) 닫았어요.` }] }
      }
      case 'login': {
        // 두리 금고 (ADR 0011): AI는 칸만 알려 주고, 값은 본체가 주소를 확인한 뒤 확장에 직접 넘긴다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 로그인 페이지를 읽어 주세요')
        const pw = page.refs.get(String(a.passwordRef ?? ''))
        if (pw?.role !== '비밀번호칸') throw new Error('passwordRef는 페이지의 비밀번호칸 표시여야 해요')
        const userRef = a.usernameRef ? String(a.usernameRef) : undefined
        if (userRef && !['입력칸', '검색칸'].includes(page.refs.get(userRef)?.role ?? ''))
          throw new Error('usernameRef는 아이디 입력칸 표시여야 해요')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('페이지 주소를 알 수 없어요')
        }
        const entry = await this.vault?.findForOrigin(origin)
        if (!entry)
          throw new Error(
            `이 사이트(${origin})는 두리 금고에 없어요. browser_request_login으로 사용자에게 로그인 카드를 띄우고 이번 답을 끝내세요.`,
          )
        // 확장도 주소를 다시 확인한다 (그 사이 다른 페이지로 넘어갔으면 채우지 않는다)
        if (userRef) await this.browser.call('fill', { tabId, ref: userRef, value: entry.username, origin })
        await this.browser.call('fill', {
          tabId,
          ref: String(a.passwordRef),
          value: entry.password,
          origin,
          password: true,
        })
        await this.vault?.markUsed(entry.id)
        return this.read(tabId, undefined, '두리 금고에서 로그인 정보를 채웠어요. 로그인 버튼을 눌러 주세요.')
      }
      case 'request_approval': {
        const ref = String(a.ref ?? '')
        return this.askApproval(tabId, ref, {
          what: String(a.what ?? ''),
          where: String(a.where ?? ''),
          ...(a.amount ? { amount: String(a.amount) } : {}),
          ...(a.cancel ? { cancel: String(a.cancel) } : {}),
        })
      }
      case 'request_login': {
        // 로그인 카드: 사용자가 PC·폰 카드에 넣은 값은 금고에만 들어간다. AI는 값을 보지 않는다
        const page = this.pages.get(tabId)
        if (!page) throw new Error('먼저 로그인 페이지를 읽어 주세요')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('페이지 주소를 알 수 없어요')
        }
        const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
        if (!origin.startsWith('https://') && !local)
          throw new Error(
            'https 사이트만 로그인 정보를 저장할 수 있어요. browser_handoff로 사용자에게 넘겨 주세요.',
          )
        if (await this.vault?.findForOrigin(origin))
          return {
            content: [
              { type: 'text', text: '이 사이트는 이미 두리 금고에 있어요. browser_login으로 채우세요.' },
            ],
          }
        const site =
          String(a.site ?? '')
            .trim()
            .slice(0, 60) || new URL(origin).hostname
        const r = this.logins.create({ tabId, origin, site })
        return {
          content: [
            {
              type: 'text',
              text:
                `로그인 카드를 띄웠어요(${r.id.slice(0, 8)}). 사용자에게 카드에 ${site} 아이디와 비밀번호를 넣어 달라고 한두 문장으로 말하고 이번 답을 끝내세요. ` +
                '넣은 값은 두리 금고에만 저장되고 당신에게는 오지 않아요. 저장되면 다음 메시지로 알려 줘요. 그때 페이지를 다시 읽고 browser_login으로 채운 뒤 로그인 버튼을 누르세요.',
            },
          ],
        }
      }
      case 'handoff': {
        // 사람이 해야 하는 일(로그인·캡차·본인인증·마지막 버튼): 두리 탭을 앞으로 띄우고 이번 답을 끝내게 한다.
        // 화면은 이 도구 호출을 보고 [Chrome에서 보기] [다 했어요]를 띄운다
        await this.browser.call('focus', { tabId })
        this.handedOff.set(tabId, Date.now())
        return {
          content: [
            {
              type: 'text',
              text:
                'Chrome의 두리 탭을 사용자 앞에 띄웠어요. 사용자에게 무엇을 해 달라는지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. ' +
                '사용자가 [다 했어요]를 누르면 다음 메시지로 이어서 하라는 부탁이 와요. 그때 페이지를 다시 읽어 확인하고 이어 가세요.',
            },
          ],
        }
      }
    }
    throw new Error(`모르는 브라우저 도구예요: ${tool}`)
  }

  /**
   * 이 버튼을 누를지 사용자 승인을 받는다 (AI의 request_approval, 커넥터의 approve 단계).
   * kind를 주면(커넥터 등급이 돈 내기·연락하기) 버튼 글자로 위험이 안 보여도 승인을 받는다
   */
  async askApproval(
    tabId: number,
    ref: string,
    d: { what: string; where: string; amount?: string; cancel?: string },
    kind?: RiskKind,
  ): Promise<ToolResult> {
    const page = this.pages.get(tabId)
    const target = page?.refs.get(ref)
    if (!page || !target) throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어 주세요`)
    const risk =
      classifyRisk(`${target.role} ${target.name}`, page.url, page.pay) ??
      (kind ? { kind, reason: '서비스 도구 등급' } : undefined)
    if (!risk) throw new Error('이 버튼은 승인 없이 눌러도 돼요. browser_click을 쓰세요.')
    if (this.finalStep() === 'self')
      throw new Error(
        '사용자가 "마지막 버튼은 항상 직접 누르기"로 정해 두었어요. 내용을 정리해 알려 주고 browser_handoff로 넘겨 주세요.',
      )
    // 승인 카드에 실제 화면을 함께 보여 준다 (AI가 적은 금액이 틀려도 사용자가 알아챌 수 있게)
    const shot = (await this.browser.call('screenshot', { tabId }).catch(() => undefined)) as
      | { data?: string }
      | undefined
    const rec = this.approvals.create({
      tabId,
      ref,
      role: target.role,
      label: target.name,
      url: page.url,
      kind: risk.kind,
      reason: risk.reason,
      what: d.what.slice(0, 200),
      where: d.where.slice(0, 100),
      ...(d.amount ? { amount: d.amount.slice(0, 60) } : {}),
      ...(d.cancel ? { cancel: d.cancel.slice(0, 200) } : {}),
      ...(shot?.data ? { shot: shot.data } : {}),
    })
    return {
      content: [
        {
          type: 'text',
          text:
            `승인을 요청했어요(${rec.id.slice(0, 8)}). 사용자에게 무엇을 승인해 달라는지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. ` +
            '사용자가 승인하면 두리가 그 버튼을 직접 누르고, 다음 메시지로 결과를 알려 줘요. 그때 페이지를 다시 읽어 확인하세요.',
        },
      ],
    }
  }

  /** 화면 글자로 누를 곳에 표시를 붙인다 (먼저 읽은 페이지여야 한다). 붙인 표시와 그 글 */
  async markText(tabId: number, text: string): Promise<{ ref: string; name: string }> {
    const page = this.pages.get(tabId)
    if (!page) throw new Error('먼저 페이지를 읽어(browser_read) 주세요')
    const m = (await this.browser.call('mark-text', { tabId, text }, 15_000)) as { ref: string; name: string }
    page.refs.set(m.ref, { role: '글', name: m.name })
    return m
  }

  /** 마지막으로 읽은 탭의 표시 목록 (커넥터가 입력칸을 찾을 때) */
  refsOf(tabId: number): Map<string, { role: string; name: string }> | undefined {
    return this.pages.get(tabId)?.refs
  }

  /** 이 탭을 지금 폰 원격 화면으로 다뤄도 되는지: 두리가 사람에게 넘긴 지 30분 안 */
  /** 사람이 직접 할 탭으로 표시 (서비스 연결에서 연 탭을 폰 원격 화면으로 로그인할 때) */
  allowRemote(tabId: number) {
    this.handedOff.set(tabId, Date.now())
  }

  remoteAllowed(tabId: number, now = Date.now()): boolean {
    const at = this.handedOff.get(tabId)
    if (at === undefined) return false
    if (now - at > REMOTE_TTL_MS) {
      this.handedOff.delete(tabId)
      return false
    }
    return true
  }

  /** 원격 화면 한 장 (폰으로 보낼 크기로 줄여서) */
  async remoteScreen(tabId: number, fit?: { width: number; height: number }) {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격 화면으로 볼 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    // 실시간 화면용: 폰 화면에 맞는 크기·화질로 빠르게 (초당 여러 장). 화면의 입력칸·버튼·지금 칸도 같이 (remote).
    // fit을 주면 PC 탭을 폰 화면 크기로 그리게 한다 (폰 너비 그리기는 원격 입력 view로도)
    const args = fit
      ? { tabId, fit, maxWidth: Math.min(fit.width * 2, 1000), quality: 55, remote: true }
      : { tabId, maxWidth: 780, quality: 55, remote: true }
    return (await this.browser.call('screenshot', args)) as {
      url: string
      title: string
      data: string
      viewport: { width: number; height: number }
    } & RemoteInfo
  }

  /** 원격 화면 '필요한 칸만': 사람이 채울 칸·고를 것·버튼 (두리가 넘긴 탭만) */
  async remoteForm(tabId: number): Promise<RemoteForm> {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격 화면으로 볼 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    return (await this.browser.call('form', { tabId }, 20_000)) as RemoteForm
  }

  /** 칸만 화면에서 채운 값을 넣고 버튼을 누른다. 값은 AI에게 가지 않고 페이지 칸에만 들어간다 */
  async remoteFill(tabId: number, values: RemoteFormValue[], press?: string) {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격으로 다룰 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    const id = (x: unknown) => String(x ?? '').slice(0, 24)
    const clean = (Array.isArray(values) ? values : []).slice(0, 30).map((v) => ({
      id: id(v.id),
      ...(typeof v.value === 'string' ? { value: v.value.slice(0, 200) } : {}),
      ...(typeof v.checked === 'boolean' ? { checked: v.checked } : {}),
      ...(typeof v.pick === 'string' ? { pick: id(v.pick) } : {}),
    }))
    return this.browser.call(
      'form-fill',
      { tabId, values: clean, ...(press ? { press: id(press) } : {}) },
      30_000,
    )
  }

  /** 원격 화면에서 사람이 한 입력. 좌표는 사진 비율(0~1)로 받아 페이지 좌표로 바꾼다 */
  async remoteInput(
    tabId: number,
    input: {
      action: 'tap' | 'text' | 'key' | 'scroll' | 'view' | 'leave'
      x?: number
      y?: number
      text?: string
      key?: string
      dy?: number
      w?: number
      h?: number
    },
    viewport: { width: number; height: number },
  ) {
    if (!this.remoteAllowed(tabId))
      throw new Error('이 탭은 원격으로 다룰 수 없어요 (두리가 넘긴 탭만, 30분 동안)')
    const args: Record<string, unknown> = { tabId, action: input.action }
    if (input.action === 'tap') {
      const fx = Number(input.x)
      const fy = Number(input.y)
      if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) throw new Error('누른 자리가 화면 밖이에요')
      args.x = fx * viewport.width
      args.y = fy * viewport.height
    }
    if (input.action === 'text') args.text = String(input.text ?? '').slice(0, 500)
    if (input.action === 'key') args.key = String(input.key ?? '')
    if (input.action === 'scroll') {
      const dy = Number(input.dy) || 0
      // ±1은 한 화면씩, 그보다 크면 손가락으로 끈 페이지 픽셀 (끈 자리에서 굴린다)
      args.dy = Math.abs(dy) <= 1 ? (dy < 0 ? -1 : 1) : Math.max(-3000, Math.min(3000, dy))
      const fx = Number(input.x)
      const fy = Number(input.y)
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        args.x = fx * viewport.width
        args.y = fy * viewport.height
      }
    }
    if (input.action === 'view') {
      args.w = Number(input.w) || 390
      args.h = Number(input.h) || 700
    }
    return this.browser.call('input', args)
  }

  /** 위험한 동작이면 멈추고 이유를 돌려준다 */
  private guard(label: string, url: string, clickable = false, pay?: string) {
    const risk = classifyRisk(label, url, pay)
    if (!risk) return
    const next =
      clickable && this.finalStep() === 'approve'
        ? 'browser_request_approval로 무엇을·어디서·얼마인지·취소 조건을 적어 사용자 승인을 요청해 주세요. 승인되면 두리가 직접 눌러요.'
        : '여기까지 한 내용(무엇을, 어디서, 얼마인지)을 사용자에게 정리해 알려 주고, browser_handoff로 마지막 버튼은 사용자가 직접 누르게 넘겨 주세요.'
    throw new Error(`멈췄어요: ${risk.reason} — ${RISK_TEXT[risk.kind]}이라 승인 없이는 하지 않아요. ${next}`)
  }

  /**
   * 사용자가 승인한 버튼을 누른다. 누르기 직전 페이지를 다시 읽어, 승인한 버튼 글자와 주소가 그대로일 때만.
   * 화면용 토큰을 가진 쪽(사용자 화면)만 부를 수 있다 (AI의 도구 토큰으로는 못 부른다)
   */
  async approve(id: string): Promise<{ ok: boolean; message: string }> {
    const rec: ApprovalRecord | undefined = this.approvals.take(id)
    if (!rec) return { ok: false, message: '이미 처리했거나 시간이 지난 승인 요청이에요' }
    try {
      const s = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
      let now = parseRefs(s.text).get(rec.ref)
      this.pages.set(rec.tabId, { url: s.url, refs: parseRefs(s.text), pay: payScreen(s.text) })
      // 글자로 찾은 곳(서비스 도구의 마지막 버튼)은 표시 목록에 없다: 같은 글자로 다시 찾아 같은 곳인지 본다
      if (rec.role === '글' && s.url === rec.url) {
        const m = (await this.browser
          .call('mark-text', { tabId: rec.tabId, text: rec.label }, 15_000)
          .catch(() => undefined)) as { ref: string; name: string } | undefined
        if (m?.ref === rec.ref) now = { role: '글', name: m.name }
      }
      if (s.url !== rec.url || !now || now.name !== rec.label || now.role !== rec.role) {
        const msg = `승인한 뒤 화면이 바뀌어서 "${rec.label}" 버튼을 누르지 않았어요. 페이지를 다시 확인해 주세요.`
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      const r = (await this.browser.call('click', { tabId: rec.tabId, ref: rec.ref }, 30_000)) as {
        url?: string
        title?: string
      }
      const msg = `"${rec.label}" 버튼을 눌렀어요. 지금 화면: ${r.title ?? ''} (${r.url ?? ''})`
      this.approvals.finish(id, true, msg)
      return { ok: true, message: msg }
    } catch (e) {
      const msg = `"${rec.label}" 버튼을 누르지 못했어요: ${(e as Error).message}`
      this.approvals.finish(id, false, msg)
      return { ok: false, message: msg }
    }
  }

  /** 탭이 닫혔다 (사용자·탭 정리): 그 탭의 기록을 지우고, 기다리던 승인은 만료시킨다 */
  forgetTab(tabId: number) {
    this.pages.delete(tabId)
    this.guided.delete(tabId)
    this.handedOff.delete(tabId)
    this.approvals.expireTab(tabId)
    if (this._lastTabId === tabId) this._lastTabId = undefined
  }

  /** 처음 들어온 사이트에 서비스 도구가 있으면 그걸 쓰라고 알린다 (화면을 하나씩 누르기보다 빠르고 정확하다) */
  private async guideFor(tabId: number, url: string): Promise<string | undefined> {
    const svc = await this.siteConnector?.(url).catch(() => undefined)
    if (svc) {
      if (this.guided.get(tabId) === svc.id) return undefined
      this.guided.set(tabId, svc.id)
      return `📘 이 사이트(${svc.name})는 두리 서비스 도구가 있어요: ${svc.tools.join(', ')}. 화면을 하나씩 누르기보다 이 도구를 먼저 쓰세요(바로 보이는 도구 목록에 없으면 service_call). 도구로 안 되는 일만 브라우저로 이어서 해요.`
    }
    return undefined
  }

  private async read(tabId: number, maxChars?: unknown, note?: string): Promise<ToolResult> {
    const max = Number(maxChars) || 8_000
    let s = (await this.browser.call('snapshot', { tabId, maxChars: max })) as Snapshot
    // 늦게 그리는 사이트는 막 연 화면이 비어 있다 (캐치테이블: 링크 4개뿐). 한 번 기다렸다 다시 읽는다
    if (nearlyEmpty(s.text)) {
      await new Promise((r) => setTimeout(r, 1500))
      s = (await this.browser.call('snapshot', { tabId, maxChars: max })) as Snapshot
    }
    this.pages.set(tabId, { url: s.url, refs: parseRefs(s.text), pay: payScreen(s.text) })
    const guide = await this.guideFor(tabId, s.url)
    const lines = [
      ...(note ? [note] : []),
      `[탭 ${tabId}] ${s.title || '(제목 없음)'} — ${s.url}`,
      ...(s.captcha
        ? [
            '⚠ 로봇 확인(캡차·자동입력 방지) 화면이 보여요. 풀려고 하지 말고 사용자에게 직접 해 달라고 부탁해 주세요.',
          ]
        : []),
      ...(guide ? [guide] : []),
      ...(nearlyEmpty(s.text)
        ? [
            '⚠ 화면에 글이 거의 없어요. 주소가 틀렸을 수 있어요(사이트에 없는 주소는 빈 화면만 나와요). 사이트 홈을 열어 검색칸으로 찾아보세요. 사람에게 넘기기 전에 다른 길을 먼저 해 보세요.',
          ]
        : []),
      '',
      s.text || '(읽을 글이 없어요. 화면이 아직 그려지는 중이면 잠시 뒤 다시 읽어 주세요)',
      ...(s.truncated
        ? ['', `(글이 길어 앞부분 ${max}자만 보여 드렸어요. 더 필요하면 maxChars를 늘려 다시 읽어 주세요)`]
        : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }
}

/** 표시(e12)를 빼고 글이 거의 없는 화면 (늦게 그리는 중이거나 없는 주소) */
export function nearlyEmpty(text: string): boolean {
  const words = text.replace(/\[e\d+ [^\]]*\]/g, '').replace(/\s+/g, '')
  return words.length < 8
}
