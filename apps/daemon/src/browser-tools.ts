// 두리 브라우저 도구의 본체 쪽 실행기. AI(MCP 도구 서버)는 여기로 부탁만 하고, 해도 되는지는 여기서 정한다.
// 확장은 판단하지 않는 손이라서, 위험한 클릭을 막는 것도 여기서 한다 (docs/architecture.md 4.2, 위협 모델 T2·T3).
//
// M2: 돈이 나가거나·연락이 가거나·되돌릴 수 없는 버튼은 누르지 않고 사람에게 넘긴다.
// M3에서 폰 승인을 붙이면 "승인받고 누르기"로 바뀐다.
import type { BrowserCommand } from '@dool2/protocol'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
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
    /결제|구매|주문|구독|충전|송금|이체|입금|예약\s*(?:확정|완료|하기)|예매\s*하기|후원|기부|계좌\s*등록|\b(?:pay|checkout|purchase|buy\s*now|place\s*order)\b/i,
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

export function classifyRisk(label: string, url: string): Risk | undefined {
  for (const [kind, re] of RISK_WORDS) {
    const m = re.exec(label)
    if (m) return { kind, reason: `"${m[0]}"` }
  }
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

export class BrowserTools {
  private pages = new Map<number, PageInfo>()

  constructor(
    private readonly browser: BrowserCaller,
    private readonly vault?: VaultLookup,
  ) {}

  async run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await this.dispatch(tool, args)
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const tabId = Number(a.tabId)
    switch (tool as BrowserTool) {
      case 'open': {
        const r = (await this.browser.call('open', { url: a.url }, 40_000)) as { tabId: number }
        return this.read(r.tabId, undefined, '새 탭을 열었어요.')
      }
      case 'navigate': {
        await this.browser.call('navigate', { tabId, url: a.url }, 40_000)
        return this.read(tabId, undefined, '주소를 열었어요.')
      }
      case 'read':
        return this.read(tabId, a.maxChars)
      case 'click': {
        const ref = String(a.ref ?? '')
        const page = this.pages.get(tabId)
        const target = page?.refs.get(ref)
        if (!page || !target)
          throw new Error(`${ref}가 무엇인지 몰라요. 먼저 페이지를 읽어(browser_read) 표시를 확인해 주세요`)
        this.guard(`${target.role} ${target.name}`, page.url)
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
        if (a.submit) this.guard('', page.url)
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
            `이 사이트(${origin})는 두리 금고에 없어요. browser_handoff로 사용자에게 직접 로그인해 달라고 부탁해 주세요.`,
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
      case 'handoff': {
        // 사람이 해야 하는 일(로그인·캡차·본인인증·마지막 버튼): 두리 탭을 앞으로 띄우고 이번 답을 끝내게 한다.
        // 화면은 이 도구 호출을 보고 [Chrome에서 보기] [다 했어요]를 띄운다
        await this.browser.call('focus', { tabId })
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

  /** 위험한 동작이면 멈추고 이유를 돌려준다 */
  private guard(label: string, url: string) {
    const risk = classifyRisk(label, url)
    if (!risk) return
    throw new Error(
      `멈췄어요: ${risk.reason} — ${RISK_TEXT[risk.kind]}이라 두리가 직접 하지 않아요. ` +
        '여기까지 한 내용(무엇을, 어디서, 얼마인지)을 사용자에게 정리해 알려 주고, browser_handoff로 마지막 버튼은 사용자가 직접 누르게 넘겨 주세요.',
    )
  }

  private async read(tabId: number, maxChars?: unknown, note?: string): Promise<ToolResult> {
    const max = Number(maxChars) || 8_000
    const s = (await this.browser.call('snapshot', { tabId, maxChars: max })) as Snapshot
    this.pages.set(tabId, { url: s.url, refs: parseRefs(s.text) })
    const lines = [
      ...(note ? [note] : []),
      `[탭 ${tabId}] ${s.title || '(제목 없음)'} — ${s.url}`,
      ...(s.captcha
        ? [
            '⚠ 로봇 확인(캡차·자동입력 방지) 화면이 보여요. 풀려고 하지 말고 사용자에게 직접 해 달라고 부탁해 주세요.',
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
