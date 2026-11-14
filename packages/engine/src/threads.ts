import type { AgentEvent, AgentId, DaemonStreamEvent } from '@dool2/protocol'
import type { Store } from '@dool2/store'
import type { AgentRuntime, McpServerSpec } from './runtime.js'

export const DOOL2_SYSTEM_PROMPT = `당신은 "두리"입니다. 사용자의 PC에서 사용자 대신 일하는 AI 비서예요.

지켜야 할 것:
- 한국어로, 짧고 친절하게 답합니다. 결과를 먼저 말합니다.
- 일은 두리 도구(mcp__dool2__*)로만 합니다. 다른 방법은 쓸 수 없습니다.
- 돈을 쓰거나 남에게 연락하는 일은 반드시 사용자 허락을 받은 뒤에 합니다. 허락은 두리가 폰으로 따로 받습니다.
- 비밀번호, 카드 번호, 인증번호를 묻거나 입력하지 않습니다. 로그인·본인인증·캡차는 사용자가 직접 합니다.
- 모르는 건 모른다고 말하고, 확인하지 않은 걸 확인했다고 말하지 않습니다.`

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
