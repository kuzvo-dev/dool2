// 두리 PC 앱 화면. dool2d 로컬 API(127.0.0.1 + 토큰)만 쓴다.
import type {
  AgentEvent,
  AgentId,
  AgentStatus,
  AiChoice,
  ApprovalRecordMessage,
  ApprovalView,
  ChromeStatus,
  DaemonStreamEvent,
  ExtensionStatus,
  HandoffRecord,
  LoginRecordMessage,
  LoginRequestView,
  Settings,
  StoredMessage,
  ThreadSummary,
  UsageLimit,
} from '@dool2/protocol'
import { appNote, type Inline, readAppNote, richBlocks, toolLabel } from './rich.js'
import { runSetup, type SetupOptions } from './setup.js'
import {
  type CheckAction,
  costLabel,
  neededAgents,
  planLabel,
  SETUP_STEPS,
  type SetupStep,
} from './setup-model.js'

declare global {
  interface Window {
    dool2: {
      config(): Promise<{
        url: string
        token: string
        smokeOpen?: string
        smokeSetup?: string
        smokeAsk?: string
        smokeAskWait?: number
      }>
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
  /** 첫 설정에서 고른 AI 구독 */
  choice?: AiChoice
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
  return { cls: 'ok', text: a.plan ? planLabel(a.plan) : '준비됨' }
}

/** 왼쪽 아래 연결 상태 한 줄. 할 일이 있으면 줄 전체가 버튼이 된다 */
function statRow(name: string, cls: string, meta: string, title: string, onClick?: () => void) {
  const row = document.createElement(onClick ? 'button' : 'div')
  row.className = 'stat'
  if (row instanceof HTMLButtonElement) {
    row.type = 'button'
    row.onclick = () => onClick?.()
  }
  row.title = title
  const dot = document.createElement('i')
  dot.className = `dot ${cls}`
  const n = document.createElement('span')
  n.className = 'name'
  n.textContent = name
  const m = document.createElement('span')
  m.className = cls === 'ok' ? 'meta' : 'meta warn'
  m.textContent = meta
  row.append(dot, n, m)
  return row
}

function renderAgents() {
  const box = $('agents')
  box.replaceChildren(
    // 깔려 있거나, 고른 구독에 필요한 AI만 보여 준다 (Claude만 고른 사람에게 "Codex 설치 필요"를 띄우지 않게).
    // 종량제 실행기는 준비한 사람에게만
    ...state.agents
      .filter((a) =>
        a.id === 'opencode'
          ? a.installed
          : a.installed || !state.choice || neededAgents(state.choice).includes(a.id),
      )
      .map((a) => {
        const s = agentState(a)
        const title =
          [a.version && `v${a.version}`, a.plan && `${planLabel(a.plan)} 구독`].filter(Boolean).join(' · ') ||
          s.text
        // 아직 없는 AI는 마법사의 설치 단계로, 로그인 안 된 AI는 로그인으로 바로 데려간다
        let onClick: (() => void) | undefined
        if (!a.installed && (a.id === 'claude' || a.id === 'codex')) {
          const which = a.id
          onClick = () => void openSetup({ step: 'check', choice: which, action: `${which}-install` })
        } else if (a.installed && !a.loggedIn) {
          onClick =
            a.id === 'codex'
              ? async () => {
                  await api('/api/agents/codex/login', { method: 'POST' }).catch(() => {})
                  await loadAgents()
                }
              : () => void openSetup({ step: 'check', choice: 'claude', action: 'claude-login' })
        }
        return statRow(AGENT_LABEL[a.id], s.cls, s.text, title, onClick)
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

/** 오늘이면 "오전 10:03", 아니면 "11. 14." */
function shortTime(iso: string) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

// ── 읽은 표시: 새로 끝난 일에 초록 점 ──────────────────
const SEEN_KEY = 'dool2.seen'
const seen: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null') ?? {}
  } catch {
    return {}
  }
})()
/** 처음 켠 PC에서는 지난 대화를 모두 읽은 걸로 둔다 */
const firstRun = localStorage.getItem(SEEN_KEY) === null
function markSeen(t: ThreadSummary) {
  seen[t.id] = t.updatedAt
  localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
}
const unread = (t: ThreadSummary) =>
  !t.busy && Boolean(t.preview) && t.id !== state.current?.id && (seen[t.id] ?? '') < t.updatedAt

/** 맡긴 일 카드의 상태 줄: "방금 끝났어요", "12분 전", "오전 10:03", "11. 14." */
function whenLabel(iso: string) {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (min < 2) return '방금 끝났어요'
  if (min < 60) return `${min}분 전`
  return shortTime(iso)
}

function renderThreads() {
  if (!state.threads.length) {
    const p = document.createElement('li')
    p.className = 'empty-list'
    p.textContent = '아직 맡긴 일이 없어요'
    $('threads').replaceChildren(p)
    return
  }
  $('threads').replaceChildren(
    ...state.threads.map((t) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('aria-current', String(t.id === state.current?.id))
      const title = document.createElement('span')
      title.className = 't'
      title.textContent = t.title
      // 오른쪽: 일하는 중이면 도는 원, 새로 끝났으면 초록 점, 아니면 시각
      const busy = t.busy || (state.busy && t.id === state.current?.id)
      const meta = document.createElement(busy || unread(t) ? 'i' : 'span')
      meta.className = busy ? 'spin' : t.approval ? 'dot warn' : unread(t) ? 'dot ok' : 'm'
      if (!busy && !unread(t) && !t.approval) meta.textContent = shortTime(t.updatedAt)
      b.title = `${t.title}\n${AGENT_LABEL[t.agent]} · ${new Date(t.updatedAt).toLocaleString('ko-KR')}`
      b.append(title, meta)
      b.onclick = () => void openThread(t.id)
      li.append(b)
      return li
    }),
  )
}

async function loadThreads() {
  state.threads = (await api<{ threads: ThreadSummary[] }>('/api/threads')).threads
  if (firstRun && !Object.keys(seen).length) for (const t of state.threads) markSeen(t)
  renderThreads()
  // 목록을 받는 사이 부탁을 보내기 시작했으면 홈을 다시 그리지 않는다 (대화 위에 홈이 끼어들어 대화를 지우던 버그)
  if (!state.current && !state.busy) renderHome()
}

// ── 홈: 부탁 칸과 최근에 맡긴 일 ─────────────────────

const EXAMPLES = ['내일 아침 우산 챙겨야 해?', '이번 주 택배 어디쯤 왔어?', '뭘 할 수 있어?']

/** 부탁 칸(form)을 홈의 가운데로, 대화에서는 아래로 옮긴다 */
let composerForm: HTMLElement | undefined
function placeComposer(home: boolean) {
  // 홈 화면을 지우면 부탁 칸도 문서에서 빠지므로 처음 찾은 걸 붙잡아 둔다
  composerForm ??= $('composer')
  const form = composerForm
  const main = document.querySelector('.main') as HTMLElement
  main.classList.toggle('home', home)
  if (home) $('home-ask')?.append(form)
  else if (form.parentElement !== main) main.append(form)
}

function taskCard(t: ThreadSummary): HTMLElement {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = t.approval ? 'task dark' : 'task'
  card.onclick = () => void openThread(t.id)
  const meta = document.createElement('div')
  meta.className = 'task-meta'
  const title = document.createElement('div')
  title.className = 'task-title'
  const body = document.createElement('p')
  body.className = 'task-body'
  if (t.approval) {
    const dot = document.createElement('i')
    dot.className = 'dot mint'
    meta.append(dot, '승인을 기다려요')
    title.textContent = [t.approval.what, t.approval.amount].filter(Boolean).join(' · ')
    body.textContent = `승인하시면 "${t.approval.label}"을(를) 눌러요`
    const go = document.createElement('span')
    go.className = 'btn-light'
    go.textContent = '확인하기'
    card.append(meta, title, body, go)
    return card
  }
  const busy = t.busy || (state.busy && t.id === state.current?.id)
  const when = document.createElement('span')
  when.textContent = busy ? '일하는 중' : whenLabel(t.updatedAt)
  meta.append(when)
  if (busy) {
    const spin = document.createElement('i')
    spin.className = 'spin'
    meta.append(spin)
  } else if (unread(t)) {
    const dot = document.createElement('i')
    dot.className = 'dot ok'
    meta.append(dot)
  }
  title.textContent = t.title
  body.textContent = t.preview ?? (busy ? '두리가 이 컴퓨터에서 하고 있어요' : '')
  card.append(meta, title, body)
  return card
}

/** 새 부탁 화면: 인사 → 부탁 칸 → 예시 → 최근에 맡긴 일 */
function renderHome() {
  const box = $('messages')
  let home = document.getElementById('home')
  if (!home) {
    home = document.createElement('div')
    home.id = 'home'
    home.className = 'home-view'
    const hero = document.createElement('div')
    hero.className = 'home-hero'
    const face = document.createElement('span')
    face.className = 'face'
    const h = document.createElement('p')
    h.className = 'hero'
    h.textContent = '오늘은 뭘 대신 해 드릴까요?'
    hero.append(face, h)
    const ask = document.createElement('div')
    ask.id = 'home-ask'
    const hint = document.createElement('p')
    hint.className = 'cap home-hint'
    hint.textContent = '돈 쓰는 일은 꼭 먼저 물어볼게요 · 폰에서 보낸 부탁도 여기서 이어서 해요'
    const examples = document.createElement('div')
    examples.className = 'examples'
    for (const ex of EXAMPLES) {
      const c = document.createElement('button')
      c.type = 'button'
      c.className = 'chip'
      c.textContent = ex
      c.onclick = () => void send(ex)
      examples.append(c)
    }
    const recent = document.createElement('section')
    recent.id = 'recent'
    recent.className = 'recent'
    home.append(hero, ask, hint, examples, recent)
    box.replaceChildren(home)
    placeComposer(true)
  }
  const recent = $('recent')
  const list = state.threads.slice(0, 3)
  if (!list.length) {
    recent.replaceChildren()
    return
  }
  const head = document.createElement('h2')
  head.className = 'over'
  head.textContent = '최근에 맡긴 일'
  const grid = document.createElement('div')
  grid.className = 'tasks'
  grid.append(...list.map(taskCard))
  recent.replaceChildren(head, grid)
}

async function openThread(id: string) {
  const { thread, messages } = await api<{ thread: ThreadSummary; messages: StoredMessage[] }>(
    `/api/threads/${id}`,
  )
  state.current = thread
  markSeen(state.threads.find((t) => t.id === id) ?? thread)
  setHeader()
  placeComposer(false)
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
    ...order.map(({ m, i }) => (m.role === 'tool' ? toolCard(m.text, i > lastUser) : bubble(m.role, m.text))),
  )
  box.scrollTop = box.scrollHeight
  renderThreads()
}

// ── 사람에게 넘기기 · 승인 요청 ──────────────────────

/** 대화 기록의 tool 메시지: 넘기기(handoff) 또는 승인 요청(approval) */
function toolCard(raw: string, active: boolean): Node {
  try {
    const rec = JSON.parse(raw) as { kind?: string }
    if (rec.kind === 'approval') return approvalCard(rec as ApprovalRecordMessage)
    if (rec.kind === 'login') return loginCard(rec as LoginRecordMessage)
  } catch {
    return document.createTextNode('')
  }
  return handoffCard(raw, active)
}

/** 선 아이콘 (24 격자) */
function svgIcon(d: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'i')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}
const ICON_LOCK = 'M6 11h12v9H6ZM8 11V8a4 4 0 0 1 8 0v3'
const ICON_GLOBE =
  'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9'
const ICON_EYE =
  'M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12ZM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5'

/**
 * 로그인 카드: 금고에 없는 사이트에서 두리가 아이디·비밀번호를 부탁할 때.
 * 넣은 값은 본체 금고(OS 키체인)로만 간다. AI·대화 기록에는 남지 않는다
 */
function loginCard(rec: LoginRecordMessage): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card login-card'
  const render = (r: LoginRequestView | undefined) => {
    if (!r || r.status !== 'pending') {
      card.className = 'card quiet login-card'
      const done = document.createElement('div')
      done.className = 'card-label'
      done.append(svgIcon(ICON_LOCK))
      done.append(
        r?.status === 'saved'
          ? `${r.site} 로그인 정보를 금고에 저장했어요${r.username ? ` · ${r.username}` : ''}`
          : `${rec.site || '사이트'} 로그인 요청이 끝났어요`,
      )
      card.replaceChildren(done)
      return
    }
    const head = document.createElement('div')
    head.className = 'login-head'
    const badge = document.createElement('span')
    badge.className = 'login-badge'
    badge.append(svgIcon(ICON_GLOBE))
    const title = document.createElement('div')
    const t = document.createElement('strong')
    t.textContent = `${r.site} 로그인`
    const host = document.createElement('span')
    host.className = 'mono'
    host.textContent = new URL(r.origin).host
    title.append(t, host)
    head.append(badge, title)
    const form = document.createElement('form')
    form.className = 'login-form'
    const user = document.createElement('input')
    user.className = 'field'
    user.placeholder = '아이디 또는 이메일'
    user.autocomplete = 'username'
    const pwRow = document.createElement('div')
    pwRow.className = 'pw-row'
    const pw = document.createElement('input')
    pw.className = 'field'
    pw.type = 'password'
    pw.placeholder = '비밀번호'
    pw.autocomplete = 'current-password'
    const eye = document.createElement('button')
    eye.type = 'button'
    eye.className = 'icon-btn'
    eye.setAttribute('aria-label', '비밀번호 보기')
    eye.append(svgIcon(ICON_EYE))
    eye.onclick = () => {
      pw.type = pw.type === 'password' ? 'text' : 'password'
    }
    pwRow.append(pw, eye)
    const err = document.createElement('p')
    err.className = 'login-error'
    const go = document.createElement('button')
    go.type = 'submit'
    go.className = 'btn'
    go.textContent = '로그인'
    form.append(user, pwRow, err, go)
    form.onsubmit = async (e) => {
      e.preventDefault()
      if (!user.value.trim() || !pw.value) {
        err.textContent = '아이디와 비밀번호를 모두 넣어 주세요'
        return
      }
      go.disabled = true
      go.textContent = '저장하는 중…'
      const res = await api<{ ok: boolean; message: string }>(`/api/logins/${encodeURIComponent(r.id)}`, {
        method: 'POST',
        body: JSON.stringify({ username: user.value.trim(), password: pw.value }),
      }).catch((x: Error) => ({ ok: false, message: x.message }))
      pw.value = ''
      if (!res.ok) {
        go.disabled = false
        go.textContent = '로그인'
        err.textContent = res.message
        return
      }
      render({ ...r, status: 'saved', username: user.value.trim() })
      // AI에게는 "저장됐어요"만 알린다. 값은 보내지 않는다
      void send(appNote(`${res.message} browser_login으로 채우고 로그인한 뒤 하던 일을 이어서 해 주세요.`))
    }
    const foot = document.createElement('p')
    foot.className = 'login-foot'
    foot.append(svgIcon(ICON_LOCK), '이 PC의 두리 금고에만 암호화해서 저장돼요. 두리(AI)는 볼 수 없어요.')
    card.replaceChildren(head, form, foot)
    setTimeout(() => user.focus(), 50)
  }
  void api<{ logins: LoginRequestView[] }>('/api/logins')
    .then(({ logins }) =>
      render(
        logins.filter((x) => x.tabId === rec.tabId).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0],
      ),
    )
    .catch(() => render(undefined))
  return card
}

const RISK_LABEL: Record<ApprovalView['kind'], string> = {
  money: '돈이 나가는 일',
  contact: '다른 사람에게 보내는 일',
  irreversible: '되돌릴 수 없는 일',
  app: '처음 다루는 PC 앱',
}

/**
 * 승인 카드 (M3). 누를 버튼·주소는 본체가 페이지에서 읽은 값, 무엇을·얼마는 AI가 적은 값이라
 * 실제 화면 캡처를 함께 보여 준다. 승인하면 본체가 그 버튼 하나만 누른다.
 */
function approvalCard(rec: ApprovalRecordMessage): HTMLElement {
  const card = document.createElement('div')
  card.className = 'approval'
  const title = document.createElement('strong')
  title.textContent = '승인을 기다려요'
  card.append(title)
  const body = document.createElement('div')
  body.className = 'approval-body'
  body.textContent = rec.what || '확인하는 중…'
  card.append(body)

  const fill = async () => {
    const { approvals } = await api<{ approvals: ApprovalView[] }>('/api/approvals').catch(() => ({
      approvals: [],
    }))
    const view = approvals
      .filter((x) => x.tabId === rec.tabId && x.ref === rec.ref)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
    render(view)
    if (view?.status === 'pending') {
      const { approval } = await api<{ approval: ApprovalView & { shot?: string } }>(
        `/api/approvals/${encodeURIComponent(view.id)}`,
      ).catch(() => ({ approval: undefined }))
      if (approval?.shot) {
        const img = document.createElement('img')
        img.className = 'approval-shot'
        img.alt = '승인할 화면'
        img.src = `data:image/jpeg;base64,${approval.shot}`
        // 카드가 길어지면 아래 버튼이 보이게 내려 준다
        img.onload = () => card.scrollIntoView({ block: 'end' })
        card.querySelector('.approval-rows')?.after(img)
      }
    }
  }

  const render = (v: ApprovalView | undefined) => {
    card.className = `approval ${v?.status ?? 'expired'}`
    if (!v) {
      title.textContent = '승인 요청이 끝났어요'
      body.textContent = `${rec.what} (두리를 다시 켜서 요청이 사라졌어요. 필요하면 다시 부탁해 주세요)`
      return
    }
    const host = (() => {
      try {
        return new URL(v.url).host
      } catch {
        return v.url
      }
    })()
    title.textContent =
      v.status === 'pending'
        ? '승인이 필요해요'
        : v.status === 'done'
          ? '승인해서 눌렀어요'
          : v.status === 'rejected'
            ? '거절했어요'
            : v.status === 'expired'
              ? '승인 시간이 지났어요'
              : v.status === 'failed'
                ? '누르지 못했어요'
                : '누르는 중이에요'
    if (v.status === 'pending') {
      const kind = document.createElement('span')
      kind.className = 'kind'
      kind.textContent = RISK_LABEL[v.kind]
      title.append(kind)
    }
    const rows = document.createElement('dl')
    rows.className = 'kv'
    const row = (k: string, val?: string, cls?: string) => {
      if (!val) return
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = val
      if (cls) dd.className = cls
      rows.append(dt, dd)
    }
    row('무엇을', v.what)
    row('어디서', v.where)
    row('주소', v.url.startsWith('app:') ? '' : host, 'host')
    row('얼마', v.amount, 'money')
    row('취소 조건', v.cancel)
    if (v.kind !== 'app') row('누를 버튼', `"${v.label}"`)
    body.replaceChildren(rows)
    if (v.result) {
      const p = document.createElement('p')
      p.className = 'cap'
      p.textContent = v.result
      body.append(p)
    }
    card.querySelector('.approval-actions')?.remove()
    if (v.status !== 'pending') return
    const note = document.createElement('p')
    note.className = 'cap'
    note.textContent =
      '화면과 내용이 맞는지 확인해 주세요. "얼마"·"무엇을"은 두리가 읽어 적은 것이라 틀릴 수 있어요. 승인하면 두리가 이 버튼 하나만 눌러요.'
    body.append(note)
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    const no = document.createElement('button')
    no.type = 'button'
    no.className = 'btn-ghost'
    no.textContent = '거절'
    const yes = document.createElement('button')
    yes.type = 'button'
    yes.className = 'btn'
    yes.textContent = v.kind === 'app' ? '허용하기' : `승인하고 "${v.label}" 누르기`
    const decide = async (decision: 'approve' | 'reject') => {
      yes.disabled = true
      no.disabled = true
      if (decision === 'approve') yes.textContent = '누르는 중…'
      const r = await api<{ ok: boolean; message: string }>(`/api/approvals/${encodeURIComponent(v.id)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }).catch((e: Error) => ({ ok: false, message: e.message }))
      card.querySelector('.approval-shot')?.remove()
      await fill()
      // AI에게 결과를 알려 이어서 하게 한다
      void send(
        decision === 'reject'
          ? appNote(`"${v.label}"은(는) 거절했어요. 누르지 말아 주세요.`)
          : appNote(`${r.message} 결과를 확인하고 이어서 해 주세요.`),
      )
    }
    no.onclick = () => void decide('reject')
    yes.onclick = () => void decide('approve')
    actions.append(no, yes)
    card.append(actions)
  }
  void fill()
  return card
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
  const ext = state.extension
  $('browser').replaceChildren(
    ext?.connected
      ? statRow(
          'Chrome 확장',
          'ok',
          '연결됨',
          [ext.browser, ext.version && `확장 v${ext.version}`].filter(Boolean).join(' · '),
        )
      : statRow(
          'Chrome 확장',
          'warn',
          '연결하기',
          '웹 일을 하려면 연결해 주세요',
          () => void openSetup({ step: 'check', action: 'extension-install' }),
        ),
  )
}

async function loadExtension() {
  const { extension } = await api<{ extension: ExtensionStatus }>('/api/browser/extension')
  const changed = JSON.stringify(extension) !== JSON.stringify(state.extension)
  state.extension = extension
  if (changed) renderBrowser()
  return extension
}

function setHeader() {
  $('title').textContent = state.current?.title ?? '새 부탁'
  $('subtitle').textContent = state.current ? AGENT_LABEL[state.current.agent] : ''
  $('agent-pick').hidden = Boolean(state.current)
}

// ── 메시지 ───────────────────────────────────────────

/** 말풍선. 두리 답은 문단·목록·**굵게**만 그린다 (HTML로 해석하지 않는다) */
function bubble(role: string, text: string) {
  const el = document.createElement('div')
  el.className = role === 'assistant' ? 'msg assistant rich' : `msg ${role}`
  setRich(el, text)
  return el
}

function setRich(el: HTMLElement, text: string) {
  // 내가 쓴 말은 적은 그대로, 두리 앱이 대신 보낸 알림(승인 결과)은 가운데 알림 줄로
  if (el.classList.contains('user')) {
    const note = readAppNote(text)
    if (note !== undefined) el.className = 'msg note'
    el.textContent = note ?? text
    return
  }
  const spans = (parent: HTMLElement, parts: Inline[]) => {
    for (const part of parts) {
      if (part.bold) {
        const b = document.createElement('strong')
        b.textContent = part.text
        parent.append(b)
      } else parent.append(part.text)
    }
  }
  el.replaceChildren(
    ...richBlocks(text).map((block) => {
      if (block.type === 'p') {
        const p = document.createElement('p')
        block.lines.forEach((line, i) => {
          if (i) p.append(document.createElement('br'))
          spans(p, line)
        })
        return p
      }
      const list = document.createElement(block.type)
      if (block.type === 'ol' && block.start !== 1) (list as HTMLOListElement).start = block.start
      for (const item of block.items) {
        const li = document.createElement('li')
        spans(li, item)
        list.append(li)
      }
      return list
    }),
  )
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
  // 홈에서 보내면 대화 화면으로 바뀐다
  // 홈만 걷어 낸다 (대화 내용은 건드리지 않는다)
  if (document.getElementById('home')) {
    placeComposer(false)
    document.getElementById('home')?.remove()
  }

  try {
    if (!state.current) {
      const { thread } = await api<{ thread: ThreadSummary }>('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ agent: state.pick }),
      })
      // 제목은 본체가 첫 답 뒤에 정한다. 그 전까지는 부탁 글로 보여 주고, 왼쪽 목록 맨 위에 바로 넣는다
      state.current = {
        ...thread,
        title: text.trim().split('\n')[0]?.slice(0, 60) || thread.title,
        busy: true,
      }
      state.threads = [state.current, ...state.threads.filter((t) => t.id !== thread.id)]
      setHeader()
    }
    // 새로 부탁하면 이전 "직접 해 주세요" 카드의 버튼은 거둔다
    box.querySelectorAll('.handoff.active').forEach((c) => {
      c.classList.remove('active')
      c.querySelector('.handoff-actions')?.remove()
    })
    box.append(bubble('user', text))
    renderThreads()
    // 일하는 중: 지금 하는 일(빛) + 한 일 목록. 끝나면 "한 일 N가지"로 접는다
    const work = document.createElement('div')
    work.className = 'work'
    const workHead = document.createElement('div')
    workHead.className = 'work-head'
    const spin = document.createElement('i')
    spin.className = 'spin'
    const activity = document.createElement('span')
    activity.className = 'activity shimmer'
    activity.textContent = '두리가 생각하는 중…'
    const clock = document.createElement('span')
    clock.className = 'work-time'
    workHead.append(spin, activity, clock)
    const log = document.createElement('ul')
    log.className = 'worklog'
    work.append(workHead, log)
    box.append(work)
    const started = Date.now()
    const elapsed = () => {
      const sec = Math.floor((Date.now() - started) / 1000)
      return sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`
    }
    const tick = setInterval(() => {
      clock.textContent = elapsed()
    }, 1000)
    const step = (label: string) => {
      const now = log.querySelector('li.now')
      if (now?.textContent === label) return
      now?.classList.replace('now', 'done')
      const li = document.createElement('li')
      li.className = 'now'
      li.textContent = label
      log.append(li)
      activity.textContent = `${label}…`
    }
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
          box.append(answer)
        }
        setRich(answer, answerText)
      } else if (ev.type === 'tool') step(`${toolLabel(ev.name)} 중`)
      else if (ev.type === 'tool_result') activity.textContent = '정리하는 중…'
      else if (ev.type === 'usage') renderUsage(ev.limits)
      else if (ev.type === 'cost') usd += ev.usd
      else if (ev.type === 'error' || ev.type === 'limit_reached') box.append(bubble('system', ev.message))
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
    clearInterval(tick)
    // 한 일이 있으면 접어서 남기고, 없으면 지운다
    const steps = [...log.querySelectorAll('li')]
    if (steps.length) {
      for (const li of steps) li.className = 'done'
      const done = document.createElement('details')
      done.className = 'work done'
      const summary = document.createElement('summary')
      summary.textContent = `한 일 ${steps.length}가지 · ${elapsed()}`
      done.append(summary, log)
      work.replaceWith(done)
    } else work.remove()
    if (handoff) {
      box.append(toolCard(handoff, true))
      try {
        const rec = JSON.parse(handoff) as HandoffRecord | ApprovalRecordMessage | LoginRecordMessage
        notifyHandoff(
          rec.kind === 'approval'
            ? `승인을 기다려요: ${rec.what}`
            : rec.kind === 'login'
              ? `${rec.site} 로그인 정보를 넣어 주세요`
              : rec.reason,
        )
      } catch {}
    }
    if (usd > 0) {
      const cost = document.createElement('p')
      cost.className = 'cost'
      cost.textContent = `이번 답 ${costLabel(usd)}`
      box.append(cost)
    }
  } catch (err) {
    box.querySelector('.work:not(.done)')?.remove()
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
  $('new-thread').onclick = () => {
    if (state.busy) return
    state.current = undefined
    setHeader()
    placeComposer(false)
    $('messages').replaceChildren()
    renderHome()
    renderThreads()
    input.focus()
  }
  renderHome()

  const [{ settings }] = await Promise.all([
    api<{ settings: Settings }>('/api/settings'),
    loadAgents(),
    loadThreads(),
    loadExtension().catch(() => undefined),
  ])
  if (settings.aiChoice) state.choice = settings.aiChoice
  renderAgents()
  renderBrowser()
  // 확장이 붙고 떨어지는 걸 왼쪽에 보여 준다
  // 폰에서 맡긴 일도 목록·홈에 보이게 맡긴 일을 같이 새로 본다
  setInterval(() => {
    void loadExtension().catch(() => {})
    if (!state.busy) void loadThreads().catch(() => {})
  }, 5_000)
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
      if (saved.aiChoice) state.choice = saved.aiChoice
      renderAgents()
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
  if (cfg.smokeAsk) {
    const done = send(cfg.smokeAsk)
    if (cfg.smokeAskWait) await new Promise((r) => setTimeout(r, cfg.smokeAskWait))
    else await done
  }
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
