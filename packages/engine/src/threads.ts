import {
  type AgentEvent,
  type AgentId,
  type ApprovalRecordMessage,
  type CardsRecordMessage,
  type ConnectRecordMessage,
  cleanCards,
  type DaemonStreamEvent,
  type HandoffRecord,
  type LoginRecordMessage,
  type WorkRecordMessage,
} from '@dool2/protocol'
import {
  type BlockRecordMessage,
  cleanDraft,
  cleanResult,
  cleanRoute,
  cleanRows,
  type QuickRecordMessage,
} from '@dool2/protocol/blocks'
import { narrationLine, splitQuick, stripMonologue, toolLabel, toolPlace } from '@dool2/protocol/rich'
import type { Store } from '@dool2/store'
import { DOOL2_SYSTEM_PROMPT } from './persona.js'
import type { AgentRuntime, McpServerSpec } from './runtime.js'

export interface ThreadServiceOptions {
  store: Store
  runtimes: Partial<Record<AgentId, AgentRuntime>>
  /** 두리 전용 작업 폴더 */
  workspaceDir: string
  mcpServers: McpServerSpec[]
  systemPrompt?: string | (() => string)
  /** 탭 번호 → 그 탭의 사이트 주소 (일한 과정을 사이트별로 묶는다) */
  tabHost?: (tabId: number) => string | undefined
  /** 서비스 도구 이름 → 사람이 읽는 제목 ("가게 찾기·영업 확인"). 일한 과정에 "일하는 중" 대신 보인다 */
  toolTitle?: (name: string) => string | undefined
  /** 말과 함께 넘기는 지금 시각 한 줄 (기본 nowLine, 시험에서는 끈다) */
  timeLine?: () => string | undefined
}

/** 대화 단위로 에이전트를 돌리고 기록을 남긴다. */
export class ThreadService {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly opts: ThreadServiceOptions) {}

  runtime(agent: AgentId): AgentRuntime {
    const rt = this.opts.runtimes[agent]
    if (!rt) throw new Error(`지원하지 않는 AI예요: ${agent}`)
    return rt
  }

  private readonly summarizing = new Set<string>()
  isRunning(threadId: string) {
    return this.running.has(threadId)
  }

  cancel(threadId: string) {
    this.running.get(threadId)?.abort()
  }

  /** 두리 지침 + 앞 구간에서 넘겨받은 내용 (ADR 0015) */
  private systemFor(thread: { carry?: string }) {
    const sp = this.opts.systemPrompt
    const base = (typeof sp === 'function' ? sp() : sp) ?? DOOL2_SYSTEM_PROMPT
    return thread.carry ? `${base}\n\n${thread.carry}` : base
  }

  /**
   * 기록에 남기지 않는 한 차례: 구간을 닫기 전에 그 AI에게 요약을 부탁한다.
   * 이어 할 세션이 없거나 답하는 중이면 하지 않는다. 오래 걸리면 그만둔다
   */
  async summarize(threadId: string, timeoutMs = 90_000): Promise<string | undefined> {
    const thread = this.opts.store.getThread(threadId)
    if (!thread?.resumeId || this.running.has(threadId) || this.summarizing.has(threadId)) return undefined
    // 요약은 "답하는 중"이 아니다: 답이 끝난 뒤 미리 요약하는 동안 새 말이 줄에 서지 않게 따로 센다
    const ac = new AbortController()
    this.summarizing.add(threadId)
    try {
      let text = ''
      const events = this.runtime(thread.agent).runTurn({
        text: SUMMARY_REQUEST,
        resumeId: thread.resumeId,
        systemPrompt: this.systemFor(thread),
        mcpServers: this.opts.mcpServers,
        cwd: this.opts.workspaceDir,
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
      })
      for await (const ev of events) {
        if (ev.type === 'tool') text = ''
        if (ev.type === 'text') text += ev.delta
        if (ev.type === 'done' && !text.trim() && ev.text) text = ev.text
        if (ev.type === 'error' || ev.type === 'limit_reached') return undefined
      }
      return text.trim() || undefined
    } catch {
      return undefined
    } finally {
      this.summarizing.delete(threadId)
    }
  }

  /**
   * 사용자 글을 저장하고 에이전트를 한 턴 돌린다.
   * 같은 대화에서 동시에 두 턴은 돌리지 않는다.
   */
  /** aside: 이번 차례에만 AI에게 덧붙여 보낼 배경 (기록·화면에는 남기지 않는다. 예: 방금 먼저 알린 것) */
  async *send(threadId: string, text: string, o: { aside?: string } = {}): AsyncGenerator<DaemonStreamEvent> {
    const { store } = this.opts
    const thread = store.getThread(threadId)
    if (!thread) throw new Error(`대화를 찾을 수 없어요: ${threadId}`)
    if (this.running.has(threadId)) throw new Error('이 대화는 아직 답하는 중이에요')

    const ac = new AbortController()
    this.running.set(threadId, ac)
    try {
      const userMsg = store.addMessage(threadId, 'user', text)
      yield { type: 'saved', message: userMsg }
      if (thread.title === '새 대화') store.updateThread(threadId, { title: titleFrom(text) })

      let answer = ''
      let resumeId = thread.resumeId
      let failed: AgentEvent | undefined
      // 답은 'done'이 오자마자 저장해 화면에 보낸다. 공식 CLI가 끝 정리(도구 서버 닫기 등)를 하는 0.5초쯤을 기다리지 않는다
      let saved = false
      const work = new WorkLog(Date.now, this.opts.tabHost, this.opts.toolTitle)
      // 답에 붙일 결과 블록 (show_cards·show_list·show_result·show_draft·show_route): 답을 저장한 바로 뒤에 남겨 답 아래에 보인다.
      // 답 하나에 결과 블록 하나 — 여러 번 부르면 마지막 것만 (사진 카드끼리는 이어 붙인다)
      let block: CardsRecordMessage | BlockRecordMessage | undefined
      /** PC 파일 승인(여러 개 옮기기·출력): 도구가 승인을 실제로 요청했을 때(성공한 결과)만 카드를 남긴다 */
      let fileAsk: { name: string; record: ApprovalRecordMessage } | undefined
      let approvalAsk: { name: string; record: ApprovalRecordMessage } | undefined
      let handoffAsk: { name: string; record: HandoffRecord } | undefined
      const saveBlock = () => {
        if (!block) return undefined
        const m = store.addMessage(threadId, 'tool', JSON.stringify(block))
        block = undefined
        return m
      }
      // 답 저장: 일한 과정 → 답 글 → 결과 블록 → 빠른 답 (답 끝 [[답: a | b]] 줄은 떼어 버튼으로)
      /** 답 글 아래에 둘 카드 (넘기기·로그인·승인): 답이 저장되기 전에 오면 모아 뒀다가 답 다음에 남긴다 */
      const below: string[] = []
      const saveAnswer = () => {
        const out = []
        const rec = work.record()
        if (rec) out.push(store.addMessage(threadId, 'tool', JSON.stringify(rec)))
        const raw = stripMonologue(answer)
        // 결과 블록은 답 글 아래에 보인다: AI가 "위 목록·위에 정리"라고 써도 아래로 고친다 (도구를 먼저 불러 '위'라고 쓴다)
        const full = block ? blockBelow(raw) : raw
        const { text, replies } = splitQuick(full)
        out.push(store.addMessage(threadId, 'assistant', text || full))
        const c = saveBlock()
        if (c) out.push(c)
        for (const r of below.splice(0)) out.push(store.addMessage(threadId, 'tool', r))
        if (replies && text) {
          const quick: QuickRecordMessage = { kind: 'quick', replies }
          out.push(store.addMessage(threadId, 'tool', JSON.stringify(quick)))
        }
        return out
      }
      const events = this.runtime(thread.agent).runTurn({
        // 지금 시각은 지침이 아니라 말과 함께 (지침이 매분 바뀌면 AI 대화 캐시가 깨진다). 없으면 AI가 시각을 알려고 status를 부른다
        text: [(this.opts.timeLine ?? nowLine)(), o.aside, text].filter(Boolean).join('\n\n'),
        ...(resumeId ? { resumeId } : {}),
        systemPrompt: this.systemFor(thread),
        mcpServers: this.opts.mcpServers,
        cwd: this.opts.workspaceDir,
        signal: ac.signal,
      })
      for await (const ev of events) {
        if (ev.type === 'started' && ev.resumeId) resumeId = ev.resumeId
        // 답은 마지막 도구 뒤의 말만. 도구 앞 혼잣말("날짜를 맞출게요")은 일하는 중 표시일 뿐이다
        if (ev.type === 'tool') {
          work.tool(ev.name, answer, ev.input)
          answer = ''
        }
        if (ev.type === 'tool' && /show_cards$/.test(ev.name)) {
          const input = ev.input as { cards?: unknown; shape?: unknown } | undefined
          const list = cleanCards(input?.cards)
          // 한 차례에 여러 번 부르면 이어 붙인다 (10장까지)
          const prev = block?.kind === 'cards' ? block : undefined
          if (list.length)
            block = {
              kind: 'cards',
              cards: [...(prev?.cards ?? []), ...list].slice(0, 10),
              ...(input?.shape === 'portrait' || prev?.shape === 'portrait'
                ? { shape: 'portrait' as const }
                : {}),
            }
        }
        if (ev.type === 'tool' && /show_(list|result|draft|route)$/.test(ev.name)) {
          const kind = ev.name.match(/show_(list|result|draft|route)$/)?.[1]
          const rec =
            kind === 'list'
              ? cleanRows(ev.input)
              : kind === 'result'
                ? cleanResult(ev.input)
                : kind === 'route'
                  ? cleanRoute(ev.input)
                  : cleanDraft(ev.input)
          if (rec) block = rec
        }
        if (ev.type === 'text') answer += ev.delta
        if (ev.type === 'done') {
          if (ev.resumeId) resumeId = ev.resumeId
          if (!answer.trim() && ev.text) answer = ev.text
        }
        if (ev.type === 'error' || ev.type === 'limit_reached') failed = ev
        // 구간의 실제 크기: 다음 말 전에 구간을 바꿀지 볼 때 쓴다 (ADR 0015)
        if (ev.type === 'context') store.setContextTokens(threadId, ev.tokens)
        // 서비스 도구면 제목을 실어 보낸다: 화면이 "일하는 중" 대신 "가게 찾기·영업 확인 중"을 보인다
        // (화면은 끝에 " 중"을 붙이니 떼고 보낸다)
        const title =
          ev.type === 'tool'
            ? serviceAct(ev.name, ev.input, this.opts.toolTitle)?.replace(/ 중$/, '')
            : undefined
        yield { type: 'agent', event: title && ev.type === 'tool' ? { ...ev, title } : ev }
        if (ev.type === 'done' && answer && !saved) {
          saved = true
          if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
          for (const m of saveAnswer()) yield { type: 'saved', message: m }
        }
        // 사람에게 넘기기는 기록에 남겨 둔다 (다시 열어도 [다 했어요]가 보이게).
        // 실제로 넘겼을 때(성공한 결과)만: 처음 부르면 넘기지 않고 화면을 다시 읽어 실패로 돌려준다
        if (ev.type === 'tool' && /browser_handoff$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { tabId?: unknown; reason?: unknown }
          handoffAsk = {
            name: ev.name,
            record: {
              kind: 'handoff',
              ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
              reason: typeof input.reason === 'string' ? input.reason : '직접 해 주실 일이 있어요',
            },
          }
        }
        if (ev.type === 'tool_result' && handoffAsk && (!ev.name || ev.name === handoffAsk.name)) {
          const ask = handoffAsk
          handoffAsk = undefined
          // 답 글보다 위에 뜨지 않게: 답이 아직이면 답 다음에 남긴다 (사용자: "버튼이 메시지보다 위에 있어 별로")
          if (ev.ok) {
            if (saved)
              yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(ask.record)) }
            else below.push(JSON.stringify(ask.record))
          }
        }
        // 승인 요청도 남긴다. 카드는 본체에 상태(기다림·승인·거절·만료)를 물어 그린다
        // 로그인 카드 요청도 남긴다 (값은 남기지 않는다. 카드가 본체에 상태를 묻는다)
        if (ev.type === 'tool' && /browser_request_login$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { tabId?: unknown; site?: unknown }
          const record: LoginRecordMessage = {
            kind: 'login',
            ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
            site: typeof input.site === 'string' ? input.site : '',
          }
          yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(record)) }
        }
        // 서비스 연결 부탁: 대화에 연결 카드를 남긴다 (값은 카드 → 금고로만 간다)
        if (ev.type === 'tool' && /connect_ask$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { service?: unknown }
          if (typeof input.service === 'string' && input.service.trim()) {
            const record: ConnectRecordMessage = {
              kind: 'connect',
              service: input.service.trim().slice(0, 60),
            }
            yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(record)) }
          }
        }
        // PC 파일·PC 승인은 탭 번호 대신 -2, ref는 도구 이름 (ADR 0024).
        // 하나만 옮기기·되살리기, 되돌리기, 프린터 목록, 실행 파일이 아닌 내려받기, 끄기 부탁은 승인이 없다
        if (ev.type === 'tool') {
          const ref = /(file_move|file_print|file_trash|file_download|pc_screen)$/.exec(ev.name)?.[1]
          const what = ref ? fileApprovalWhat(ref, (ev.input ?? {}) as Record<string, unknown>) : undefined
          if (ref)
            fileAsk = what ? { name: ev.name, record: { kind: 'approval', tabId: -2, ref, what } } : undefined
        }
        if (ev.type === 'tool_result' && fileAsk && (!ev.name || ev.name === fileAsk.name)) {
          const ask = fileAsk
          fileAsk = undefined
          if (ev.ok)
            yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(ask.record)) }
        }
        // PC 앱(화면 제어) 승인은 탭 번호 대신 -1, 앱 허용 요청은 ref "app"
        const screen = ev.type === 'tool' && /screen_request_(?:approval|app)$/.test(ev.name)
        // 결제 카드(browser_checkout)도 같은 승인 카드다 (what이 없으면 제목·상품 이름으로)
        if (ev.type === 'tool' && (screen || /browser_(?:request_approval|checkout)$/.test(ev.name))) {
          const input = (ev.input ?? {}) as {
            tabId?: unknown
            ref?: unknown
            what?: unknown
            why?: unknown
            title?: unknown
            goods?: unknown
          }
          if (/browser_checkout$/.test(ev.name) && typeof input.what !== 'string') {
            const names = Array.isArray(input.goods)
              ? input.goods.map((g) => String((g as { name?: unknown })?.name ?? '')).filter(Boolean)
              : []
            input.what =
              [typeof input.title === 'string' ? input.title : '', names.join('·')]
                .filter(Boolean)
                .join(' · ') || '결제'
          }
          const appRequest = /screen_request_app$/.test(ev.name)
          const record: ApprovalRecordMessage = {
            kind: 'approval',
            ...(screen ? { tabId: -1 } : typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
            ...(appRequest ? { ref: 'app' } : typeof input.ref === 'string' ? { ref: input.ref } : {}),
            what: appRequest
              ? `앱 조작 허용${typeof input.why === 'string' ? `: ${input.why}` : ''}`
              : typeof input.what === 'string'
                ? input.what
                : '',
          }
          // 도구가 실제로 승인을 요청했을 때(성공한 결과)만 카드를 남긴다 (이미 승인한 사이트의 동의 등은 실패로 돌아온다)
          approvalAsk = { name: ev.name, record }
        }
        if (ev.type === 'tool_result' && approvalAsk && (!ev.name || ev.name === approvalAsk.name)) {
          const ask = approvalAsk
          approvalAsk = undefined
          if (ev.ok)
            yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(ask.record)) }
        }
      }

      if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
      if (saved) {
        // 이미 저장했다
      } else if (answer) {
        for (const m of saveAnswer()) yield { type: 'saved', message: m }
      } else if (failed && 'message' in failed) {
        yield { type: 'saved', message: store.addMessage(threadId, 'system', failed.message) }
      }
      // 답 없이 끝났어도 넘기기 카드는 남긴다
      for (const r of below.splice(0)) yield { type: 'saved', message: store.addMessage(threadId, 'tool', r) }
    } finally {
      this.running.delete(threadId)
      yield { type: 'end' }
    }
  }
}

/** 구간을 닫을 때 AI에게 보내는 요약 부탁 (기록에 남지 않는다) */
export const SUMMARY_REQUEST =
  '[두리 앱 알림] 대화가 길어져서 새 대화로 이어 가요. 지금까지 사용자와 나눈 이야기에서 앞으로도 기억해야 할 것' +
  '(사용자 취향, 약속, 진행 중이거나 끝낸 일, 정해진 날짜·시간·금액)을 한국어 글머리표 15줄 안으로 요약해 주세요. ' +
  '도구는 쓰지 말고 요약만 답해 주세요.'

/** PC 파일·PC 도구가 승인을 요청하는 입력이면 승인 카드에 적을 말, 아니면 undefined (본체 file-ops.ts와 같은 기준) */
export function fileApprovalWhat(ref: string, input: Record<string, unknown>): string | undefined {
  const base = (p: unknown) => String(p).split(/[\\/]/).pop()
  if (ref === 'file_move')
    return input.undo !== true && Array.isArray(input.moves) && input.moves.length >= 2
      ? `파일 ${input.moves.length}개 옮기기`
      : undefined
  if (ref === 'file_print')
    return typeof input.path === 'string' && input.path.trim() ? `"${base(input.path)}" 출력` : undefined
  if (ref === 'file_trash')
    return Array.isArray(input.restore) && input.restore.length >= 2
      ? `휴지통에서 ${input.restore.length}개 되살리기`
      : undefined
  if (ref === 'file_download')
    return input.confirm === true && typeof input.url === 'string' ? '실행 파일 받기' : undefined
  if (ref === 'pc_screen')
    return input.action === 'lock'
      ? '이 PC 화면 잠그기'
      : input.action === 'sleep'
        ? '이 PC 잠자기'
        : undefined
  return undefined
}

function titleFrom(text: string) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 30 ? `${one.slice(0, 30)}…` : one
}

/** 정리·기억 같은 속일만 한 차례에는 일한 과정을 남기지 않는다 (답마다 카드가 붙지 않게) */
const QUIET_TOOL =
  /(goal|memory|library|feed|idea)_|status$|skill_|conversation_search|show_(cards|list|result|draft)/

/** 한 차례 동안 한 일을 모아 '일한 과정' 기록(WorkRecordMessage)을 만든다. 폰·PC 화면의 단계 표시와 같은 이름을 쓴다 */
export class WorkLog {
  private readonly started: number
  private steps: { text: string; act: string; place?: string; at: number }[] = []
  private worked = false
  private host: string | undefined
  constructor(
    private readonly now: () => number = Date.now,
    private readonly tabHost?: (tabId: number) => string | undefined,
    private readonly toolTitle?: (name: string) => string | undefined,
  ) {
    this.started = now()
  }
  /** 도구를 부를 때: 그 앞에 한 혼잣말 한 줄, 없으면 도구 이름("웹페이지 여는 중"). 일한 곳(place)도 같이 남긴다 */
  tool(name: string, before: string, input?: unknown) {
    const bare = name.replace(/^(mcp__dool2__|dool2_)/, '')
    if (!QUIET_TOOL.test(bare)) this.worked = true
    // 주소 없는 웹 도구: 그 탭의 사이트, 모르면 마지막으로 연 사이트
    const tabId = (input as { tabId?: unknown } | undefined)?.tabId
    const here = (typeof tabId === 'number' ? this.tabHost?.(tabId) : undefined) ?? this.host
    const place = toolPlace(name, input, here)
    if (/^browser_(open|navigate)$/.test(bare) && place) this.host = place
    // 서비스 도구는 제목으로 ("네이버 지도 · 일하기" 대신 "가게 찾기·영업 확인")
    const act = serviceAct(name, input, this.toolTitle) ?? `${toolLabel(name)} 중`
    const text = narrationLine(before) ?? act
    const last = this.steps.at(-1)
    if (last?.text !== text || last.place !== place)
      this.steps.push({ text, act, ...(place ? { place } : {}), at: this.now() })
  }
  record(): WorkRecordMessage | undefined {
    if (!this.worked || !this.steps.length) return undefined
    const end = this.now()
    const steps = this.steps.map(({ at, ...s }, i) => ({ ...s, ms: (this.steps[i + 1]?.at ?? end) - at }))
    return {
      kind: 'work',
      steps: steps.slice(-30),
      count: steps.length,
      ms: end - this.started,
      ...(this.host ? { host: this.host } : {}),
    }
  }
}

/**
 * 서비스 도구(직접 부른 것이든 service_call로 부른 것이든)의 일하는 중 글: "극장 찾기 중", "상영 중인 영화 보는 중".
 * 제목을 모르면 undefined (그때는 toolLabel)
 */
export function serviceAct(
  name: string,
  input: unknown,
  toolTitle?: (name: string) => string | undefined,
): string | undefined {
  const bare = name.replace(/^(mcp__dool2__|dool2_)/, '')
  const inner = (input as { tool?: unknown } | undefined)?.tool
  const target = bare === 'service_call' && typeof inner === 'string' ? inner : bare
  const title = toolTitle?.(target)
  if (!title) return undefined
  // 하는 일 이름(찾기·확인·조회·준비)은 "… 중", 볼 것 이름(상영 중인 영화·상영 시간)은 "… 보는 중"
  return /(기|인|회|비|약|청|문|소|색|산)$/.test(title) ? `${title} 중` : `${title} 보는 중`
}

/** 말과 함께 넘기는 지금 시각 한 줄 (데이터) */
export function nowLine(now = Date.now()): string {
  const d = new Date(now + 9 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `(지금 ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}(${'일월화수목금토'[d.getUTCDay()]}) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}, 한국 시각)`
}

/** 같은 답에 붙는 결과 블록을 가리키는 '위'를 '아래'로 (블록은 답 글 아래에 보인다) */
export function blockBelow(text: string): string {
  return text
    .replace(/위(?:의)? (목록|카드|사진 카드|표|초안|글|결과|줄)/g, '아래 $1')
    .replace(/위에 (정리|붙|써|적|모아|올려|넣어|보여|골라)/g, '아래에 $1')
}
