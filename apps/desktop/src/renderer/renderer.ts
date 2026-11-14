// 두리 PC 앱 화면. dool2d 로컬 API(127.0.0.1 + 토큰)만 쓴다.
import type {
  AgentEvent,
  AgentId,
  AgentStatus,
  DaemonStreamEvent,
  StoredMessage,
  ThreadSummary,
  UsageLimit,
} from '@dool2/protocol'

declare global {
  interface Window {
    dool2: {
      config(): Promise<{ url: string; token: string; smokeOpen?: string }>
      ready(summary: string): void
    }
  }
}

const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' }
const TOOL_LABEL: Record<string, string> = { mcp__dool2__status: '두리 상태 확인' }
const LIMIT_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '이번 주' }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const state: {
  url: string
  token: string
  agents: AgentStatus[]
  threads: ThreadSummary[]
  current?: ThreadSummary
  pick: AgentId
  busy: boolean
} = { url: '', token: '', agents: [], threads: [], pick: 'claude', busy: false }

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(state.url + path, {
    ...init,
    headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `요청 실패 (${res.status})`)
  }
  return (await res.json()) as T
}

// ── AI 연결 상태 ───────────────────────────────────────

function agentState(a: AgentStatus): { cls: string; text: string } {
  if (!a.installed) return { cls: 'bad', text: '설치 필요' }
  if (!a.loggedIn) return { cls: 'warn', text: '로그인 필요' }
  return { cls: 'ok', text: '준비됨' }
}

function renderAgents() {
  const box = $('agents')
  box.replaceChildren(
    ...state.agents.map((a) => {
      const el = document.createElement('div')
      el.className = 'agent'
      const s = agentState(a)
      const row = document.createElement('div')
      row.className = 'row'
      const name = document.createElement('strong')
      name.textContent = AGENT_LABEL[a.id]
      const chip = document.createElement('span')
      chip.className = `state ${s.cls}`
      chip.textContent = s.text
      row.append(name, chip)
      const meta = document.createElement('p')
      meta.className = 'cap'
      meta.textContent =
        [a.version && `v${a.version}`, a.plan && `${a.plan} 구독`].filter(Boolean).join(' · ') || ' '
      el.append(row, meta)
      if (a.installed && !a.loggedIn) {
        const btn = document.createElement('button')
        btn.className = 'act'
        btn.type = 'button'
        if (a.id === 'codex') {
          btn.textContent = 'ChatGPT로 로그인 →'
          btn.onclick = async () => {
            btn.textContent = '브라우저에서 로그인해 주세요…'
            await api('/api/agents/codex/login', { method: 'POST' }).catch(() => {})
            await loadAgents()
          }
        } else {
          btn.textContent = '로그인 방법 보기'
          btn.onclick = () => {
            meta.textContent = '터미널에서 claude auth login 을 실행해 주세요. (곧 버튼 하나로 바뀌어요)'
          }
        }
        el.append(btn)
      }
      return el
    }),
  )
  renderPick()
}

function renderPick() {
  const box = $('agent-pick')
  box.replaceChildren(
    ...(['claude', 'codex'] as AgentId[]).map((id) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(state.pick === id))
      b.textContent = AGENT_LABEL[id]
      b.onclick = () => {
        state.pick = id
        renderPick()
      }
      return b
    }),
  )
}

async function loadAgents() {
  const { agents } = await api<{ agents: AgentStatus[] }>('/api/agents')
  state.agents = agents
  const ready = agents.find((a) => a.installed && a.loggedIn)
  if (ready && !agents.find((a) => a.id === state.pick && a.loggedIn)) state.pick = ready.id
  renderAgents()
}

// ── 대화 목록 ─────────────────────────────────────────

function renderThreads() {
  $('threads').replaceChildren(
    ...state.threads.map((t) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('aria-current', String(t.id === state.current?.id))
      const title = document.createElement('span')
      title.className = 't'
      title.textContent = t.title
      const meta = document.createElement('span')
      meta.className = 'm'
      meta.textContent = `${AGENT_LABEL[t.agent]} · ${new Date(t.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      b.append(title, meta)
      b.onclick = () => void openThread(t.id)
      li.append(b)
      return li
    }),
  )
}

async function loadThreads() {
  state.threads = (await api<{ threads: ThreadSummary[] }>('/api/threads')).threads
  renderThreads()
}

async function openThread(id: string) {
  const { thread, messages } = await api<{ thread: ThreadSummary; messages: StoredMessage[] }>(
    `/api/threads/${id}`,
  )
  state.current = thread
  setHeader()
  const box = $('messages')
  box.replaceChildren(...messages.map((m) => bubble(m.role, m.text)))
  box.scrollTop = box.scrollHeight
  renderThreads()
}

function setHeader() {
  $('title').textContent = state.current?.title ?? '새 대화'
  $('subtitle').textContent = state.current ? `${AGENT_LABEL[state.current.agent]}로 실행 중` : ''
}

// ── 메시지 ───────────────────────────────────────────

/** 아주 작은 마크다운: **굵게**만. 나머지는 글자 그대로 (HTML로 해석하지 않는다) */
function bubble(role: string, text: string) {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  setRich(el, text)
  return el
}

function setRich(el: HTMLElement, text: string) {
  el.replaceChildren()
  text.split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const b = document.createElement('strong')
      b.textContent = part.slice(2, -2)
      el.append(b)
    } else if (part) el.append(document.createTextNode(part))
  })
}

function renderUsage(limits: UsageLimit[]) {
  const box = $('usage')
  box.hidden = limits.length === 0
  box.replaceChildren(
    ...limits.map((l) => {
      const u = document.createElement('div')
      u.className = 'u'
      const label = document.createElement('span')
      label.textContent = `${LIMIT_LABEL[l.kind] ?? l.kind} 사용량 ${l.percent}%`
      const bar = document.createElement('div')
      bar.className = 'bar'
      const fill = document.createElement('i')
      fill.style.width = `${Math.min(100, l.percent)}%`
      if (l.percent >= 80) fill.className = 'hi'
      bar.append(fill)
      u.append(label, bar)
      return u
    }),
  )
}

async function send(text: string) {
  if (state.busy || !text.trim()) return
  state.busy = true
  $<HTMLButtonElement>('send').disabled = true
  const box = $('messages')
  $('empty')?.remove()

  try {
    if (!state.current) {
      const { thread } = await api<{ thread: ThreadSummary }>('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ agent: state.pick }),
      })
      state.current = thread
      setHeader()
    }
    box.append(bubble('user', text))
    const activity = document.createElement('div')
    activity.className = 'activity'
    activity.textContent = '두리가 생각하는 중…'
    box.append(activity)
    let answer: HTMLElement | undefined
    let answerText = ''
    box.scrollTop = box.scrollHeight

    const res = await fetch(`${state.url}/api/threads/${state.current.id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok || !res.body)
      throw new Error((await res.json().catch(() => ({ error: '' }))).error || '보내지 못했어요')

    const onAgent = (ev: AgentEvent) => {
      if (ev.type === 'text') {
        answerText += ev.delta
        if (!answer) {
          answer = bubble('assistant', '')
          box.insertBefore(answer, activity)
        }
        setRich(answer, answerText)
      } else if (ev.type === 'tool') activity.textContent = `${TOOL_LABEL[ev.name] ?? ev.name} 중…`
      else if (ev.type === 'tool_result') activity.textContent = '정리하는 중…'
      else if (ev.type === 'usage') renderUsage(ev.limits)
      else if (ev.type === 'error' || ev.type === 'limit_reached')
        box.insertBefore(bubble('system', ev.message), activity)
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let i = buf.indexOf('\n\n')
      while (i >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (chunk.startsWith('data: ')) {
          const ev = JSON.parse(chunk.slice(6)) as DaemonStreamEvent
          if (ev.type === 'agent') onAgent(ev.event)
        }
        box.scrollTop = box.scrollHeight
        i = buf.indexOf('\n\n')
      }
    }
    activity.remove()
  } catch (err) {
    box.append(bubble('system', (err as Error).message))
  } finally {
    state.busy = false
    $<HTMLButtonElement>('send').disabled = false
    await loadThreads()
    if (state.current) state.current = state.threads.find((t) => t.id === state.current?.id) ?? state.current
    setHeader()
    renderThreads()
  }
}

// ── 시작 ─────────────────────────────────────────────

async function main() {
  const cfg = await window.dool2.config()
  state.url = cfg.url
  state.token = cfg.token

  const input = $<HTMLTextAreaElement>('input')
  const autosize = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }
  input.addEventListener('input', autosize)
  input.addEventListener('keydown', (e) => {
    // 한글 조합 중 Enter는 무시한다
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      $<HTMLFormElement>('composer').requestSubmit()
    }
  })
  $<HTMLFormElement>('composer').addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value
    input.value = ''
    autosize()
    void send(text)
  })
  // 빈 화면(예시 버튼 포함)을 복제해 두었다가 새 대화에서 다시 쓴다
  const emptyTemplate = $('empty').cloneNode(true) as HTMLElement
  const showEmpty = () => {
    const empty = emptyTemplate.cloneNode(true) as HTMLElement
    empty.querySelectorAll<HTMLButtonElement>('[data-example]').forEach((b) => {
      b.onclick = () => void send(b.dataset.example ?? '')
    })
    $('messages').replaceChildren(empty)
  }
  $('new-thread').onclick = () => {
    if (state.busy) return
    state.current = undefined
    setHeader()
    showEmpty()
    renderThreads()
    input.focus()
  }
  showEmpty()

  await Promise.all([loadAgents(), loadThreads()])
  // 점검 모드: 최근 대화를 열어 캡처한다
  const latest = state.threads[0]
  if (cfg.smokeOpen === 'latest' && latest) await openThread(latest.id)
  const ready = state.agents.filter((a) => a.installed && a.loggedIn).map((a) => a.id)
  // 화면이 실제로 그려진 뒤에 알린다
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dool2.ready(
    `agents=${state.agents.length} ready=${ready.join(',') || 'none'} threads=${state.threads.length}`,
  )
}

main().catch((err: Error) => {
  document.body.textContent = `두리를 시작하지 못했어요: ${err.message}`
  window.dool2?.ready(`error=${err.message}`)
})
