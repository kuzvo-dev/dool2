import type {
  AgentEvent,
  AgentId,
  ApprovalRecordMessage,
  DaemonStreamEvent,
  HandoffRecord,
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
      const events = this.runtime(thread.agent).runTurn({
        text,
        ...(resumeId ? { resumeId } : {}),
        systemPrompt: this.opts.systemPrompt ?? DOOL2_SYSTEM_PROMPT,
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
      if (answer) yield { type: 'saved', message: store.addMessage(threadId, 'assistant', answer) }
      else if (failed && 'message' in failed) {
        yield { type: 'saved', message: store.addMessage(threadId, 'system', failed.message) }
      }
    } finally {
      this.running.delete(threadId)
      yield { type: 'end' }
    }
  }
}

function titleFrom(text: string) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 30 ? `${one.slice(0, 30)}…` : one
}
