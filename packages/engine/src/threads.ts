import type { AgentEvent, AgentId, DaemonStreamEvent } from '@dool2/protocol'
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
