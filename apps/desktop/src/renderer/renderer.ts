// 두리 PC 앱 화면. dool2d 로컬 API(127.0.0.1 + 토큰)만 쓴다.
import type {
  AgentEvent,
  AgentId,
  AgentStatus,
  AiChoice,
  ChromeStatus,
  DaemonStreamEvent,
  ExtensionStatus,
  HandoffRecord,
  Settings,
  StoredMessage,
  ThreadSummary,
  UsageLimit,
} from '@dool2/protocol'
import { runSetup, type SetupOptions } from './setup.js'
import { type CheckAction, costLabel, planLabel, SETUP_STEPS, type SetupStep } from './setup-model.js'

declare global {
  interface Window {
    dool2: {
      config(): Promise<{ url: string; token: string; smokeOpen?: string; smokeSetup?: string }>
      ready(summary: string): void
      extensionDir(): Promise<string>
      revealExtension(): void
    }
  }
}

const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'API 키 (종량제)',
}
/** 일하는 중 표시: "웹페이지 여는 중…" (도구 이름 앞의 mcp__dool2__ / dool2_는 떼고 본다) */
const TOOL_LABEL: Record<string, string> = {
  status: '두리 상태 확인하는',
  browser_open: '웹페이지 여는',
  browser_navigate: '웹페이지 여는',
  browser_read: '페이지 읽는',
  browser_click: '누르는',
  browser_type: '입력하는',
  browser_press: '키 누르는',
  browser_scroll: '스크롤하는',
  browser_screenshot: '화면 보는',
  browser_back: '뒤로 가는',
  browser_close: '탭 닫는',
  browser_handoff: '도움 부탁하는',
}
const toolLabel = (name: string) => TOOL_LABEL[name.replace(/^(mcp__dool2__|dool2_)/, '')] ?? '일하는'
const LIMIT_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '이번 주' }

/** 자가 점검: 마법사를 끝냈는데 일할 AI가 없으면 왼쪽 위에 알리고 [고치기]로 설정을 연다 */
function renderNotice(settings: Settings) {
  const box = $('notice')
  const ready = state.agents.some((a) => a.installed && a.loggedIn)
  box.hidden = !settings.setupDone || ready
  if (box.hidden) return
  const text = document.createElement('span')
  text.className = 'notice-text'
  text.textContent = '두리가 일할 AI가 연결돼 있지 않아요'
  const fix = document.createElement('button')
  fix.type = 'button'
  fix.className = 'btn-small'
  fix.textContent = '고치기'
  fix.onclick = () => void openSetup({ step: 'settings' })
  box.replaceChildren(text, fix)
}

/** 첫 실행 마법사를 연다 (main에서 채운다). 왼쪽 "Claude로 로그인"도 이걸 쓴다 */
let openSetup: (start?: SetupOptions['start']) => Promise<void> = async () => {}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const state: {
  url: string
  token: string
  agents: AgentStatus[]
  threads: ThreadSummary[]
  current?: ThreadSummary
  pick: AgentId
  busy: boolean
  extension?: ExtensionStatus
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
    // 종량제 실행기는 준비한 사람에게만 보여 준다
    ...state.agents
      .filter((a) => a.id !== 'opencode' || a.installed)
      .map((a) => {
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
          [a.version && `v${a.version}`, a.plan && `${planLabel(a.plan)} 구독`].filter(Boolean).join(' · ') ||
          ' '
        el.append(row, meta)
        // 아직 없는 AI는 마법사의 설치 단계로 바로 데려간다
        if (!a.installed && (a.id === 'claude' || a.id === 'codex')) {
          const get = document.createElement('button')
          get.className = 'act'
          get.type = 'button'
          get.textContent = a.id === 'claude' ? 'Claude Code 설치하기 →' : 'Codex 받기 →'
          const which = a.id === 'claude' ? 'claude' : 'codex'
          get.onclick = () => void openSetup({ step: 'check', choice: which, action: `${which}-install` })
          el.append(get)
        }
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
            btn.textContent = 'Claude로 로그인 →'
            btn.onclick = () => void openSetup({ step: 'check', choice: 'claude', action: 'claude-login' })
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
    ...(['claude', 'codex', 'opencode'] as AgentId[])
      .filter((id) => id !== 'opencode' || state.agents.some((a) => a.id === 'opencode' && a.installed))
      .map((id) => {
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
  // 사람에게 넘긴 뒤 아직 사용자가 답하지 않았으면 [다 했어요]를 살려 둔다
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  // 넘기기 기록은 답보다 먼저 저장되지만, 화면에서는 그 답 아래에 둔다 (대화 중에 보이는 순서와 같게)
  const order = messages.map((m, i) => ({ m, i }))
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k]
    const b = order[k + 1]
    if (a && b && a.m.role === 'tool' && b.m.role === 'assistant') {
      order[k] = b
      order[k + 1] = a
      k++
    }
  }
  box.replaceChildren(
    ...order.map(({ m, i }) =>
      m.role === 'tool' ? handoffCard(m.text, i > lastUser) : bubble(m.role, m.text),
    ),
  )
  box.scrollTop = box.scrollHeight
  renderThreads()
}

// ── 사람에게 넘기기 ──────────────────────────────────

/** 두리가 "직접 해 주세요"라고 넘긴 일. active면 [Chrome에서 보기] [다 했어요] */
function handoffCard(raw: string, active: boolean) {
  let rec: HandoffRecord
  try {
    rec = JSON.parse(raw) as HandoffRecord
  } catch {
    return document.createTextNode('')
  }
  const card = document.createElement('div')
  card.className = `handoff${active ? ' active' : ''}`
  const title = document.createElement('strong')
  title.textContent = active ? 'Chrome에서 직접 해 주세요' : '직접 해 주신 일'
  const reason = document.createElement('p')
  reason.textContent = rec.reason
  card.append(title, reason)
  if (active) {
    const row = document.createElement('div')
    row.className = 'handoff-actions'
    const look = document.createElement('button')
    look.type = 'button'
    look.className = 'btn-ghost'
    look.textContent = 'Chrome에서 보기'
    look.onclick = () =>
      void api('/api/browser/focus', { method: 'POST', body: JSON.stringify({ tabId: rec.tabId }) }).catch(
        () => {},
      )
    const doneBtn = document.createElement('button')
    doneBtn.type = 'button'
    doneBtn.className = 'btn'
    doneBtn.textContent = '다 했어요'
    doneBtn.onclick = () => void send('다 했어요. 이어서 해 주세요.')
    if (rec.tabId === undefined) look.hidden = true
    row.append(look, doneBtn)
    card.append(row)
  }
  return card
}

/** 창이 뒤에 있으면 알림으로도 알린다 */
function notifyHandoff(reason: string) {
  if (document.hasFocus()) return
  try {
    new Notification('두리가 도움을 기다려요', { body: reason })
  } catch {}
}

// ── 브라우저 (Chrome의 두리 확장) ──────────────────────

function renderBrowser() {
  const box = $('browser')
  const ext = state.extension
  const row = document.createElement('div')
  row.className = 'row'
  const name = document.createElement('strong')
  name.textContent = 'Chrome 두리 확장'
  const chip = document.createElement('span')
  chip.className = `state ${ext?.connected ? 'ok' : 'warn'}`
  chip.textContent = ext?.connected ? '연결됨' : '연결 안 됨'
  row.append(name, chip)
  const meta = document.createElement('p')
  meta.className = 'cap'
  meta.textContent = ext?.connected
    ? [ext.browser, ext.version && `확장 v${ext.version}`].filter(Boolean).join(' · ')
    : '웹 일을 하려면 연결해 주세요'
  const el = document.createElement('div')
  el.className = 'agent'
  el.append(row, meta)
  if (!ext?.connected) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'act'
    b.textContent = '연결하기 →'
    b.onclick = () => void openSetup({ step: 'check', action: 'extension-install' })
    el.append(b)
  }
  box.replaceChildren(el)
}

async function loadExtension() {
  const { extension } = await api<{ extension: ExtensionStatus }>('/api/browser/extension')
  const changed = JSON.stringify(extension) !== JSON.stringify(state.extension)
  state.extension = extension
  if (changed) renderBrowser()
  return extension
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
    // 새로 부탁하면 이전 "직접 해 주세요" 카드의 버튼은 거둔다
    box.querySelectorAll('.handoff.active').forEach((c) => {
      c.classList.remove('active')
      c.querySelector('.handoff-actions')?.remove()
    })
    box.append(bubble('user', text))
    const activity = document.createElement('div')
    activity.className = 'activity'
    activity.textContent = '두리가 생각하는 중…'
    box.append(activity)
    let answer: HTMLElement | undefined
    let answerText = ''
    // 종량제: 이번 답에 쓴 돈
    let usd = 0
    // 이번 답에서 사람에게 넘긴 일 (답이 끝난 뒤 카드로 보여 준다)
    let handoff: string | undefined
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
      } else if (ev.type === 'tool') activity.textContent = `${toolLabel(ev.name)} 중…`
      else if (ev.type === 'tool_result') activity.textContent = '정리하는 중…'
      else if (ev.type === 'usage') renderUsage(ev.limits)
      else if (ev.type === 'cost') usd += ev.usd
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
          if (ev.type === 'saved' && ev.message.role === 'tool') {
            handoff = ev.message.text
          }
        }
        box.scrollTop = box.scrollHeight
        i = buf.indexOf('\n\n')
      }
    }
    activity.remove()
    if (handoff) {
      box.append(handoffCard(handoff, true))
      try {
        notifyHandoff((JSON.parse(handoff) as HandoffRecord).reason)
      } catch {}
    }
    if (usd > 0) {
      const cost = document.createElement('p')
      cost.className = 'cost'
      cost.textContent = `이번 답 ${costLabel(usd)}`
      box.append(cost)
    }
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

  const [{ settings }] = await Promise.all([
    api<{ settings: Settings }>('/api/settings'),
    loadAgents(),
    loadThreads(),
    loadExtension().catch(() => undefined),
  ])
  renderBrowser()
  // 확장이 붙고 떨어지는 걸 왼쪽에 보여 준다
  setInterval(() => void loadExtension().catch(() => {}), 5_000)
  if (settings.defaultAgent && state.agents.some((a) => a.id === settings.defaultAgent && a.loggedIn)) {
    state.pick = settings.defaultAgent
    renderPick()
  }
  // 점검 모드: 최근 대화를 열어 캡처한다
  const latest = state.threads[0]
  if (cfg.smokeOpen === 'latest' && latest) await openThread(latest.id)

  // 첫 실행이면 마법사를 띄운다. 점검 모드에서는 "단계:선택"(예: check:both)으로 바로 연다
  const [smokeStep, smokeChoice, smokeAction] = (cfg.smokeSetup ?? '').split(':')
  const start = [...SETUP_STEPS, 'settings'].includes(smokeStep as SetupStep)
    ? {
        step: smokeStep as SetupStep,
        choice: (smokeChoice || undefined) as AiChoice | undefined,
        action: (smokeAction || undefined) as CheckAction | undefined,
      }
    : undefined
  let saved = settings
  openSetup = (from) => {
    const wizard = runSetup({
      api,
      settings: saved,
      loadAgents: async () => {
        await loadAgents()
        return state.agents
      },
      loadChrome: async () => (await api<{ chrome: ChromeStatus }>('/api/browser')).chrome,
      loadExtension,
      extensionDir: () => window.dool2.extensionDir(),
      revealExtension: () => window.dool2.revealExtension(),
      ...(from ? { start: from } : {}),
    })
    void wizard.done.then((r) => {
      saved = r.settings
      if (r.defaultAgent) state.pick = r.defaultAgent
      renderPick()
      renderNotice(saved)
      input.focus()
    })
    return wizard.shown
  }
  let setup = 'done'
  if (start || !settings.setupDone) {
    await openSetup(start)
    setup = [start?.step ?? 'welcome', start?.action].filter(Boolean).join(':')
  }
  $('open-settings').onclick = () => void openSetup({ step: 'settings' })
  renderNotice(saved)
  const ready = state.agents.filter((a) => a.installed && a.loggedIn).map((a) => a.id)
  // 화면이 실제로 그려진 뒤에 알린다
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dool2.ready(
    `agents=${state.agents.length} ready=${ready.join(',') || 'none'} threads=${state.threads.length} setup=${setup}`,
  )
}

main().catch((err: Error) => {
  document.body.textContent = `두리를 시작하지 못했어요: ${err.message}`
  window.dool2?.ready(`error=${err.message}`)
})
