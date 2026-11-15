import type {
  AgentEvent,
  AgentId,
  ApprovalRecordMessage,
  DaemonStreamEvent,
  HandoffRecord,
  LoginRecordMessage,
} from '@dool2/protocol'
import type { Store } from '@dool2/store'
import { DOOL2_SYSTEM_PROMPT } from './persona.js'
import type { AgentRuntime, McpServerSpec } from './runtime.js'

export interface ThreadServiceOptions {
  store: Store
  runtimes: Partial<Record<AgentId, AgentRuntime>>
  /** 두리 전용 작업 폴더 */
  workspaceDir: string
  mcpServers: McpServerSpec[]
  systemPrompt?: string
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

  isRunning(threadId: string) {
    return this.running.has(threadId)
  }

  cancel(threadId: string) {
    this.running.get(threadId)?.abort()
  }

  /** 두리 지침 + 앞 구간에서 넘겨받은 내용 (ADR 0015) */
  private systemFor(thread: { carry?: string }) {
    const base = this.opts.systemPrompt ?? DOOL2_SYSTEM_PROMPT
    return thread.carry ? `${base}\n\n${thread.carry}` : base
  }

  /**
   * 기록에 남기지 않는 한 차례: 구간을 닫기 전에 그 AI에게 요약을 부탁한다.
   * 이어 할 세션이 없거나 답하는 중이면 하지 않는다. 오래 걸리면 그만둔다
   */
  async summarize(threadId: string, timeoutMs = 90_000): Promise<string | undefined> {
    const thread = this.opts.store.getThread(threadId)
    if (!thread?.resumeId || this.running.has(threadId)) return undefined
    const ac = new AbortController()
    this.running.set(threadId, ac)
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
        if (ev.type === 'text') text += ev.delta
        if (ev.type === 'done' && !text && ev.text) text = ev.text
        if (ev.type === 'error' || ev.type === 'limit_reached') return undefined
      }
      return text.trim() || undefined
    } catch {
      return undefined
    } finally {
      this.running.delete(threadId)
    }
  }

  /**
   * 사용자 글을 저장하고 에이전트를 한 턴 돌린다.
   * 같은 대화에서 동시에 두 턴은 돌리지 않는다.
   */
  async *send(threadId: string, text: string): AsyncGenerator<DaemonStreamEvent> {
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
      const events = this.runtime(thread.agent).runTurn({
        text,
        ...(resumeId ? { resumeId } : {}),
        systemPrompt: this.systemFor(thread),
        mcpServers: this.opts.mcpServers,
        cwd: this.opts.workspaceDir,
        signal: ac.signal,
      })
      for await (const ev of events) {
        if (ev.type === 'started' && ev.resumeId) resumeId = ev.resumeId
        if (ev.type === 'text') answer += ev.delta
        if (ev.type === 'done') {
          if (ev.resumeId) resumeId = ev.resumeId
          if (!answer && ev.text) answer = ev.text
        }
        if (ev.type === 'error' || ev.type === 'limit_reached') failed = ev
        yield { type: 'agent', event: ev }
        if (ev.type === 'done' && answer && !saved) {
          saved = true
          if (resumeId && resumeId !== thread.resumeId) store.updateThread(threadId, { resumeId })
          yield { type: 'saved', message: store.addMessage(threadId, 'assistant', answer) }
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
      } else if (answer) yield { type: 'saved', message: store.addMessage(threadId, 'assistant', answer) }
      else if (failed && 'message' in failed) {
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
