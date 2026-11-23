// First-run wizard: welcome → which AI subscription? → readiness check
import type {
  AgentId,
  AgentStatus,
  AiChoice,
  ChromeStatus,
  ClaudeLoginStatus,
  ExtensionStatus,
  InstallStatus,
  LinkStatus,
  PairStatus,
  PaygAccount,
  PaygProvider,
  ScreenControlStatus,
  Settings,
  VaultEntry,
} from '@dool2/protocol'
import { type IconName, icon } from './dom.js'
import type { Lang } from './i18n.js'
import { lang, switchLang } from './lang.js'
import { authAppText, LANG_NAMES, profileExamples, profileLabels, setupText } from './locales/setup.js'
import { AUTH_APPS } from './region/kr/auth-apps.js'
import { hyphenate } from './rich.js'
import {
  aiChoiceLabel,
  type CheckAction,
  checkHeadline,
  checklist,
  choices,
  pickDefault,
  SETUP_STEPS,
  type SetupStep,
  type UpdateInfo,
  updateLine,
} from './setup-model.js'

type Api = <T>(path: string, init?: RequestInit) => Promise<T>

/** Shows only a name, without a runtime import (the official address is OFFICIAL_RELAY in @dool2/protocol/link) */
const relayName = (relay?: string) =>
  !relay || new URL(relay).host === 'relay.dool2.com'
    ? setupText(lang).relayOfficial
    : setupText(lang).relaySelf(new URL(relay).host)

export interface SetupOptions {
  api: Api
  loadAgents(): Promise<AgentStatus[]>
  loadChrome(): Promise<ChromeStatus>
  loadExtension(): Promise<ExtensionStatus>
  /** Shows the Dool2 extension folder to load into Chrome */
  revealExtension(): void
  extensionDir(): Promise<string>
  /** Web Store extension id (null if none). With one, setup is a single [Add to Chrome] */
  storeExtension?(): Promise<string | null>
  /** Opens the Dool2 extension's Web Store page in Chrome */
  openStore?(): void
  /** Saved settings (shown and changed on the Settings screen) */
  settings?: Settings
  /** New versions (ADR 0028). state and check return null outside a release build */
  update?: {
    state(): Promise<UpdateInfo | null>
    check(): Promise<UpdateInfo | null>
    install(): Promise<UpdateInfo | null>
    version(): Promise<string>
  }
  /** Opens straight at this step and choice. In smoke mode, action presses that button */
  start?: { step: SetupStep; choice?: AiChoice; action?: CheckAction; tab?: SettingsTab }
}

/** Sections of the Settings screen */
export type SettingsTab = 'general' | 'ai' | 'phone' | 'vault' | 'me' | 'apps' | 'about'

type InstallKind = 'claude' | 'chrome' | 'opencode' | 'codex'

/** Install endpoint and help page per component (copy is in locales/setup.ts) */
const INSTALLS: Record<InstallKind, { url: string; help: string }> = {
  claude: { url: '/api/agents/claude/install', help: 'https://code.claude.com/docs/en/setup' },
  codex: { url: '/api/agents/codex/install', help: 'https://developers.openai.com/codex' },
  opencode: { url: '/api/agents/opencode/install', help: 'https://opencode.ai' },
  chrome: { url: '/api/browser/install', help: 'https://www.google.com/chrome/' },
}

export interface SetupResult {
  settings: Settings
  defaultAgent?: AgentId
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Developer mode (`localStorage['dool2.dev'] === '1'`): shows settings that are not ready for everyone */
function devMode(): boolean {
  try {
    return localStorage.getItem('dool2.dev') === '1'
  } catch {
    return false
  }
}

function button(cls: string, text: string, onClick: () => void) {
  const b = el('button', cls, text)
  b.type = 'button'
  b.onclick = onClick
  return b
}

/** Shows the wizard. shown resolves when the first screen is drawn, done when the wizard is finished */
export function runSetup(opts: SetupOptions): {
  shown: Promise<void>
  done: Promise<SetupResult>
  /** Closes Settings (when going to another screen from the left menu) */
  close(): void
} {
  let closeNow: () => void = () => {}
  let markShown: () => void = () => {}
  const shown = new Promise<void>((r) => {
    markShown = r
  })
  const m = setupText(lang)
  const PROFILE_LABELS: Record<string, string> = profileLabels(lang)
  const PROFILE_EXAMPLES: Record<string, string> = profileExamples(lang)
  const root = document.getElementById('setup') as HTMLElement
  root.hidden = false
  let step: SetupStep = opts.start?.step ?? 'welcome'
  let choice: AiChoice | undefined = opts.start?.choice ?? opts.settings?.aiChoice
  let current: Settings = opts.settings ?? { setupDone: false }
  let agents: AgentStatus[] = []
  let note = ''
  let login: ClaudeLoginStatus = { state: 'idle' }
  let chrome: ChromeStatus | undefined
  let extension: ExtensionStatus | undefined
  // Guide for adding the Dool2 extension (until the Web Store, the folder is loaded by hand)
  const ext: { open: boolean; dir: string; copied: boolean; store?: string | null } = {
    open: false,
    dir: '',
    copied: false,
  }
  let extTimer: ReturnType<typeof setTimeout> | undefined
  // Phone pairing (Settings screen)
  const phone: { link?: LinkStatus; pair: PairStatus; relayDraft: string; error?: string } = {
    pair: { state: 'idle' },
    relayDraft: '',
  }
  let pairTimer: ReturnType<typeof setTimeout> | undefined
  /** Scroll to the QR or confirmation code when it appears (the Settings screen is long) */
  let scrollToPair = false
  // My info and payment (Settings screen): only masked values come in. Editing changes only the filled fields
  const me: {
    have: Record<string, string>
    payChoices: Record<string, string>
    editing: boolean
    draft: Record<string, string>
    saving: boolean
    note?: string
  } = { have: {}, payChoices: {}, editing: false, draft: {}, saving: false }
  // Dool2 vault (Settings screen)
  const vault: {
    entries: VaultEntry[]
    adding: boolean
    url: string
    username: string
    password: string
    saving: boolean
    error?: string
    /** Password shown briefly (hidden again after 30 seconds, ADR 0026) */
    shown?: { id: string; password: string }
    /** Entry being edited */
    editing?: string
  } = { entries: [], adding: false, url: '', username: '', password: '', saving: false }
  const installs: Record<InstallKind, InstallStatus> = {
    claude: { state: 'idle' },
    chrome: { state: 'idle' },
    opencode: { state: 'idle' },
    codex: { state: 'idle' },
  }
  const installTimers: Partial<Record<InstallKind, ReturnType<typeof setTimeout>>> = {}
  let codeDraft = ''
  // Pay-as-you-go API key input
  const payg: {
    open: boolean
    providers: PaygProvider[]
    provider: string
    model: string
    key: string
    saving: boolean
    error?: string
    account?: PaygAccount | null
  } = { open: false, providers: [], provider: 'anthropic', model: '', key: '', saving: false }
  // Choices on the "keep Dool2 running" step (both on by default, the user can turn them off)
  let awakeWorking = current.keepAwake ? current.keepAwake !== 'off' : true
  let autoStart = current.launchAtLogin ?? true
  // Usage stats (numbers only): asked on the last setup screen. Off means nothing is sent (apps/daemon/src/stats.ts)
  let shareStats = current.usageStats ?? true
  let statsPreview: string | undefined
  let sending = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  // Section shown on the Settings screen (the phone section when opened from the pair button)
  let settingsTab: SettingsTab =
    opts.start?.tab ?? (opts.start?.action === 'phone-pair' ? 'phone' : 'general')
  // Animate only when the step changes (so redraws while typing do not flicker)
  let enter = true
  // When smoke mode presses a button, capture only after its result is drawn
  let holdShown = Boolean(opts.start?.action)

  const done = new Promise<SetupResult>((resolve) => {
    const stopLogin = () => {
      if (pairTimer) clearTimeout(pairTimer)
      if (phone.pair.state === 'waiting' || phone.pair.state === 'confirm')
        void opts.api('/api/link/pair', { method: 'DELETE' }).catch(() => {})
      if (extTimer) clearTimeout(extTimer)
      if (pollTimer) clearTimeout(pollTimer)
      if (login.state === 'waiting')
        void opts.api('/api/agents/claude/login', { method: 'DELETE' }).catch(() => {})
      login = { state: 'idle' }
    }

    const setLogin = async (next: ClaudeLoginStatus) => {
      const changed = JSON.stringify(next) !== JSON.stringify(login)
      login = next
      if (next.state === 'done') {
        codeDraft = ''
        agents = await opts.loadAgents()
      }
      if (changed) render()
    }

    // Poll whether sign-in finished in the browser
    const pollLogin = () => {
      if (pollTimer) clearTimeout(pollTimer)
      if (login.state !== 'waiting') return
      pollTimer = setTimeout(async () => {
        const r = await opts
          .api<{ login: ClaudeLoginStatus }>('/api/agents/claude/login')
          .catch(() => undefined)
        if (r && !sending) await setLogin(r.login)
        pollLogin()
      }, 1_500)
    }

    // After an install, check that component again
    const refresh = async (kind: InstallKind) => {
      if (kind === 'chrome')
        [chrome, extension] = await Promise.all([opts.loadChrome(), opts.loadExtension()])
      else agents = await opts.loadAgents()
    }

    // Poll install progress
    const pollInstall = (kind: InstallKind) => {
      clearTimeout(installTimers[kind])
      if (installs[kind].state !== 'running') return
      installTimers[kind] = setTimeout(async () => {
        const r = await opts.api<{ install: InstallStatus }>(INSTALLS[kind].url).catch(() => undefined)
        if (r) {
          const changed = JSON.stringify(r.install) !== JSON.stringify(installs[kind])
          installs[kind] = r.install
          if (r.install.state === 'done') await refresh(kind)
          if (changed) render()
        }
        pollInstall(kind)
      }, 700)
    }

    const startInstall = async (kind: InstallKind) => {
      installs[kind] = { state: 'running', phase: 'prepare' }
      render()
      const r = await opts
        .api<{ install: InstallStatus }>(INSTALLS[kind].url, { method: 'POST' })
        .catch((err: Error) => ({ install: { state: 'failed', message: err.message } as InstallStatus }))
      installs[kind] = r.install
      render()
      pollInstall(kind)
      // Wait only until the download is a little along (so the smoke capture shows progress)
      const early = () => {
        const s = installs[kind]
        return (
          s.state === 'running' &&
          (s.phase === 'prepare' || (s.phase === 'download' && (s.percent ?? 0) < 10))
        )
      }
      for (let i = 0; i < 80 && early(); i++) await new Promise((res) => setTimeout(res, 250))
    }

    // Poll whether the extension connected. When it does, close the guide and show green
    const pollExtension = () => {
      if (extTimer) clearTimeout(extTimer)
      if (!ext.open) return
      extTimer = setTimeout(async () => {
        const r = await opts.loadExtension().catch(() => undefined)
        if (r?.connected) {
          extension = r
          ext.open = false
          render()
          return
        }
        pollExtension()
      }, 2_000)
    }

    const startClaudeLogin = async () => {
      login = { state: 'waiting' }
      codeDraft = ''
      render()
      const r = await opts
        .api<{ login: ClaudeLoginStatus }>('/api/agents/claude/login', { method: 'POST' })
        .catch((err: Error) => ({ login: { state: 'failed', message: err.message } as ClaudeLoginStatus }))
      await setLogin(r.login)
      render()
      pollLogin()
    }

    const sendCode = async () => {
      if (!codeDraft.trim() || sending) return
      sending = true
      render()
      const r = await opts
        .api<{ login: ClaudeLoginStatus }>('/api/agents/claude/login/code', {
          method: 'POST',
          body: JSON.stringify({ code: codeDraft }),
        })
        .catch(() => undefined)
      sending = false
      if (r) await setLogin(r.login)
      render()
      pollLogin()
    }

    const finish = async (power?: Pick<Settings, 'keepAwake' | 'launchAtLogin' | 'usageStats'>) => {
      stopLogin()
      for (const t of Object.values(installTimers)) clearTimeout(t)
      const defaultAgent = choice ? pickDefault(choice, agents) : undefined
      const { settings } = await opts.api<{ settings: Settings }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          setupDone: true,
          ...(choice ? { aiChoice: choice } : {}),
          defaultAgent,
          ...power,
        }),
      })
      root.hidden = true
      root.replaceChildren()
      resolve({ settings, defaultAgent })
    }

    /** Just closes Settings (does not change the wizard-done flag) */
    const close = () => {
      stopLogin()
      for (const t of Object.values(installTimers)) clearTimeout(t)
      root.hidden = true
      root.replaceChildren()
      resolve({ settings: current })
    }
    closeNow = close

    /** Settings switches save as soon as they are pressed */
    const save = async (patch: Partial<Settings>) => {
      const r = await opts
        .api<{ settings: Settings }>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) })
        .catch(() => undefined)
      if (r) current = r.settings
      render()
    }

    const go = async (next: SetupStep) => {
      step = next
      note = ''
      enter = true
      if (step === 'check' || step === 'settings') {
        render(true)
        ;[agents, chrome, extension] = await Promise.all([
          opts.loadAgents(),
          opts.loadChrome(),
          opts.loadExtension(),
        ])
        if (step === 'settings')
          await Promise.all([loadVault(), loadLink(), loadScreen(), loadMe(), loadVersion()])
      }
      render()
    }

    const act = async (action: CheckAction) => {
      if (action === 'codex-login') {
        note = m.codexLoginNote
        render()
        await opts.api('/api/agents/codex/login', { method: 'POST' }).catch(() => {})
        agents = await opts.loadAgents()
        note = ''
      } else if (action === 'claude-login') {
        await startClaudeLogin()
        return
      } else if (action === 'payg-key') {
        await openPayg()
        return
      } else if (action === 'phone-pair') {
        const r = await opts
          .api<{ pair: PairStatus }>('/api/link/pair', { method: 'POST' })
          .catch(() => undefined)
        if (r) phone.pair = r.pair
        scrollToPair = true
        render()
        pollPair()
        return
      } else if (action === 'extension-install') {
        ext.open = true
        ext.store = (await opts.storeExtension?.().catch(() => null)) ?? null
        // On the Web Store, open that page in Chrome right away (the user only presses [Add to Chrome])
        if (ext.store) opts.openStore?.()
        else ext.dir = await opts.extensionDir()
        render()
        pollExtension()
        return
      } else {
        const kind: InstallKind =
          action === 'chrome-install'
            ? 'chrome'
            : action === 'opencode-install'
              ? 'opencode'
              : action === 'codex-install'
                ? 'codex'
                : 'claude'
        await startInstall(kind)
        return
      }
      render()
    }

    const render = (loading = false) => {
      const card = el('div', enter ? 'setup-card enter' : 'setup-card')
      enter = false
      const dots = el('div', 'steps')
      for (const s of SETUP_STEPS) {
        const d = el('span')
        if (s === step) d.className = 'on'
        dots.append(d)
      }
      if (step !== 'settings') card.append(dots)

      if (step === 'welcome') {
        card.append(
          el('div', 'doori setup-mark'),
          el('h1', 'setup-title', m.welcomeTitle),
          el('p', 'setup-sub', m.welcomeSub),
        )
        const promise = el('ul', 'promise')
        for (const t of [m.promise1, m.promise2, m.promise3]) promise.append(el('li', undefined, t))
        card.append(promise)
        const foot = el('div', 'setup-foot')
        foot.append(button('btn', m.start, () => void go('choice')))
        card.append(foot)
      }

      if (step === 'choice') {
        card.append(el('h1', 'setup-title', m.choiceTitle), el('p', 'setup-sub', m.choiceSub))
        const list = el('div', 'choices')
        list.setAttribute('role', 'radiogroup')
        for (const c of choices()) {
          const b = button(c.id === 'payg' ? 'choice wide' : 'choice', '', () => {
            choice = c.id
            render()
          })
          b.setAttribute('role', 'radio')
          b.setAttribute('aria-checked', String(choice === c.id))
          b.append(el('strong', undefined, c.title), el('span', undefined, c.sub))
          list.append(b)
        }
        card.append(list)
        const foot = el('div', 'setup-foot')
        const next = button('btn', m.next, () => void go('check'))
        next.disabled = !choice
        foot.append(
          button('btn-text', m.back, () => void go('welcome')),
          next,
        )
        card.append(foot)
      }

      if (step === 'check' && choice) {
        if (loading) {
          card.append(el('h1', 'setup-title', m.scanning), el('p', 'setup-sub', m.scanningSub))
        } else {
          const head = checkHeadline(choice, agents, chrome, extension)
          card.append(el('h1', 'setup-title', head.title), el('p', 'setup-sub', head.sub))
          card.append(...checksBlock(choice))
          if (note) card.append(el('p', 'setup-note', note))
          const foot = el('div', 'setup-foot')
          const canStart = Boolean(pickDefault(choice, agents))
          const startBtn = button('btn', canStart ? m.next : m.doLater, () => void go('awake'))
          if (!canStart) startBtn.className = 'btn-text'
          foot.append(
            button('btn-text', m.back, () => void go('choice')),
            button('btn-text', m.recheck, () => void go('check')),
            startBtn,
          )
          card.append(foot)
        }
      }

      if (step === 'awake') {
        card.append(el('h1', 'setup-title', m.awakeTitle), el('p', 'setup-sub', m.awakeSub))
        const list = el('ul', 'checks toggles')
        const toggle = (label: string, detail: string, on: boolean, set: (v: boolean) => void) =>
          toggleRow(label, detail, on, () => {
            set(!on)
            render()
          })
        list.append(
          toggle(m.awakeWorkingWizard, m.awakeDetail, awakeWorking, (v) => {
            awakeWorking = v
          }),
          toggle(m.autoStartWizard, m.autoStartDetail, autoStart, (v) => {
            autoStart = v
          }),
        )
        const statsList = el('ul', 'checks toggles')
        statsList.append(
          toggle(m.statsLabel, m.statsWizardDetail, shareStats, (v) => {
            shareStats = v
          }),
        )
        card.append(list, el('p', 'setup-hint', m.awakeHint), statsList, statsPeek())
        const foot = el('div', 'setup-foot')
        foot.append(
          button('btn-text', m.back, () => void go('check')),
          button('btn-text', m.later, () => void finish()),
          button(
            'btn',
            m.confirmPower,
            () =>
              void finish({
                keepAwake: awakeWorking ? 'working' : 'off',
                launchAtLogin: autoStart,
                usageStats: shareStats,
              }),
          ),
        )
        card.append(foot)
      }

      if (step === 'settings') {
        // Settings is a page inside the app: the left menu stays, and its own section list shows one section at a time
        card.className = 'settings-page'
        const todo = checklist(choice ?? 'both', agents, chrome, extension).filter((x) => !x.ok).length
        const tabs: [SettingsTab, IconName, string, string?][] = [
          ['general', 'gear', m.tabGeneral],
          ['ai', 'brain', m.tabAi, !loading && todo ? String(todo) : undefined],
          ['phone', 'phone', m.tabPhone],
          ['vault', 'lock', m.tabVault],
          ['me', 'card', m.tabMe],
          ...(screen?.available ? ([['apps', 'pc', m.tabApps]] as [SettingsTab, IconName, string][]) : []),
          ['about', 'info', m.tabAbout, ver.info?.status === 'available' ? 'N' : undefined],
        ]
        if (!tabs.some(([id]) => id === settingsTab)) settingsTab = 'general'
        const nav = el('nav', 'settings-nav')
        nav.setAttribute('aria-label', m.settingsNav)
        for (const [id, ic, label, badge] of tabs) {
          const b = button('settings-tab', '', () => {
            settingsTab = id
            root.scrollTop = 0
            render()
          })
          b.replaceChildren(icon(ic, 'i md'), el('span', 'grow', label))
          if (badge) b.append(el('span', 'settings-badge', badge))
          if (id === settingsTab) {
            b.classList.add('on')
            b.setAttribute('aria-current', 'page')
          }
          nav.append(b)
        }
        const body = el('div', 'settings-content')
        const sec = (title: string, sub: string | undefined, ...children: HTMLElement[]) => {
          const box = el('section', 'settings-sec')
          box.append(el('h2', 'over', title))
          if (sub) box.append(el('p', 'setup-hint', sub))
          box.append(...children)
          return box
        }
        const head = (title: string, sub: string) => {
          const h = el('header', 'page-head')
          h.append(el('h1', 'title', title), el('p', 'cap', sub))
          return h
        }
        if (loading) body.append(el('p', 'setup-sub', m.scanningDots))
        else if (settingsTab === 'general') {
          const awake = current.keepAwake === 'working' || current.keepAwake === 'always'
          const list = el('ul', 'checks toggles')
          list.append(
            toggleRow(
              m.awakeWorking,
              m.awakeDetail,
              awake,
              () => void save({ keepAwake: awake ? 'off' : 'working' }),
            ),
            toggleRow(
              m.autoStart,
              m.autoStartDetail,
              current.launchAtLogin === true,
              () => void save({ launchAtLogin: current.launchAtLogin !== true }),
            ),
          )
          const approve = (current.finalStep ?? 'approve') === 'approve'
          const gate = el('ul', 'checks toggles')
          gate.append(
            toggleRow(
              m.finalStep,
              approve ? m.finalStepOn : m.finalStepOff,
              approve,
              () => void save({ finalStep: approve ? 'self' : 'approve' }),
            ),
          )
          body.append(
            head(m.tabGeneral, m.generalSub),
            sec(m.secAwake, undefined, list),
            sec(m.secFinal, undefined, gate),
            sec(
              m.secStats,
              undefined,
              (() => {
                const ul = el('ul', 'checks toggles')
                ul.append(
                  toggleRow(
                    m.statsLabel,
                    current.usageStats ? m.statsOn : m.statsOff,
                    current.usageStats === true,
                    () => void save({ usageStats: current.usageStats !== true }),
                  ),
                )
                return ul
              })(),
              statsPeek(),
            ),
          )
          if (devMode()) body.append(sec(m.secLanguage, undefined, languageRow()))
        } else if (settingsTab === 'ai') {
          const ai = el('p', 'setup-hint')
          ai.append(
            m.chosenAi(choice ? aiChoiceLabel(choice) : m.notChosen),
            button('btn-link', m.redoSetup, () => void go('welcome')),
          )
          body.append(
            head(m.tabAi, todo ? m.todoLeft(todo) : m.aiReady),
            sec(m.secReady, undefined, ...checksBlock(choice ?? 'both')),
            ai,
          )
        } else if (settingsTab === 'phone')
          body.append(head(m.tabPhone, m.phoneSub), sec(m.secPhone, undefined, phoneBlock()))
        else if (settingsTab === 'vault')
          body.append(head(m.tabVault, m.vaultSub), sec(m.secVault, undefined, vaultBlock()))
        else if (settingsTab === 'me') body.append(head(m.tabMe, m.meSub), sec(m.secMe, undefined, meBlock()))
        else if (settingsTab === 'apps')
          body.append(head(m.tabApps, m.appsSub), sec(m.secApps, undefined, screenBlock()))
        else {
          const links = el('div', 'about-links')
          for (const [label, url] of [
            [m.siteLink, 'https://dool2.com'],
            [m.sourceLink, 'https://github.com/kuzvo-dev/dool2'],
          ] as const) {
            const a = el('a', 'btn-ghost', label)
            a.href = url
            a.target = '_blank'
            a.rel = 'noopener'
            links.append(a)
          }
          body.append(
            head(m.tabAbout, m.aboutSub),
            sec(m.secVersion, undefined, versionBlock()),
            sec(m.secReport, m.reportSub, reportBlock()),
            sec(m.secMore, undefined, links),
          )
        }
        const layout = el('div', 'settings-layout')
        const side = el('div', 'settings-side')
        side.append(el('h1', 'settings-title', m.settingsTitle), nav)
        layout.append(side, body)
        card.append(layout)
      }

      // Keep the cursor in the field being typed in after a redraw
      const typing = ['claude-code', 'payg-key', 'vault-url', 'vault-user', 'vault-pw', 'relay-url'].find(
        (id) => document.activeElement?.id === id,
      )
      // Settings sits inside the app (left menu visible); the wizard covers the whole window
      root.classList.toggle('in-app', step === 'settings')
      root.setAttribute('aria-label', step === 'settings' ? m.settingsTitle : m.firstSetup)
      root.replaceChildren(card)
      if (typing) document.getElementById(typing)?.focus()
      if (scrollToPair) {
        const panel = card.querySelector('.pair-panel')
        if (panel) {
          scrollToPair = false
          panel.scrollIntoView({ block: 'center' })
        }
      }
      // Report "drawn" only after the enter animation ends (so smoke captures are not blurry)
      if (!loading && !holdShown)
        requestAnimationFrame(() => {
          void Promise.all(card.getAnimations().map((a) => a.finished)).then(markShown, markShown)
        })
    }

    const loadLink = async () => {
      const r = await opts.api<{ link: LinkStatus }>('/api/link').catch(() => undefined)
      phone.link = r?.link
      phone.relayDraft = phone.relayDraft || r?.link.relay || ''
    }

    // Poll until the phone scans the QR and a confirmation code appears
    const pollPair = () => {
      if (pairTimer) clearTimeout(pairTimer)
      pairTimer = setTimeout(async () => {
        const r = await opts.api<{ pair: PairStatus }>('/api/link/pair').catch(() => undefined)
        if (r) {
          const changed = JSON.stringify(r.pair) !== JSON.stringify(phone.pair)
          phone.pair = r.pair
          if (r.pair.state === 'done') await loadLink()
          if (changed) scrollToPair = true
          if (changed) render()
        }
        if (phone.pair.state === 'waiting' || phone.pair.state === 'confirm') pollPair()
      }, 1_200)
    }

    /** Phone pairing: QR → check the code matches the phone → [Connect] (ADR 0012) */
    const phoneBlock = () => {
      const box = el('div', 'vault')
      const link = phone.link
      if (!link?.relay) {
        box.append(el('p', 'setup-hint', m.relayNeeded))
        const form = el('form', 'key-form')
        const i = el('input')
        i.id = 'relay-url'
        i.placeholder = m.relayPlaceholder
        i.value = phone.relayDraft
        i.oninput = () => {
          phone.relayDraft = i.value
        }
        const l = el('label', undefined, m.relayLabel)
        l.append(i)
        const save = el('button', 'btn-small', m.save)
        save.type = 'submit'
        form.append(l, save)
        form.onsubmit = (ev) => {
          ev.preventDefault()
          void (async () => {
            const r = await opts
              .api<{ settings: Settings }>('/api/settings', {
                method: 'PATCH',
                body: JSON.stringify({ relay: phone.relayDraft.trim() }),
              })
              .catch((e: Error) => {
                phone.error = e.message
                return undefined
              })
            if (r) current = r.settings
            await loadLink()
            render()
          })()
        }
        box.append(form)
        if (phone.error) box.append(el('p', 'login-error', phone.error))
        return box
      }
      box.append(el('p', 'setup-hint', m.relayStatus(relayName(link.relay), link.connected)))
      if (link.phones.length) {
        const list = el('ul', 'vault-list')
        for (const p of link.phones) {
          const li = el('li')
          const text = el('div', 'text')
          text.append(
            el('strong', undefined, p.name),
            el(
              'span',
              undefined,
              m.pairedOn(new Date(p.pairedAt).toLocaleDateString(m.dateLocale), Boolean(p.push)),
            ),
          )
          li.append(
            text,
            button('btn-link', m.unpair, async () => {
              await opts
                .api(`/api/link/phones/${encodeURIComponent(p.id)}`, { method: 'DELETE' })
                .catch(() => {})
              await loadLink()
              render()
            }),
          )
          list.append(li)
        }
        box.append(list)
      }
      const st = phone.pair
      if (st.state === 'waiting' || st.state === 'confirm') {
        const panel = el('div', 'login-panel pair-panel')
        if (st.state === 'waiting') {
          panel.append(el('strong', undefined, m.scanQr))
          const img = el('img', 'pair-qr')
          img.alt = m.qrAlt
          img.src = `data:image/svg+xml;base64,${btoa(st.qr)}`
          panel.append(img, el('p', 'cap', m.qrHint))
        } else {
          panel.append(
            el('strong', undefined, m.pairAsk(st.name)),
            el('p', undefined, m.pairCheck),
            el('div', 'pair-code', st.code.replace(/(\d{3})(\d{3})/, '$1 $2')),
          )
          const row = el('div', 'login-actions')
          row.append(
            button('btn-small', m.pairYes, async () => {
              const r = await opts
                .api<{ pair: PairStatus }>('/api/link/pair/confirm', {
                  method: 'POST',
                  body: JSON.stringify({ accept: true }),
                })
                .catch(() => undefined)
              if (r) phone.pair = r.pair
              await loadLink()
              render()
            }),
            button('btn-link', m.pairNo, async () => {
              await opts
                .api('/api/link/pair/confirm', { method: 'POST', body: JSON.stringify({ accept: false }) })
                .catch(() => {})
              phone.pair = { state: 'idle' }
              render()
            }),
          )
          panel.append(row)
        }
        panel.append(
          button('btn-link', m.close, () => {
            void opts.api('/api/link/pair', { method: 'DELETE' }).catch(() => {})
            phone.pair = { state: 'idle' }
            render()
          }),
        )
        box.append(panel)
        return box
      }
      if (st.state === 'done') box.append(el('p', 'setup-hint', m.paired(st.name)))
      if (st.state === 'expired') box.append(el('p', 'setup-hint', m.qrExpired))
      box.append(
        button('btn-small', link.phones.length ? m.pairMore : m.pair, async () => {
          const r = await opts
            .api<{ pair: PairStatus }>('/api/link/pair', { method: 'POST' })
            .catch((e: Error) => {
              phone.error = e.message
              return undefined
            })
          if (r) phone.pair = r.pair
          scrollToPair = true
          render()
          pollPair()
        }),
      )
      return box
    }

    // ── PC app control (M4): macOS permissions and allowed apps ──
    let screen: ScreenControlStatus | undefined
    const loadScreen = async () => {
      screen = (await opts.api<{ screen: ScreenControlStatus }>('/api/screen').catch(() => undefined))?.screen
    }
    /** The matching macOS System Settings pane (the user turns it on there) */
    const PANES = {
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    }
    // ── Report a problem: one line plus, if chosen, the last two days of logs. Logs hold only successes and failures, no conversations or file names (apps/daemon/src/report.ts) ──
    const report: {
      text: string
      contact: string
      logs: boolean
      preview?: string
      busy: boolean
      sentId?: string
      error?: string
    } = { text: '', contact: '', logs: true, busy: false }
    const reportBlock = () => {
      const wrap = el('div', 'report-block')
      if (report.sentId !== undefined) {
        wrap.append(
          el('p', 'setup-hint', m.reportSent(report.sentId, Boolean(report.contact))),
          button('btn-ghost', m.reportAnother, () => {
            Object.assign(report, { text: '', preview: undefined, sentId: undefined, error: undefined })
            render()
          }),
        )
        return wrap
      }
      const ta = el('textarea', 'report-text')
      ta.rows = 3
      ta.maxLength = 2000
      ta.placeholder = m.reportPlaceholder
      ta.value = report.text
      ta.oninput = () => {
        report.text = ta.value
      }
      const mail = el('input', 'report-mail')
      mail.type = 'email'
      mail.placeholder = m.reportMail
      mail.value = report.contact
      mail.oninput = () => {
        report.contact = mail.value
      }
      const check = el('label', 'report-check')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = report.logs
      cb.onchange = () => {
        report.logs = cb.checked
        report.preview = undefined
        render()
      }
      check.append(cb, m.reportLogs)
      const body = () =>
        JSON.stringify({ text: report.text, contact: report.contact, includeLogs: report.logs })
      const row = el('div', 'report-actions')
      row.append(
        button('btn-ghost', report.preview ? m.previewHide : m.previewShow, async () => {
          if (report.preview) report.preview = undefined
          else {
            const r = await opts
              .api<{ payload: unknown }>('/api/report/preview', { method: 'POST', body: body() })
              .catch(() => undefined)
            report.preview = r ? JSON.stringify(r.payload, null, 2) : m.previewFailed
          }
          render()
        }),
        button('btn-small', report.busy ? m.sending : m.send, async () => {
          if (report.busy) return
          if (!report.text.trim()) {
            report.error = m.reportEmpty
            render()
            return
          }
          report.busy = true
          report.error = undefined
          render()
          const r = await opts
            .api<{ ok: boolean; id?: string; error?: string }>('/api/report', {
              method: 'POST',
              body: body(),
            })
            .catch(
              (e: Error) => ({ ok: false, error: e.message }) as { ok: boolean; id?: string; error?: string },
            )
          report.busy = false
          if (r.ok) report.sentId = r.id ?? ''
          else report.error = r.error ?? m.reportFailed
          render()
        }),
      )
      wrap.append(ta, mail, check, row)
      if (report.error) wrap.append(el('p', 'report-error', report.error))
      if (report.preview) wrap.append(el('pre', 'report-preview', report.preview))
      wrap.append(el('p', 'setup-hint', m.reportPrivacy))
      return wrap
    }

    // ── Dool2 version: current version, check and install updates (ADR 0028) ──
    const ver: { version?: string; info: UpdateInfo | null; checking: boolean } = {
      info: null,
      checking: false,
    }
    const loadVersion = async () => {
      if (!opts.update) return
      ;[ver.version, ver.info] = await Promise.all([
        opts.update.version().catch(() => undefined),
        opts.update.state().catch(() => null),
      ])
    }
    const versionBlock = () => {
      const box = el('ul', 'checks')
      const u = ver.info
      const fresh = u?.status === 'available'
      const busy = u?.status === 'downloading' || u?.status === 'ready' || u?.status === 'installing'
      const li = el('li', fresh ? 'todo' : u?.status === 'error' ? 'todo' : 'ok')
      const text = el('div', 'text')
      text.append(
        el('strong', undefined, m.currentVersion(ver.version ?? u?.current ?? m.unknown)),
        el('span', undefined, ver.checking ? m.checkingUpdate : updateLine(u)),
      )
      if (fresh && u?.notes) text.append(el('span', 'ver-notes', m.whatsNew(u.notes)))
      li.append(el('span', 'mark'), text)
      if (opts.update && u && !busy && !ver.checking)
        li.append(
          fresh
            ? button('btn-small', m.updateTo(String(u.latest)), async () => {
                ver.info = { ...u, status: 'downloading', progress: 0 }
                render()
                ver.info = (await opts.update?.install().catch(() => null)) ?? ver.info
                render()
              })
            : button('btn-ghost', m.checkUpdate, async () => {
                ver.checking = true
                render()
                ver.info = (await opts.update?.check().catch(() => null)) ?? ver.info
                ver.checking = false
                render()
              }),
        )
      box.append(li)
      const hint = el('p', 'setup-hint')
      hint.append(m.updateHint)
      const wrap = el('div', 'ver-block')
      wrap.append(box, hint)
      return wrap
    }

    const screenBlock = () => {
      const box = el('div', 'vault')
      box.append(el('p', 'setup-hint', m.screenIntro))
      const s = screen
      if (!s) return box
      const perms = el('ul', 'checks')
      const permRow = (label: string, detail: string, on: boolean | undefined, pane: string) => {
        const li = el('li', on ? 'ok' : 'todo')
        const text = el('div', 'text')
        text.append(el('strong', undefined, label), el('span', undefined, detail))
        li.append(el('span', 'mark'), text)
        if (!on)
          li.append(
            button('btn-small', m.permOn, async () => {
              // Show the system permission prompt and open System Settings. Dool2 may need a restart after
              await opts.api('/api/screen/permissions', { method: 'POST' }).catch(() => {})
              window.open(pane)
              setTimeout(() => void loadScreen().then(() => render()), 4000)
            }),
          )
        return li
      }
      perms.append(
        permRow(
          m.accessibility,
          s.accessibility ? m.isOn : m.accessibilityTodo,
          s.accessibility,
          PANES.accessibility,
        ),
        permRow(
          m.screenRecording,
          s.screenRecording ? m.isOn : m.screenRecordingTodo,
          s.screenRecording,
          PANES.screen,
        ),
      )
      box.append(perms)
      if (s.allowed.length) {
        const list = el('ul', 'vault-list')
        for (const id of s.allowed) {
          const li = el('li')
          const text = el('div', 'text')
          text.append(el('strong', undefined, id), el('span', undefined, m.appAllowed))
          li.append(
            text,
            button('btn-link', m.allowOff, async () => {
              current = await opts
                .api<{ settings: Settings }>('/api/settings', {
                  method: 'PATCH',
                  body: JSON.stringify({ allowedApps: s.allowed.filter((x) => x !== id) }),
                })
                .then((r) => r.settings)
                .catch(() => current)
              await loadScreen()
              render()
            }),
          )
          list.append(li)
        }
        box.append(list)
      } else box.append(el('p', 'setup-hint', m.noApps))
      return box
    }

    const loadMe = async () => {
      const r = await opts
        .api<{ have: Record<string, string>; payChoices?: Record<string, string> }>('/api/profile')
        .catch(() => ({ have: {}, payChoices: {} }))
      me.have = r.have ?? {}
      me.payChoices = r.payChoices ?? {}
    }

    const saveMe = async () => {
      if (me.saving) return
      const body = Object.fromEntries(Object.entries(me.draft).filter(([, v]) => v.trim()))
      if (!Object.keys(body).length) {
        me.editing = false
        render()
        return
      }
      me.saving = true
      render()
      const r = await opts
        .api<{ bad?: string[] }>('/api/profile', { method: 'PUT', body: JSON.stringify(body) })
        .catch(() => ({ bad: Object.keys(body) }))
      const bad = (r.bad ?? []).map((k) => PROFILE_LABELS[k] ?? k)
      me.note = bad.length ? m.badFormat(bad.join('·')) : m.saved
      me.saving = false
      me.editing = false
      me.draft = {}
      await loadMe()
      render()
    }

    /** My info: values Dool2 fills into booking and order forms. Only masked values show on screen (values live only in this PC's keychain) */
    const meBlock = () => {
      const box = el('div', 'vault')
      box.append(el('p', 'setup-hint', m.meIntro))
      if (!me.editing) {
        // One row per filled field, missing ones gathered in one line (nine "not yet" rows are hard to read)
        const list = el('ul', 'vault-list')
        const missing: string[] = []
        for (const [k, label] of Object.entries(PROFILE_LABELS)) {
          const v = me.have[k]
          if (!v) {
            missing.push(label)
            continue
          }
          const li = el('li')
          const text = el('div', 'text')
          text.append(el('strong', undefined, label), el('span', undefined, v))
          li.append(text)
          list.append(li)
        }
        if (list.childElementCount) box.append(list)
        if (missing.length)
          box.append(el('p', 'cap', list.childElementCount ? m.missing(missing.join('·')) : m.meEmpty))
        const row = el('div', 'login-actions')
        row.append(
          button('btn-small', m.edit, () => {
            me.editing = true
            me.note = undefined
            render()
          }),
        )
        if (Object.keys(me.have).length)
          row.append(
            button('btn-link', m.clearAll, async () => {
              await opts.api('/api/profile', { method: 'DELETE' }).catch(() => {})
              me.note = m.meCleared
              await loadMe()
              render()
            }),
          )
        box.append(row)
      } else {
        const form = el('form', 'key-form')
        for (const [k, label] of Object.entries(PROFILE_LABELS)) {
          if (k === 'auth_app') {
            // The verification app is a choice (not a secret, so the current pick shows as is)
            const sel = el('select')
            sel.id = `me-${k}`
            sel.append(el('option', undefined, me.have[k] ? m.keepAsIs(me.have[k]) : m.pick))
            ;(sel.firstChild as HTMLOptionElement).value = ''
            for (const a of AUTH_APPS) {
              const o = el('option', undefined, authAppText(lang).name(a))
              o.value = a
              sel.append(o)
            }
            sel.value = me.draft[k] ?? ''
            sel.onchange = () => {
              me.draft[k] = sel.value
            }
            const l = el('label', undefined, label)
            l.append(sel)
            form.append(l)
            continue
          }
          const i = el('input')
          i.id = `me-${k}`
          i.autocomplete = 'off'
          if (k === 'rrn_back') i.type = 'password'
          // The current value shows masked, only as a placeholder. Leaving it empty keeps it
          i.placeholder = me.have[k] ?? (PROFILE_EXAMPLES[k] ? m.example(PROFILE_EXAMPLES[k]) : '')
          i.value = me.draft[k] ?? ''
          i.oninput = () => {
            // Phone and birth date get hyphens even when only digits are typed
            if (k === 'phone' || k === 'birth') i.value = hyphenate(k, i.value)
            me.draft[k] = i.value
          }
          const l = el('label', undefined, label)
          l.append(i)
          form.append(l)
        }
        form.onsubmit = (ev) => {
          ev.preventDefault()
          void saveMe()
        }
        const row = el('div', 'login-actions')
        const save = el('button', 'btn-small', me.saving ? m.saving : m.save)
        save.type = 'submit'
        save.disabled = me.saving
        row.append(
          save,
          button('btn-link', m.close, () => {
            me.editing = false
            me.draft = {}
            render()
          }),
        )
        form.append(row, el('p', 'cap', m.meFormHint))
        box.append(form)
      }
      if (me.note) box.append(el('p', 'cap', me.note))
      // Payment method remembered per site (the approval card's default)
      const pays = Object.entries(me.payChoices)
      if (pays.length) {
        box.append(el('p', 'setup-hint', m.payChoicesHint))
        const list = el('ul', 'vault-list')
        for (const [host, label] of pays) {
          const li = el('li')
          const text = el('div', 'text')
          text.append(el('strong', undefined, host), el('span', undefined, label))
          li.append(
            text,
            button('btn-link', m.forget, async () => {
              await opts
                .api(`/api/profile/pay/${encodeURIComponent(host)}`, { method: 'DELETE' })
                .catch(() => {})
              await loadMe()
              render()
            }),
          )
          list.append(li)
        }
        box.append(list)
      }
      return box
    }

    const loadVault = async () => {
      const r = await opts.api<{ entries: VaultEntry[] }>('/api/vault').catch(() => ({ entries: [] }))
      vault.entries = r.entries
    }

    const saveVault = async () => {
      if (vault.saving) return
      if (!vault.url.trim() || !vault.username || !vault.password) {
        vault.error = m.vaultMissing
        render()
        return
      }
      vault.saving = true
      vault.error = undefined
      render()
      try {
        await opts.api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({ url: vault.url, username: vault.username, password: vault.password }),
        })
        vault.adding = false
        vault.url = ''
        vault.username = ''
        vault.password = ''
        await loadVault()
      } catch (e) {
        vault.error = (e as Error).message
      }
      vault.saving = false
      render()
    }

    /** Dool2 vault: sign-in details per site. Passwords go in and are not shown back (ADR 0011) */
    const vaultBlock = () => {
      const box = el('div', 'vault')
      box.append(el('p', 'setup-hint', m.vaultIntro))
      if (vault.entries.length) {
        const list = el('ul', 'vault-list')
        for (const e of vault.entries) {
          const li = el('li')
          const text = el('div', 'text')
          let host = e.origin
          try {
            host = new URL(e.origin).host
          } catch {}
          const used = e.lastUsedAt
            ? m.lastUsed(
                new Date(e.lastUsedAt).toLocaleString(m.dateLocale, {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              )
            : m.notUsed
          text.append(el('strong', undefined, host), el('span', undefined, `${e.username} · ${used}`))
          if (vault.shown?.id === e.id) text.append(el('code', 'vault-pw', vault.shown.password))
          // Show and edit (ADR 0026): only on the user's screen. Hidden again after 30 seconds
          const shown = vault.shown?.id === e.id
          li.append(
            text,
            button('btn-link', shown ? m.hide : m.show, async () => {
              if (shown) {
                vault.shown = undefined
                render()
                return
              }
              const r = await opts
                .api<{ password: string }>(`/api/vault/${encodeURIComponent(e.id)}/reveal`, {
                  method: 'POST',
                })
                .catch(() => undefined)
              if (!r) return
              vault.shown = { id: e.id, password: r.password }
              render()
              setTimeout(() => {
                if (vault.shown?.id === e.id) {
                  vault.shown = undefined
                  render()
                }
              }, 30_000)
            }),
            button('btn-link', m.edit, () => {
              vault.editing = vault.editing === e.id ? undefined : e.id
              render()
            }),
            button('btn-link', m.remove, async () => {
              await opts.api(`/api/vault/${encodeURIComponent(e.id)}`, { method: 'DELETE' }).catch(() => {})
              await loadVault()
              render()
            }),
          )
          list.append(li)
          if (vault.editing === e.id) {
            const f = el('form', 'key-form')
            const u = el('input')
            u.placeholder = m.idWith(e.username)
            u.autocomplete = 'off'
            const pw = el('input')
            pw.type = 'password'
            pw.placeholder = m.newPw
            pw.autocomplete = 'new-password'
            const save = el('button', 'btn-small', m.save)
            save.type = 'submit'
            f.append(u, pw, save)
            f.onsubmit = async (ev) => {
              ev.preventDefault()
              if (!u.value.trim() && !pw.value) return
              await opts
                .api(`/api/vault/${encodeURIComponent(e.id)}`, {
                  method: 'PUT',
                  body: JSON.stringify({
                    ...(u.value.trim() ? { username: u.value.trim() } : {}),
                    ...(pw.value ? { password: pw.value } : {}),
                  }),
                })
                .catch(() => {})
              vault.editing = undefined
              vault.shown = undefined
              await loadVault()
              render()
            }
            list.append(f)
          }
        }
        box.append(list)
      }
      if (!vault.adding) {
        box.append(
          button('btn-small', m.addSite, () => {
            vault.adding = true
            render()
          }),
        )
        return box
      }
      const form = el('form', 'key-form')
      const input = (
        id: string,
        label: string,
        type: string,
        value: string,
        set: (v: string) => void,
        ph: string,
      ) => {
        const i = el('input')
        i.id = id
        i.type = type
        i.autocomplete = 'off'
        i.placeholder = ph
        i.value = value
        i.oninput = () => set(i.value)
        const l = el('label', undefined, label)
        l.append(i)
        return l
      }
      form.append(
        input('vault-url', m.siteUrl, 'text', vault.url, (v) => (vault.url = v), m.siteUrlPh),
        input('vault-user', m.id, 'text', vault.username, (v) => (vault.username = v), ''),
        input('vault-pw', m.password, 'password', vault.password, (v) => (vault.password = v), ''),
      )
      form.onsubmit = (ev) => {
        ev.preventDefault()
        void saveVault()
      }
      const row = el('div', 'login-actions')
      const save = el('button', 'btn-small', vault.saving ? m.saving : m.save)
      save.type = 'submit'
      save.disabled = vault.saving
      row.append(
        save,
        button('btn-link', m.close, () => {
          vault.adding = false
          vault.password = ''
          vault.error = undefined
          render()
        }),
      )
      form.append(row)
      box.append(form)
      if (vault.error) box.append(el('p', 'login-error', vault.error))
      box.append(el('p', 'cap', m.vaultCap))
      return box
    }

    const openPayg = async () => {
      payg.open = true
      payg.error = undefined
      render()
      const [cat, acc] = await Promise.all([
        opts
          .api<{ providers: PaygProvider[] }>('/api/agents/opencode/catalog')
          .catch(() => ({ providers: [] })),
        opts
          .api<{ account: PaygAccount | null }>('/api/agents/opencode/account')
          .catch(() => ({ account: null })),
      ])
      payg.providers = cat.providers
      payg.account = acc.account
      payg.provider = acc.account?.provider ?? cat.providers[0]?.id ?? 'anthropic'
      payg.model =
        acc.account?.model ?? cat.providers.find((p) => p.id === payg.provider)?.models[0]?.id ?? ''
      render()
    }

    const savePayg = async () => {
      if (payg.saving) return
      if (!payg.key.trim() && !payg.account?.hasKey) {
        payg.error = m.apiKeyNeeded
        render()
        return
      }
      payg.saving = true
      payg.error = undefined
      render()
      try {
        await opts.api('/api/agents/opencode/account', {
          method: 'PUT',
          body: JSON.stringify({
            provider: payg.provider,
            model: payg.model,
            ...(payg.key.trim() ? { apiKey: payg.key.trim() } : {}),
          }),
        })
        payg.open = false
        payg.key = ''
        agents = await opts.loadAgents()
      } catch (err) {
        payg.error = (err as Error).message
      }
      payg.saving = false
      render()
    }

    /** Pay as you go: pick a provider and model and enter an API key. The key is stored only in this PC's keychain */
    const paygPanel = () => {
      const panel = el('div', 'login-panel')
      panel.append(el('strong', undefined, m.paygTitle), el('p', undefined, m.paygKeyInfo))
      if (payg.providers.length === 0) {
        panel.append(el('p', undefined, m.loading))
        return panel
      }
      const form = el('form', 'key-form')
      const provSel = el('select')
      for (const p of payg.providers) {
        const o = el('option', undefined, p.label)
        o.value = p.id
        o.selected = p.id === payg.provider
        provSel.append(o)
      }
      provSel.onchange = () => {
        payg.provider = provSel.value
        payg.model = payg.providers.find((p) => p.id === payg.provider)?.models[0]?.id ?? ''
        render()
      }
      const prov = payg.providers.find((p) => p.id === payg.provider)
      const modelSel = el('select')
      for (const m of prov?.models ?? []) {
        const o = el('option', undefined, m.label)
        o.value = m.id
        o.selected = m.id === payg.model
        modelSel.append(o)
      }
      modelSel.onchange = () => {
        payg.model = modelSel.value
      }
      const key = el('input')
      key.id = 'payg-key'
      key.type = 'password'
      key.autocomplete = 'off'
      key.placeholder =
        payg.account?.hasKey && payg.account.provider === payg.provider
          ? m.savedKey(payg.account.keyHint ?? '')
          : m.pasteKey
      key.value = payg.key
      key.oninput = () => {
        payg.key = key.value
      }
      const label = (text: string, input: HTMLElement) => {
        const l = el('label', undefined, text)
        l.append(input)
        return l
      }
      form.append(label(m.aiCompany, provSel), label(m.model, modelSel), label(m.apiKey, key))
      form.onsubmit = (e) => {
        e.preventDefault()
        void savePayg()
      }
      const row = el('div', 'login-actions')
      const save = el('button', 'btn-small', payg.saving ? m.saving : m.save)
      save.type = 'submit'
      save.disabled = payg.saving
      row.append(save)
      if (prov) row.append(button('btn-link', m.getKey, () => window.open(prov.keyUrl)))
      row.append(
        button('btn-link', m.close, () => {
          payg.open = false
          render()
        }),
      )
      form.append(row)
      panel.append(form)
      if (payg.error) panel.append(el('p', 'login-error', payg.error))
      panel.append(el('p', 'cap', m.paygCap))
      return panel
    }

    /** Language row (Settings → General). Hidden outside dev mode until every screen has English copy */
    const languageRow = () => {
      const sel = el('select')
      sel.id = 'ui-language'
      for (const [code, name] of Object.entries(LANG_NAMES)) {
        const o = el('option', undefined, name)
        o.value = code
        sel.append(o)
      }
      sel.value = lang
      sel.onchange = () => {
        const next = sel.value as Lang
        void save({ language: next }).then(() => switchLang(next))
      }
      const l = el('label', undefined, m.languageLabel)
      l.append(sel)
      const form = el('form', 'key-form')
      form.append(l)
      return form
    }

    /** Shows the exact numbers sent as usage stats */
    const statsPeek = () => {
      const box = el('div', 'report-block')
      box.append(
        button('btn-link', statsPreview ? m.statsHide : m.statsShow, async () => {
          if (statsPreview) statsPreview = undefined
          else {
            const r = await opts.api<{ stats: unknown }>('/api/stats/preview').catch(() => undefined)
            statsPreview = r ? JSON.stringify(r.stats, null, 2) : m.previewFailed
          }
          render()
        }),
      )
      if (statsPreview) box.append(el('pre', 'report-preview', statsPreview))
      return box
    }

    /** One on/off row */
    const toggleRow = (label: string, detail: string, on: boolean, onClick: () => void) => {
      const li = el('li', on ? 'ok' : 'todo')
      const b = button('toggle-row', '', onClick)
      b.setAttribute('role', 'checkbox')
      b.setAttribute('aria-checked', String(on))
      const text = el('div', 'text')
      text.append(el('strong', undefined, label), el('span', undefined, detail))
      b.append(text, el('span', 'switch'))
      li.append(b)
      return li
    }

    /** Readiness list plus any install or sign-in panels in progress */
    const checksBlock = (choice: AiChoice): HTMLElement[] => {
      const parts: HTMLElement[] = []
      const list = el('ul', 'checks')
      for (const item of checklist(choice, agents, chrome, extension)) {
        const li = el('li', item.ok ? 'ok' : 'todo')
        const mark = el('span', 'mark')
        const text = el('div', 'text')
        text.append(el('strong', undefined, item.label), el('span', undefined, item.detail))
        li.append(mark, text)
        if (item.action) {
          const label =
            item.action === 'claude-install' ||
            item.action === 'chrome-install' ||
            item.action === 'opencode-install' ||
            item.action === 'codex-install'
              ? m.install
              : item.action === 'payg-key'
                ? m.addKey
                : item.action === 'extension-install'
                  ? m.howToAdd
                  : item.action === 'codex-login'
                    ? m.chatgptSignIn
                    : m.signIn
          const action = item.action
          const b = button('btn-small', label, () => void act(action))
          if (action === 'claude-login' && login.state === 'waiting') {
            b.textContent = m.signingIn
            b.disabled = true
          }
          const kind: InstallKind | undefined =
            action === 'claude-install'
              ? 'claude'
              : action === 'chrome-install'
                ? 'chrome'
                : action === 'opencode-install'
                  ? 'opencode'
                  : action === 'codex-install'
                    ? 'codex'
                    : undefined
          if (kind && installs[kind].state === 'running') {
            b.textContent = m.installingBtn
            b.disabled = true
          }
          li.append(b)
        }
        list.append(li)
      }
      parts.push(list)
      for (const kind of ['claude', 'codex', 'opencode', 'chrome'] as const) {
        const st = installs[kind].state
        if (st === 'running' || st === 'failed') parts.push(installPanel(kind))
      }
      if (login.state === 'waiting' || login.state === 'failed') parts.push(loginPanel())
      if (payg.open) parts.push(paygPanel())
      if (ext.open) parts.push(extensionPanel())
      return parts
    }

    /** Adding the Dool2 extension: one [Add to Chrome] when it's on the Web Store, otherwise load the folder by hand */
    const extensionPanel = () => (ext.store ? storePanel() : folderPanel())

    /** On the Web Store: [Add to Chrome] → [Add extension] on the page opened in Chrome */
    const storePanel = () => {
      const panel = el('div', 'login-panel')
      panel.append(el('strong', undefined, m.extAddTitle))
      const steps = el('ol', 'ext-steps')
      for (const parts of [
        [m.storeStep1a, el('b', undefined, m.storeStep1b), m.storeStep1c],
        [m.storeStep2a, el('b', undefined, m.storeStep2b), m.storeStep2c],
      ] as (string | HTMLElement)[][]) {
        const item = el('li')
        item.append(...parts)
        steps.append(item)
      }
      panel.append(steps)
      const wait = el('p', 'ext-wait')
      wait.append(el('span', 'spin'), document.createTextNode(m.extWait))
      panel.append(wait, el('p', 'cap', m.storeCap))
      const row = el('div', 'login-actions')
      row.append(
        button('btn-small', m.reopenChrome, () => opts.openStore?.()),
        button('btn-link', m.close, () => {
          ext.open = false
          if (extTimer) clearTimeout(extTimer)
          render()
        }),
      )
      panel.append(row)
      return panel
    }

    /** Before the Web Store: load the extension folder by hand in developer mode */
    const folderPanel = () => {
      const panel = el('div', 'login-panel')
      panel.append(el('strong', undefined, m.extAddTitle))
      const steps = el('ol', 'ext-steps')
      const li = (...parts: (string | HTMLElement)[]) => {
        const item = el('li')
        item.append(...parts)
        steps.append(item)
      }
      const copy = button('btn-link', ext.copied ? m.copied : m.copyAddr, async () => {
        await navigator.clipboard.writeText('chrome://extensions').catch(() => {})
        ext.copied = true
        render()
      })
      li(m.folderStep1a, el('code', undefined, 'chrome://extensions'), m.folderStep1b, copy)
      li(m.folderStep2a, el('b', undefined, m.folderStep2b), m.folderStep2c)
      li(
        button('btn-small', m.openExtFolder, () => opts.revealExtension()),
        m.folderStep3a,
        el('b', undefined, 'chrome-extension'),
        m.folderStep3b,
      )
      panel.append(steps)
      const wait = el('p', 'ext-wait')
      wait.append(el('span', 'spin'), document.createTextNode(m.extWait))
      panel.append(wait, el('p', 'cap', m.folderCap))
      const row = el('div', 'login-actions')
      row.append(
        button('btn-link', m.close, () => {
          ext.open = false
          if (extTimer) clearTimeout(extTimer)
          render()
        }),
      )
      panel.append(row)
      return panel
    }

    /** Install progress for a component (Claude Code, Chrome) */
    const installPanel = (kind: InstallKind) => {
      const info = INSTALLS[kind]
      const st = installs[kind]
      const panel = el('div', 'login-panel')
      if (st.state === 'failed') {
        panel.append(el('strong', undefined, m.installFailed(kind)), el('p', undefined, st.message))
        const row = el('div', 'login-actions')
        row.append(
          button('btn-small', m.retry, () => void startInstall(kind)),
          button('btn-link', m.manualInstall, () => window.open(info.help)),
        )
        panel.append(row)
        return panel
      }
      if (st.state !== 'running') return panel
      const label: Record<string, string> = {
        prepare: m.phasePrepare,
        download: m.phaseDownload(st.percent),
        verify: m.phaseVerify,
        setup: m.phaseSetup,
      }
      panel.append(el('strong', undefined, m.installing(kind)), el('p', undefined, label[st.phase] ?? ''))
      const bar = el('div', 'progress')
      const fill = el('span', 'progress-fill')
      const pct = st.phase === 'download' ? (st.percent ?? 0) : st.phase === 'prepare' ? 0 : 100
      fill.style.width = `${Math.max(3, pct)}%`
      bar.append(fill)
      panel.append(bar, el('p', 'cap', m.installSource(kind)))
      return panel
    }

    /** Claude sign-in: sign in in the browser, or paste the code it shows */
    const loginPanel = () => {
      const panel = el('div', 'login-panel')
      if (login.state === 'failed') {
        panel.append(el('strong', undefined, m.claudeLoginFailed), el('p', undefined, login.message))
        const row = el('div', 'login-actions')
        row.append(
          button('btn-small', m.retry, () => void startClaudeLogin()),
          button('btn-link', m.close, () => {
            login = { state: 'idle' }
            render()
          }),
        )
        panel.append(row)
        return panel
      }
      if (login.state !== 'waiting') return panel
      panel.append(el('strong', undefined, m.claudeLoginTitle), el('p', undefined, m.claudeLoginBody))
      const form = el('form', 'code-row')
      const input = el('input')
      input.id = 'claude-code'
      input.placeholder = m.pasteCode
      input.autocomplete = 'off'
      input.spellcheck = false
      input.value = codeDraft
      input.oninput = () => {
        codeDraft = input.value
      }
      const ok = el('button', 'btn-small', sending ? m.checking : m.confirm)
      ok.type = 'submit'
      ok.disabled = sending
      form.onsubmit = (e) => {
        e.preventDefault()
        void sendCode()
      }
      form.append(input, ok)
      panel.append(form)
      if (login.codeRejected && !sending) panel.append(el('p', 'login-error', m.codeRejected))
      const row = el('div', 'login-actions')
      const url = login.url
      if (url) row.append(button('btn-link', m.reopenLogin, () => window.open(url)))
      row.append(
        button('btn-link', m.giveUp, () => {
          stopLogin()
          render()
        }),
      )
      panel.append(row)
      return panel
    }

    const begin = async () => {
      if (step === 'check' || step === 'settings') await go(step)
      else render()
      const action = opts.start?.action
      if (action) {
        await act(action)
        holdShown = false
        render()
      }
    }
    void begin()
  })
  return { shown, done, close: () => closeNow() }
}
