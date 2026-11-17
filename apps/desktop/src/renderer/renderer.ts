// 두리 PC 앱 화면. dool2d 로컬 API(127.0.0.1 + 토큰)만 쓴다.
// 폰과 같은 구조 (docs/design/screens/soft/pc.png): 왼쪽 탭 5개(대화·피드·아이디어·목표·보관함) · 따로 하는 대화 · 연결 · 설정,
// 가운데 지금 탭(머리에 떠 있는 두리), 오른쪽 두리 판(예정·기억·화면·활동·승인). 대화는 하나 (ADR 0015).
import type {
  AgentEvent,
  AgentId,
  AgentStatus,
  AiChoice,
  ApprovalRecordMessage,
  ApprovalView,
  ChromeStatus,
  ConnectRecordMessage,
  ConversationLiveEvent,
  ConversationState,
  DaemonStreamEvent,
  ExtensionStatus,
  HandoffRecord,
  LifeAction,
  LifeState,
  LoginRecordMessage,
  LoginRequestView,
  Settings,
  StoredMessage,
  ThreadSummary,
  UsageLimit,
  WorkRecordMessage,
} from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { findCard } from './connect-text.js'
import { renderConnections } from './connections.js'
import { button, doori, el, emptyState, type IconName, icon, liveDoori, setRich, withLogo } from './dom.js'
import type { LibraryTab } from './life-model.js'
import { dayLabel, isFeedRoutine, plain, titleFrom } from './life-model.js'
import {
  activityTab,
  emptyLife,
  feedView,
  goalDetail,
  goalsView,
  ideasView,
  type LifeCtx,
  libraryView,
  memoryTab,
  scheduleTab,
} from './life-views.js'
import { appNote, narrationLine, readAppNote, splitPhoto, toolLabel } from './rich.js'
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

/** 왼쪽 탭 5개 + 연결 + 따로 하는 대화 + 목표 상세 */
type View = 'talk' | 'feed' | 'ideas' | 'goals' | 'goal' | 'library' | 'connect' | 'thread'
type Tab = 'talk' | 'feed' | 'ideas' | 'goals' | 'library'
const TABS: [Tab, IconName, string][] = [
  ['talk', 'chat', '대화'],
  ['feed', 'feed', '피드'],
  ['ideas', 'idea', '아이디어'],
  ['goals', 'goal', '목표'],
  ['library', 'library', '보관함'],
]
/** 두리 판의 칸 */
type PanelTab = 'schedule' | 'memory' | 'screen' | 'activity' | 'approvals'
const PANEL_TABS: [PanelTab, IconName, string][] = [
  ['schedule', 'clock', '예정'],
  ['memory', 'brain', '기억'],
  ['screen', 'pc', '화면'],
  ['activity', 'list', '활동'],
  ['approvals', 'hand', '승인'],
]

/** 지금 돌고 있는 차례 (두리 판의 화면과 대화 아래 "일하는 중"에 보인다) */
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
  /** 목표 상세·따로 하는 대화의 id */
  goalId?: string
  threadId?: string
  libTab: LibraryTab
  panelOpen: boolean
  panelTab: PanelTab
  messages: StoredMessage[]
  hasMore: boolean
  busy: boolean
  queued: string[]
  turn?: Turn
  /** 마지막으로 끝난 차례 (쉬는 동안 두리 판에 남겨 둔다) */
  lastTurn?: { ask: string; steps: string[]; seconds: number }
  approvals: ApprovalView[]
  logins: LoginRequestView[]
  life: LifeState
  services: ConnectionItem[]
  /** 두리 본체가 지금 로그인하고 있는 서비스 */
  connecting: Set<string>
  threads: ThreadSummary[]
} = {
  url: '',
  token: '',
  agents: [],
  view: 'talk',
  libTab: 'made',
  panelOpen: false,
  panelTab: 'schedule',
  messages: [],
  hasMore: false,
  busy: false,
  queued: [],
  approvals: [],
  logins: [],
  life: emptyLife(),
  services: [],
  connecting: new Set(),
  threads: [],
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

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

// ── 시각 ─────────────────────────────────────────────

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

const elapsed = (sec: number) =>
  sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`

const cut = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ── 잠깐 뜨는 알림 ────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(text: string) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  t.classList.remove('rise')
  void t.offsetWidth
  t.classList.add('rise')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    t.hidden = true
  }, 2600)
}

// ── 연결 상태 (이 컴퓨터) ─────────────────────────────

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
  const row = onClick ? button('stat', () => onClick()) : el('div', 'stat')
  row.title = title
  row.append(
    el('i', `dot ${cls}`),
    el('span', 'grow', name),
    el('span', cls === 'work' ? 'meta' : 'meta need', meta),
  )
  if (onClick) row.append(icon('chevron'))
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

/** 머리 오른쪽 "이 PC" + 왼쪽 위 자가 점검 알림 */
function renderDevice(settings?: Settings) {
  const ready = readyAgents().length > 0
  const pill = $('device')
  pill.querySelector('.dot')?.setAttribute('class', `dot ${ready ? 'work' : ''}`)
  $('device-text').textContent = ready ? '이 PC' : '이 PC · 준비 필요'
  pill.title = ready
    ? state.extension?.connected
      ? '이 컴퓨터에서 일할 수 있어요'
      : '웹 일을 하려면 Chrome 확장을 연결해 주세요'
    : '두리가 일할 AI가 연결돼 있지 않아요'
  if (state.panelOpen && state.panelTab === 'screen') renderPanel('live')
  if (!settings) return
  const box = $('notice')
  box.hidden = !settings.setupDone || ready
  if (box.hidden) return
  const fix = button('btn-small', () => void openSetup({ step: 'settings' }), '고치기')
  box.replaceChildren(el('span', 'notice-text', '두리가 일할 AI가 연결돼 있지 않아요'), fix)
}

async function loadAgents() {
  const { agents } = await api<{ agents: AgentStatus[] }>('/api/agents')
  state.agents = agents
  renderDevice()
  renderHead()
}

async function loadExtension() {
  const { extension } = await api<{ extension: ExtensionStatus }>('/api/browser/extension')
  const changed = JSON.stringify(extension) !== JSON.stringify(state.extension)
  state.extension = extension
  if (changed) renderDevice()
  return extension
}

/** 기다리는 승인·로그인 (왼쪽 "지금", 두리 판의 승인) */
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
  renderPanel('live')
  renderHead()
  renderTabs()
}
const pendingApprovals = () => state.approvals.filter((a) => a.status === 'pending')
const pendingLogins = () => state.logins.filter((l) => l.status === 'pending')

// ── 목표·보관함·기억·피드 ─────────────────────────────

async function loadLife() {
  state.life = await api<LifeState>('/api/life')
  onLifeChanged()
}

/** 생활 기록이 바뀌면 그 화면만 다시 그린다 (입력하는 중이면 건드리지 않는다) */
function onLifeChanged() {
  renderPanel('life')
  const box = $('messages')
  const typing = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement)
  if (state.view !== 'talk' && state.view !== 'connect' && state.view !== 'thread' && !typing)
    void show(state.view)
}

async function lifeAct(a: LifeAction) {
  try {
    const r = await api<{ ok: boolean; state: LifeState }>('/api/life/action', {
      method: 'POST',
      body: JSON.stringify(a),
    })
    state.life = r.state
    onLifeChanged()
  } catch (e) {
    toast((e as Error).message)
  }
}

async function loadServices() {
  const { services } = await api<{ services: ConnectionItem[] }>('/api/connections')
  state.services = services
}

const lifeCtx: LifeCtx = {
  life: () => state.life,
  services: () => state.services,
  act: lifeAct,
  send: (text) => void send(text),
  compose,
  openGoal: (id) => void show('goal', id),
  openView: (v) => void show(v),
  openService: (id) => void show('connect', id),
  toast,
  waiting: () => waitingBars(true),
  working: () =>
    state.busy
      ? el(
          'div',
          'side-row now-row',
          el('span', 'tile mint', el('span', 'spin')),
          el(
            'span',
            'grow',
            el('span', 'side-t', state.turn?.steps.length ? state.turn.activity : '대답하는 중'),
            state.turn?.ask ? el('span', 'meta', cut(state.turn.ask, 40)) : undefined,
          ),
          el('span', 'side-when meta', '지금'),
        )
      : undefined,
}

/** 대화 입력칸에 넣고 대화로 간다 (목표 만들기, 이어서 말하기) */
function compose(text: string) {
  void show('talk').then(() => {
    const input = $<HTMLTextAreaElement>('input')
    input.value = text
    input.dispatchEvent(new Event('input'))
    input.focus()
    input.setSelectionRange(text.length, text.length)
  })
}

// ── 따로 하는 대화 (메인 대화에 섞지 않는 주제별 대화) ─────

/** 지금 연 따로 하는 대화 */
interface Side {
  id: string
  title: string
  createdAt: string
  messages: StoredMessage[]
  live: string
  steps: string[]
  busy: boolean
}
let side: Side | undefined

async function loadThreads() {
  const { threads } = await api<{ threads: ThreadSummary[] }>('/api/threads')
  // 피드 글을 쓰는 대화는 목록에 두지 않는다 (결과는 피드로 간다)
  state.threads = threads.filter((t) => t.side && t.title !== '두리 피드')
  renderThreads()
}

function renderThreads() {
  const list = state.threads.slice(0, 12)
  const pencil = button('icon-btn side-new', () => void newSide(), icon('pencil'))
  pencil.setAttribute('aria-label', '따로 하는 대화 새로 만들기')
  pencil.title = '새로 만들기'
  $('threads-head').replaceChildren(el('span', 'grow', '따로 하는 대화'), pencil)
  $('thread-list').replaceChildren(
    ...(list.length
      ? list.map((t) => {
          const b = button(
            'navi thread-item',
            () => void show('thread', t.id),
            el('span', 'grow', cut(t.title, 22)),
            t.busy ? el('i', 'dot work pulse') : t.approval ? el('i', 'dot ask') : undefined,
          )
          if (state.view === 'thread' && state.threadId === t.id) {
            b.classList.add('on')
            b.setAttribute('aria-current', 'page')
          }
          b.title = t.title
          return b
        })
      : [el('p', 'meta thread-empty', '여행·이사처럼 길게 이어질 일은 따로 이야기해요')]),
  )
}

async function newSide() {
  try {
    const { thread } = await api<{ thread: ThreadSummary }>('/api/threads', {
      method: 'POST',
      body: JSON.stringify({ side: true }),
    })
    await loadThreads().catch(() => {})
    await show('thread', thread.id)
  } catch (e) {
    toast((e as Error).message)
  }
}

async function openSide(id: string) {
  const box = $('messages')
  try {
    const data = await api<{ thread: ThreadSummary; messages: StoredMessage[] }>(
      `/api/threads/${encodeURIComponent(id)}`,
    )
    const busy = state.threads.find((t) => t.id === id)?.busy === true
    side =
      side?.id === id
        ? { ...side, title: data.thread.title, messages: data.messages }
        : {
            id,
            title: data.thread.title,
            createdAt: data.thread.createdAt,
            messages: data.messages,
            live: '',
            steps: [],
            busy,
          }
  } catch {
    side = undefined
    box.replaceChildren(
      el('div', 'page', emptyState('', '이 대화를 찾을 수 없어요', '목록에서 다른 대화를 골라 주세요.')),
    )
    return
  }
  renderSide()
}

/** 따로 하는 대화 화면: 제목 · 지우기 / 말 / 아래 입력칸(메인과 같은 자리) */
function renderSide() {
  const sd = side
  if (!sd || state.view !== 'thread' || state.threadId !== sd.id) return
  const box = $('messages')
  const list = el('div', 'thread')
  let prev = ''
  for (const m of sd.messages) {
    if (m.role === 'tool') {
      list.append(toolCard(m.text, false))
      continue
    }
    const note = m.role === 'user' ? readAppNote(m.text) : undefined
    if (m.role === 'assistant' && prev !== 'assistant') list.append(who(m.createdAt))
    list.append(messageEl(m.role, m.text, note))
    prev = note !== undefined ? 'note' : m.role
  }
  const live = el('div', 'live')
  live.id = 'side-live'
  const del = button(
    'btn-text sm',
    () => {
      if (sd.busy) return toast('답하는 중에는 지울 수 없어요')
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1'
        del.classList.add('armed')
        del.replaceChildren('한 번 더 누르면 지워요')
        setTimeout(() => {
          del.dataset.armed = ''
          del.classList.remove('armed')
          del.replaceChildren(icon('trash'), '지우기')
        }, 3000)
        return
      }
      void api(`/api/threads/${encodeURIComponent(sd.id)}`, { method: 'DELETE' })
        .then(async () => {
          side = undefined
          toast('대화를 지웠어요')
          await loadThreads().catch(() => {})
          await show('talk')
        })
        .catch((e: Error) => toast(e.message))
    },
    icon('trash'),
    '지우기',
  )
  box.replaceChildren(
    el(
      'div',
      'page page-narrow side-page',
      el(
        'header',
        'side-head',
        el(
          'div',
          'grow',
          el('h1', 'title-2', sd.title),
          el('p', 'cap', `따로 하는 대화 · ${dayLabel(sd.createdAt)}에 시작했어요`),
        ),
        del,
      ),
      sd.messages.length || sd.busy
        ? list
        : el(
            'div',
            'card side-hint',
            el('div', 'card-label', doori('', 22), '주제 하나를 따로 이야기해요'),
            el(
              'p',
              '',
              '여행 계획, 이사 준비처럼 길게 이어질 일을 여기서 하면 메인 대화가 어지럽지 않아요. 두리는 메인 대화에서 알게 된 것도 기억해요.',
            ),
          ),
      live,
    ),
  )
  renderSideLive()
  box.scrollTop = box.scrollHeight
}

function renderSideLive() {
  const live = document.getElementById('side-live')
  if (!live || !side) return
  const parts: HTMLElement[] = []
  if (side.busy) {
    if (side.live) {
      const b = el('div', 'bubble rich')
      setRich(b, side.live)
      parts.push(who(new Date().toISOString()), b)
    }
    parts.push(
      el(
        'div',
        'working',
        el('span', 'spin'),
        el('span', 'shimmer', side.steps.length ? `${side.steps.at(-1)}…` : '생각하는 중…'),
      ),
    )
  }
  live.replaceChildren(...parts)
  renderSend()
}

/** 따로 하는 대화로 보낸다. 진행은 실시간 연결(side 표시)로 그린다 */
async function sendSide(text: string) {
  const sd = side
  if (!sd || !text.trim()) return
  if (sd.busy) return toast('이 대화는 아직 답하는 중이에요. 끝나면 이어서 말해 주세요')
  sd.busy = true
  renderSideLive()
  try {
    const res = await fetch(`${state.url}/api/threads/${encodeURIComponent(sd.id)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `보내지 못했어요 (${res.status})`)
    }
    // 응답을 끝까지 읽어야 차례가 끊기지 않는다 (닫으면 본체가 멈춘다)
    const reader = res.body?.getReader()
    if (reader) for (;;) if ((await reader.read()).done) break
  } catch (e) {
    toast((e as Error).message)
  } finally {
    if (side?.id === sd.id && sd.busy) {
      sd.busy = false
      void openSide(sd.id)
    }
  }
}

/** 실시간 연결에서 온 따로 하는 대화의 차례 */
function onSideTurn(threadId: string, e: DaemonStreamEvent) {
  const known = state.threads.find((t) => t.id === threadId)
  if (e.type === 'saved' && e.message.role === 'user') {
    if (known) {
      known.busy = true
      renderThreads()
    } else void loadThreads().catch(() => {})
  }
  if (e.type === 'end') void loadThreads().catch(() => {})
  const sd = side
  if (!sd || sd.id !== threadId) return
  if (e.type === 'saved') {
    if (!sd.messages.some((m) => m.id === e.message.id)) sd.messages.push(e.message)
    if (e.message.role === 'assistant') {
      sd.live = ''
      sd.steps = []
    }
    if (e.message.role === 'user') sd.busy = true
    renderSide()
    return
  }
  if (e.type === 'agent') {
    sd.busy = true
    const ev = e.event
    if (ev.type === 'text') sd.live += ev.delta
    else if (ev.type === 'tool') {
      const label = narrationLine(sd.live) ?? `${toolLabel(ev.name)} 중`
      sd.live = ''
      if (sd.steps.at(-1) !== label) sd.steps.push(label)
    } else return
    if (state.view === 'thread' && state.threadId === sd.id) renderSideLive()
    return
  }
  if (e.type === 'end') {
    sd.busy = false
    sd.live = ''
    sd.steps = []
    void openSide(sd.id)
  }
}

// ── 머리: 떠 있는 두리 + 상태 한 줄 ─────────────────────

function moodNow(): { mood: string; line: string; cls: string } {
  const waiting = pendingApprovals().length + pendingLogins().length
  if (state.busy)
    return {
      mood: 'working',
      line: state.turn?.activity && state.turn.steps.length ? state.turn.activity : '이 컴퓨터에서 일하는 중',
      cls: '',
    }
  if (waiting)
    return {
      mood: 'asking',
      line: pendingApprovals().length ? '승인을 기다려요' : '로그인을 기다려요',
      cls: 'ask',
    }
  if (!readyAgents().length && state.agents.length)
    return { mood: 'sleeping', line: '일할 AI가 연결돼 있지 않아요', cls: 'off' }
  return { mood: '', line: '쉬는 중', cls: 'off' }
}

function renderHead() {
  const m = moodNow()
  const av = $('head-av')
  const d = liveDoori('head', m.mood, 52)
  if (d.parentElement !== av) av.replaceChildren(d)
  d.classList.toggle('bob', state.busy)
  $('head-tag').replaceChildren('두리', el('span', m.cls, cut(m.line, 22)))
  $('agent').setAttribute('aria-expanded', String(state.panelOpen))
  if (state.panelOpen) renderPanelTop()
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

// ── 왼쪽: 탭 · 지금 · 연결 · 설정 ──────────────────────

function renderTabs() {
  const waiting = pendingApprovals().length + pendingLogins().length
  const current: Tab | undefined =
    state.view === 'goal' ? 'goals' : TABS.some(([t]) => t === state.view) ? (state.view as Tab) : undefined
  $('tabs').replaceChildren(
    ...TABS.map(([id, ic, label]) => {
      const b = button('navi', () => void show(id), icon(ic, 'i md'), el('span', 'grow', label))
      if (id === 'talk' && waiting) b.append(el('span', 'count', String(waiting)))
      if (id === 'goals') {
        const on = state.life.routines.filter((r) => r.enabled && !isFeedRoutine(r)).length
        if (on) b.append(el('span', 'meta', String(on)))
      }
      if (current === id) {
        b.classList.add('on')
        b.setAttribute('aria-current', 'page')
      }
      return b
    }),
  )
  const connect = button('navi', () => void show('connect'), icon('apps', 'i md'), el('span', 'grow', '연결'))
  if (state.view === 'connect') {
    connect.classList.add('on')
    connect.setAttribute('aria-current', 'page')
  }
  const connected = state.services.filter((s) => s.connectedAt).length
  if (connected) connect.append(el('span', 'meta', String(connected)))
  $('side-foot').replaceChildren(
    connect,
    button(
      'navi',
      () => void openSetup({ step: 'settings' }),
      icon('gear', 'i md'),
      el('span', 'grow', '설정'),
    ),
  )
  renderThreads()
}

/** 지금 하는 일 · 나를 기다리는 승인·로그인 막대 (왼쪽 "지금", 피드 맨 위) */
function waitingBars(withBusy: boolean): HTMLElement[] {
  const items: HTMLElement[] = []
  if (withBusy && state.busy && state.turn)
    items.push(
      button(
        'livebar',
        () => void show('talk'),
        el('i', 'dot work pulse'),
        el(
          'span',
          'grow',
          el('b', '', cut(state.turn.ask || '두리가 일하는 중', 24)),
          el('br'),
          el('span', 'meta', state.turn.steps.length ? state.turn.activity : '생각하는 중'),
        ),
      ),
    )
  for (const a of pendingApprovals())
    items.push(
      button(
        'livebar ask',
        () =>
          void show('talk').then(() =>
            document.querySelector('.approve')?.scrollIntoView({ block: 'center' }),
          ),
        el('i', 'dot ask'),
        el(
          'span',
          'grow',
          el('b', '', cut(a.what || '승인', 24)),
          el('br'),
          el('span', 'meta mono', a.amount ?? a.label),
        ),
        icon('chevron'),
      ),
    )
  for (const l of pendingLogins())
    items.push(
      button(
        'livebar ask',
        () => void show('talk'),
        el('i', 'dot ask'),
        el(
          'span',
          'grow',
          el('b', '', `${l.site} 로그인`),
          el('br'),
          el('span', 'meta', '아이디·비밀번호가 필요해요'),
        ),
        icon('chevron'),
      ),
    )
  return items
}

function renderNow() {
  const items = waitingBars(state.view !== 'talk')
  $('now').hidden = items.length === 0
  $('now-list').replaceChildren(...items)
}

// ── 오른쪽: 두리 판 ───────────────────────────────────

function setPanel(open: boolean, tab?: PanelTab) {
  state.panelOpen = open
  if (tab) state.panelTab = tab
  try {
    localStorage.setItem('dool2.panel', open ? 'open' : 'closed')
  } catch {}
  $('app').classList.toggle('panel-open', open)
  renderHead()
  renderPanel('all')
}

function renderPanelTop() {
  const top = document.getElementById('panel-top')
  if (!top) return
  const m = moodNow()
  const d = liveDoori('panel', m.mood, 96)
  const status = state.busy
    ? '두리가 일하는 중'
    : m.mood === 'asking'
      ? '두리가 기다리는 중'
      : '두리가 쉬는 중'
  top.replaceChildren(
    el('span', 'panel-av', d),
    el('h2', 'title-2', '두리'),
    el(
      'p',
      'meta panel-status',
      el('i', `dot ${state.busy ? 'work pulse' : m.mood === 'asking' ? 'ask' : ''}`),
      status,
    ),
  )
}

/** 두리 판을 그린다. live = 일하는 중 바뀐 것(화면·승인), life = 생활 기록(예정·기억·활동) */
function renderPanel(reason: 'live' | 'life' | 'all' = 'live') {
  const panel = $('panel')
  if (!state.panelOpen) {
    if (panel.childElementCount) panel.replaceChildren()
    return
  }
  if (!document.getElementById('panel-top')) {
    const close = button('fbtn panel-close', () => setPanel(false), icon('close'))
    close.setAttribute('aria-label', '두리 판 닫기')
    const top = el('div', 'panel-top')
    top.id = 'panel-top'
    const seg = el('div', 'seg panel-tabs')
    seg.id = 'panel-tabs'
    const body = el('div', 'panel-body')
    body.id = 'panel-body'
    panel.replaceChildren(close, top, seg, body)
    reason = 'all'
  }
  renderPanelTop()
  const waiting = pendingApprovals().length + pendingLogins().length
  $('panel-tabs').replaceChildren(
    ...PANEL_TABS.map(([id, ic, label]) => {
      const b = button(
        '',
        () => {
          state.panelTab = id
          renderPanel('all')
        },
        icon(ic),
        label,
      )
      b.setAttribute('aria-pressed', String(state.panelTab === id))
      if (id === 'approvals' && waiting) b.append(el('i', 'dot ask'))
      if (id === 'screen' && state.busy) b.append(el('i', 'dot work pulse'))
      return b
    }),
  )
  const tab = state.panelTab
  const liveTab = tab === 'screen' || tab === 'approvals'
  if (reason !== 'all' && (reason === 'live') !== liveTab) return
  // 기억 칸에서 입력하는 중이면 다시 그리지 않는다
  const body = $('panel-body')
  if (
    reason !== 'all' &&
    document.activeElement instanceof HTMLInputElement &&
    body.contains(document.activeElement)
  )
    return
  const content =
    tab === 'schedule'
      ? scheduleTab(lifeCtx)
      : tab === 'memory'
        ? memoryTab(lifeCtx)
        : tab === 'activity'
          ? activityTab(lifeCtx)
          : tab === 'approvals'
            ? approvalsTab()
            : screenTab()
  body.replaceChildren(content)
}

/** 화면: 지금 하는 일(단계 기록) · 다음 차례 · 이 컴퓨터 */
function screenTab(): HTMLElement {
  const box = el('div', 'screen-tab')
  const t = state.turn
  if (state.busy && t) {
    const log = el('ul', 'worklog')
    t.steps.forEach((s, i) => {
      log.append(el('li', i === t.steps.length - 1 ? 'now' : 'done', s))
    })
    if (!t.steps.length) log.append(el('li', 'now', '무엇부터 할지 정하는 중'))
    log.append(el('li', 'next', '돈 드는 일은 먼저 물어볼게요'))
    const clock = el('span', 'meta', elapsed(Math.floor((Date.now() - t.started) / 1000)))
    clock.id = 'work-clock'
    const stop = button(
      'btn-danger sm',
      () => void api('/api/conversation/cancel', { method: 'POST' }).catch(() => {}),
      icon('stop'),
      '멈추기',
    )
    box.append(
      el(
        'article',
        'workcard',
        el(
          'div',
          'workcard-head',
          el('b', '', cut(t.ask || '부탁하신 일', 28)),
          el('span', '', t.steps.length ? t.activity : '생각하는 중'),
        ),
        el('div', 'panel-log', log),
        el('div', 'workcard-foot', clock, el('span', 'grow'), stop),
      ),
    )
  } else if (state.lastTurn?.steps.length) {
    const lt = state.lastTurn
    const log = el('ul', 'worklog')
    for (const s of lt.steps) log.append(el('li', 'done', s))
    box.append(
      el(
        'article',
        'workcard quiet',
        el('div', 'workcard-head', el('b', '', cut(lt.ask, 28)), el('span', 'done-label', '끝났어요')),
        el('div', 'panel-log', log),
        el(
          'div',
          'workcard-foot',
          el('span', 'meta', `한 일 ${lt.steps.length}가지 · ${elapsed(lt.seconds)}`),
        ),
      ),
    )
  } else {
    box.append(
      emptyState(
        'sleeping',
        '지금은 쉬고 있어요',
        '부탁하면 두리가 이 컴퓨터의 Chrome에서 하는 일을 여기서 한 단계씩 보여 드릴게요.',
      ),
    )
  }
  if (state.queued.length)
    box.append(
      el(
        'section',
        'panel-sec',
        el('h3', 'over', '다음 차례'),
        ...state.queued.map((q) =>
          el(
            'div',
            'side-row',
            icon('chat', 'i md'),
            el(
              'span',
              'grow',
              el('span', 'side-t', cut(q, 40)),
              el('span', 'meta', '지금 일이 끝나면 이어서 볼게요'),
            ),
          ),
        ),
      ),
    )
  box.append(
    el(
      'section',
      'panel-sec',
      el('h3', 'over', '이 컴퓨터'),
      el('div', 'stats', ...agentRows(), extensionRow()),
    ),
    el('p', 'panel-foot meta', icon('lock'), '두리는 이 컴퓨터에서 일하고, 대화도 이 컴퓨터에만 남아요.'),
  )
  return box
}

const STATUS_LABEL: Record<ApprovalView['status'], string> = {
  pending: '승인할까요?',
  approved: '누르는 중이에요',
  done: '승인해서 눌렀어요',
  rejected: '거절했어요',
  expired: '승인 시간이 지났어요',
  failed: '누르지 못했어요',
}

/** 승인: 기다리는 것 · 지난 승인 */
function approvalsTab(): HTMLElement {
  const box = el('div', 'approvals-tab')
  const waiting: HTMLElement[] = []
  for (const a of pendingApprovals())
    waiting.push(
      button(
        'side-row',
        () =>
          void show('talk').then(() =>
            document.querySelector('.approve')?.scrollIntoView({ block: 'center' }),
          ),
        el('i', 'dot ask'),
        el(
          'span',
          'grow',
          el('span', 'side-t', a.what || a.label),
          el('span', 'meta', [a.where, a.amount].filter(Boolean).join(' · ')),
        ),
        el('span', 'pill ask', '승인 대기'),
      ),
    )
  for (const l of pendingLogins())
    waiting.push(
      button(
        'side-row',
        () => void show('talk'),
        el('i', 'dot ask'),
        el(
          'span',
          'grow',
          el('span', 'side-t', `${l.site} 로그인`),
          el('span', 'meta', '아이디·비밀번호가 필요해요'),
        ),
        el('span', 'pill ask', '입력 대기'),
      ),
    )
  box.append(
    el(
      'section',
      'panel-sec',
      el('h3', 'over', '기다리는 것'),
      ...(waiting.length ? waiting : [el('p', 'cap', '지금은 승인을 기다리는 일이 없어요.')]),
    ),
  )
  const done = state.approvals.filter((a) => a.status !== 'pending').slice(0, 20)
  box.append(
    el(
      'section',
      'panel-sec',
      el('h3', 'over', '지난 승인'),
      ...(done.length
        ? done.map((a) =>
            el(
              'div',
              'side-row',
              a.status === 'done'
                ? icon('check', 'i md')
                : el('i', `dot ${a.status === 'rejected' ? 'stop' : ''}`),
              el(
                'span',
                'grow',
                el('span', 'side-t', a.what || a.label),
                el('span', 'meta', `${STATUS_LABEL[a.status]} · ${dayLabel(a.createdAt)}`),
              ),
              el('span', 'meta mono', a.amount ?? ''),
            ),
          )
        : [el('p', 'cap', '돈 드는 일이나 보내기를 맡기면 여기에 남아요.')]),
    ),
    el(
      'p',
      'panel-foot meta',
      icon('shield'),
      '돈 쓰는 일과 누군가에게 보내는 일은 늘 먼저 물어봐요. 이건 끌 수 없어요.',
    ),
  )
  return box
}

// ── 대화 ─────────────────────────────────────────────

/** 대화 기록을 받아 다시 그린다 */
async function loadConversation() {
  const s = await api<ConversationState>('/api/conversation?limit=150')
  state.messages = s.messages
  state.hasMore = s.hasMore
  state.queued = s.queued
  state.busy = s.busy
  if (state.view === 'talk') renderTalk()
  renderPanel('live')
}

function renderTalk() {
  const box = $('messages')
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
    // 일한 과정은 답 위 그대로 둔다
    if (a && b && a.m.role === 'tool' && b.m.role === 'assistant' && !a.m.text.includes('"kind":"work"')) {
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
function messageEl(role: string, text: string, note?: string, tools = true): HTMLElement {
  if (role === 'user') {
    if (note !== undefined) return el('p', 'msg note', note)
    // 사진을 보낸 말: "[사진: 파일]" 대신 사진 표시
    const { text: said, photo: sent } = splitPhoto(text)
    if (sent) return el('div', 'bubble me with-photo', el('span', 'photo-chip', icon('image'), '사진'), said)
    return el('div', 'bubble me', text)
  }
  if (role === 'system') return el('p', 'sysline', el('i', 'dot stop'), text)
  const b = el('div', 'bubble rich')
  setRich(b, text)
  if (!tools || plain(text).length < 24) return b
  return el('div', 'answer', b, answerTools(text))
}

/** 답 아래 작은 동작: 보관함에 남기기 */
function answerTools(text: string) {
  const save = button(
    'btn-text sm',
    () => {
      save.disabled = true
      void lifeAct({ action: 'library-save', title: titleFrom(text), body: text, itemKind: 'note' }).then(
        () => {
          save.replaceChildren(icon('check'), '보관함에 남겼어요')
          toast('보관함에 남겼어요')
        },
      )
    },
    icon('bookmark'),
    '보관함에 남기기',
  )
  return el('div', 'answer-tools', save)
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
  renderSend()
}

function emptyView() {
  const chips = el('div', 'chips')
  for (const ex of EXAMPLES) chips.append(button('chip', () => void send(ex), ex))
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
  if (ev.kind === 'life') {
    void loadLife().catch(() => {})
    return
  }
  if (ev.kind === 'connect') {
    // 연결하기가 끝났거나 시작했다: 연결 목록을 다시 받고 대화 안 연결 카드를 고친다
    state.connecting = new Set(ev.connecting)
    void loadServices()
      .then(() => {
        for (const c of document.querySelectorAll<HTMLElement>('.connect-card[data-service]'))
          c.replaceWith(connectCard({ kind: 'connect', service: c.dataset.service ?? '' }))
      })
      .catch(() => {})
    return
  }
  if (ev.kind === 'busy') {
    // 본체의 busy는 따로 하는 대화·피드 글까지 센다. 메인 대화가 일하는지는 대화 상태로 확인한다
    if (!ev.busy) setMainBusy(false)
    else
      void api<ConversationState>('/api/conversation?limit=1')
        .then((s) => setMainBusy(s.busy))
        .catch(() => {})
    return
  }
  if (ev.kind === 'queued') {
    state.queued = ev.texts
    renderPanel('live')
    if (state.view === 'talk') renderLive()
    return
  }
  const e = ev.event
  if (ev.side) {
    onSideTurn(ev.threadId, e)
    return
  }
  // 메인 대화의 차례가 흐르고 있으면 일하는 중
  if (e.type !== 'end' && !state.busy) setMainBusy(true)
  if (e.type === 'saved') {
    const m = e.message
    if (m.role === 'tool') {
      state.turn?.records.push(m.text)
      return
    }
    if (m.role === 'user') {
      // 새 차례의 시작: 두리 판에 무엇을 부탁했는지 보인다
      const note = readAppNote(m.text)
      state.turn = { ...(state.turn ?? newTurn('')), ask: note ?? m.text }
    }
    if (m.role === 'assistant' && state.turn) state.turn.text = ''
    state.messages.push(m)
    if (state.view === 'talk') appendSaved(m)
    renderNow()
    renderPanel('live')
    return
  }
  if (e.type === 'agent') onAgent(e.event)
  if (e.type === 'end') void finishTurn()
}

/** 메인 대화가 일하는 중인지 바뀌었을 때 */
function setMainBusy(busy: boolean) {
  const was = state.busy
  if (was === busy) return
  state.busy = busy
  if (busy && !state.turn) state.turn = newTurn('')
  // 일을 시작하면 두리 판을 화면 칸으로 (기억을 고치는 중이 아니면)
  if (busy && state.panelOpen && state.panelTab !== 'memory') state.panelTab = 'screen'
  renderHead()
  renderNow()
  renderPanel('all')
  if (state.view === 'talk') renderLive()
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
  renderPanel('live')
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
  void loadThreads().catch(() => {})
  if (t && t.usd > 0 && state.view === 'talk')
    document.querySelector('#messages .thread')?.append(el('p', 'cost meta', `이번 답 ${costLabel(t.usd)}`))
  renderHead()
  renderNow()
  renderPanel('live')
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
    await loadLife().catch(() => {})
  }
}

/** 말 하나를 보낸다. 두리가 답하는 중이면 본체가 줄을 세웠다가 이어서 전한다 */
/** 보낼 사진 (줄인 JPEG base64): 입력칸에 붙여 넣거나 끌어 놓는다 */
let photo: string | undefined

async function shrinkPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * scale)
  c.height = Math.round(bmp.height * scale)
  c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.82).split(',')[1] ?? ''
}

function renderPhoto() {
  const box = document.getElementById('attach')
  if (!box) return
  if (!photo) {
    box.replaceChildren()
    box.hidden = true
    return
  }
  const img = document.createElement('img')
  img.src = `data:image/jpeg;base64,${photo}`
  img.alt = '보낼 사진'
  const x = el('button', 'icon-btn', icon('close'))
  x.type = 'button'
  x.setAttribute('aria-label', '사진 빼기')
  x.onclick = () => {
    photo = undefined
    renderPhoto()
    renderSend()
  }
  box.replaceChildren(img, x)
  box.hidden = false
}

async function attachPhoto(file: File | undefined | null) {
  if (!file || !file.type.startsWith('image/')) return
  try {
    photo = await shrinkPhoto(file)
    renderPhoto()
    renderSend()
  } catch {
    // 읽을 수 없는 그림이면 그냥 둔다
  }
}

async function send(text: string) {
  if (!text.trim() && !photo) return
  if (state.view !== 'talk') await show('talk')
  const image = photo
  photo = undefined
  renderPhoto()
  try {
    await api<{ queued: boolean }>('/api/conversation/messages', {
      method: 'POST',
      body: JSON.stringify({ text: text.trim() || '이 사진 봐 줘', ...(image ? { image } : {}) }),
    })
  } catch (err) {
    document
      .querySelector('#messages .thread')
      ?.append(el('p', 'sysline', el('i', 'dot stop'), (err as Error).message))
  }
}

/** 보내기 단추: 글이 있으면 보내기, 비었고 일하는 중이면 멈추기 */
function renderSend() {
  const input = $<HTMLTextAreaElement>('input')
  const btn = $<HTMLButtonElement>('send')
  const hasText = input.value.trim().length > 0 || photo !== undefined
  // 따로 하는 대화는 줄 서기 없이 한 번에 하나 (답하는 중엔 멈추기만)
  const inSide = state.view === 'thread'
  const busy = inSide ? side?.busy === true : state.busy
  const stop = busy && (!hasText || inSide)
  btn.className = `send-btn${stop ? ' stop' : hasText ? ' ready' : ''}`
  btn.replaceChildren(icon(stop ? 'stop' : 'send', 'i md'))
  const label = stop ? '멈추기' : busy ? '이어서 말하기' : '보내기'
  btn.setAttribute('aria-label', label)
  btn.title = stop ? '지금 하는 일 멈추기' : `${label} (Enter)`
  input.placeholder = inSide
    ? busy
      ? '답이 끝나면 이어서 말할 수 있어요'
      : '이 주제로 두리에게 부탁하기'
    : busy
      ? '두리가 일하는 중에도 말할 수 있어요'
      : '두리에게 부탁하기'
}

// ── 대화 안의 카드: 승인 · 로그인 · 직접 해 주세요 ─────

/** 대화 기록의 tool 메시지: 넘기기(handoff), 승인 요청(approval), 로그인(login) */
function toolCard(raw: string, active: boolean): Node {
  try {
    const rec = JSON.parse(raw) as { kind?: string }
    if (rec.kind === 'approval') return approvalCard(rec as ApprovalRecordMessage)
    if (rec.kind === 'login') return loginCard(rec as LoginRecordMessage)
    if (rec.kind === 'connect') return connectCard(rec as ConnectRecordMessage)
    if (rec.kind === 'work') return workDoneCard(rec as WorkRecordMessage)
  } catch {
    return document.createTextNode('')
  }
  return handoffCard(raw, active)
}

/** 일한 과정: 답 위에 접힌 한 줄, 누르면 단계와 걸린 시간 */
function workDoneCard(rec: WorkRecordMessage): HTMLElement {
  const secs = (ms: number) => {
    const s = Math.max(1, Math.round(ms / 1000))
    return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}`
  }
  const box = el('details', 'work-done')
  const where = rec.host ? `${rec.host.replace(/^(www|m|app)\./, '')}에서 일했어요` : '일한 과정'
  box.append(
    el(
      'summary',
      '',
      icon('check'),
      el('b', '', where),
      el('span', 'meta', `${rec.count}단계 · ${secs(rec.ms)}`),
    ),
    el(
      'ol',
      '',
      ...rec.steps.map((s) => el('li', '', el('span', '', s.text), el('span', 'meta', secs(s.ms)))),
    ),
  )
  return box
}

/**
 * 연결 카드 (connect_ask): 아이디·비밀번호를 넣으면 두리 본체가 뒤에서 로그인한다.
 * 기다리지 않아도 된다. 끝나면 대화 알림이 오고 이 카드는 "연결돼 있어요"로 바뀐다
 */
function connectCard(rec: ConnectRecordMessage): HTMLElement {
  const card = el('div', 'card connect-card')
  card.dataset.service = rec.service
  const found = findCard(
    state.services.map((s) => s.card),
    rec.service,
  )
  const it = found ? state.services.find((s) => s.card.id === found.id) : undefined
  if (!it) {
    card.className = 'card quiet connect-card'
    card.append(el('div', 'card-label', icon('link'), `${rec.service} 연결 카드를 찾지 못했어요`))
    return card
  }
  const c = it.card
  const mark = withLogo(el('span', 'svc-mark', /^\d+/.exec(c.name)?.[0] ?? [...c.name][0] ?? ''), c.id)
  if (it.connectedAt) {
    card.className = 'card quiet connect-card'
    card.append(el('div', 'card-label', mark, `${c.name} 연결돼 있어요`))
    return card
  }
  const busy = state.connecting.has(c.id)
  card.className = 'card ask connect-card'
  const head = el(
    'div',
    'login-head',
    mark,
    el(
      'div',
      '',
      el('strong', '', busy ? `${c.name}에 로그인하는 중이에요` : `${c.name} 연결`),
      el(
        'span',
        'cap',
        busy
          ? '두리가 Chrome에서 하고 있어요. 다른 일을 하셔도 돼요'
          : '아이디·비밀번호를 넣으면 두리가 Chrome에서 대신 로그인해요',
      ),
    ),
    busy ? el('span', 'spin') : undefined,
  )
  if (busy || c.how !== 'browser') {
    card.append(head)
    if (!busy) card.append(button('btn', () => void show('connect', c.id), '연결 화면 열기'))
    return card
  }
  const form = el('form', 'login-form')
  const user = el('input', 'field')
  user.placeholder = '아이디 또는 이메일'
  user.autocomplete = 'username'
  const pw = el('input', 'field')
  pw.type = 'password'
  pw.placeholder = '비밀번호'
  pw.autocomplete = 'current-password'
  const err = el('p', 'login-error')
  const go = el('button', 'btn', '연결하기')
  go.type = 'submit'
  form.append(user, pw, err, go)
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (!user.value.trim() || !pw.value) {
      err.textContent = '아이디와 비밀번호를 모두 넣어 주세요'
      return
    }
    go.disabled = true
    const res = await api<{ message: string }>(`/api/connections/${encodeURIComponent(c.id)}/login`, {
      method: 'POST',
      body: JSON.stringify({ username: user.value.trim(), password: pw.value, background: true }),
    }).catch((x: Error) => ({ message: x.message, failed: true }))
    pw.value = ''
    if ('failed' in res) {
      go.disabled = false
      err.textContent = res.message
      return
    }
    state.connecting.add(c.id)
    card.replaceWith(connectCard(rec))
  }
  card.append(
    head,
    form,
    el('p', 'cap', 'PC의 두리 금고에만 암호화해 저장돼요. 두리(AI)는 비밀번호를 보지 않아요.'),
  )
  return card
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
      card.replaceChildren(
        el(
          'div',
          'card-label',
          icon('lock'),
          r?.status === 'saved'
            ? `${r.site} 로그인 정보를 금고에 저장했어요${r.username ? ` · ${r.username}` : ''}`
            : `${rec.site || '사이트'} 로그인 요청이 끝났어요`,
        ),
      )
      return
    }
    card.className = 'card ask login-card'
    const head = el(
      'div',
      'login-head',
      el('span', 'tile', icon('globe', 'i md')),
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
    const eye = button(
      'icon-btn',
      () => {
        pw.type = pw.type === 'password' ? 'text' : 'password'
      },
      icon('eye'),
    )
    eye.setAttribute('aria-label', '비밀번호 보기')
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
      icon('lock'),
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
      const mark =
        v?.status === 'done' ? icon('check') : el('i', `dot ${v?.status === 'rejected' ? 'stop' : ''}`)
      card.replaceChildren(
        el(
          'div',
          'card-label',
          mark,
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
      rows.append(el('dt', '', k), el('dd', cls ?? '', val))
    }
    row('무엇을', v.what)
    row('주소', v.url.startsWith('app:') ? '' : host, 'host')
    row('취소 조건', v.cancel)
    if (v.kind !== 'app') row('누를 버튼', `"${v.label}"`)
    row('얼마', v.amount, 'money')
    const no = el('button', 'btn-ghost', '거절')
    no.type = 'button'
    const yes = el('button', 'btn btn-approve', v.kind === 'app' ? '허용하기' : '승인하기')
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
    const look = button(
      'btn-ghost sm',
      () =>
        void api('/api/browser/focus', { method: 'POST', body: JSON.stringify({ tabId: rec.tabId }) }).catch(
          () => {},
        ),
      'Chrome에서 보기',
    )
    const doneBtn = button('btn sm', () => void send('다 했어요. 이어서 해 주세요.'), '다 했어요')
    if (rec.tabId === undefined) look.hidden = true
    card.append(el('div', 'handoff-actions', look, doneBtn))
  }
  return card
}

// ── 화면 바꾸기 ───────────────────────────────────────

async function show(view: View, id?: string) {
  const changed =
    state.view !== view || (id !== undefined && id !== (view === 'goal' ? state.goalId : state.threadId))
  state.view = view
  if (view === 'goal' && id) state.goalId = id
  if (view === 'thread' && id) state.threadId = id
  const main = $('main')
  main.dataset.view = view
  renderTabs()
  renderNow()
  renderHead()
  const box = $('messages')
  const keep = changed ? 0 : box.scrollTop
  if (view === 'talk') {
    renderTalk()
    renderSend()
    $('input').focus()
    return
  }
  if (view === 'connect') {
    await renderConnections(
      {
        api,
        box,
        setHeader: () => {},
        ask: (text) => void send(text),
      },
      id,
    )
    // 연결 표시가 바뀌었을 수 있다 (맞춤 아이디어)
    void loadServices()
      .then(renderTabs)
      .catch(() => {})
    return
  }
  if (view === 'thread') {
    await openSide(state.threadId ?? '')
    renderSend()
    $('input').focus()
    return
  }
  const page =
    view === 'feed'
      ? feedView(lifeCtx)
      : view === 'ideas'
        ? ideasView(lifeCtx)
        : view === 'goals'
          ? goalsView(lifeCtx)
          : view === 'goal'
            ? goalDetail(lifeCtx, state.goalId ?? '', () => void show('goals'))
            : libraryView(lifeCtx, state.libTab, (t) => {
                state.libTab = t
                void show('library')
              })
  box.replaceChildren(page)
  box.scrollTop = keep
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
    renderSend()
  }
  input.addEventListener('input', autosize)
  // 사진: 붙여 넣기 · 끌어 놓기
  input.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
    if (f) {
      e.preventDefault()
      void attachPhoto(f)
    }
  })
  const dock = $<HTMLFormElement>('composer')
  dock.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      dock.classList.add('dropping')
    }
  })
  dock.addEventListener('dragleave', () => dock.classList.remove('dropping'))
  dock.addEventListener('drop', (e) => {
    e.preventDefault()
    dock.classList.remove('dropping')
    void attachPhoto(e.dataTransfer?.files?.[0])
  })
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
    if (state.view === 'thread' && side) {
      // 따로 하는 대화: 답하는 중이면 멈추기, 아니면 그 대화로 보내기
      if (side.busy) {
        void api(`/api/threads/${encodeURIComponent(side.id)}/cancel`, { method: 'POST' }).catch(() => {})
        return
      }
      if (!text.trim()) return
      input.value = ''
      autosize()
      void sendSide(text)
      return
    }
    if (!text.trim() && !photo) {
      if (state.busy) void api('/api/conversation/cancel', { method: 'POST' }).catch(() => {})
      return
    }
    input.value = ''
    autosize()
    void send(text)
  })
  $('ideas-btn').onclick = () => void show('ideas')
  $('agent').onclick = () => setPanel(!state.panelOpen)
  $('device').onclick = () => setPanel(true, 'screen')

  // 두리 판: 넓은 창에서는 열어 둔 채로 쓴다 (사용자가 닫았으면 기억한다)
  let saved: string | null = null
  try {
    saved = localStorage.getItem('dool2.panel')
  } catch {}
  state.panelOpen = saved ? saved === 'open' : window.innerWidth >= 1180
  $('app').classList.toggle('panel-open', state.panelOpen)

  const [{ settings }] = await Promise.all([
    api<{ settings: Settings }>('/api/settings'),
    loadAgents(),
    loadConversation(),
    loadWaiting().catch(() => {}),
    loadExtension().catch(() => undefined),
    loadLife().catch(() => {}),
    loadServices().catch(() => {}),
    loadThreads().catch(() => {}),
  ])
  if (settings.aiChoice) state.choice = settings.aiChoice
  renderDevice(settings)
  renderSend()
  void connectLive()
  // 확장·승인·로그인 요청을 새로 본다 (폰에서 한 일도 보이게). 창이 앞에 있을 때만 3초마다, 뒤에 있으면 15초마다
  let polledAt = 0
  setInterval(() => {
    const clock = document.getElementById('work-clock')
    if (clock && state.turn) clock.textContent = elapsed(Math.floor((Date.now() - state.turn.started) / 1000))
    if (!document.hasFocus() && Date.now() - polledAt < 15_000) return
    polledAt = Date.now()
    void loadExtension().catch(() => {})
    void loadWaiting().catch(() => {})
  }, 3_000)
  // 창으로 돌아오면 바로 새로 본다
  window.addEventListener('focus', () => {
    polledAt = Date.now()
    void loadExtension().catch(() => {})
    void loadWaiting().catch(() => {})
  })

  // 점검 모드: "화면[:id][+panel:칸|+nopanel]"으로 그 화면을 열어 캡처한다
  // 예: feed, ideas, goals, goal(첫 목표), library:files, connections:coupang, thread(최근), talk+panel:memory
  const [smoke = '', ...opts] = (cfg.smokeOpen ?? '').split('+')
  const [smokeView, smokeId] = smoke.split(':')
  for (const o of opts) {
    if (o === 'nopanel') setPanel(false)
    else if (o.startsWith('panel:')) setPanel(true, o.slice(6) as PanelTab)
  }
  if (smokeView === 'connections') await show('connect', smokeId)
  else if (smokeView === 'feed' || smokeView === 'ideas' || smokeView === 'goals') await show(smokeView)
  else if (smokeView === 'library') {
    if (smokeId === 'files') state.libTab = 'files'
    await show('library')
  } else if (smokeView === 'goal') await show('goal', smokeId || state.life.routines[0]?.id)
  else if (smokeView === 'thread') await show('thread', smokeId || state.threads[0]?.id)
  else if (smokeView === 'tasks') {
    setPanel(true, 'approvals')
    await show('talk')
  } else if (smokeView === 'me') {
    setPanel(true, 'screen')
    await show('talk')
  } else await show('talk')
  renderPanel('all')

  // 첫 실행이면 마법사를 띄운다. 점검 모드에서는 "단계:선택"(예: check:both)으로 바로 연다
  const [smokeStep, smokeChoice, smokeAction] = (cfg.smokeSetup ?? '').split(':')
  const start = [...SETUP_STEPS, 'settings'].includes(smokeStep as SetupStep)
    ? {
        step: smokeStep as SetupStep,
        choice: (smokeChoice || undefined) as AiChoice | undefined,
        action: (smokeAction || undefined) as CheckAction | undefined,
      }
    : undefined
  let savedSettings = settings
  openSetup = (from) => {
    const wizard = runSetup({
      api,
      settings: savedSettings,
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
      savedSettings = r.settings
      if (savedSettings.aiChoice) state.choice = savedSettings.aiChoice
      renderDevice(savedSettings)
      if (state.view === 'talk') input.focus()
    })
    return wizard.shown
  }
  let setup = 'done'
  if (start || !settings.setupDone) {
    await openSetup(start)
    setup = [start?.step ?? 'welcome', start?.action].filter(Boolean).join(':')
  }
  if (cfg.smokeAsk) {
    await send(cfg.smokeAsk)
    await new Promise((r) => setTimeout(r, cfg.smokeAskWait || 1500))
    for (let i = 0; i < 600 && state.busy && !cfg.smokeAskWait; i++)
      await new Promise((r) => setTimeout(r, 500))
  }
  const ready = readyAgents().map((a) => a.id)
  // 화면이 실제로 그려진 뒤에 알린다 (3D 두리가 뜰 틈을 조금 준다)
  await new Promise((r) => setTimeout(r, 600))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dool2.ready(
    `agents=${state.agents.length} ready=${ready.join(',') || 'none'} messages=${state.messages.length} setup=${setup} view=${state.view} life=${state.life.routines.length}/${state.life.feed.length}/${state.life.library.length}`,
  )
}

main().catch((err: Error) => {
  document.body.textContent = `두리를 시작하지 못했어요: ${err.message}`
  window.dool2?.ready(`error=${err.message}`)
})
