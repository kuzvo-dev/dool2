// Dool2 desktop window. Talks only to the dool2d local API (127.0.0.1 + token).
// Same layout as the phone (docs/design/screens/soft/pc.png): five tabs on the left (Chat · Feed · Ideas · Goals ·
// Library) · side chats · Connections · Settings, the current tab in the middle (Dool2 floating at the top), and the
// assistant panel on the right (Upcoming · Memory · Screen · Activity · Approvals). One conversation (ADR 0015).
import type {
  AgentEvent,
  AgentId,
  AgentStatus,
  AiChoice,
  ApprovalRecordMessage,
  ApprovalView,
  CardsRecordMessage,
  ChromeStatus,
  ConnectRecordMessage,
  ConversationLiveEvent,
  ConversationState,
  DaemonStreamEvent,
  ExtensionStatus,
  FeedItem,
  HandoffRecord,
  LeftRecordMessage,
  LibraryItem,
  LifeAction,
  LifeState,
  LoginRecordMessage,
  LoginRequestView,
  Settings,
  StepDetail,
  StoredMessage,
  TaskRecordMessage,
  TaskView,
  TellRecordMessage,
  ThreadSummary,
  UsageLimit,
  WorkRecordMessage,
} from '@dool2/protocol'
import type { ConnectionItem } from '@dool2/protocol/connect'
import { type BlockEnv, blockView } from './blocks-view.js'
import { findCard, socialOrder } from './connect-text.js'
import { renderConnections, SOCIAL_LABEL } from './connections.js'
import {
  button,
  doori,
  el,
  emptyState,
  type IconName,
  icon,
  liveDoori,
  setFileOpener,
  setRich,
  withLogo,
} from './dom.js'
import { lang, syncLang } from './lang.js'
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
import { appText } from './locales/app.js'
import { statsAsk } from './locales/stats-ask.js'
import { talkText } from './locales/talk.js'
import { type Page, Pager } from './paging.js'
import { FEED_THREAD_TITLE, LOGIN_BUSY_RE } from './region/kr/talk.js'
import {
  appNote,
  finishProgress,
  handoffRecord,
  interimAnswers,
  narrationLine,
  readAppNote,
  splitPhoto,
  toolLabel,
  toolPlace,
} from './rich.js'
import { runSetup, type SettingsTab, type SetupOptions } from './setup.js'
import {
  type CheckAction,
  costLabel,
  neededAgents,
  planLabel,
  SETUP_STEPS,
  type SetupStep,
  spentLabel,
} from './setup-model.js'
import {
  AWAY_MIN_MS,
  actDone,
  awaySummary,
  doneLine,
  groupSteps,
  type PlaceCard,
  type WorkGroup,
  type WorkStepIn,
} from './work-steps.js'

/** Copy in the current language (read on every call, so a language switch shows up on the next render) */
const A = () => appText(lang)
/** Answers whose folded earlier answers the user opened */
const openEarlier = new Set<string>()
const T = () => talkText(lang)

declare global {
  interface Window {
    dool2: {
      config(): Promise<{
        url: string
        token: string
        smokeOpen?: string
        smokeSetup?: string
        smokeNoAi?: boolean
        smokeAsk?: string
        smokeAskWait?: number
      }>
      ready(summary: string): void
      extensionDir(): Promise<string>
      revealExtension(): void
      storeExtension(): Promise<string | null>
      openStore(): void
      update: {
        state(): Promise<UpdateView | null>
        install(): Promise<UpdateView | null>
        check(): Promise<UpdateView | null>
        version(): Promise<string>
        onChange(cb: (s: UpdateView) => void): void
      }
    }
  }
}

/** Asked once of people who already finished setup: may we send usage stats (numbers only)? (Settings → General changes it anytime) */
function renderStatsAsk(settings: Settings) {
  const old = document.getElementById('stats-ask')
  if (!settings.setupDone || settings.usageStats !== undefined) {
    old?.remove()
    return
  }
  if (old) return
  const box = el('div', 'notice ask')
  box.id = 'stats-ask'
  const answer = (v: boolean) => async () => {
    box.remove()
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ usageStats: v }) }).catch(() => {})
  }
  const m = statsAsk(lang)
  const actions = el('div', 'ask-actions')
  actions.append(button('btn-small', answer(true), m.yes), button('btn-ghost', answer(false), m.no))
  box.append(el('strong', 'ask-title', m.title), el('span', 'notice-text', m.body), actions)
  $('notice').after(box)
}

/**
 * Static text in index.html in the current language: `data-t` sets the text, `data-t-aria` the aria-label and
 * `data-t-title` the tooltip, all with keys from locales/app.ts
 */
function renderStatic() {
  const m = A()
  const text = (key: string | undefined) => {
    const v = key ? (m as Record<string, unknown>)[key] : undefined
    return typeof v === 'string' ? v : ''
  }
  document.documentElement.lang = lang
  document.title = m.docTitle
  for (const n of document.querySelectorAll<HTMLElement>('[data-t]')) n.textContent = text(n.dataset.t)
  for (const n of document.querySelectorAll<HTMLElement>('[data-t-aria]'))
    n.setAttribute('aria-label', text(n.dataset.tAria))
  for (const n of document.querySelectorAll<HTMLElement>('[data-t-title]')) n.title = text(n.dataset.tTitle)
  renderSend()
}

/** New version (UpdateState in apps/desktop/src/update.ts) */
interface UpdateView {
  status: 'idle' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  current: string
  latest?: string
  notes?: string
  required?: boolean
  progress?: number
  error?: string
}

/** New-version strip (top left) + a full-window notice when the update is required (ADR 0028) */
function renderUpdate(u: UpdateView | null) {
  const box = $('update')
  const wall = $('update-wall')
  const show =
    !!u && !!u.latest && ['available', 'downloading', 'ready', 'installing', 'error'].includes(u.status)
  const busy = u?.status === 'downloading' || u?.status === 'ready' || u?.status === 'installing'
  const line = !u
    ? ''
    : busy
      ? u.status === 'downloading'
        ? A().updDownloading(Math.round((u.progress ?? 0) * 100))
        : A().updInstalling
      : u.status === 'error' && u.latest
        ? A().updFailed(u.error ?? '')
        : A().updAvailable(u.latest ?? '')
  const go = () => {
    void window.dool2.update.install().then((s) => renderUpdate(s))
    renderUpdate(u ? { ...u, status: 'downloading', progress: u.progress ?? 0 } : null)
  }
  box.hidden = !show || !!u?.required
  if (!box.hidden && u) {
    const act = busy
      ? el('span', 'muted', '')
      : button('btn-small', go, u.status === 'error' ? A().retry : A().update)
    box.replaceChildren(el('span', 'notice-text', line), act)
    box.title = u.notes ?? ''
  }
  wall.hidden = !show || !u?.required
  if (!wall.hidden && u) {
    const card = el('div', 'update-card')
    card.append(
      el('h2', '', A().updWallTitle),
      el('p', '', A().updWallBody(u.current)),
      ...(u.notes ? [el('p', 'muted', A().updNotes(u.notes))] : []),
      el('p', 'update-line', busy || u.status === 'error' ? line : ''),
      busy
        ? el('span', '', '')
        : button('btn', go, u.status === 'error' ? A().retry : A().updTo(u.latest ?? '')),
    )
    wall.replaceChildren(card)
  }
}

const agentLabel = (id: AgentId): string =>
  id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : A().apiKey
const limitLabel = (kind: string): string => {
  if (kind === 'five_hour') return A().limit5h
  if (kind === 'one_day') return A().limitDay
  if (kind === 'seven_day') return A().limitWeek
  if (kind === 'month') return A().limitMonth
  // Other windows come as minutes ("90m"): hours or days for people
  const mins = Number(/^(\d+)m$/.exec(kind)?.[1])
  if (!mins) return kind
  return mins % 1440 === 0 ? A().limitDays(mins / 1440) : A().limitHours(Math.max(1, Math.round(mins / 60)))
}
const examples = () => [T().ex1, T().ex2, T().ex3]

/** Five tabs on the left + Connections + side chats + goal detail */
type View = 'talk' | 'feed' | 'ideas' | 'goals' | 'goal' | 'library' | 'connect' | 'thread'
type Tab = 'talk' | 'feed' | 'ideas' | 'goals' | 'library'
const TABS: [Tab, IconName, () => string][] = [
  ['talk', 'chat', () => A().tabTalk],
  ['feed', 'feed', () => A().tabFeed],
  ['ideas', 'idea', () => A().tabIdeas],
  ['goals', 'goal', () => A().tabGoals],
  ['library', 'library', () => A().tabLibrary],
]
/** Sections of the assistant panel */
type PanelTab = 'schedule' | 'memory' | 'screen' | 'activity' | 'approvals'
/** Where the Screen tab's timeline comes from (a chat line opens it) */
type WorkSrc = { kind: 'live' } | { kind: 'rec'; rec: WorkRecordMessage } | { kind: 'task'; id: string }
const PANEL_TABS: [PanelTab, IconName, () => string][] = [
  ['schedule', 'clock', () => A().pSchedule],
  ['memory', 'brain', () => A().pMemory],
  ['screen', 'pc', () => A().pScreen],
  ['activity', 'list', () => A().pActivity],
  ['approvals', 'hand', () => A().pApprovals],
]

/** The turn running now (shown on the panel's Screen and as "working" under the chat) */
interface Turn {
  ask: string
  started: number
  steps: string[]
  /** What the tool did and where, per step (same order as steps; grouped into one row per service) */
  info: { act: string; place?: string; at: number; detail?: StepDetail[] }[]
  /** Last site opened */
  host?: string
  activity: string
  text: string
  usd: number
  /** Hand-off, approval and login records from this turn (shown as cards under the answer) */
  records: string[]
}

const state: {
  url: string
  token: string
  agents: AgentStatus[]
  extension?: ExtensionStatus
  /** AI subscription picked in first setup */
  choice?: AiChoice
  view: View
  /** Id of the open goal detail or side chat */
  goalId?: string
  threadId?: string
  libTab: LibraryTab
  panelOpen: boolean
  panelTab: PanelTab
  /** What the Screen tab shows: the work running now, or the one a chat line was clicked for */
  workSrc?: WorkSrc
  messages: StoredMessage[]
  hasMore: boolean
  busy: boolean
  /** The last answer is a draft being checked before it is final (ADR 0027) */
  checking: boolean
  /** Tasks handed over in the conversation (ADR 0038), by id */
  tasks: Map<string, TaskView>
  queued: string[]
  turn?: Turn
  /** Last finished turn (kept on the panel while resting) */
  lastTurn?: { ask: string; steps: string[]; info: Turn['info']; seconds: number }
  approvals: ApprovalView[]
  logins: LoginRequestView[]
  life: LifeState
  services: ConnectionItem[]
  /** Services the daemon is logging in to right now */
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
  checking: false,
  tasks: new Map(),
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
    throw new Error(body.error ?? A().requestFailed(res.status))
  }
  return (await res.json()) as T
}

// ── Time ─────────────────────────────────────────────

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : lang, {
    hour: '2-digit',
    minute: '2-digit',
    // Korean screens have always shown 24-hour time; English uses the locale's clock
    ...(lang === 'ko' ? { hour12: false } : {}),
  })

const elapsed = (sec: number) =>
  sec < 60
    ? A().seconds(sec)
    : `${A().minutes(Math.floor(sec / 60))} ${A().seconds(String(sec % 60).padStart(2, '0'))}`

const cut = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Opens a PC file (file links in answers, Library). With reveal, shows it in Finder or Explorer */
async function openPcFile(path: string, reveal = false) {
  try {
    const r = await api<{ how: 'open' | 'reveal' }>('/api/files/open', {
      method: 'POST',
      body: JSON.stringify({ path, ...(reveal ? { reveal } : {}) }),
    })
    if (r.how === 'reveal' && !reveal) toast(T().openedInFolder)
  } catch (e) {
    toast((e as Error).message)
  }
}
setFileOpener((path) => void openPcFile(path))

// ── Toast ────────────────────────────────────

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

// ── Connection status (this computer) ─────────────────────────────

function agentState(a: AgentStatus): { cls: string; text: string } {
  if (!a.installed) return { cls: 'stop', text: A().needInstall }
  if (!a.loggedIn) return { cls: 'ask', text: A().needLogin }
  return { cls: 'work', text: a.plan ? planLabel(a.plan) : A().ready }
}
const readyAgents = () => state.agents.filter((a) => a.installed && a.loggedIn)

/** Opens the first-run wizard (set in main) */
let openSetup: (start?: SetupOptions['start']) => Promise<void> = async () => {}
/** Settings, if open (an in-app page). Closed when the left menu goes to another screen */
let settingsOpen: { close(): void } | undefined
// Pressing the left menu (tabs, Connections, side chats, Now) while Settings is open closes Settings and goes there
document.addEventListener(
  'click',
  (e) => {
    const t = e.target as HTMLElement
    const b = t.closest('.side button, .side a')
    if (settingsOpen && b && !b.classList.contains('on') && !t.closest('.notice')) settingsOpen.close()
  },
  true,
)

/** One status row. If something needs doing, the whole row is a button */
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
        [a.version && `v${a.version}`, a.plan && A().planSub(planLabel(a.plan))]
          .filter(Boolean)
          .join(' · ') || s.text
      let onClick: (() => void) | undefined
      if (a.id === 'opencode') {
        // Add, change or remove the API key (Settings → AI)
        onClick = () => void openSetup({ step: 'settings', tab: 'ai', action: 'payg-key' })
      } else if (!a.installed && (a.id === 'claude' || a.id === 'codex')) {
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
      return statRow(agentLabel(a.id), s.cls, s.text, title, onClick)
    })
}

function extensionRow() {
  const ext = state.extension
  return ext?.connected
    ? statRow(
        A().chromeExt,
        'work',
        A().connected,
        [ext.browser, ext.version && A().extVersion(ext.version)].filter(Boolean).join(' · '),
      )
    : statRow(
        A().chromeExt,
        'ask',
        A().connect,
        A().extNeedForWeb,
        () => void openSetup({ step: 'check', action: 'extension-install' }),
      )
}

/** Opens the step that connects an AI: the API key form for pay-as-you-go, else the readiness check */
function connectAi() {
  if (state.choice === 'payg') return openSetup({ step: 'settings', tab: 'ai', action: 'payg-key' })
  return openSetup({ step: 'check', choice: state.choice ?? 'unsure' })
}

/** "This PC" at the top right + the self-check notice at the top left */
function renderDevice(settings?: Settings) {
  const ready = readyAgents().length > 0
  const pill = $('device')
  pill.querySelector('.dot')?.setAttribute('class', `dot ${ready ? 'work' : ''}`)
  $('device-text').textContent = ready ? A().deviceText : A().deviceNeedsSetup
  pill.title = ready ? (state.extension?.connected ? A().deviceCanWork : A().deviceNeedExt) : A().noAi
  if (state.panelOpen && state.panelTab === 'screen') renderPanel('live')
  if (!settings) return
  const box = $('notice')
  box.hidden = !settings.setupDone || ready
  if (box.hidden) return
  const fix = button('btn-small', () => void connectAi(), A().fix)
  box.replaceChildren(el('span', 'notice-text', A().noAi), fix)
}

/** Smoke screenshots of a PC with no AI ready (DOOL2_SMOKE_NO_AI) */
let smokeNoAi = false

async function loadAgents() {
  const { agents } = await api<{ agents: AgentStatus[] }>('/api/agents')
  const wasNoAi = noAiReady()
  state.agents = smokeNoAi ? agents.map((a) => ({ id: a.id, installed: false, loggedIn: false })) : agents
  renderSpend()
  renderDevice()
  renderHead()
  // The empty chat says "connect an AI" while none is ready: redraw it when that changes
  if (wasNoAi !== noAiReady()) renderTalk()
}

async function loadExtension() {
  const { extension } = await api<{ extension: ExtensionStatus }>('/api/browser/extension')
  const changed = JSON.stringify(extension) !== JSON.stringify(state.extension)
  const flipped = extension.connected !== state.extension?.connected
  state.extension = extension
  if (changed) renderDevice()
  // Connected services' chips in the chat depend on it
  if (flipped && state.view === 'talk') renderTalk()
  return extension
}

/** Waiting approvals and logins ("Now" on the left, Approvals on the panel) */
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

// ── Goals · Library · Memory · Feed ─────────────────────────────

/** Long lists: the first page comes with /api/life, scrolling down fetches and appends the next page */
const pageQuery = (before?: string, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams(extra)
  if (before) q.set('before', before)
  return q.toString()
}
const feedPager: Pager<FeedItem> = new Pager<FeedItem>(
  (f) => f.at,
  (before) =>
    void api<Page<FeedItem>>(`/api/life/feed?${pageQuery(before)}`)
      .then((p) => feedPager.take(before, p))
      .catch(() => {}),
  () => renderLists(),
)
const libPagers: Record<LibraryTab, Pager<LibraryItem>> = {
  made: libPager('made'),
  files: libPager('files'),
}
function libPager(tab: LibraryTab): Pager<LibraryItem> {
  const p: Pager<LibraryItem> = new Pager<LibraryItem>(
    (it) => it.savedAt,
    (before) =>
      void api<Page<LibraryItem>>(`/api/life/library?${pageQuery(before, { tab })}`)
        .then((page) => p.take(before, page))
        .catch(() => {}),
    () => renderLists(),
  )
  return p
}
/** Panel activity: finished and scheduled tasks only (fetches its own first page too) */
const activityPager: Pager<FeedItem> = new Pager<FeedItem>(
  (f) => f.at,
  (before) =>
    void api<Page<FeedItem>>(`/api/life/feed?${pageQuery(before, { kinds: 'done,routine' })}`)
      .then((p) => activityPager.take(before, p))
      .catch(() => {}),
  () => {
    if (state.panelTab === 'activity') renderPanel('life')
  },
)

/** Applies the fetched first page to each list (pages fetched beyond it stay) */
function takeLife(life: LifeState) {
  state.life = life
  feedPager.take(undefined, { items: life.feed, ...(life.feedNext ? { next: life.feedNext } : {}) })
  for (const tab of ['made', 'files'] as const) {
    const next = life.libraryNext?.[tab]
    libPagers[tab].take(undefined, {
      items: life.library.filter((it) => (tab === 'files' ? it.kind === 'file' : it.kind !== 'file')),
      ...(next ? { next } : {}),
    })
  }
  if (activityPager.started || state.panelTab === 'activity') activityPager.refresh()
}

/** When a next page arrives, redraws only the screen showing that list (not while typing) */
function renderLists() {
  const box = $('messages')
  const typing = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement)
  if ((state.view === 'feed' || state.view === 'library') && !typing) void show(state.view)
}

/** Next page when scrolled near the bottom (Feed, Library, panel Activity) */
function moreNearBottom(box: HTMLElement, pager: () => Pager<{ id: string }> | undefined) {
  box.addEventListener(
    'scroll',
    () => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 600) pager()?.more()
    },
    { passive: true },
  )
}

async function loadLife() {
  takeLife(await api<LifeState>('/api/life'))
  onLifeChanged()
}

/** When life records change, redraws only that screen (not while typing) */
function onLifeChanged() {
  renderPanel('life')
  // Proactive-check cards in the chat: update them too if answered on the phone or in the Feed
  for (const c of document.querySelectorAll<HTMLElement>('.tell-card[data-rec]'))
    c.replaceWith(tellCard(JSON.parse(c.dataset.rec ?? '{}') as TellRecordMessage))
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
    // Show changes to items beyond the first page right away (the new first page only covers the top)
    for (const p of [feedPager, activityPager]) {
      if (a.action === 'feed-react')
        p.patch(a.id, (f) => {
          const { reaction: _r, ...rest } = f
          return a.reaction ? { ...rest, reaction: a.reaction } : rest
        })
      if (a.action === 'feed-answer') p.patch(a.id, (f) => (f.answered ? f : { ...f, answered: a.answer }))
    }
    if (a.action === 'library-delete') for (const p of Object.values(libPagers)) p.remove(a.id)
    takeLife(r.state)
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
  feedList: () => feedPager,
  libraryList: (tab) => libPagers[tab],
  activityList: () => activityPager,
  openFile: (path, reveal) => void openPcFile(path, reveal),
  libraryFull: async (id) =>
    (await api<{ item?: LibraryItem }>(`/api/life/library/${encodeURIComponent(id)}`)).item,
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
            el('span', 'side-t', state.turn?.steps.length ? state.turn.activity : A().answering),
            state.turn?.ask ? el('span', 'meta', cut(state.turn.ask, 40)) : undefined,
          ),
          el('span', 'side-when meta', A().now),
        )
      : undefined,
}

/** Puts text in the chat input and goes to Chat (making a goal, following up) */
function compose(text: string) {
  void show('talk').then(() => {
    const input = $<HTMLTextAreaElement>('input')
    input.value = text
    input.dispatchEvent(new Event('input'))
    input.focus()
    input.setSelectionRange(text.length, text.length)
  })
}

// ── Side chats (topic chats kept out of the main chat) ─────

/** The side chat open now */
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
/** Side chats shown at first in the left list (same as SIDE_THREAD_PEEK in protocol). The rest are under "show more" */
const SIDE_PEEK = 8
/** Whether the left list shows every side chat */
let sideAll = false

async function loadThreads() {
  const { threads } = await api<{ threads: ThreadSummary[] }>('/api/threads')
  // The thread that writes feed posts is not listed (its results go to the Feed)
  state.threads = threads.filter((t) => t.side && t.title !== FEED_THREAD_TITLE)
  renderThreads()
}

function renderThreads() {
  const open = state.view === 'thread' ? state.threadId : undefined
  // Chats that are answering, waiting for approval or open now move to the front so they show even when collapsed
  const pinned = state.threads.filter((t) => t.busy || t.approval || t.id === open)
  const ordered = [...pinned, ...state.threads.filter((t) => !pinned.includes(t))]
  const list = sideAll ? ordered : ordered.slice(0, SIDE_PEEK)
  const more = ordered.length - list.length
  const pencil = button('icon-btn side-new', () => void newSide(), icon('pencil'))
  pencil.setAttribute('aria-label', A().newSide)
  pencil.title = A().newShort
  $('threads-head').replaceChildren(el('span', 'grow', A().threadsHead), pencil)
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
      : [el('p', 'meta thread-empty', A().sideEmpty)]),
    ...(more > 0 || (sideAll && ordered.length > SIDE_PEEK)
      ? [
          button(
            'navi thread-item thread-more',
            () => {
              sideAll = !sideAll
              renderThreads()
            },
            el('span', '', sideAll ? A().collapse : A().more(more)),
            icon('chevron', sideAll ? 'i more-chev open' : 'i more-chev'),
          ),
        ]
      : []),
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
    box.replaceChildren(el('div', 'page', emptyState('', A().threadNotFound, A().threadNotFoundBody)))
    return
  }
  renderSide()
}

/** Side chat screen: title · delete / messages / input at the bottom (same place as the main chat) */
function renderSide() {
  const sd = side
  if (!sd || state.view !== 'thread' || state.threadId !== sd.id) return
  const box = $('messages')
  const list = el('div', 'thread')
  let prev = ''
  for (const m of sd.messages) {
    if (m.role === 'tool') {
      // Quick replies go to the main chat, so they are not drawn in side chats
      if (!m.text.includes('"kind":"quick"')) list.append(toolCard(m.text, false))
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
      if (sd.busy) return toast(A().cantDeleteBusy)
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1'
        del.classList.add('armed')
        del.replaceChildren(A().pressAgain)
        setTimeout(() => {
          del.dataset.armed = ''
          del.classList.remove('armed')
          del.replaceChildren(icon('trash'), A().delete)
        }, 3000)
        return
      }
      void api(`/api/threads/${encodeURIComponent(sd.id)}`, { method: 'DELETE' })
        .then(async () => {
          side = undefined
          toast(A().deleted)
          await loadThreads().catch(() => {})
          await show('talk')
        })
        .catch((e: Error) => toast(e.message))
    },
    icon('trash'),
    A().delete,
  )
  box.replaceChildren(
    el(
      'div',
      // Same width as the main chat (uses the 760px column set by .messages)
      'page side-page',
      el(
        'header',
        'side-head',
        el(
          'div',
          'grow',
          el('h1', 'title-2', sd.title),
          el('p', 'cap', A().sideStarted(dayLabel(sd.createdAt))),
        ),
        del,
      ),
      sd.messages.length || sd.busy
        ? list
        : el(
            'div',
            'card side-hint',
            el('div', 'card-label', doori('', 22), A().sideHintTitle),
            el('p', '', A().sideHintBody),
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
        el('span', 'shimmer', side.steps.length ? `${side.steps.at(-1)}…` : A().thinkingDots),
      ),
    )
  }
  live.replaceChildren(...parts)
  renderSend()
}

/** Sends to the side chat. Progress is drawn from the live stream (marked side) */
async function sendSide(text: string) {
  const sd = side
  if (!sd || !text.trim()) return
  if (sd.busy) return toast(A().sideStillAnswering)
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
      throw new Error(body.error ?? A().sendFailed(res.status))
    }
    // Read the response to the end so the turn is not cut (closing it stops the daemon's turn)
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

/** A side chat turn from the live stream */
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
      const label = narrationLine(sd.live, lang) ?? A().doing(ev.title ?? toolLabel(ev.name, lang))
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

// ── Head: floating Dool2 + one status line ─────────────────────

function moodNow(): { mood: string; line: string; cls: string } {
  const waiting = pendingApprovals().length + pendingLogins().length
  if (state.busy)
    return {
      mood: 'working',
      line: state.turn?.activity && state.turn.steps.length ? state.turn.activity : A().workingHere,
      cls: '',
    }
  if (waiting)
    return {
      mood: 'asking',
      line: pendingApprovals().length ? A().waitApproval : A().waitLogin,
      cls: 'ask',
    }
  // Not asleep but waiting for an AI: a sleeping Dool2 here read as "stuck asleep" (mail inquiries)
  if (noAiReady()) return { mood: 'asking', line: A().noAiShort, cls: 'ask' }
  return { mood: '', line: A().resting, cls: 'off' }
}

function renderHead() {
  const m = moodNow()
  const av = $('head-av')
  const d = liveDoori('head', m.mood, 52)
  if (d.parentElement !== av) av.replaceChildren(d)
  d.classList.toggle('bob', state.busy)
  $('head-tag').replaceChildren(A().doori, el('span', m.cls, cut(m.line, 22)))
  $('agent').setAttribute('aria-expanded', String(state.panelOpen))
  if (state.panelOpen) renderPanelTop()
}

/**
 * Pay as you go has no usage window to fill: the strip says what this month's answers cost instead (first-run test
 * 11-26: people asked to see what they spend)
 */
function renderSpend() {
  if (state.choice !== 'payg') return
  const spent = state.agents.find((a) => a.id === 'opencode' && a.loggedIn)?.spent
  const box = $('usage')
  box.hidden = !spent
  if (spent) box.replaceChildren(el('div', 'u', el('span', '', A().spentMonth(spentLabel(spent.usd)))))
}

function renderUsage(limits: UsageLimit[]) {
  const box = $('usage')
  box.hidden = limits.length === 0
  box.replaceChildren(
    ...limits.map((l) => {
      const fill = el('i', l.percent >= 80 ? 'hi' : '')
      fill.style.width = `${Math.min(100, l.percent)}%`
      return el('div', 'u', el('span', '', A().usage(limitLabel(l.kind), l.percent)), el('div', 'bar', fill))
    }),
  )
}

// ── Left: tabs · Now · Connections · Settings ──────────────────────

function renderTabs() {
  const waiting = pendingApprovals().length + pendingLogins().length
  const current: Tab | undefined = settingsOpen
    ? undefined
    : state.view === 'goal'
      ? 'goals'
      : TABS.some(([t]) => t === state.view)
        ? (state.view as Tab)
        : undefined
  $('tabs').replaceChildren(
    ...TABS.map(([id, ic, label]) => {
      const b = button('navi', () => void show(id), icon(ic, 'i md'), el('span', 'grow', label()))
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
  const connect = button(
    'navi',
    () => void show('connect'),
    icon('apps', 'i md'),
    el('span', 'grow', A().tabConnect),
  )
  if (state.view === 'connect' && !settingsOpen) {
    connect.classList.add('on')
    connect.setAttribute('aria-current', 'page')
  }
  const connected = state.services.filter((s) => s.connectedAt).length
  if (connected) connect.append(el('span', 'meta', String(connected)))
  const gear = button(
    'navi',
    () => void (settingsOpen ? undefined : openSetup({ step: 'settings' })),
    icon('gear', 'i md'),
    el('span', 'grow', A().tabSettings),
  )
  if (settingsOpen) {
    gear.classList.add('on')
    gear.setAttribute('aria-current', 'page')
  }
  $('side-foot').replaceChildren(connect, gear)
  renderThreads()
}

/** Current task · bars for approvals and logins waiting on me ("Now" on the left, top of the Feed) */
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
          el('b', '', cut(state.turn.ask || A().dooriWorking, 24)),
          el('br'),
          el('span', 'meta', state.turn.steps.length ? state.turn.activity : A().thinking),
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
          el('b', '', cut(a.what || A().approval, 24)),
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
        el('span', 'grow', el('b', '', A().siteLogin(l.site)), el('br'), el('span', 'meta', A().needIdPw)),
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

// ── Right: assistant panel ───────────────────────────────────

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
    ? A().statusWorking
    : noAiReady()
      ? A().noAiShort
      : m.mood === 'asking'
        ? A().statusWaiting
        : A().statusResting
  top.replaceChildren(
    el('span', 'panel-av', d),
    el('h2', 'title-2', A().doori),
    el(
      'p',
      'meta panel-status',
      el('i', `dot ${state.busy ? 'work pulse' : m.mood === 'asking' ? 'ask' : ''}`),
      status,
    ),
  )
}

/** Draws the assistant panel. live = changes while working (Screen, Approvals), life = life records (Upcoming, Memory, Activity) */
function renderPanel(reason: 'live' | 'life' | 'all' = 'live') {
  const panel = $('panel')
  if (!state.panelOpen) {
    if (panel.childElementCount) panel.replaceChildren()
    return
  }
  if (!document.getElementById('panel-top')) {
    const close = button('fbtn panel-close', () => setPanel(false), icon('close'))
    close.setAttribute('aria-label', A().closePanel)
    const top = el('div', 'panel-top')
    top.id = 'panel-top'
    const seg = el('div', 'seg panel-tabs')
    seg.id = 'panel-tabs'
    const body = el('div', 'panel-body')
    body.id = 'panel-body'
    moreNearBottom(body, () => (state.panelTab === 'activity' ? activityPager : undefined))
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
        label(),
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
  // Do not redraw while typing in Memory
  const body = $('panel-body')
  if (
    reason !== 'all' &&
    document.activeElement instanceof HTMLInputElement &&
    body.contains(document.activeElement)
  )
    return
  // Activity fetches its first page when first opened
  if (tab === 'activity' && !activityPager.started) activityPager.refresh()
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
  const y = body.scrollTop
  body.replaceChildren(content)
  if (reason !== 'all') body.scrollTop = y
}

/** Screen: the timeline of the work running now, or of the one a chat line was clicked for (same as the phone's sheet) */
function screenTab(): HTMLElement {
  const box = el('div', 'screen-tab')
  const t = state.turn
  const src = state.workSrc
  const card = (title: string, meta: string, steps: WStep[], running: boolean, foot: HTMLElement[]) =>
    el(
      'article',
      `workcard work-sheet${running ? '' : ' quiet'}`,
      el('div', 'workcard-head ws-head', el('b', '', title), el('span', 'meta', meta)),
      workTimeline(steps, running),
      ...(foot.length ? [el('div', 'workcard-foot', el('span', 'grow'), ...foot)] : []),
    )
  const draftOf = (text: string) => {
    const d = el('details', 'wc-draft')
    const body = el('div', 'rich')
    setRich(body, text)
    d.append(el('summary', '', A().seeDraft), body)
    return d
  }
  if (src?.kind === 'rec') {
    const rec = src.rec
    box.append(
      card(
        T().workLog,
        T().stepsTime(rec.count, secs(rec.ms)),
        rec.steps.map((x) => ({ ...x, act: x.act ?? x.text })),
        false,
        [],
      ),
    )
  } else if (src?.kind === 'task' && state.tasks.get(src.id)) {
    const v = state.tasks.get(src.id) as TaskView
    const ended = v.status === 'done' || v.status === 'stopped' || v.status === 'failed'
    const from = Date.parse(v.startedAt ?? v.createdAt)
    const act = (what: 'stop' | 'accept') => () =>
      void api(`/api/tasks/${encodeURIComponent(v.id)}/${what}`, { method: 'POST' }).catch(() => {})
    const foot: HTMLElement[] = []
    if (!ended && (v.draft || v.continuing)) foot.push(button('btn-ghost sm', act('accept'), A().takeAsIs))
    if (!ended) foot.push(button('btn-text sm wc-stop', act('stop'), A().stopWork))
    const c = card(
      v.title,
      ended && v.endedAt ? T().stepsTime(v.count, secs(Date.parse(v.endedAt) - from)) : clockText(from),
      v.steps.map((x) => ({ ...x, act: x.act ?? x.text })),
      !ended && v.status !== 'needs-you',
      foot,
    )
    if (v.draft) c.insertBefore(draftOf(v.draft), c.querySelector('.workcard-foot'))
    box.append(c)
  } else if (state.busy && t) {
    const fp = finishProgress(state.messages, { running: true, checking: state.checking })
    const draftMsg = fp?.draft ? state.messages.find((m) => m.id === fp.draft) : undefined
    const writing = t.text && t.steps.length ? t.text : ''
    const foot: HTMLElement[] = []
    if (draftMsg)
      foot.push(
        button(
          'btn-ghost sm',
          () => void api('/api/conversation/accept', { method: 'POST' }).catch(() => {}),
          A().takeAsIs,
        ),
      )
    foot.push(
      button(
        'btn-danger sm',
        () => void api('/api/conversation/cancel', { method: 'POST' }).catch(() => {}),
        icon('stop'),
        A().stop,
      ),
    )
    const c = card(cut(t.ask || A().yourRequest, 28), '', turnSteps(t.steps, t.info) as WStep[], true, foot)
    const clock = c.querySelector<HTMLElement>('.ws-head .meta')
    if (clock) clock.id = 'work-clock'
    if (!t.steps.length)
      c.querySelector('.wtl')?.append(
        el('li', 'wtl-say', el('span', 'wtl-dot'), el('span', '', A().deciding)),
      )
    const draftText = writing || draftMsg?.text
    if (draftText) c.insertBefore(draftOf(draftText), c.querySelector('.workcard-foot'))
    box.append(c)
  } else if (state.lastTurn?.steps.length) {
    const lt = state.lastTurn
    box.append(
      card(
        cut(lt.ask, 28),
        A().didSteps(lt.steps.length, elapsed(lt.seconds)),
        turnSteps(lt.steps, lt.info, Date.now()) as WStep[],
        false,
        [],
      ),
    )
  } else if (state.agents.length && !readyAgents().length) {
    // No AI to work with: a sleeping Dool2 with "Resting right now" read as "Dool2 is stuck asleep".
    // Say what wakes it up and open the step that does it
    box.append(
      emptyState(
        'asking',
        A().noAiTitle,
        A().noAiBody,
        button('btn', () => void connectAi(), A().connectAi),
      ),
    )
  } else {
    box.append(emptyState('sleeping', A().restingTitle, A().restingBody))
  }
  if (state.queued.length)
    box.append(
      el(
        'section',
        'panel-sec',
        el('h3', 'over', A().nextUp),
        ...state.queued.map((q) =>
          el(
            'div',
            'side-row',
            icon('chat', 'i md'),
            el('span', 'grow', el('span', 'side-t', cut(q, 40)), el('span', 'meta', A().nextUpNote)),
          ),
        ),
      ),
    )
  box.append(
    el(
      'section',
      'panel-sec',
      el('h3', 'over', A().thisComputer),
      el('div', 'stats', ...agentRows(), extensionRow()),
    ),
    el('p', 'panel-foot meta', icon('lock'), A().localOnly),
  )
  return box
}

function statusLabel(status: ApprovalView['status']): string {
  const m = A()
  const labels: Record<ApprovalView['status'], string> = {
    pending: m.stPending,
    approved: m.stApproved,
    done: m.stDone,
    rejected: m.stRejected,
    expired: m.stExpired,
    failed: m.stFailed,
  }
  return labels[status]
}

/** Approvals: waiting · past approvals */
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
        el('span', 'pill ask', A().awaitingApproval),
      ),
    )
  for (const l of pendingLogins())
    waiting.push(
      button(
        'side-row',
        () => void show('talk'),
        el('i', 'dot ask'),
        el('span', 'grow', el('span', 'side-t', A().siteLogin(l.site)), el('span', 'meta', A().needIdPw)),
        el('span', 'pill ask', A().awaitingInput),
      ),
    )
  box.append(
    el(
      'section',
      'panel-sec',
      el('h3', 'over', A().waitingHead),
      ...(waiting.length ? waiting : [el('p', 'cap', A().noneWaiting)]),
    ),
  )
  const done = state.approvals.filter((a) => a.status !== 'pending').slice(0, 20)
  box.append(
    el(
      'section',
      'panel-sec',
      el('h3', 'over', A().pastApprovals),
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
                el('span', 'meta', `${statusLabel(a.status)} · ${dayLabel(a.createdAt)}`),
              ),
              el('span', 'meta mono', a.amount ?? ''),
            ),
          )
        : [el('p', 'cap', A().pastEmpty)]),
    ),
    el('p', 'panel-foot meta', icon('shield'), A().alwaysAsk),
  )
  return box
}

// ── Chat ─────────────────────────────────────────────

/** Fetches the chat history and redraws */
async function loadConversation() {
  const s = await api<ConversationState>('/api/conversation?limit=150')
  state.messages = s.messages
  state.hasMore = s.hasMore
  state.queued = s.queued
  state.busy = s.busy
  state.checking = s.checking === true
  state.tasks = new Map((s.tasks ?? []).map((t) => [t.id, t]))
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
  // After a hand-off, keep [Done] active until the user says something
  const lastUser = state.messages.map((m) => m.role).lastIndexOf('user')
  // Hand-off and approval records are saved before the answer, but shown below it
  const order = state.messages.map((m, i) => ({ m, i }))
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k]
    const b = order[k + 1]
    // The work log stays above the answer
    if (a && b && a.m.role === 'tool' && b.m.role === 'assistant' && !a.m.text.includes('"kind":"work"')) {
      order[k] = b
      order[k + 1] = a
      k++
    }
  }
  let day = ''
  let prevRole = ''
  // One answer per request: answers the finish check sent back and replaced are folded (11-23)
  const fold = interimAnswers(state.messages, { running: state.busy })
  // The answer being checked or continued stays in the progress card as a draft, never as a message first (ADR 0027)
  const draft = finishProgress(state.messages, { running: state.busy, checking: state.checking })?.draft
  if (draft) fold.hidden.add(draft)
  const revealed = new Set([...fold.replaced].filter(([f]) => openEarlier.has(f)).flatMap(([, ids]) => ids))
  const roleOf = new Map(state.messages.map((x) => [x.id, x.role]))
  for (const { m, i } of order) {
    if (fold.hidden.has(m.id) && !revealed.has(m.id)) continue
    const earlier = fold.replaced.get(m.id)
    if (earlier) {
      const n = earlier.filter((id) => roleOf.get(id) === 'assistant').length
      const open = openEarlier.has(m.id)
      list.append(
        button(
          'btn-text sm earlier-answers',
          () => {
            if (open) openEarlier.delete(m.id)
            else openEarlier.add(m.id)
            renderTalk()
          },
          open ? A().hideEarlierAnswers : A().showEarlierAnswers(n),
        ),
      )
      prevRole = ''
    }
    const d = dayLabel(m.createdAt)
    if (d !== day) {
      day = d
      list.append(el('div', 'sep', d))
      prevRole = ''
    }
    if (m.role === 'tool') {
      // Quick replies and multi-picks need the user's next message to draw themselves dimmed or locked
      const used = /"kind":"quick"|"pick":"multi"/.test(m.text) ? saidAfter(state.messages, i) : undefined
      list.append(toolCard(m.text, i > lastUser, used))
      continue
    }
    const note = m.role === 'user' ? readAppNote(m.text) : undefined
    if (m.role === 'assistant' && prevRole !== 'assistant') list.append(who(m.createdAt))
    list.append(messageEl(m.role, m.text, note))
    prevRole = note !== undefined ? 'note' : m.role
  }
  const away = awayCard()
  if (away) list.append(away)
  const live = el('div', 'live')
  live.id = 'live'
  box.replaceChildren(list, live)
  renderLive()
  box.scrollTop = box.scrollHeight
}

function who(iso: string) {
  return el('div', 'who', doori(''), T().doori, el('span', 'meta', hhmm(iso)))
}

/** One message. Dool2's answers draw only paragraphs, lists and **bold** (never parsed as HTML) */
function messageEl(role: string, text: string, note?: string, tools = true): HTMLElement {
  if (role === 'user') {
    if (note !== undefined) return el('p', 'msg note', note)
    // A message with a photo: show the photo instead of the photo marker
    const { text: said, photo: sent } = splitPhoto(text)
    if (sent) {
      // Show the sent photo in the bubble (fetched from the daemon; shows "Photo" until then or if it fails)
      const chip = el('span', 'photo-chip', icon('image'), T().photo)
      void thumb(`photo:${sent}`).then((data) => {
        if (!data) return
        const img = document.createElement('img')
        img.className = 'sent-photo'
        img.alt = T().sentPhoto
        img.src = data
        chip.replaceWith(img)
      })
      return el('div', 'bubble me with-photo', chip, said)
    }
    return el('div', 'bubble me', text)
  }
  if (role === 'system') return el('p', 'sysline', el('i', 'dot stop'), text)
  const b = el('div', 'bubble rich')
  setRich(b, text)
  if (!tools || plain(text).length < 24) return b
  return el('div', 'answer', b, answerTools(text))
}

/** Small action under an answer: save to Library */
function answerTools(text: string) {
  const save = button(
    'btn-text sm',
    () => {
      save.disabled = true
      void lifeAct({ action: 'library-save', title: titleFrom(text), body: text, itemKind: 'note' }).then(
        () => {
          save.replaceChildren(icon('check'), T().savedToLibrary)
          toast(T().savedToLibrary)
        },
      )
    },
    icon('bookmark'),
    T().saveToLibrary,
  )
  return el('div', 'answer-tools', save)
}

/** m:ss since a time (the progress card shows elapsed time, never an estimate of what is left) */
const clockText = (from: number) => {
  const sec = Math.max(0, Math.floor((Date.now() - from) / 1000))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

/**
 * The work running now: one line in the chat (what it is doing, the time), like the phone. Its timeline, the draft,
 * take-as-is and stop are in the panel's Screen tab, which the line opens
 */
function progressCard(t: Turn | undefined): HTMLElement {
  const fp = finishProgress(state.messages, { running: state.busy, checking: state.checking })
  const writing = t?.text && t.steps.length ? t.text : ''
  const steps = (t ? turnSteps(t.steps, t.info) : []) as WStep[]
  const text = state.checking
    ? [A().checkingTitle]
    : fp?.rounds
      ? [fp.next ? A().continuingTitle(fp.next) : A().continuingPlain]
      : writing
        ? [A().writingTitle]
        : steps.length
          ? nowParts(steps)
          : [A().thinkingDots]
  const time = el('span', 'wl-meta wc-time', clockText(t?.started ?? Date.now()))
  time.dataset.from = String(t?.started ?? Date.now())
  return workLineEl('doing', wlDots(), text, time, () => openWork({ kind: 'live' }))
}

// ── Return summary: what happened while the person was away, from stored records (no AI) ──

const SEEN_KEY = 'dool2.seenAt'
/** When the person was last here, if it was long enough ago to sum up */
let awayFrom: number | undefined
function noteSeen() {
  localStorage.setItem(SEEN_KEY, String(Date.now()))
}
/** On opening or coming back: was the person away long enough? */
function checkAway() {
  const seen = Number(localStorage.getItem(SEEN_KEY))
  if (seen && Date.now() - seen >= AWAY_MIN_MS) awayFrom = seen
  noteSeen()
}

function awayCard(): HTMLElement | undefined {
  if (awayFrom === undefined) return undefined
  const s = awaySummary({
    since: awayFrom,
    now: Date.now(),
    feed: state.life.feed,
    approvals: state.approvals,
    logins: state.logins,
  })
  if (!s) return undefined
  const card = el('div', 'card quiet away-card', el('div', 'card-label', A().awayTitle))
  if (s.doneCount)
    card.append(
      el('p', '', A().awayDone(s.doneCount)),
      el('ul', '', ...s.done.map((d) => el('li', '', d.title))),
    )
  if (s.decidedCount)
    card.append(
      el('p', '', A().awayDecided(s.decidedCount)),
      el(
        'ul',
        '',
        ...s.decided.map((d) =>
          el('li', '', d.title, el('div', 'away-if', d.approved ? A().awayApproved : A().awayRejected)),
        ),
      ),
    )
  if (s.waiting.length)
    card.append(
      el('p', '', A().awayWaiting),
      el(
        'ul',
        '',
        ...s.waiting.map((w) =>
          el(
            'li',
            '',
            w.title,
            el(
              'div',
              'away-if',
              w.kind === 'approval'
                ? A().awayApprovalIfNot(hhmm(w.expiresAt))
                : A().awayLoginIfNot(hhmm(w.expiresAt)),
            ),
          ),
        ),
      ),
    )
  card.append(
    button(
      'btn-text sm',
      () => {
        awayFrom = undefined
        renderTalk()
      },
      A().awayOk,
    ),
  )
  return card
}

/** Below the chat: the answer being written, or the progress card while working with tools + queued messages */
function renderLive() {
  const live = document.getElementById('live')
  if (!live) return
  const parts: HTMLElement[] = []
  const t = state.turn
  if (state.busy) {
    const fp = finishProgress(state.messages, { running: true, checking: state.checking })
    // A plain chat answer streams as a bubble; work with tools (or a check) gets the one progress card
    if (t?.text && !t.steps.length && !fp) {
      const b = el('div', 'bubble rich')
      setRich(b, t.text)
      parts.push(who(new Date().toISOString()), b)
    } else parts.push(progressCard(t))
  }
  for (const q of state.queued)
    parts.push(el('div', 'bubble me queued', q), el('p', 'queued-note meta', T().queuedNote))
  live.replaceChildren(...parts)
  renderSend()
}

/** Agents were checked and none is ready to work */
const noAiReady = () => state.agents.length > 0 && !readyAgents().length

function emptyView() {
  // With no AI, the example chips only lead to an error: say what wakes Dool2 up instead
  if (noAiReady())
    return el(
      'div',
      'empty-view',
      liveDoori('home', 'asking', 120),
      el('p', 'title-2', A().noAiTitle),
      el('p', 'cap', A().noAiBody),
      el(
        'div',
        'chips',
        button('btn', () => void connectAi(), A().connectAi),
      ),
    )
  const chips = el('div', 'chips')
  for (const ex of examples()) chips.append(button('chip', () => void send(ex), ex))
  return el(
    'div',
    'empty-view',
    liveDoori('home', '', 120),
    el('p', 'title-2', T().emptyTitle),
    el('p', 'cap', T().emptyCap),
    chips,
  )
}

// ── Live: turns started anywhere (GET /api/conversation/live) ──

function onLive(ev: ConversationLiveEvent) {
  if (ev.kind === 'life') {
    void loadLife().catch(() => {})
    return
  }
  if (ev.kind === 'reset') {
    // "Start over" was pressed on the phone: refetch the chat, Library and goals
    void Promise.all([loadConversation(), loadLife(), loadServices()]).catch(() => {})
    return
  }
  if (ev.kind === 'connect') {
    // A connection started or finished: refetch connections and update connect cards in the chat
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
    // The daemon's busy also counts side chats and feed posts. Check the chat state to see if the main chat is working
    if (!ev.busy) setMainBusy(false)
    else
      void api<ConversationState>('/api/conversation?limit=1')
        .then((s) => setMainBusy(s.busy))
        .catch(() => {})
    return
  }
  if (ev.kind === 'ack') {
    // Received: show the status line now, before the AI has said anything
    setMainBusy(true)
    return
  }
  if (ev.kind === 'checking') {
    state.checking = ev.checking
    if (state.view === 'talk') renderTalk()
    return
  }
  if (ev.kind === 'queued') {
    state.queued = ev.texts
    renderPanel('live')
    if (state.view === 'talk') renderLive()
    return
  }
  // A task changed (ADR 0038): its card redraws in place; its own turns never stream into the conversation
  if (ev.kind === 'task') {
    state.tasks.set(ev.task.id, ev.task)
    for (const c of document.querySelectorAll<HTMLElement>(`.task-card[data-task="${ev.task.id}"]`))
      c.replaceWith(taskCard({ kind: 'task', id: ev.task.id, title: ev.task.title }))
    if (state.workSrc?.kind === 'task' && state.workSrc.id === ev.task.id) renderPanel('live')
    return
  }
  const e = ev.event
  if (ev.side) {
    onSideTurn(ev.threadId, e)
    return
  }
  // Messages and cards the daemon posted directly (connect cards etc.): not a turn, so draw them without switching to working
  if (ev.posted && e.type === 'saved') {
    if (state.messages.some((m) => m.id === e.message.id)) return
    state.messages.push(e.message)
    if (state.view === 'talk') {
      renderTalk()
      scrollDown()
    }
    return
  }
  // Working while a main chat turn is streaming
  if (e.type !== 'end' && !state.busy) setMainBusy(true)
  if (e.type === 'saved') {
    const m = e.message
    if (m.role === 'tool') {
      state.turn?.records.push(m.text)
      return
    }
    if (m.role === 'user') {
      // A new turn starts: the panel shows what was asked
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

/** When the main chat starts or stops working */
function setMainBusy(busy: boolean) {
  const was = state.busy
  if (was === busy) return
  state.busy = busy
  if (busy && !state.turn) state.turn = newTurn('')
  // When work starts, switch the panel to Screen (unless Memory is being edited)
  if (busy && state.panelOpen && state.panelTab !== 'memory') state.panelTab = 'screen'
  renderHead()
  renderNow()
  renderPanel('all')
  if (state.view === 'talk') renderLive()
}

function newTurn(ask: string): Turn {
  return { ask, started: Date.now(), steps: [], info: [], activity: '', text: '', usd: 0, records: [] }
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
    // Text before a tool call is what Dool2 is doing, not the answer. Keep one line as the step and clear the stream
    const act = A().doing(ev.title ?? toolLabel(ev.name, lang))
    const label = narrationLine(t.text, lang) ?? act
    t.text = ''
    const place = toolPlace(ev.name, ev.input, t.host)
    if (/browser_(open|navigate)$/.test(ev.name) && place) t.host = place
    if (t.steps.at(-1) !== label || t.info.at(-1)?.place !== place) {
      t.steps.push(label)
      t.info.push({
        act,
        ...(place ? { place } : {}),
        at: Date.now(),
        ...(ev.detail ? { detail: ev.detail } : {}),
      })
    } else if (ev.detail) {
      const cur = t.info.at(-1)
      if (cur) cur.detail = [...(cur.detail ?? []), ...ev.detail].slice(-6)
    }
    t.activity = label
  } else if (ev.type === 'tool_result') t.activity = T().tidying
  else if (ev.type === 'usage') renderUsage(ev.limits)
  else if (ev.type === 'cost') {
    t.usd += ev.usd
    // The month's spend on the strip moves with each answer (the daemon adds the same cost)
    const oc = state.agents.find((a) => a.id === 'opencode')
    if (oc?.spent) oc.spent = { ...oc.spent, usd: oc.spent.usd + ev.usd }
    renderSpend()
  } else return
  renderHead()
  renderNow()
  renderPanel('live')
  if (state.view === 'talk') renderLive()
}

/** Appends one saved message to the end of the chat (without redrawing) */
function appendSaved(m: StoredMessage) {
  // A draft answer waits in the progress card until it is checked (ADR 0027)
  if (finishProgress(state.messages, { running: state.busy, checking: state.checking })?.draft === m.id) {
    renderLive()
    return
  }
  const list = document.querySelector('#messages .thread')
  if (!list) {
    renderTalk()
    return
  }
  const prev = state.messages.at(-2)
  if (!prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt))
    list.append(el('div', 'sep', dayLabel(m.createdAt)))
  // A new request removes the buttons from earlier "please do this yourself" cards
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
    state.lastTurn = {
      ask: t.ask,
      steps: t.steps,
      info: t.info,
      seconds: Math.floor((Date.now() - t.started) / 1000),
    }
    for (const raw of t.records) notifyRecord(raw)
  }
  await loadConversation().catch(() => {})
  await loadWaiting().catch(() => {})
  void loadThreads().catch(() => {})
  if (t && t.usd > 0 && state.view === 'talk')
    document
      .querySelector('#messages .thread')
      ?.append(el('p', 'cost meta', T().thisAnswer(costLabel(t.usd))))
  renderHead()
  renderNow()
  renderPanel('live')
}

function scrollDown() {
  const box = $('messages')
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight
}

/** Also sends a notification when the window is in the background */
function notifyRecord(raw: string) {
  if (document.hasFocus()) return
  try {
    const rec = JSON.parse(raw) as ApprovalRecordMessage | LoginRecordMessage | { kind?: string }
    // Only what waits for the person: other records (work log, task card, result blocks) notify nothing
    const body =
      rec.kind === 'approval'
        ? T().notifyApproval((rec as ApprovalRecordMessage).what)
        : rec.kind === 'login'
          ? T().notifyLogin((rec as LoginRecordMessage).site)
          : handoffRecord(rec)?.reason
    if (body) new Notification(T().notifyTitle, { body })
  } catch {}
}

/** Live stream. Reconnects when it drops */
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

/** Photo to send (shrunk JPEG, base64): pasted or dropped on the input */
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
  img.alt = T().photoToSend
  const x = el('button', 'icon-btn', icon('close'))
  x.type = 'button'
  x.setAttribute('aria-label', T().removePhoto)
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
    // Ignore images that cannot be read
  }
}

/** Sends one message. If Dool2 is answering, the daemon queues it and passes it on next */
async function send(text: string) {
  if (!text.trim() && !photo) return
  awayFrom = undefined
  if (state.view !== 'talk') await show('talk')
  const image = photo
  photo = undefined
  renderPhoto()
  try {
    await api<{ queued: boolean }>('/api/conversation/messages', {
      method: 'POST',
      body: JSON.stringify({ text: text.trim() || T().lookAtPhoto, ...(image ? { image } : {}) }),
    })
  } catch (err) {
    document
      .querySelector('#messages .thread')
      ?.append(el('p', 'sysline', el('i', 'dot stop'), (err as Error).message))
  }
}

/** Send button: sends if there is text, stops if empty while working */
function renderSend() {
  const input = $<HTMLTextAreaElement>('input')
  const btn = $<HTMLButtonElement>('send')
  const hasText = input.value.trim().length > 0 || photo !== undefined
  // Side chats take one message at a time, no queue (only stop while answering)
  const inSide = state.view === 'thread'
  const busy = inSide ? side?.busy === true : state.busy
  const stop = busy && (!hasText || inSide)
  btn.className = `send-btn${stop ? ' stop' : hasText ? ' ready' : ''}`
  btn.replaceChildren(icon(stop ? 'stop' : 'send', 'i md'))
  const m = T()
  const label = stop ? m.stop : busy ? m.continueTalk : m.send
  btn.setAttribute('aria-label', label)
  btn.title = stop ? m.stopTitle : m.withEnter(label)
  input.placeholder = inSide ? (busy ? m.phSideBusy : m.phSide) : busy ? m.phBusy : m.ph
  input.setAttribute('aria-label', m.ph)
}

// ── Cards in the chat: approval · login · please do this yourself ─────

/** What the user said after the i-th record, or undefined */
function saidAfter(list: { role: string; text: string }[], i: number): string | undefined {
  for (const m of list.slice(i + 1)) if (m.role === 'user') return readAppNote(m.text) ?? m.text
  return undefined
}

/** What result blocks (quick replies, list rows, result sheet, text to send) use */
const blockEnv: BlockEnv = {
  send: (text) => void send(text),
  open: (url) => void window.open(url, '_blank'),
  thumb: (url) => thumb(url),
  copy: (text) =>
    navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    ),
}

/** A tool message in the chat history: result blocks, hand-off, approval request, login and other cards */
function toolCard(raw: string, active: boolean, used?: string): Node {
  try {
    const rec = JSON.parse(raw) as { kind?: string }
    const block = blockView(rec, blockEnv, used, lang)
    if (block) return block
    if (rec.kind === 'approval') return approvalCard(rec as ApprovalRecordMessage)
    if (rec.kind === 'login') return loginCard(rec as LoginRecordMessage)
    if (rec.kind === 'connect') return connectCard(rec as ConnectRecordMessage)
    if (rec.kind === 'work') return workDoneCard(rec as WorkRecordMessage)
    if (rec.kind === 'task') return taskCard(rec as TaskRecordMessage)
    if (rec.kind === 'left') return leftCard(rec as LeftRecordMessage, active)
    if (rec.kind === 'tell') return tellCard(rec as TellRecordMessage)
    if (rec.kind === 'cards') return pickCards(rec as CardsRecordMessage)
    if (rec.kind === 'made') {
      // Image made with an image AI: large under the answer (click for full size in a new window)
      const made = rec as { title?: string; photo?: string }
      const box = el('div', 'made-photo', icon('image'))
      void thumb(`photo:${made.photo ?? ''}`).then((data) => {
        if (!data) return
        const img = document.createElement('img')
        img.alt = made.title ?? T().madePicture
        img.src = data
        img.addEventListener('click', () => window.open(data, '_blank'))
        box.replaceChildren(img)
      })
      return el('div', 'made', box)
    }
  } catch {
    return document.createTextNode('')
  }
  return handoffCard(raw, active)
}

/** What the before-finishing check left at its limit, with [Continue] (only until the next message) */
function leftCard(rec: LeftRecordMessage, active: boolean): HTMLElement {
  const go = button(
    'btn-ghost sm',
    () => {
      go.disabled = true
      void api('/api/conversation/continue', { method: 'POST' }).catch(() => {})
    },
    A().continueLeft,
  )
  go.disabled = !active || state.busy
  return el('div', 'card quiet left-card', el('div', 'card-label', A().leftTitle), el('p', '', rec.why), go)
}

/** Card photos: the window never connects to outside servers; it gets them from the daemon (/api/thumb) and caches them */
const thumbCache = new Map<string, Promise<string | undefined>>()
function thumb(url: string): Promise<string | undefined> {
  let p = thumbCache.get(url)
  if (!p) {
    p = api<{ data?: string }>(`/api/thumb?url=${encodeURIComponent(url)}`)
      .then((r) => r.data)
      .catch(() => undefined)
    thumbCache.set(url, p)
  }
  return p
}

/** Cards under an answer (products, stays, restaurants): swipe sideways, [View] opens the default browser, [This one] sends the pick to the chat */
function pickCards(rec: CardsRecordMessage): HTMLElement {
  return el(
    'div',
    rec.shape === 'portrait' ? 'pick-cards portrait' : 'pick-cards',
    ...rec.cards.map((c) => {
      let img: HTMLImageElement | undefined
      if (c.image) {
        const pic = document.createElement('img')
        pic.alt = ''
        img = pic
        void thumb(c.image).then((data) => {
          if (!data) return
          pic.onload = () => pic.classList.add('on')
          pic.src = data
        })
      }
      return el(
        'div',
        'pick-card',
        el('div', 'pick-photo', img ?? icon('box'), c.badge ? el('span', 'pick-badge', c.badge) : undefined),
        el(
          'div',
          'pick-body',
          el('span', 'pick-title', c.title),
          // Keep the space even when empty (price and note rows line up across cards)
          el('span', 'pick-price', c.price ?? ''),
          el('span', 'pick-note', c.note ?? ''),
        ),
        el(
          'div',
          'pick-actions',
          c.url ? button('', () => window.open(c.url, '_blank'), T().view) : undefined,
          button('go', () => void send(T().pickSay(c.title, c.price)), T().pickThis),
        ),
      )
    }),
  )
}

/** A box with Dool2's text (a little markdown) */
function richBox(cls: string, text: string): HTMLElement {
  const box = el('div', cls)
  setRich(box, text)
  return box
}

/** Proactive check (ADR 0019): same content and answers as the Feed card. [Do it] sends that request to the chat */
function tellCard(rec: TellRecordMessage): HTMLElement {
  const f = feedPager.items.find((x) => x.id === rec.id)
  const ask = rec.ask
  const card = el(
    'div',
    'card tell-card',
    el('div', 'card-label', doori('', 22), T().tellLabel),
    el('p', 'tell-title', rec.title),
    rec.body ? richBox('tell-body rich', rec.body) : undefined,
    rec.from ? el('p', 'cap', rec.from) : undefined,
    ask
      ? f?.answered
        ? el('p', 'cap tell-done', f.answered === 'yes' ? T().handed : T().passed)
        : el(
            'div',
            'tell-actions',
            button(
              'btn sm',
              () => void lifeAct({ action: 'feed-answer', id: rec.id, answer: 'yes' }).then(() => send(ask)),
              rec.askLabel || T().doIt,
            ),
            button(
              'btn-ghost sm',
              () => void lifeAct({ action: 'feed-answer', id: rec.id, answer: 'no' }),
              T().noThanks,
            ),
          )
      : undefined,
  )
  card.dataset.rec = JSON.stringify(rec)
  return card
}

/** Time taken: "5s", "1m 20s" */
function secs(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000))
  const m = A()
  return s < 60 ? m.seconds(s) : `${m.minutes(Math.floor(s / 60))}${s % 60 ? ` ${m.seconds(s % 60)}` : ''}`
}

function placeCards(): PlaceCard[] {
  return state.services.map((s) => ({
    id: s.card.id,
    name: s.card.name,
    ...(s.card.site ? { site: s.card.site } : {}),
  }))
}

/** Steps of the current turn → grouping input (time runs until the next step) */
function turnSteps(steps: string[], info: Turn['info'], end?: number): WorkStepIn[] {
  return steps.map((text, i) => {
    const it = info[i]
    const next = info[i + 1]?.at ?? end
    return {
      text,
      act: it?.act ?? text,
      ...(it?.place ? { place: it.place } : {}),
      ...(it && next ? { ms: next - it.at } : {}),
      ...(it?.detail ? { detail: it.detail } : {}),
    }
  })
}

/** Service icon: logo (or first letter), line icons for PC apps, files and Dool2's own work */
function groupMark(g: WorkGroup): HTMLElement {
  const glyph: IconName | undefined =
    g.kind === 'app' ? 'pc' : g.kind === 'file' ? 'file' : g.kind === 'doori' ? 'brain' : undefined
  const mark = el('span', `svc-mark ws-mark${glyph ? ' plain' : ''}`, glyph ? '' : g.letter)
  if (glyph) mark.append(icon(glyph))
  else withLogo(mark, g.cardId)
  return mark
}

/** One service row: icon (spinner or check in the corner) · name / what it does · time taken */
function groupRow(g: WorkGroup, state: 'now' | 'done'): HTMLElement {
  const sub = state === 'now' ? g.act : g.kind === 'doori' ? '' : doneLine(g, lang)
  return el(
    'li',
    `ws ${state}`,
    el(
      'span',
      'ws-ico',
      groupMark(g),
      el('span', `ws-badge ${state}`, state === 'done' ? icon('check') : ''),
    ),
    el('span', 'wt', el('b', '', g.title), sub && sub !== g.title ? el('span', 'wsub', sub) : ''),
    el('span', 'meta', state === 'done' && g.ms !== undefined ? secs(g.ms) : ''),
  )
}

/** A finished turn: "worked at … · time", like the phone; the panel shows its timeline */
function workDoneCard(rec: WorkRecordMessage): HTMLElement {
  const steps = rec.steps.map((x) => ({ ...x, act: x.act ?? x.text }))
  const at = workPlaces(steps)
  const lead = at[0] ? groupMark(at[0]) : el('span', 'wl-ok', icon('check'))
  const text =
    at.length === 1
      ? [T().workedAtHead, el('b', '', at[0]?.title ?? ''), T().workedAtTail]
      : at.length > 1
        ? [T().lookedAt(at.length)]
        : rec.host
          ? [T().workedAtHead, el('b', '', rec.host.replace(/^(www|m|app)\./, '')), T().workedAtTail]
          : [`${T().workLog} · ${T().stepsTime(rec.count, secs(rec.ms))}`]
  return workLineEl('done', lead, text, el('span', 'wl-meta', secs(rec.ms)), () =>
    openWork({ kind: 'rec', rec }),
  )
}

/** A task (ADR 0038): the same one line, live while it runs, yellow while it waits for the person, then done */
function taskCard(rec: TaskRecordMessage): HTMLElement {
  const v = state.tasks.get(rec.id)
  const open = () => openWork({ kind: 'task', id: rec.id })
  let line: HTMLElement
  if (!v || v.status === 'done' || v.status === 'stopped' || v.status === 'failed') {
    const steps = v ? v.steps.map((x) => ({ ...x, act: x.act ?? x.text })) : []
    const at = workPlaces(steps)
    const ms = v?.endedAt ? Date.parse(v.endedAt) - Date.parse(v.startedAt ?? v.createdAt) : 0
    const lead =
      at[0] && v?.status === 'done'
        ? groupMark(at[0])
        : el('span', 'wl-ok', icon(v?.status === 'done' ? 'check' : 'stop'))
    const text =
      v?.status === 'stopped'
        ? [el('b', '', rec.title), ` · ${A().taskStopped}`]
        : v?.status === 'failed'
          ? [el('b', '', rec.title), ` · ${A().taskFailed}`]
          : at.length === 1
            ? [T().workedAtHead, el('b', '', at[0]?.title ?? ''), T().workedAtTail]
            : at.length > 1
              ? [T().lookedAt(at.length)]
              : [el('b', '', rec.title)]
    line = workLineEl(
      `done${v?.status === 'done' ? '' : ' off'}`,
      lead,
      text,
      el('span', 'wl-meta', ms ? secs(ms) : ''),
      open,
    )
  } else if (v.status === 'needs-you') {
    const a = pendingApprovals()[0]
    const l = pendingLogins()[0]
    line = workLineEl(
      'wait',
      el('span', 'wl-wait'),
      [el('b', '', T().waitsYou), a ? ` · ${a.what}` : l ? ` · ${l.site}` : ''],
      el('span', 'wl-meta', ''),
      a ? () => setPanel(true, 'approvals') : open,
    )
  } else {
    const from = Date.parse(v.startedAt ?? v.createdAt)
    const time = el('span', 'wl-meta wc-time', clockText(from))
    time.dataset.from = String(from)
    const steps = v.steps.map((x) => ({ ...x, act: x.act ?? x.text }))
    const text =
      v.status === 'waiting'
        ? [el('b', '', rec.title), ` · ${T().inLine(v.ahead ?? 0)}`]
        : v.status === 'checking'
          ? [A().checkingTitle]
          : steps.length
            ? nowParts(steps)
            : [el('b', '', rec.title)]
    line = workLineEl('doing', wlDots(), text, time, open)
  }
  const wrap = el('div', 'wline-wrap task-card', line)
  wrap.dataset.task = rec.id
  return wrap
}

// ── Work as one line, its timeline in the panel (same as the phone's work-line.ts) ──

type WStep = WorkStepIn & { act: string; detail?: StepDetail[] }

function workLineEl(
  cls: string,
  lead: HTMLElement,
  text: (HTMLElement | string)[],
  meta: HTMLElement,
  onclick: () => void,
): HTMLElement {
  const b = button(`wline ${cls}`, onclick, lead, el('span', 'wl-text', ...text), meta, icon('chevron'))
  b.title = T().openWork
  return b
}

const wlDots = () => el('span', 'wl-dots', el('i', ''), el('i', ''), el('i', ''), el('i', ''))

function workPlaces(steps: WStep[]): WorkGroup[] {
  const groups = groupSteps(steps, placeCards(), lang)
  return [
    ...new Map(
      groups.filter((g) => g.kind === 'web' || g.kind === 'service').map((g) => [g.key, g]),
    ).values(),
  ]
}

/** What a step did, as specific as its details allow */
function actText(x: WStep, doing: boolean): string {
  const d = x.detail?.at(-1)
  if (d?.k === 'press') return doing ? T().pressingV(d.v) : T().pressedV(d.v)
  if (d?.k === 'field') return doing ? T().fillingV(d.v) : T().filledV(d.v)
  return doing ? x.act : actDone(x.act, lang)
}

/** "<service> · <what it does now>" for the live line */
function nowParts(steps: WStep[]): (HTMLElement | string)[] {
  const last = steps.at(-1)
  if (!last) return []
  const g = groupSteps([last], placeCards(), lang)[0]
  const place = g && (g.kind === 'web' || g.kind === 'service') ? g.title : ''
  const specific = last.detail?.some((d) => d.k === 'press' || d.k === 'field')
  const what = specific ? actText(last, true) : last.text && last.text !== last.act ? last.text : last.act
  return place ? [el('b', '', place), ` · ${what}`] : [what]
}

const DETAIL_LABEL: Record<StepDetail['k'], () => string> = {
  url: () => T().dUrl,
  press: () => T().dPress,
  field: () => T().dField,
  query: () => T().dQuery,
  page: () => T().dPage,
}

/** The timeline: one-line self-talk, then each action with its logo, what it did and its time; details open on click */
function workTimeline(steps: WStep[], running: boolean): HTMLElement {
  const list = el('ol', 'wtl')
  let said = ''
  steps.forEach((x, i) => {
    if (x.text && x.text !== x.act && x.text !== said) {
      said = x.text
      list.append(el('li', 'wtl-say', el('span', 'wtl-dot'), el('span', '', x.text)))
    }
    const g = groupSteps([x], placeCards(), lang)[0]
    const now = running && i === steps.length - 1
    const web = g && (g.kind === 'web' || g.kind === 'service')
    const has = Boolean(x.detail?.length)
    const mk = g ? groupMark(g) : el('span', 'svc-mark plain', icon('brain'))
    mk.classList.add('wl-mark')
    const row = el(
      'li',
      `wtl-act${now ? ' cur' : ''}${has ? ' has' : ''}`,
      mk,
      el(
        'span',
        'wtl-x',
        el('b', '', web ? (g?.title ?? '') : x.act),
        web ? el('small', '', actText(x, now)) : '',
      ),
      el('span', 'wtl-ms', !now && x.ms !== undefined ? secs(x.ms) : ''),
      has ? icon('chevron') : '',
    )
    list.append(row)
    if (has) {
      const dl = el('li', 'wtl-detail')
      dl.hidden = true
      for (const d of x.detail ?? []) dl.append(el('span', 'dt', DETAIL_LABEL[d.k]()), el('span', 'dd', d.v))
      row.addEventListener('click', () => {
        dl.hidden = !dl.hidden
        row.classList.toggle('open', !dl.hidden)
      })
      list.append(dl)
    }
  })
  return list
}

/** Opens the panel's Screen tab on this work's timeline */
function openWork(src: WorkSrc) {
  state.workSrc = src
  setPanel(true, 'screen')
}

/**
 * Connect card (connect_ask): enter an ID and password and the daemon logs in in the background.
 * No need to wait. When it finishes, a chat note arrives and this card changes to "connected"
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
    card.append(el('div', 'card-label', icon('link'), T().cardNotFound(rec.service)))
    return card
  }
  const c = it.card
  const mark = withLogo(el('span', 'svc-mark', /^\d+/.exec(c.name)?.[0] ?? [...c.name][0] ?? ''), c.id)
  if (it.connectedAt) {
    card.className = 'card quiet connect-card'
    // Its tools run in Chrome: while Chrome or the extension is off, say so instead of "connected"
    const off = c.how !== 'device' && state.extension !== undefined && !state.extension.connected
    card.append(el('div', 'card-label', mark, off ? T().chromeOffFor(c.name) : T().isConnected(c.name)))
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
      el('strong', '', busy ? T().loggingIn(c.name) : T().connectTitle(c.name)),
      el('span', 'cap', busy ? T().busyNote : T().loginNote),
    ),
    busy ? el('span', 'spin') : undefined,
  )
  // Official integrations (Gmail etc.) also log in through Chrome until they are ready: same card as browser connections
  if (busy || (c.how !== 'browser' && c.how !== 'official')) {
    card.append(head)
    if (!busy) card.append(button('btn', () => void show('connect', c.id), T().openConnect))
    return card
  }
  const err = el('p', 'login-error')
  const redraw = () => card.replaceWith(connectCard(rec))
  // Social login: reuses the Kakao, Naver… login in this PC's Chrome (in the order used before)
  const social = el('div', 'social-row')
  for (const { provider, hint } of c.social?.length ? socialOrder(c, state.services, lang) : []) {
    const b = button(
      `btn-social ${provider}`,
      async () => {
        for (const x of social.querySelectorAll('button')) x.disabled = true
        const r = await api<{ ok: boolean; message: string }>(
          `/api/connections/${encodeURIComponent(c.id)}/social`,
          {
            method: 'POST',
            body: JSON.stringify({ provider, background: true }),
          },
        ).catch((x: Error) => ({ ok: false, message: x.message, routed: false }))
        if (r.ok || LOGIN_BUSY_RE.test(r.message)) {
          state.connecting.add(c.id)
          return redraw()
        }
        for (const x of social.querySelectorAll('button')) x.disabled = false
        err.textContent = r.message
      },
      T().socialConnect(SOCIAL_LABEL[provider]),
    )
    if (hint) b.append(el('span', 'social-hint', hint))
    social.append(b)
  }
  const form = el('form', 'login-form')
  const user = el('input', 'field')
  user.placeholder = T().idOrEmail
  user.autocomplete = 'username'
  const pw = el('input', 'field')
  pw.type = 'password'
  pw.placeholder = T().password
  pw.autocomplete = 'current-password'
  const go = el('button', 'btn', T().connectBtn)
  go.type = 'submit'
  form.append(user, pw, err, go)
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (!user.value.trim() || !pw.value) {
      err.textContent = T().fillBoth
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
    redraw()
  }
  // Do it yourself: open the login page in Chrome, and when done, Dool2 looks at the page to check
  const direct = button(
    'btn-text sm',
    async () => {
      direct.disabled = true
      try {
        await api(`/api/connections/${encodeURIComponent(c.id)}/open`, { method: 'POST' })
      } catch (x) {
        direct.disabled = false
        err.textContent = (x as Error).message
        return
      }
      const done = button(
        'btn',
        async () => {
          done.disabled = true
          const r = await api<{ ok: boolean }>(`/api/connections/${encodeURIComponent(c.id)}/verify`, {
            method: 'POST',
          }).catch(() => ({ ok: false }))
          if (r.ok) {
            await loadServices().catch(() => {})
            return redraw()
          }
          done.disabled = false
          wait.textContent = T().notLoggedYet(c.name)
        },
        T().loggedIn,
      )
      const wait = el('p', 'cap', T().openedLogin(c.name))
      card.replaceChildren(head, wait, done, button('btn-text sm', redraw, T().back))
    },
    T().doMyself,
  )
  card.append(
    head,
    ...(social.childElementCount ? [social, el('p', 'cap social-or', T().orIdPw)] : []),
    form,
    el('p', 'cap', T().vaultNote),
    direct,
  )
  return card
}

/**
 * Login card: when Dool2 asks for an ID and password for a site not in the vault.
 * Values go only to the daemon's vault (OS keychain). Never to the AI or the chat history
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
          r?.status === 'saved' ? T().loginSaved(r.site, r.username) : T().loginEnded(rec.site || T().site),
        ),
      )
      return
    }
    card.className = 'card ask login-card'
    const head = el(
      'div',
      'login-head',
      el('span', 'tile', icon('globe', 'i md')),
      el('div', '', el('strong', '', T().siteLogin(r.site)), el('span', 'mono', new URL(r.origin).host)),
    )
    const form = el('form', 'login-form')
    const user = el('input', 'field')
    user.placeholder = T().idOrEmail
    user.autocomplete = 'username'
    user.setAttribute('aria-label', T().idOrEmail)
    const pw = el('input', 'field')
    pw.type = 'password'
    pw.placeholder = T().password
    pw.autocomplete = 'current-password'
    pw.setAttribute('aria-label', T().password)
    const eye = button(
      'icon-btn',
      () => {
        pw.type = pw.type === 'password' ? 'text' : 'password'
      },
      icon('eye'),
    )
    eye.setAttribute('aria-label', T().showPw)
    const err = el('p', 'login-error')
    const go = el('button', 'btn', T().login)
    go.type = 'submit'
    form.append(user, el('div', 'pw-row', pw, eye), err, go)
    form.onsubmit = async (e) => {
      e.preventDefault()
      if (!user.value.trim() || !pw.value) {
        err.textContent = T().fillBoth
        return
      }
      go.disabled = true
      go.textContent = T().saving
      const res = await api<{ ok: boolean; message: string; routed?: boolean }>(
        `/api/logins/${encodeURIComponent(r.id)}`,
        {
          method: 'POST',
          body: JSON.stringify({ username: user.value.trim(), password: pw.value }),
        },
      ).catch((x: Error) => ({ ok: false, message: x.message, routed: false }))
      pw.value = ''
      if (!res.ok) {
        go.disabled = false
        go.textContent = T().login
        err.textContent = res.message
        return
      }
      render({ ...r, status: 'saved', username: user.value.trim() })
      // Tell the AI only that it was saved. The values are never sent (a task's sign-in: the daemon told that task)
      if (!res.routed) void send(appNote(T().loginSavedNote(res.message)))
    }
    const foot = el('p', 'login-foot meta', icon('lock'), T().vaultFoot)
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

function riskLabel(kind: ApprovalView['kind']): string {
  const m = T()
  const labels: Record<ApprovalView['kind'], string> = {
    money: m.riskMoney,
    contact: m.riskContact,
    irreversible: m.riskIrreversible,
    app: m.riskApp,
    file: m.riskFile,
    print: m.riskPrint,
    pc: m.riskPc,
  }
  return labels[kind]
}

/**
 * Approval card (M3). The button and address are read from the page by the daemon, while what and how much are
 * written by the AI, so a real screenshot is shown alongside. Once approved, the daemon presses only that button.
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
        img.alt = T().shotAlt
        img.src = `data:image/jpeg;base64,${approval.shot}`
        img.onload = () => card.scrollIntoView({ block: 'nearest' })
        card.querySelector('.approve-body')?.append(img)
      }
    }
  }

  const render = (v: ApprovalView | undefined) => {
    if (!v || v.status !== 'pending') {
      card.className = 'card quiet approve-done'
      const label = v ? statusLabel(v.status) : T().approvalEnded
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
      if (!v) card.append(el('p', 'cap', T().approvalLost))
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
        el('p', 'approve-q', v.amount ? T().amountQ(v.amount, v.kind === 'money') : T().approveQ),
        el('span', 'meta', [riskLabel(v.kind), v.where].filter(Boolean).join(' · ')),
      ),
    )
    // Auto-approve sent this one as a card: say why (ADR 0030 amendment)
    const held = v.held
      ? [el('p', 'approve-held', v.held === 'unrelated' ? T().heldUnrelated : T().heldUnchecked)]
      : []
    const rows = el('dl', 'kv')
    const row = (k: string, val?: string, cls?: string) => {
      if (!val) return
      rows.append(el('dt', '', k), el('dd', cls ?? '', val))
    }
    // Texts (from my phone number): the phone sends it and only the phone knows the number. The PC only shows it
    if (v.url.startsWith('sms:')) {
      row(T().recipient, v.label)
      row(T().textToSend, v.what)
      card.replaceChildren(
        top,
        ...held,
        el('div', 'approve-body', rows),
        el('p', 'approve-note', T().smsNote),
      )
      return
    }
    row(T().what, v.what)
    row(T().address, v.url.startsWith('app:') ? '' : host, 'host')
    const pc = v.kind === 'file' || v.kind === 'print' || v.kind === 'pc'
    row(pc ? T().goodToKnow : T().cancelTerms, v.cancel)
    if (v.kind !== 'app' && !pc) row(T().buttonToPress, `"${v.label}"`)
    row(T().howMuch, v.amount, 'money')
    // PC files: what goes where (list made by the daemon). Shows up to 30 lines, then only the count
    if (v.items?.length) {
      const list = el('ul', 'approve-items')
      for (const line of v.items.slice(0, 30)) list.append(el('li', '', line))
      if (v.items.length > 30) list.append(el('li', 'meta', T().moreItems(v.items.length - 30)))
      rows.append(el('dt', '', v.kind === 'print' ? T().file : T().listN(v.items.length)), el('dd', '', list))
    }
    const no = el('button', 'btn-ghost', T().reject)
    no.type = 'button'
    const yes = el(
      'button',
      'btn btn-approve',
      v.kind === 'app'
        ? T().allow
        : v.kind === 'print'
          ? T().print
          : v.kind === 'file' || v.kind === 'pc'
            ? v.label
            : T().approve,
    )
    yes.type = 'button'
    const decide = async (decision: 'approve' | 'reject') => {
      yes.disabled = true
      no.disabled = true
      if (decision === 'approve')
        yes.textContent =
          v.kind === 'file' || v.kind === 'pc' ? T().working : v.kind === 'print' ? T().sending : T().pressing
      const r = await api<{ ok: boolean; message: string; routed?: boolean }>(
        `/api/approvals/${encodeURIComponent(v.id)}`,
        { method: 'POST', body: JSON.stringify({ decision }) },
      ).catch((e: Error) => ({ ok: false, message: e.message, routed: false }))
      await fill()
      void loadWaiting()
      // Tell the AI the result so it continues (a task's approval: the daemon already told that task, ADR 0038)
      if (!r.routed)
        void send(appNote(decision === 'reject' ? T().rejectedNote(v.label) : T().approvedNote(r.message)))
    }
    no.onclick = () => void decide('reject')
    yes.onclick = () => void decide('approve')
    card.replaceChildren(
      top,
      ...held,
      el('div', 'approve-body', rows),
      el('div', 'approve-actions', no, yes),
      el(
        'p',
        'approve-note',
        v.kind === 'file'
          ? T().noteFile
          : v.kind === 'pc'
            ? T().notePc
            : v.kind === 'print'
              ? T().notePrint
              : T().noteDefault,
      ),
    )
  }
  void fill()
  return card
}

/** A task Dool2 handed to the person ("please do this yourself"). When active: [Show in Chrome] [Done] */
function handoffCard(raw: string, active: boolean) {
  let rec: HandoffRecord | undefined
  try {
    rec = handoffRecord(JSON.parse(raw))
  } catch {}
  // Only a real hand-off with its reason: a record this screen does not know yet draws nothing (never an empty card)
  if (!rec) return document.createTextNode('')
  const card = el('div', active ? 'card ask handoff' : 'card quiet handoff')
  card.append(
    el('div', 'card-label', doori(active ? 'asking' : '', 24), active ? T().handoffActive : T().handoffDone),
    el('p', 'handoff-reason', rec.reason),
  )
  if (active) {
    const look = button(
      'btn-ghost sm',
      () =>
        void api('/api/browser/focus', { method: 'POST', body: JSON.stringify({ tabId: rec.tabId }) }).catch(
          () => {},
        ),
      T().viewInChrome,
    )
    const doneBtn = button('btn sm', () => void send(T().doneSay), T().doneBtn)
    if (rec.tabId === undefined) look.hidden = true
    card.append(el('div', 'handoff-actions', look, doneBtn))
  }
  return card
}

// ── Switching screens ───────────────────────────────────────

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
        // Connecting happens in the chat: post a connect card there and go to Chat
        connect: async (cid) => {
          await api(`/api/connections/${encodeURIComponent(cid)}/chat`, { method: 'POST' })
          await show('talk')
          document
            .querySelector(`.connect-card[data-service="${CSS.escape(cid)}"]`)
            ?.scrollIntoView({ block: 'center' })
        },
      },
      id,
    )
    // Connection marks may have changed (tailored ideas)
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

// ── Start ─────────────────────────────────────────────

async function main() {
  const cfg = await window.dool2.config()
  smokeNoAi = cfg.smokeNoAi === true
  state.url = cfg.url
  state.token = cfg.token
  // Last-used language first (localStorage), settled from settings below
  renderStatic()

  const input = $<HTMLTextAreaElement>('input')
  const autosize = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
    renderSend()
  }
  input.addEventListener('input', autosize)
  // Photos: paste · drag and drop
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
    // Ignore Enter while an IME is composing (Hangul input)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      $<HTMLFormElement>('composer').requestSubmit()
    }
  })
  $<HTMLFormElement>('composer').addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value
    if (state.view === 'thread' && side) {
      // Side chat: stop if answering, otherwise send to that chat
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
  // Feed and Library: next page when scrolled near the bottom
  moreNearBottom($('messages'), () =>
    state.view === 'feed' ? feedPager : state.view === 'library' ? libPagers[state.libTab] : undefined,
  )
  $('ideas-btn').onclick = () => void show('ideas')
  $('agent').onclick = () => setPanel(!state.panelOpen)
  $('device').onclick = () => setPanel(true, 'screen')

  // Assistant panel: stays open on wide windows (remembers if the user closed it)
  let saved: string | null = null
  try {
    saved = localStorage.getItem('dool2.panel')
  } catch {}
  state.panelOpen = saved ? saved === 'open' : window.innerWidth >= 1180
  $('app').classList.toggle('panel-open', state.panelOpen)

  // Language first (ADR 0029): every load below may render text
  const { settings } = await api<{ settings: Settings }>('/api/settings')
  syncLang(settings.language, settings.region)
  // First run: keep the language this window settled on, so the daemon (notices, the AI's voice) and the phone agree
  if (!settings.language)
    void api('/api/settings', { method: 'PATCH', body: JSON.stringify({ language: lang }) }).catch(() => {})
  renderStatic()
  await Promise.all([
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
  renderStatsAsk(settings)
  renderSend()
  void connectLive()
  void window.dool2.update
    .state()
    .then(renderUpdate)
    .catch(() => {})
  window.dool2.update.onChange(renderUpdate)
  // Re-check the extension, approvals and login requests (so phone actions show up). Every 3s in front, 15s behind
  let polledAt = 0
  setInterval(() => {
    for (const c of document.querySelectorAll<HTMLElement>('.wc-time'))
      c.textContent = clockText(Number(c.dataset.from) || Date.now())
  }, 1_000)
  setInterval(() => {
    const clock = document.getElementById('work-clock')
    if (clock && state.turn) clock.textContent = elapsed(Math.floor((Date.now() - state.turn.started) / 1000))
    if (!document.hasFocus() && Date.now() - polledAt < 15_000) return
    polledAt = Date.now()
    void loadExtension().catch(() => {})
    void loadWaiting().catch(() => {})
  }, 3_000)
  // Re-check right away when the window comes back to front
  // The return summary: when the window comes back after a while, sum up what happened from the records
  checkAway()
  void Promise.all([loadLife(), loadWaiting()])
    .then(() => state.view === 'talk' && renderTalk())
    .catch(() => {})
  window.addEventListener('blur', noteSeen)
  setInterval(() => document.hasFocus() && noteSeen(), 60_000)
  window.addEventListener('focus', () => {
    checkAway()
    if (awayFrom !== undefined)
      void Promise.all([loadLife(), loadWaiting()])
        .then(() => state.view === 'talk' && renderTalk())
        .catch(() => {})
    polledAt = Date.now()
    void loadExtension().catch(() => {})
    void loadWaiting().catch(() => {})
  })

  // Smoke mode: "view[:id][+panel:section|+nopanel]" opens that screen for the capture
  // e.g. feed, ideas, goals, goal (first goal), library:files, connections:coupang, thread (latest), talk+panel:memory
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

  // Open the wizard on first run. Smoke mode opens it directly with "step:choice" (e.g. check:both)
  const [smokeStep, smokeChoice, smokeAction] = (cfg.smokeSetup ?? '').split(':')
  const start = [...SETUP_STEPS, 'settings'].includes(smokeStep as SetupStep)
    ? {
        step: smokeStep as SetupStep,
        // For settings the second value is the section (settings:about)
        ...(smokeStep === 'settings' && smokeChoice ? { tab: smokeChoice as SettingsTab } : {}),
        choice: (smokeStep === 'settings' ? undefined : smokeChoice || undefined) as AiChoice | undefined,
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
      storeExtension: () => window.dool2.storeExtension(),
      openStore: () => window.dool2.openStore(),
      update: {
        state: () => window.dool2.update.state(),
        check: async () => {
          const u = await window.dool2.update.check()
          // Update the top-left strip too (it shows when there is a new version)
          renderUpdate(u)
          return u
        },
        install: async () => {
          const u = await window.dool2.update.install()
          renderUpdate(u)
          return u
        },
        version: () => window.dool2.update.version(),
      },
      ...(from ? { start: from } : {}),
    })
    settingsOpen = (from?.step ?? 'welcome') === 'settings' ? wizard : undefined
    renderTabs()
    void wizard.done.then((r) => {
      settingsOpen = undefined
      renderTabs()
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
  // Report after the screen has actually drawn (give the 3D Dool2 a moment to appear)
  await new Promise((r) => setTimeout(r, 600))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dool2.ready(
    `agents=${state.agents.length} ready=${ready.join(',') || 'none'} messages=${state.messages.length} setup=${setup} view=${state.view} life=${state.life.routines.length}/${state.life.feed.length}/${state.life.library.length}`,
  )
}

main().catch((err: Error) => {
  document.body.textContent = A().startFailed(err.message)
  window.dool2?.ready(`error=${err.message}`)
})
