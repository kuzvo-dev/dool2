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
import { narrationLine, stripMonologue, toolLabel } from '@dool2/protocol/rich'
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
      const work = new WorkLog()
      // 답에 붙일 카드 (show_cards): 답을 저장한 바로 뒤에 남겨 메시지 첨부처럼 답 아래에 보인다
      let cards: CardsRecordMessage | undefined
      const saveCards = () => {
        if (!cards) return undefined
        const m = store.addMessage(threadId, 'tool', JSON.stringify(cards))
        cards = undefined
        return m
      }
      const events = this.runtime(thread.agent).runTurn({
        text: o.aside ? `${o.aside}\n\n${text}` : text,
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
          const list = cleanCards((ev.input as { cards?: unknown } | undefined)?.cards)
          // 한 차례에 여러 번 부르면 이어 붙인다 (10장까지)
          if (list.length) cards = { kind: 'cards', cards: [...(cards?.cards ?? []), ...list].slice(0, 10) }
        }
        if (ev.type === 'text') answer += ev.delta
        if (ev.type === 'done') {
          if (ev.resumeId) resumeId = ev.resumeId
          if (!answer.trim() && ev.text) answer = ev.text
        }
        if (ev.type === 'error' || ev.type === 'limit_reached') failed = ev
        // 구간의 실제 크기: 다음 말 전에 구간을 바꿀지 볼 때 쓴다 (ADR 0015)
        if (ev.type === 'context') store.setContextTokens(threadId, ev.tokens)
        yield { type: 'agent', event: ev }
        if (ev.type === 'done' && answer && !saved) {
          saved = true
          if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
          const rec = work.record()
          if (rec) yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(rec)) }
          yield { type: 'saved', message: store.addMessage(threadId, 'assistant', stripMonologue(answer)) }
          const c = saveCards()
          if (c) yield { type: 'saved', message: c }
        }
        // 사람에게 넘기기는 기록에 남겨 둔다 (다시 열어도 [다 했어요]가 보이게)
        if (ev.type === 'tool' && /browser_handoff$/.test(ev.name)) {
          const input = (ev.input ?? {}) as { tabId?: unknown; reason?: unknown }
          const record: HandoffRecord = {
            kind: 'handoff',
            ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
            reason: typeof input.reason === 'string' ? input.reason : '직접 해 주실 일이 있어요',
          }
          yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(record)) }
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
        // PC 앱(화면 제어) 승인은 탭 번호 대신 -1, 앱 허용 요청은 ref "app"
        const screen = ev.type === 'tool' && /screen_request_(?:approval|app)$/.test(ev.name)
        if (ev.type === 'tool' && (screen || /browser_request_approval$/.test(ev.name))) {
          const input = (ev.input ?? {}) as { tabId?: unknown; ref?: unknown; what?: unknown; why?: unknown }
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
          yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(record)) }
        }
      }

      if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
      if (saved) {
        // 이미 저장했다
      } else if (answer) {
        const rec = work.record()
        if (rec) yield { type: 'saved', message: store.addMessage(threadId, 'tool', JSON.stringify(rec)) }
        yield { type: 'saved', message: store.addMessage(threadId, 'assistant', stripMonologue(answer)) }
        const c = saveCards()
        if (c) yield { type: 'saved', message: c }
      } else if (failed && 'message' in failed) {
        yield { type: 'saved', message: store.addMessage(threadId, 'system', failed.message) }
      }
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

function titleFrom(text: string) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 30 ? `${one.slice(0, 30)}…` : one
}

/** 정리·기억 같은 속일만 한 차례에는 일한 과정을 남기지 않는다 (답마다 카드가 붙지 않게) */
const QUIET_TOOL = /(goal|memory|library|feed|idea)_|status$|skill_|conversation_search|show_cards/

/** 한 차례 동안 한 일을 모아 '일한 과정' 기록(WorkRecordMessage)을 만든다. 폰·PC 화면의 단계 표시와 같은 이름을 쓴다 */
export class WorkLog {
  private readonly started: number
  private steps: { text: string; at: number }[] = []
  private worked = false
  private host: string | undefined
  constructor(private readonly now: () => number = Date.now) {
    this.started = now()
  }
  /** 도구를 부를 때: 그 앞에 한 혼잣말 한 줄, 없으면 도구 이름("웹페이지 여는 중") */
  tool(name: string, before: string, input?: unknown) {
    const bare = name.replace(/^(mcp__dool2__|dool2_)/, '')
    if (!QUIET_TOOL.test(bare)) this.worked = true
    const url = (input as { url?: unknown } | undefined)?.url
    if (/^browser_(open|navigate)$/.test(bare) && typeof url === 'string') {
      try {
        this.host = new URL(url).host
      } catch {}
    }
    const text = narrationLine(before) ?? `${toolLabel(name)} 중`
    if (this.steps.at(-1)?.text !== text) this.steps.push({ text, at: this.now() })
  }
  record(): WorkRecordMessage | undefined {
    if (!this.worked || !this.steps.length) return undefined
    const end = this.now()
    const steps = this.steps.map((s, i) => ({ text: s.text, ms: (this.steps[i + 1]?.at ?? end) - s.at }))
    return {
      kind: 'work',
      steps: steps.slice(-30),
      count: steps.length,
      ms: end - this.started,
      ...(this.host ? { host: this.host } : {}),
    }
  }
}
