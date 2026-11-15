// 두리 PC 앱 화면. dool2d 로컬 API(127.0.0.1 + 토큰)만 쓴다.
// 대화는 하나 (ADR 0015): 왼쪽 메뉴 / 가운데 대화 / 오른쪽 두리의 화면 (docs/design/screens/pc-*.png)
import type {
  AgentEvent,
  AgentId,
  AgentStatus,
  AiChoice,
  ApprovalRecordMessage,
  ApprovalView,
  ChromeStatus,
  ConversationLiveEvent,
  ConversationState,
  ExtensionStatus,
  HandoffRecord,
  LoginRecordMessage,
  LoginRequestView,
  Settings,
  StoredMessage,
  UsageLimit,
} from '@dool2/protocol'
import { renderConnections } from './connections.js'
import { appNote, type Inline, narrationLine, readAppNote, richBlocks, toolLabel } from './rich.js'
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
const EXAMPLES = ['내일 아침 우산 챙겨야 해?', '이번 주 택배 어디쯤 왔어?', '뭘 할 수 있어?']

type View = 'talk' | 'tasks' | 'explore' | 'me'

/** 지금 돌고 있는 차례 (오른쪽 두리의 화면과 대화 아래 "일하는 중"에 보인다) */
interface Turn {
  ask: string
  started: number
  steps: string[]
  activity: string
  text: string
  usd: number
  /** 이번 차례에 나온 넘기기·승인·로그인 기록 (답 아래에 카드로) */
  records: string[]
}

const state: {
  url: string
  token: string
  agents: AgentStatus[]
  extension?: ExtensionStatus
  /** 첫 설정에서 고른 AI 구독 */
  choice?: AiChoice
  view: View
  messages: StoredMessage[]
  hasMore: boolean
  busy: boolean
  queued: string[]
  turn?: Turn
  /** 마지막으로 끝난 차례 (쉬는 동안 오른쪽에 남겨 둔다) */
  lastTurn?: { ask: string; steps: string[]; seconds: number }
  approvals: ApprovalView[]
  logins: LoginRequestView[]
} = {
  url: '',
  token: '',
  agents: [],
  view: 'talk',
  messages: [],
  hasMore: false,
  busy: false,
  queued: [],
  approvals: [],
  logins: [],
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  e.append(...children)
  return e
}

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

/** 선 아이콘 (24 격자) */
function svgIcon(d: string, cls = 'i'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
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
const ICON_CHECK = 'M5 12.5l4.5 4.5L19 7.5'
const ICON_CHEVRON = 'M9 6l6 6-6 6'

const doori = (mood = '', size?: number) => {
  const d = el('span', `doori ${mood}`.trim())
  d.setAttribute('aria-hidden', 'true')
  if (size) d.style.setProperty('--s', `${size}px`)
  return d
}

/** 움직이는 3D 두리 (packages/ui/doori3d.js를 빌드가 따로 묶은 파일) */
interface LiveDoori {
  setMood(mood: string): void
}
type Doori3d = { mountDoori(host: HTMLElement, opts: { mood?: string }): LiveDoori }
const DOORI3D = './doori3d.js' // 글자로 넘겨야 화면 코드와 따로 불러온다
let doori3dModule: Promise<Doori3d> | undefined
const liveSlots = new Map<string, { el: HTMLElement; mood: string; live?: LiveDoori }>()

/** 큰 자리의 두리: 먼저 그림을 보이고 3D가 준비되면 움직인다. 자리마다 캔버스 하나를 옮겨 쓴다 */
const liveDoori = (slot: string, mood: string, size: number) => {
  const hit = liveSlots.get(slot)
  if (hit) {
    if (hit.mood !== mood) {
      hit.mood = mood
      hit.el.classList.remove('thinking', 'working', 'asking', 'done', 'sleeping')
      if (mood) hit.el.classList.add(mood)
      hit.live?.setMood(mood || 'idle')
    }
    hit.el.style.setProperty('--s', `${size}px`)
    return hit.el
  }
  const d = doori(mood, size)
  const rec: { el: HTMLElement; mood: string; live?: LiveDoori } = { el: d, mood }
  liveSlots.set(slot, rec)
  doori3dModule ??= import(DOORI3D) as Promise<Doori3d>
  doori3dModule
    .then((m) => {
      rec.live = m.mountDoori(d, { mood: rec.mood || 'idle' })
      d.classList.add('live-ready')
    })
    .catch(() => {
      // 3D를 못 쓰면 그림 그대로
    })
  return d
}

// ── 시각 ─────────────────────────────────────────────

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

/** 날짜 나눔: 오늘 / 어제 / 11월 14일 (금) */
function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return '오늘'
  if (d.toDateString() === yesterday.toDateString()) return '어제'
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
}

const elapsed = (sec: number) =>
  sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`

// ── 연결 상태 (나의 두리, 왼쪽 아래 이 컴퓨터) ─────────

function agentState(a: AgentStatus): { cls: string; text: string } {
  if (!a.installed) return { cls: 'stop', text: '설치 필요' }
  if (!a.loggedIn) return { cls: 'ask', text: '로그인 필요' }
  return { cls: 'work', text: a.plan ? planLabel(a.plan) : '준비됨' }
}
const readyAgents = () => state.agents.filter((a) => a.installed && a.loggedIn)

/** 첫 실행 마법사를 연다 (main에서 채운다) */
let openSetup: (start?: SetupOptions['start']) => Promise<void> = async () => {}

/** 연결 상태 한 줄. 할 일이 있으면 줄 전체가 버튼이 된다 */
function statRow(name: string, cls: string, meta: string, title: string, onClick?: () => void) {
  const row = el(onClick ? 'button' : 'div', 'row stat')
  if (row instanceof HTMLButtonElement) {
    row.type = 'button'
    row.onclick = () => onClick?.()
  }
  row.title = title
  const dot = el('i', `dot ${cls}`)
  const text = el('div', 'grow', el('p', 'row-t', name))
  const m = el('span', cls === 'work' ? 'meta' : 'meta need', meta)
  row.append(dot, text, m)
  if (onClick) row.append(svgIcon(ICON_CHEVRON))
  return row
}

function agentRows() {
  return state.agents
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
    })
}

function extensionRow() {
  const ext = state.extension
  return ext?.connected
    ? statRow(
        'Chrome 확장',
        'work',
        '연결됨',
        [ext.browser, ext.version && `확장 v${ext.version}`].filter(Boolean).join(' · '),
      )
    : statRow(
        'Chrome 확장',
        'ask',
        '연결하기',
        '웹 일을 하려면 연결해 주세요',
        () => void openSetup({ step: 'check', action: 'extension-install' }),
      )
}

/** 왼쪽 아래 이 컴퓨터 + 왼쪽 위 자가 점검 알림 */
function renderDevice(settings?: Settings) {
  const ready = readyAgents().length > 0
  const status = $('device-status')
  status.replaceChildren(
    el('i', `dot ${ready ? 'work' : ''}`),
    ready ? (state.extension?.connected ? '켜져 있어요' : '켜져 있어요 · 웹 연결 필요') : '일할 AI가 없어요',
  )
  if (!settings) return
  const box = $('notice')
  box.hidden = !settings.setupDone || ready
  if (box.hidden) return
  const fix = el('button', 'btn-small', '고치기')
  fix.type = 'button'
  fix.onclick = () => void openSetup({ step: 'settings' })
  box.replaceChildren(el('span', 'notice-text', '두리가 일할 AI가 연결돼 있지 않아요'), fix)
}

async function loadAgents() {
  const { agents } = await api<{ agents: AgentStatus[] }>('/api/agents')
  state.agents = agents
  renderDevice()
  renderHead()
  if (state.view === 'me') renderMe()
}

async function loadExtension() {
  const { extension } = await api<{ extension: ExtensionStatus }>('/api/browser/extension')
  const changed = JSON.stringify(extension) !== JSON.stringify(state.extension)
  state.extension = extension
  if (changed) {
    renderDevice()
    if (state.view === 'me') renderMe()
  }
  return extension
}

/** 기다리는 승인·로그인 (왼쪽 "지금", 오른쪽 "다음 차례", 맡긴 일) */
async function loadWaiting() {
  const [{ approvals }, { logins }] = await Promise.all([
    api<{ approvals: ApprovalView[] }>('/api/approvals'),
    api<{ logins: LoginRequestView[] }>('/api/logins'),
  ])
  const changed = JSON.stringify([approvals, logins]) !== JSON.stringify([state.approvals, state.logins])
  state.approvals = approvals
  state.logins = logins
  if (!changed) return
  renderNow()
  renderPanel()
  renderHead()
  if (state.view === 'tasks') renderTasks()
}
const pendingApprovals = () => state.approvals.filter((a) => a.status === 'pending')
const pendingLogins = () => state.logins.filter((l) => l.status === 'pending')

// ── 머리: 두리 표정 + 상태 한 줄 ───────────────────────

function renderHead() {
  if (state.view !== 'talk') return
  const face = $('head-face')
  const sub = $('subtitle')
  $('title').textContent = '두리'
  const waiting = pendingApprovals().length + pendingLogins().length
  let mood = ''
  let dot = 'dot'
  let line = ''
  let live = false
  if (state.busy) {
    mood = 'working'
    dot = 'dot work pulse'
    line = state.turn?.activity && state.turn.steps.length ? state.turn.activity : '이 컴퓨터에서 일하는 중'
    live = true
  } else if (waiting) {
    mood = 'asking'
    dot = 'dot ask'
    line = '승인을 기다려요'
  } else if (!readyAgents().length && state.agents.length) {
    mood = 'sleeping'
    line = '일할 AI가 연결돼 있지 않아요'
  } else {
    dot = 'dot work'
    line = '이 컴퓨터에 연결돼 있어요'
  }
  face.className = `doori ${mood}${state.busy ? ' bob' : ''}`
  sub.className = live ? 'meta live' : 'meta'
  sub.replaceChildren(el('i', dot), line)
}

function setHeader(title: string, sub: string) {
  $('title').textContent = title
  $('subtitle').className = 'meta'
  $('subtitle').textContent = sub
  $('head-face').className = 'doori'
}

function renderUsage(limits: UsageLimit[]) {
  const box = $('usage')
  box.hidden = limits.length === 0
  box.replaceChildren(
    ...limits.map((l) => {
      const fill = el('i', l.percent >= 80 ? 'hi' : '')
      fill.style.width = `${Math.min(100, l.percent)}%`
      return el(
        'div',
        'u',
        el('span', '', `${LIMIT_LABEL[l.kind] ?? l.kind} 사용량 ${l.percent}%`),
        el('div', 'bar', fill),
      )
    }),
  )
}

// ── 왼쪽 "지금" ──────────────────────────────────────

function renderNow() {
  const items: HTMLElement[] = []
  if (state.busy && state.turn) {
    const b = el(
      'button',
      'livebar',
      el('i', 'dot work pulse'),
      el(
        'span',
        'grow',
        el('b', '', cut(state.turn.ask, 18)),
        el('br'),
        el('span', 'meta', state.turn.steps.length ? state.turn.activity : '생각하는 중'),
      ),
    )
    b.type = 'button'
    b.onclick = () => void show('talk')
    items.push(b)
  }
  for (const a of pendingApprovals()) {
    const b = el(
      'button',
      'livebar ask',
      el('i', 'dot ask'),
      el(
        'span',
        'grow',
        el('b', '', cut(a.what || '승인', 18)),
        el('br'),
        el('span', 'meta mono', a.amount ?? a.label),
      ),
      svgIcon(ICON_CHEVRON),
    )
    b.type = 'button'
    b.onclick = () =>
      void show('talk').then(() => document.querySelector('.approve')?.scrollIntoView({ block: 'center' }))
    items.push(b)
  }
  for (const l of pendingLogins()) {
    const b = el(
      'button',
      'livebar ask',
      el('i', 'dot ask'),
      el(
        'span',
        'grow',
        el('b', '', `${l.site} 로그인`),
        el('br'),
        el('span', 'meta', '아이디·비밀번호가 필요해요'),
      ),
      svgIcon(ICON_CHEVRON),
    )
    b.type = 'button'
    b.onclick = () => void show('talk')
    items.push(b)
  }
  $('now').hidden = items.length === 0
  $('now-list').replaceChildren(...items)
  const count = pendingApprovals().length + pendingLogins().length
  $('tasks-count').hidden = count === 0
  $('tasks-count').textContent = String(count)
}

// ── 오른쪽 두리의 화면 ─────────────────────────────────

function renderPanel() {
  $('stop').hidden = !state.busy
  const work = $('work')
  const t = state.turn
  if (state.busy && t) {
    const head = el(
      'div',
      'workcard-head',
      el('b', '', cut(t.ask, 24)),
      el('span', '', t.steps.length ? t.activity : '생각하는 중'),
    )
    const log = el('ul', 'worklog')
    t.steps.forEach((s, i) => {
      log.append(el('li', i === t.steps.length - 1 ? 'now' : 'done', s))
    })
    if (!t.steps.length) log.append(el('li', 'now', '무엇부터 할지 정하는 중'))
    log.append(el('li', 'next', '돈 드는 일은 먼저 물어볼게요'))
    const clock = el('span', 'meta', elapsed(Math.floor((Date.now() - t.started) / 1000)))
    clock.id = 'work-clock'
    work.replaceChildren(
      el('article', 'workcard', head, el('div', 'panel-log', log), el('div', 'workcard-foot', clock)),
    )
  } else if (state.lastTurn?.steps.length) {
    const lt = state.lastTurn
    const log = el('ul', 'worklog')
    for (const s of lt.steps) log.append(el('li', 'done', s))
    work.replaceChildren(
      el(
        'article',
        'workcard quiet',
        el('div', 'workcard-head', el('b', '', cut(lt.ask, 24)), el('span', 'done-label', '끝났어요')),
        el('div', 'panel-log', log),
        el(
          'div',
          'workcard-foot',
          el('span', 'meta', `한 일 ${lt.steps.length}가지 · ${elapsed(lt.seconds)}`),
        ),
      ),
    )
  } else {
    work.replaceChildren(
      el(
        'div',
        'panel-empty',
        doori('', 48),
        el('p', 'cap', '지금은 쉬고 있어요. 부탁하면 두리가 이 컴퓨터에서 하는 일을 여기서 보여 드릴게요.'),
      ),
    )
  }

  // 다음 차례: 기다리는 승인·로그인, 줄 선 말
  const next: HTMLElement[] = []
  for (const a of pendingApprovals())
    next.push(
      el(
        'div',
        'row',
        svgIcon('M3 4h2l2.4 11h10.2L20 7H6.2M9 19.5h.01M17 19.5h.01', 'i md'),
        el(
          'div',
          'grow',
          el('p', 'row-t', a.what || a.label),
          el('p', 'row-d mono', a.amount ?? a.where ?? ''),
        ),
        el('span', 'pill ask', '승인 대기'),
      ),
    )
  for (const l of pendingLogins())
    next.push(
      el(
        'div',
        'row',
        svgIcon(ICON_LOCK, 'i md'),
        el('div', 'grow', el('p', 'row-t', `${l.site} 로그인`)),
        el('span', 'pill ask', '입력 대기'),
      ),
    )
  for (const q of state.queued)
    next.push(
      el(
        'div',
        'row',
        svgIcon('M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z', 'i md'),
        el('div', 'grow', el('p', 'row-t', cut(q, 40)), el('p', 'row-d', '지금 일이 끝나면 이어서 볼게요')),
      ),
    )
  $('next').replaceChildren(...(next.length ? [el('p', 'meta panel-label', '다음 차례'), ...next] : []))
}

// ── 대화 ─────────────────────────────────────────────

/** 대화 기록을 받아 다시 그린다 */
async function loadConversation() {
  const s = await api<ConversationState>('/api/conversation?limit=150')
  state.messages = s.messages
  state.hasMore = s.hasMore
  state.queued = s.queued
  state.busy = s.busy || state.busy
  if (state.view === 'talk') renderTalk()
  renderPanel()
}

function renderTalk() {
  const box = $('messages')
  const main = document.querySelector('.main') as HTMLElement
  main.classList.remove('panel-view')
  main.classList.toggle('empty', !state.messages.length && !state.busy)
  renderHead()
  if (!state.messages.length && !state.busy) {
    box.replaceChildren(emptyView())
    return
  }
  const list = el('div', 'thread')
  // 사람에게 넘긴 뒤 아직 사용자가 답하지 않았으면 [다 했어요]를 살려 둔다
  const lastUser = state.messages.map((m) => m.role).lastIndexOf('user')
  // 넘기기·승인 기록은 답보다 먼저 저장되지만, 화면에서는 그 답 아래에 둔다
  const order = state.messages.map((m, i) => ({ m, i }))
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k]
    const b = order[k + 1]
    if (a && b && a.m.role === 'tool' && b.m.role === 'assistant') {
      order[k] = b
      order[k + 1] = a
      k++
    }
  }
  let day = ''
  let prevRole = ''
  for (const { m, i } of order) {
    const d = dayLabel(m.createdAt)
    if (d !== day) {
      day = d
      list.append(el('div', 'sep', d))
      prevRole = ''
    }
    if (m.role === 'tool') {
      list.append(toolCard(m.text, i > lastUser))
      continue
    }
    const note = m.role === 'user' ? readAppNote(m.text) : undefined
    if (m.role === 'assistant' && prevRole !== 'assistant') list.append(who(m.createdAt))
    list.append(messageEl(m.role, m.text, note))
    prevRole = note !== undefined ? 'note' : m.role
  }
  const live = el('div', 'live')
  live.id = 'live'
  box.replaceChildren(list, live)
  renderLive()
  box.scrollTop = box.scrollHeight
}

function who(iso: string) {
  return el('div', 'who', doori(''), '두리', el('span', 'meta', hhmm(iso)))
}

/** 말 하나. 두리 답은 문단·목록·**굵게**만 그린다 (HTML로 해석하지 않는다) */
function messageEl(role: string, text: string, note?: string): HTMLElement {
  if (role === 'user') {
    if (note !== undefined) return el('p', 'msg note', note)
    return el('div', 'bubble me', text)
  }
  if (role === 'system') return el('p', 'sysline', el('i', 'dot stop'), text)
  const b = el('div', 'bubble rich')
  setRich(b, text)
  return b
}

function setRich(target: HTMLElement, text: string) {
  const spans = (parent: HTMLElement, parts: Inline[]) => {
    for (const part of parts) parent.append(part.bold ? el('strong', '', part.text) : part.text)
  }
  target.replaceChildren(
    ...richBlocks(text).map((block) => {
      if (block.type === 'p') {
        const p = el('p')
        block.lines.forEach((line, i) => {
          if (i) p.append(el('br'))
          spans(p, line)
        })
        return p
      }
      const list = el(block.type)
      if (block.type === 'ol' && block.start !== 1) (list as HTMLOListElement).start = block.start
      for (const item of block.items) {
        const li = el('li')
        spans(li, item)
        list.append(li)
      }
      return list
    }),
  )
}

/** 대화 아래: 지금 답하는 중인 말 + "일하는 중" 한 줄 + 줄 선 말 */
function renderLive() {
  const live = document.getElementById('live')
  if (!live) return
  const parts: HTMLElement[] = []
  const t = state.turn
  if (state.busy && t) {
    if (t.text) {
      const b = el('div', 'bubble rich')
      setRich(b, t.text)
      parts.push(who(new Date().toISOString()), b)
    }
    parts.push(
      el(
        'div',
        'working',
        el('span', 'spin'),
        el('span', 'shimmer', t.steps.length ? `${t.activity}…` : '생각하는 중…'),
      ),
    )
  } else if (state.busy) {
    parts.push(el('div', 'working', el('span', 'spin'), el('span', 'shimmer', '두리가 일하는 중…')))
  }
  for (const q of state.queued)
    parts.push(el('div', 'bubble me queued', q), el('p', 'queued-note meta', '이어서 말할게요'))
  live.replaceChildren(...parts)
}

function emptyView() {
  const chips = el('div', 'chips')
  for (const ex of EXAMPLES) {
    const c = el('button', 'chip', ex)
    c.type = 'button'
    c.onclick = () => void send(ex)
    chips.append(c)
  }
  return el(
    'div',
    'empty-view',
    liveDoori('home', '', 120),
    el('p', 'title-2', '오늘은 뭘 대신 해 드릴까요?'),
    el('p', 'cap', '돈 쓰는 일은 꼭 먼저 물어볼게요 · 폰에서 한 말도 여기 이어져요'),
    chips,
  )
}

// ── 실시간: 어디서 시작한 차례든 (GET /api/conversation/live) ──

function onLive(ev: ConversationLiveEvent) {
  if (ev.kind === 'busy') {
    const was = state.busy
    state.busy = ev.busy
    if (ev.busy && !was && !state.turn) state.turn = newTurn('')
    renderHead()
    renderNow()
    renderPanel()
    if (state.view === 'talk') renderLive()
    return
  }
  if (ev.kind === 'queued') {
    state.queued = ev.texts
    renderPanel()
    if (state.view === 'talk') renderLive()
    return
  }
  const e = ev.event
  if (e.type === 'saved') {
    const m = e.message
    if (m.role === 'tool') {
      state.turn?.records.push(m.text)
      return
    }
    if (m.role === 'user') {
      // 새 차례의 시작: 오른쪽에 무엇을 부탁했는지 보인다
      const note = readAppNote(m.text)
      state.turn = { ...(state.turn ?? newTurn('')), ask: note ?? m.text }
    }
    if (m.role === 'assistant' && state.turn) state.turn.text = ''
    state.messages.push(m)
    if (state.view === 'talk') appendSaved(m)
    renderNow()
    renderPanel()
    return
  }
  if (e.type === 'agent') onAgent(e.event)
  if (e.type === 'end') void finishTurn()
}

function newTurn(ask: string): Turn {
  return { ask, started: Date.now(), steps: [], activity: '', text: '', usd: 0, records: [] }
}

function onAgent(ev: AgentEvent) {
  if (!state.turn) state.turn = newTurn('')
  const t = state.turn
  if (ev.type === 'text') {
    t.text += ev.delta
    if (state.view === 'talk') renderLive()
    scrollDown()
    return
  }
  if (ev.type === 'tool') {
    // 도구 앞에 한 말은 답이 아니라 지금 하는 일. 한국어 한 줄만 단계로 남기고 흘러오던 말은 비운다
    const label = narrationLine(t.text) ?? `${toolLabel(ev.name)} 중`
    t.text = ''
    if (t.steps.at(-1) !== label) t.steps.push(label)
    t.activity = label
  } else if (ev.type === 'tool_result') t.activity = '정리하는 중'
  else if (ev.type === 'usage') renderUsage(ev.limits)
  else if (ev.type === 'cost') t.usd += ev.usd
  else return
  renderHead()
  renderNow()
  renderPanel()
  if (state.view === 'talk') renderLive()
}

/** 저장된 말 하나를 대화 끝에 붙인다 (다시 그리지 않고) */
function appendSaved(m: StoredMessage) {
  const list = document.querySelector('#messages .thread')
  if (!list) {
    renderTalk()
    return
  }
  const prev = state.messages.at(-2)
  if (!prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt))
    list.append(el('div', 'sep', dayLabel(m.createdAt)))
  // 새로 부탁하면 이전 "직접 해 주세요" 카드의 버튼은 거둔다
  if (m.role === 'user') for (const x of list.querySelectorAll('.handoff-actions')) x.remove()
  const note = m.role === 'user' ? readAppNote(m.text) : undefined
  if (m.role === 'assistant' && prev?.role !== 'assistant') list.append(who(m.createdAt))
  list.append(messageEl(m.role, m.text, note))
  renderLive()
  scrollDown()
}

async function finishTurn() {
  const t = state.turn
  state.turn = undefined
  if (t) {
    state.lastTurn = { ask: t.ask, steps: t.steps, seconds: Math.floor((Date.now() - t.started) / 1000) }
    for (const raw of t.records) notifyRecord(raw)
  }
  await loadConversation().catch(() => {})
  await loadWaiting().catch(() => {})
  if (t && t.usd > 0 && state.view === 'talk')
    document.querySelector('#messages .thread')?.append(el('p', 'cost meta', `이번 답 ${costLabel(t.usd)}`))
  renderNow()
  renderPanel()
}

function scrollDown() {
  const box = $('messages')
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight
}

/** 창이 뒤에 있으면 알림으로도 알린다 */
function notifyRecord(raw: string) {
  if (document.hasFocus()) return
  try {
    const rec = JSON.parse(raw) as HandoffRecord | ApprovalRecordMessage | LoginRecordMessage
    const body =
      rec.kind === 'approval'
        ? `승인을 기다려요: ${rec.what}`
        : rec.kind === 'login'
          ? `${rec.site} 로그인 정보를 넣어 주세요`
          : rec.reason
    new Notification('두리가 도움을 기다려요', { body })
  } catch {}
}

/** 실시간 연결. 끊기면 다시 잇는다 */
async function connectLive() {
  for (;;) {
    try {
      const res = await fetch(`${state.url}/api/conversation/live`, {
        headers: { authorization: `Bearer ${state.token}` },
      })
      if (!res.body) throw new Error('no body')
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        let i = buf.indexOf('\n\n')
        while (i >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) onLive(JSON.parse(chunk.slice(6)) as ConversationLiveEvent)
          i = buf.indexOf('\n\n')
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
    await loadConversation().catch(() => {})
  }
}

/** 말 하나를 보낸다. 두리가 답하는 중이면 본체가 줄을 세웠다가 이어서 전한다 */
async function send(text: string) {
  if (!text.trim()) return
  if (state.view !== 'talk') await show('talk')
  try {
    await api<{ queued: boolean }>('/api/conversation/messages', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  } catch (err) {
    document
      .querySelector('#messages .thread')
      ?.append(el('p', 'sysline', el('i', 'dot stop'), (err as Error).message))
  }
}

// ── 대화 안의 카드: 승인 · 로그인 · 직접 해 주세요 ─────

/** 대화 기록의 tool 메시지: 넘기기(handoff), 승인 요청(approval), 로그인(login) */
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

/**
 * 로그인 카드: 금고에 없는 사이트에서 두리가 아이디·비밀번호를 부탁할 때.
 * 넣은 값은 본체 금고(OS 키체인)로만 간다. AI·대화 기록에는 남지 않는다
 */
function loginCard(rec: LoginRecordMessage): HTMLElement {
  const card = el('div', 'card login-card')
  const render = (r: LoginRequestView | undefined) => {
    if (!r || r.status !== 'pending') {
      card.className = 'card quiet login-card'
      const done = el('div', 'card-label', svgIcon(ICON_LOCK))
      done.append(
        r?.status === 'saved'
          ? `${r.site} 로그인 정보를 금고에 저장했어요${r.username ? ` · ${r.username}` : ''}`
          : `${rec.site || '사이트'} 로그인 요청이 끝났어요`,
      )
      card.replaceChildren(done)
      return
    }
    card.className = 'card ask login-card'
    const head = el(
      'div',
      'login-head',
      el('span', 'tile', svgIcon(ICON_GLOBE, 'i md')),
      el('div', '', el('strong', '', `${r.site} 로그인`), el('span', 'mono', new URL(r.origin).host)),
    )
    const form = el('form', 'login-form')
    const user = el('input', 'field')
    user.placeholder = '아이디 또는 이메일'
    user.autocomplete = 'username'
    user.setAttribute('aria-label', '아이디 또는 이메일')
    const pw = el('input', 'field')
    pw.type = 'password'
    pw.placeholder = '비밀번호'
    pw.autocomplete = 'current-password'
    pw.setAttribute('aria-label', '비밀번호')
    const eye = el('button', 'icon-btn', svgIcon(ICON_EYE))
    eye.type = 'button'
    eye.setAttribute('aria-label', '비밀번호 보기')
    eye.onclick = () => {
      pw.type = pw.type === 'password' ? 'text' : 'password'
    }
    const err = el('p', 'login-error')
    const go = el('button', 'btn', '로그인')
    go.type = 'submit'
    form.append(user, el('div', 'pw-row', pw, eye), err, go)
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
    const foot = el(
      'p',
      'login-foot meta',
      svgIcon(ICON_LOCK),
      '이 PC의 두리 금고에만 암호화해서 저장돼요. 두리(AI)는 볼 수 없어요.',
    )
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

const STATUS_LABEL: Record<ApprovalView['status'], string> = {
  pending: '승인할까요?',
  approved: '누르는 중이에요',
  done: '승인해서 눌렀어요',
  rejected: '거절했어요',
  expired: '승인 시간이 지났어요',
  failed: '누르지 못했어요',
}

/**
 * 승인 카드 (M3). 누를 버튼·주소는 본체가 페이지에서 읽은 값, 무엇을·얼마는 AI가 적은 값이라
 * 실제 화면 캡처를 함께 보여 준다. 승인하면 본체가 그 버튼 하나만 누른다.
 */
function approvalCard(rec: ApprovalRecordMessage): HTMLElement {
  const card = el('div', 'approve')
  const fill = async () => {
    const { approvals } = await api<{ approvals: ApprovalView[] }>('/api/approvals').catch(() => ({
      approvals: [] as ApprovalView[],
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
        const img = el('img', 'approval-shot')
        img.alt = '승인할 화면'
        img.src = `data:image/jpeg;base64,${approval.shot}`
        img.onload = () => card.scrollIntoView({ block: 'nearest' })
        card.querySelector('.approve-body')?.append(img)
      }
    }
  }

  const render = (v: ApprovalView | undefined) => {
    if (!v || v.status !== 'pending') {
      card.className = 'card quiet approve-done'
      const label = v ? STATUS_LABEL[v.status] : '승인 요청이 끝났어요'
      const icon =
        v?.status === 'done' ? svgIcon(ICON_CHECK) : el('i', `dot ${v?.status === 'rejected' ? 'stop' : ''}`)
      card.replaceChildren(
        el(
          'div',
          'card-label',
          icon,
          `${label} · ${v?.what || rec.what}${v?.amount ? ` · ${v.amount}` : ''}`,
        ),
      )
      if (v?.result) card.append(el('p', 'cap', v.result))
      if (!v) card.append(el('p', 'cap', '두리를 다시 켜서 요청이 사라졌어요. 필요하면 다시 부탁해 주세요.'))
      return
    }
    card.className = 'approve'
    const host = (() => {
      try {
        return new URL(v.url).host
      } catch {
        return v.url
      }
    })()
    const top = el(
      'div',
      'approve-top',
      doori('asking', 36),
      el(
        'div',
        '',
        el(
          'p',
          'approve-q',
          v.amount ? `${v.amount} ${v.kind === 'money' ? '결제할까요?' : '승인할까요?'}` : '승인할까요?',
        ),
        el('span', 'meta', [RISK_LABEL[v.kind], v.where].filter(Boolean).join(' · ')),
      ),
    )
    const rows = el('dl', 'kv')
    const row = (k: string, val?: string, cls?: string) => {
      if (!val) return
      const dd = el('dd', cls ?? '', val)
      rows.append(el('dt', '', k), dd)
    }
    row('무엇을', v.what)
    row('주소', v.url.startsWith('app:') ? '' : host, 'host')
    row('취소 조건', v.cancel)
    if (v.kind !== 'app') row('누를 버튼', `"${v.label}"`)
    row('얼마', v.amount, 'money')
    const no = el('button', 'btn-ghost', '거절')
    no.type = 'button'
    const yes = el('button', 'btn', v.kind === 'app' ? '허용하기' : '승인하기')
    yes.type = 'button'
    const decide = async (decision: 'approve' | 'reject') => {
      yes.disabled = true
      no.disabled = true
      if (decision === 'approve') yes.textContent = '누르는 중…'
      const r = await api<{ ok: boolean; message: string }>(`/api/approvals/${encodeURIComponent(v.id)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }).catch((e: Error) => ({ ok: false, message: e.message }))
      await fill()
      void loadWaiting()
      // AI에게 결과를 알려 이어서 하게 한다
      void send(
        decision === 'reject'
          ? appNote(`"${v.label}"은(는) 거절했어요. 누르지 말아 주세요.`)
          : appNote(`${r.message} 결과를 확인하고 이어서 해 주세요.`),
      )
    }
    no.onclick = () => void decide('reject')
    yes.onclick = () => void decide('approve')
    card.replaceChildren(
      top,
      el('div', 'approve-body', rows),
      el('div', 'approve-actions', no, yes),
      el('p', 'approve-note', '화면과 내용이 맞는지 확인해 주세요. 승인하면 두리가 이 버튼 하나만 눌러요.'),
    )
  }
  void fill()
  return card
}

/** 두리가 "직접 해 주세요"라고 넘긴 일. active면 [Chrome에서 보기] [다 했어요] */
function handoffCard(raw: string, active: boolean) {
  let rec: HandoffRecord
  try {
    rec = JSON.parse(raw) as HandoffRecord
  } catch {
    return document.createTextNode('')
  }
  const card = el('div', active ? 'card ask handoff' : 'card quiet handoff')
  card.append(
    el(
      'div',
      'card-label',
      doori(active ? 'asking' : '', 24),
      active ? 'Chrome에서 직접 해 주세요' : '직접 해 주신 일',
    ),
    el('p', 'handoff-reason', rec.reason),
  )
  if (active) {
    const look = el('button', 'btn-ghost sm', 'Chrome에서 보기')
    look.type = 'button'
    look.onclick = () =>
      void api('/api/browser/focus', { method: 'POST', body: JSON.stringify({ tabId: rec.tabId }) }).catch(
        () => {},
      )
    const doneBtn = el('button', 'btn sm', '다 했어요')
    doneBtn.type = 'button'
    doneBtn.onclick = () => void send('다 했어요. 이어서 해 주세요.')
    if (rec.tabId === undefined) look.hidden = true
    card.append(el('div', 'handoff-actions', look, doneBtn))
  }
  return card
}

// ── 다른 화면: 맡긴 일 · 둘러보기 · 나의 두리 ─────────

function panelView(title: string, sub: string) {
  const main = document.querySelector('.main') as HTMLElement
  main.classList.add('panel-view')
  main.classList.remove('empty')
  setHeader(title, sub)
}

/** 맡긴 일: 나를 기다리는 일, 끝낸 승인 */
function renderTasks() {
  panelView('맡긴 일', '나를 기다리는 일과 끝낸 일')
  const view = el('div', 'page')
  const waiting = [...pendingApprovals(), ...pendingLogins()]
  view.append(el('h2', 'over', '나를 기다리는 일'))
  if (!waiting.length) view.append(el('p', 'cap page-empty', '지금은 기다리는 일이 없어요.'))
  for (const a of pendingApprovals()) {
    const b = el(
      'button',
      'row',
      el('i', 'dot ask'),
      el(
        'div',
        'grow',
        el('p', 'row-t', a.what || a.label),
        el('p', 'row-d', [a.where, a.amount].filter(Boolean).join(' · ')),
      ),
      el('span', 'pill ask', '승인 대기'),
    )
    b.type = 'button'
    b.onclick = () =>
      void show('talk').then(() => document.querySelector('.approve')?.scrollIntoView({ block: 'center' }))
    view.append(b)
  }
  for (const l of pendingLogins())
    view.append(
      el(
        'div',
        'row',
        el('i', 'dot ask'),
        el('div', 'grow', el('p', 'row-t', `${l.site} 로그인`)),
        el('span', 'pill ask', '입력 대기'),
      ),
    )
  const done = state.approvals.filter((a) => a.status !== 'pending').slice(0, 20)
  view.append(el('h2', 'over page-sec', '끝낸 일'))
  if (!done.length) view.append(el('p', 'cap page-empty', '돈 드는 일이나 보내기를 맡기면 여기에 남아요.'))
  for (const a of done)
    view.append(
      el(
        'div',
        'row',
        a.status === 'done'
          ? svgIcon(ICON_CHECK, 'i md')
          : el('i', `dot ${a.status === 'rejected' ? 'stop' : ''}`),
        el(
          'div',
          'grow',
          el('p', 'row-t', a.what || a.label),
          el('p', 'row-d', `${STATUS_LABEL[a.status]} · ${dayLabel(a.createdAt)}`),
        ),
        el('span', 'meta mono', a.amount ?? ''),
      ),
    )
  $('messages').replaceChildren(view)
}

/** 나의 두리: 이 컴퓨터, 일할 AI, Chrome, 약속 */
function renderMe() {
  panelView('나의 두리', '이 컴퓨터와 두리가 쓰는 것')
  const ready = readyAgents().length > 0
  const settings = el('button', 'btn-ghost', '설정 열기')
  settings.type = 'button'
  settings.onclick = () => void openSetup({ step: 'settings' })
  const view = el(
    'div',
    'page',
    el(
      'div',
      'me-hero',
      liveDoori('me', ready ? '' : 'sleeping', 104),
      el('p', 'title-2', ready ? '이 컴퓨터에서 일하고 있어요' : '두리가 쉬고 있어요'),
      el(
        'p',
        'meta',
        el('i', `dot ${ready ? 'work' : ''}`),
        ready ? '켜져 있어요' : '일할 AI를 연결해 주세요',
      ),
    ),
    el('h2', 'over page-sec', '일할 AI'),
    ...agentRows(),
    el('h2', 'over page-sec', '웹'),
    extensionRow(),
    el(
      'div',
      'promise',
      el('p', '', '돈 쓰는 일은 꼭 먼저 물어봐요. 이건 끌 수 없어요.'),
      el('p', '', '비밀번호와 카드 번호는 두리도 저희도 못 봐요.'),
    ),
    el('div', 'page-actions', settings),
  )
  $('messages').replaceChildren(view)
}

/** 화면 바꾸기 */
async function show(view: View, id?: string) {
  state.view = view
  for (const b of document.querySelectorAll<HTMLElement>('.navi[data-view]'))
    b.classList.toggle('on', b.dataset.view === view)
  const main = document.querySelector('.main') as HTMLElement
  main.dataset.view = view
  if (view === 'talk') {
    renderTalk()
    $('input').focus()
  } else if (view === 'tasks') renderTasks()
  else if (view === 'me') renderMe()
  else {
    panelView('둘러보기', '두리에게 맡길 서비스와 할 수 있는 일')
    await renderConnections(
      {
        api,
        box: $('messages'),
        setHeader,
        ask: (text) => void send(text),
      },
      id,
    )
  }
}

// ── 시작 ─────────────────────────────────────────────

const cut = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

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
  for (const b of document.querySelectorAll<HTMLElement>('[data-view]'))
    b.addEventListener('click', () => void show(b.dataset.view as View))
  $('stop').onclick = () => void api('/api/conversation/cancel', { method: 'POST' }).catch(() => {})

  const [{ settings }] = await Promise.all([
    api<{ settings: Settings }>('/api/settings'),
    loadAgents(),
    loadConversation(),
    loadWaiting().catch(() => {}),
    loadExtension().catch(() => undefined),
  ])
  if (settings.aiChoice) state.choice = settings.aiChoice
  renderDevice(settings)
  void connectLive()
  // 확장·승인·로그인 요청을 새로 본다 (폰에서 한 일도 보이게)
  setInterval(() => {
    void loadExtension().catch(() => {})
    void loadWaiting().catch(() => {})
    const clock = document.getElementById('work-clock')
    if (clock && state.turn) clock.textContent = elapsed(Math.floor((Date.now() - state.turn.started) / 1000))
  }, 3_000)

  // 점검 모드: connections(:서비스 id)·tasks·me로 그 화면을 열어 캡처한다
  const smoke = cfg.smokeOpen ?? ''
  if (smoke.startsWith('connections')) await show('explore', smoke.split(':')[1])
  else if (smoke === 'tasks' || smoke === 'me') await show(smoke)
  else await show('talk')

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
      renderDevice(saved)
      if (state.view === 'me') renderMe()
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
  if (cfg.smokeAsk) {
    await send(cfg.smokeAsk)
    await new Promise((r) => setTimeout(r, cfg.smokeAskWait || 1500))
    for (let i = 0; i < 600 && state.busy && !cfg.smokeAskWait; i++)
      await new Promise((r) => setTimeout(r, 500))
  }
  const ready = readyAgents().map((a) => a.id)
  // 화면이 실제로 그려진 뒤에 알린다
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dool2.ready(
    `agents=${state.agents.length} ready=${ready.join(',') || 'none'} messages=${state.messages.length} setup=${setup}`,
  )
}

main().catch((err: Error) => {
  document.body.textContent = `두리를 시작하지 못했어요: ${err.message}`
  window.dool2?.ready(`error=${err.message}`)
})
