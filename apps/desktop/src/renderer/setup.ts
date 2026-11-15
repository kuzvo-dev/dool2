// 첫 실행 마법사 화면: 인사 → 어떤 AI 구독을 쓰세요? → 준비 상태 확인
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
import {
  AI_CHOICE_LABEL,
  CHOICES,
  type CheckAction,
  checkHeadline,
  checklist,
  pickDefault,
  SETUP_STEPS,
  type SetupStep,
} from './setup-model.js'

type Api = <T>(path: string, init?: RequestInit) => Promise<T>

export interface SetupOptions {
  api: Api
  loadAgents(): Promise<AgentStatus[]>
  loadChrome(): Promise<ChromeStatus>
  loadExtension(): Promise<ExtensionStatus>
  /** Chrome에 올릴 두리 확장 폴더를 보여 준다 */
  revealExtension(): void
  extensionDir(): Promise<string>
  /** 지금 저장된 설정 (설정 화면에서 보여 주고 바꾼다) */
  settings?: Settings
  /** 이 단계와 선택으로 바로 연다. action은 점검 모드에서 버튼을 대신 누른다 */
  start?: { step: SetupStep; choice?: AiChoice; action?: CheckAction }
}

type InstallKind = 'claude' | 'chrome' | 'opencode' | 'codex'

/** 부품별 설치 주소와 안내 문구 */
// obj: 조사까지 붙인 이름 (Claude Code를 / Chrome을)
const INSTALLS: Record<InstallKind, { url: string; obj: string; source: string; help: string }> = {
  claude: {
    url: '/api/agents/claude/install',
    obj: 'Claude Code를',
    source: 'Anthropic 공식 배포 서버에서 받아요. 1~2분 걸려요.',
    help: 'https://code.claude.com/docs/en/setup',
  },
  codex: {
    url: '/api/agents/codex/install',
    obj: 'Codex를',
    source: 'OpenAI 공식 배포(npm)에서 받아요. 두리에 적어 둔 확인값과 맞을 때만 설치해요.',
    help: 'https://developers.openai.com/codex',
  },
  opencode: {
    url: '/api/agents/opencode/install',
    obj: '종량제 실행기를',
    source: '오픈소스 OpenCode 공식 릴리스에서 받아요. 확인값을 맞춰 본 뒤 설치해요.',
    help: 'https://opencode.ai',
  },
  chrome: {
    url: '/api/browser/install',
    obj: 'Chrome을',
    source: 'Google 공식 서버에서 받아요. Google 서명을 확인한 뒤 설치해요.',
    help: 'https://www.google.com/chrome/',
  },
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

function button(cls: string, text: string, onClick: () => void) {
  const b = el('button', cls, text)
  b.type = 'button'
  b.onclick = onClick
  return b
}

/** 마법사를 띄운다. shown은 첫 화면이 다 그려졌을 때, done은 마법사를 끝냈을 때 풀린다 */
export function runSetup(opts: SetupOptions): { shown: Promise<void>; done: Promise<SetupResult> } {
  let markShown: () => void = () => {}
  const shown = new Promise<void>((r) => {
    markShown = r
  })
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
  // 두리 확장 추가 안내 (웹 스토어 전까지는 폴더를 직접 올린다)
  const ext: { open: boolean; dir: string; copied: boolean } = { open: false, dir: '', copied: false }
  let extTimer: ReturnType<typeof setTimeout> | undefined
  // 폰 연결 (설정 화면)
  const phone: { link?: LinkStatus; pair: PairStatus; relayDraft: string; error?: string } = {
    pair: { state: 'idle' },
    relayDraft: '',
  }
  let pairTimer: ReturnType<typeof setTimeout> | undefined
  /** QR·확인 코드가 새로 나오면 그 자리로 화면을 내린다 (설정 화면이 길어서) */
  let scrollToPair = false
  // 두리 금고 (설정 화면)
  const vault: {
    entries: VaultEntry[]
    adding: boolean
    url: string
    username: string
    password: string
    saving: boolean
    error?: string
  } = { entries: [], adding: false, url: '', username: '', password: '', saving: false }
  const installs: Record<InstallKind, InstallStatus> = {
    claude: { state: 'idle' },
    chrome: { state: 'idle' },
    opencode: { state: 'idle' },
    codex: { state: 'idle' },
  }
  const installTimers: Partial<Record<InstallKind, ReturnType<typeof setTimeout>>> = {}
  let codeDraft = ''
  // 종량제 API 키 입력
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
  // "두리가 쉬지 않게" 단계의 선택 (기본은 둘 다 켬, 사용자가 끌 수 있다)
  let awakeWorking = current.keepAwake ? current.keepAwake !== 'off' : true
  let autoStart = current.launchAtLogin ?? true
  let sending = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  // 단계가 바뀔 때만 나타나는 효과를 준다 (입력 중에 다시 그려도 깜빡이지 않게)
  let enter = true
  // 점검 모드에서 버튼을 대신 누르면, 그 결과까지 그린 뒤에 캡처한다
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

    // 브라우저에서 로그인이 끝났는지 주기적으로 본다
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

    // 설치가 끝나면 그 부품의 상태를 다시 확인한다
    const refresh = async (kind: InstallKind) => {
      if (kind === 'chrome')
        [chrome, extension] = await Promise.all([opts.loadChrome(), opts.loadExtension()])
      else agents = await opts.loadAgents()
    }

    // 설치 진행률을 주기적으로 받아 온다
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
      // 내려받기가 조금 진행될 때까지만 기다린다 (점검 캡처가 진행 중인 화면을 찍게)
      const early = () => {
        const s = installs[kind]
        return (
          s.state === 'running' &&
          (s.phase === 'prepare' || (s.phase === 'download' && (s.percent ?? 0) < 10))
        )
      }
      for (let i = 0; i < 80 && early(); i++) await new Promise((res) => setTimeout(res, 250))
    }

    // 확장이 붙었는지 주기적으로 본다. 붙으면 안내를 닫고 초록불
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

    const finish = async (power?: Pick<Settings, 'keepAwake' | 'launchAtLogin'>) => {
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

    /** 설정 화면을 그냥 닫는다 (마법사 완료 표시는 바꾸지 않는다) */
    const close = () => {
      stopLogin()
      for (const t of Object.values(installTimers)) clearTimeout(t)
      root.hidden = true
      root.replaceChildren()
      resolve({ settings: current })
    }

    /** 설정 화면의 스위치는 누르는 즉시 저장한다 */
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
        if (step === 'settings') await Promise.all([loadVault(), loadLink(), loadScreen()])
      }
      render()
    }

    const act = async (action: CheckAction) => {
      if (action === 'codex-login') {
        note = '브라우저에서 ChatGPT 로그인을 마치면 여기로 돌아와 주세요.'
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
        ext.dir = await opts.extensionDir()
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
          el('h1', 'setup-title', '안녕하세요, 저는 두리예요'),
          el(
            'p',
            'setup-sub',
            '이 컴퓨터에 살면서 부탁하신 일을 대신 해요. 시작하기 전에 같이 준비할 게 조금 있어요. 1분이면 돼요.',
          ),
        )
        const promise = el('ul', 'promise')
        for (const t of [
          '쓰고 계신 AI 구독으로 일해요. 두리 이용료는 없어요.',
          '돈 쓰는 일과 누군가에게 연락하는 일은 꼭 먼저 물어봐요.',
          '대화는 이 컴퓨터에만 남아요.',
        ])
          promise.append(el('li', undefined, t))
        card.append(promise)
        const foot = el('div', 'setup-foot')
        foot.append(button('btn', '시작하기', () => void go('choice')))
        card.append(foot)
      }

      if (step === 'choice') {
        card.append(
          el('h1', 'setup-title', '어떤 AI로 일할까요?'),
          el(
            'p',
            'setup-sub',
            '쓰고 계신 AI 구독으로 일해요. 구독이 없으면 쓴 만큼만 내는 방법도 있어요. 나중에 바꿀 수 있어요.',
          ),
        )
        const list = el('div', 'choices')
        list.setAttribute('role', 'radiogroup')
        for (const c of CHOICES) {
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
        const next = button('btn', '다음', () => void go('check'))
        next.disabled = !choice
        foot.append(
          button('btn-text', '이전', () => void go('welcome')),
          next,
        )
        card.append(foot)
      }

      if (step === 'check' && choice) {
        if (loading) {
          card.append(
            el('h1', 'setup-title', '이 컴퓨터를 살펴보는 중이에요'),
            el('p', 'setup-sub', '잠깐이면 돼요.'),
          )
        } else {
          const head = checkHeadline(choice, agents, chrome, extension)
          card.append(el('h1', 'setup-title', head.title), el('p', 'setup-sub', head.sub))
          card.append(...checksBlock(choice))
          if (note) card.append(el('p', 'setup-note', note))
          const foot = el('div', 'setup-foot')
          const canStart = Boolean(pickDefault(choice, agents))
          const startBtn = button('btn', canStart ? '다음' : '나중에 할게요', () => void go('awake'))
          if (!canStart) startBtn.className = 'btn-text'
          foot.append(
            button('btn-text', '이전', () => void go('choice')),
            button('btn-text', '다시 확인', () => void go('check')),
            startBtn,
          )
          card.append(foot)
        }
      }

      if (step === 'awake') {
        card.append(
          el('h1', 'setup-title', '두리가 쉬지 않게 할까요?'),
          el(
            'p',
            'setup-sub',
            'PC가 잠들면 두리도 잠시 쉬어요. 맡긴 일은 PC가 깨어나면 이어서 할게요. 허락해 주신 것만 바꾸고, 언제든 되돌릴 수 있어요.',
          ),
        )
        const list = el('ul', 'checks toggles')
        const toggle = (label: string, detail: string, on: boolean, set: (v: boolean) => void) =>
          toggleRow(label, detail, on, () => {
            set(!on)
            render()
          })
        list.append(
          toggle(
            '두리가 일하는 동안 PC가 잠들지 않게 할게요',
            '화면은 꺼져도 돼요. 일이 끝나면 평소처럼 잠들어요.',
            awakeWorking,
            (v) => {
              awakeWorking = v
            },
          ),
          toggle('PC를 켜면 두리도 자동으로 켜지게 할게요', '창 없이 조용히 켜져요.', autoStart, (v) => {
            autoStart = v
          }),
        )
        card.append(
          list,
          el(
            'p',
            'setup-hint',
            '화면 잠금이나 보안 설정은 건드리지 않아요. 그래서 컴퓨터를 다시 켜면, 로그인한 뒤에 두리가 돌아와요.',
          ),
        )
        const foot = el('div', 'setup-foot')
        foot.append(
          button('btn-text', '이전', () => void go('check')),
          button('btn-text', '나중에', () => void finish()),
          button(
            'btn',
            '이렇게 할게요',
            () => void finish({ keepAwake: awakeWorking ? 'working' : 'off', launchAtLogin: autoStart }),
          ),
        )
        card.append(foot)
      }

      if (step === 'settings') {
        card.append(
          el('h1', 'setup-title', '설정'),
          el('p', 'setup-sub', '두리가 일할 준비가 됐는지 확인하고, 쉬는 방식을 바꿀 수 있어요.'),
        )
        if (loading) card.append(el('p', 'setup-sub', '이 컴퓨터를 살펴보는 중이에요…'))
        else {
          card.append(el('h2', 'over', '준비 상태'), ...checksBlock(choice ?? 'both'))
          const awake = current.keepAwake === 'working' || current.keepAwake === 'always'
          const list = el('ul', 'checks toggles')
          list.append(
            toggleRow(
              '두리가 일하는 동안 PC가 잠들지 않게',
              '화면은 꺼져도 돼요. 일이 끝나면 평소처럼 잠들어요.',
              awake,
              () => void save({ keepAwake: awake ? 'off' : 'working' }),
            ),
            toggleRow(
              'PC를 켜면 두리도 자동으로 켜기',
              '창 없이 조용히 켜져요.',
              current.launchAtLogin === true,
              () => void save({ launchAtLogin: current.launchAtLogin !== true }),
            ),
          )
          card.append(el('h2', 'over', '두리가 쉬지 않게'), list)
          const approve = (current.finalStep ?? 'approve') === 'approve'
          const gate = el('ul', 'checks toggles')
          gate.append(
            toggleRow(
              '결제·보내기는 승인하면 두리가 누르기',
              approve
                ? '두리가 화면 캡처와 내용을 보여 드리고, 승인하시면 그 버튼 하나만 눌러요.'
                : '꺼져 있어요. 마지막 버튼은 항상 직접 누르세요. 두리는 바로 앞까지만 준비해요.',
              approve,
              () => void save({ finalStep: approve ? 'self' : 'approve' }),
            ),
          )
          card.append(el('h2', 'over', '마지막 확인'), gate)
          card.append(el('h2', 'over', '폰 연결'), phoneBlock())
          card.append(el('h2', 'over', '두리 금고'), vaultBlock())
          if (screen?.available) card.append(el('h2', 'over', 'PC 앱 조작'), screenBlock())
          const ai = el('p', 'setup-hint')
          ai.append(
            `고른 AI 구독: ${choice ? AI_CHOICE_LABEL[choice] : '아직 안 골랐어요'} · `,
            button('btn-link', '처음 설정 다시 하기', () => void go('welcome')),
          )
          card.append(ai)
        }
        const foot = el('div', 'setup-foot')
        foot.append(button('btn', '닫기', close))
        card.append(foot)
      }

      // 입력 중이던 코드 칸은 다시 그린 뒤에도 커서를 유지한다
      const typing = ['claude-code', 'payg-key', 'vault-url', 'vault-user', 'vault-pw', 'relay-url'].find(
        (id) => document.activeElement?.id === id,
      )
      root.replaceChildren(card)
      if (typing) document.getElementById(typing)?.focus()
      if (scrollToPair) {
        const panel = card.querySelector('.pair-panel')
        if (panel) {
          scrollToPair = false
          panel.scrollIntoView({ block: 'center' })
        }
      }
      // 나타나는 효과가 끝난 뒤에 "다 그려졌다"고 알린다 (점검 캡처가 흐리지 않게)
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

    // 폰이 QR을 찍고 확인 코드가 나올 때까지 본다
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

    /** 폰 연결: QR → 폰과 같은 확인 코드인지 보고 [연결] (ADR 0012) */
    const phoneBlock = () => {
      const box = el('div', 'vault')
      const link = phone.link
      if (!link?.relay) {
        box.append(
          el(
            'p',
            'setup-hint',
            '폰에서 부탁하려면 중계 서버 주소가 필요해요. 공식 주소는 출시 때 자동으로 들어가요.',
          ),
        )
        const form = el('form', 'key-form')
        const i = el('input')
        i.id = 'relay-url'
        i.placeholder = 'https://… (직접 운영하는 중계 서버)'
        i.value = phone.relayDraft
        i.oninput = () => {
          phone.relayDraft = i.value
        }
        const l = el('label', undefined, '중계 서버 주소')
        l.append(i)
        const save = el('button', 'btn-small', '저장')
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
      box.append(
        el(
          'p',
          'setup-hint',
          `${link.connected ? '중계 서버와 연결돼 있어요.' : '중계 서버에 연결하는 중이에요.'} 폰에서 부탁하고, 결제·보내기는 폰에서 승인해요. 주고받는 내용은 PC와 폰만 열 수 있게 암호화돼요.`,
        ),
      )
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
              `연결한 날 ${new Date(p.pairedAt).toLocaleDateString('ko-KR')} · ${p.push ? '알림 받음' : '알림 꺼짐 (폰 앱에서 [알림 켜기])'}`,
            ),
          )
          li.append(
            text,
            button('btn-link', '연결 끊기', async () => {
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
          panel.append(el('strong', undefined, '폰 카메라로 QR을 찍어 주세요'))
          const img = el('img', 'pair-qr')
          img.alt = '폰 연결 QR'
          img.src = `data:image/svg+xml;base64,${btoa(st.qr)}`
          panel.append(img, el('p', 'cap', '5분 안에 찍어 주세요. 이 QR은 한 번만 쓸 수 있어요.'))
        } else {
          panel.append(
            el('strong', undefined, `"${st.name}"을(를) 연결할까요?`),
            el('p', undefined, '폰 화면에 같은 숫자가 보이는지 확인해 주세요.'),
            el('div', 'pair-code', st.code.replace(/(\d{3})(\d{3})/, '$1 $2')),
          )
          const row = el('div', 'login-actions')
          row.append(
            button('btn-small', '같아요, 연결', async () => {
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
            button('btn-link', '다른 숫자예요', async () => {
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
          button('btn-link', '닫기', () => {
            void opts.api('/api/link/pair', { method: 'DELETE' }).catch(() => {})
            phone.pair = { state: 'idle' }
            render()
          }),
        )
        box.append(panel)
        return box
      }
      if (st.state === 'done') box.append(el('p', 'setup-hint', `"${st.name}"을(를) 연결했어요.`))
      if (st.state === 'expired') box.append(el('p', 'setup-hint', 'QR 시간이 지났어요. 다시 해 주세요.'))
      box.append(
        button('btn-small', link.phones.length ? '폰 더 연결하기' : '폰 연결하기', async () => {
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

    // ── PC 앱 조작 (M4): 맥 권한과 허용한 앱 ──
    let screen: ScreenControlStatus | undefined
    const loadScreen = async () => {
      screen = (await opts.api<{ screen: ScreenControlStatus }>('/api/screen').catch(() => undefined))?.screen
    }
    /** 맥 시스템 설정의 해당 화면 (사용자가 직접 켜야 한다) */
    const PANES = {
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    }
    const screenBlock = () => {
      const box = el('div', 'vault')
      box.append(
        el(
          'p',
          'setup-hint',
          '카카오톡 PC처럼 앱만 있는 일을 두리가 대신 해요. 허용한 앱만 다루고, 메시지 보내기·결제·삭제는 꼭 승인을 받아요. 화면이 잠겨 있으면 하지 않아요.',
        ),
      )
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
            button('btn-small', '권한 켜기', async () => {
              // 시스템 권한 창을 띄우고, 설정 화면도 연다. 켠 뒤에는 두리를 다시 켜야 할 수 있다
              await opts.api('/api/screen/permissions', { method: 'POST' }).catch(() => {})
              window.open(pane)
              setTimeout(() => void loadScreen().then(() => render()), 4000)
            }),
          )
        return li
      }
      perms.append(
        permRow(
          '손쉬운 사용',
          s.accessibility ? '켜져 있어요' : '앱 화면을 읽고 누르는 데 필요해요. 설정에서 "두리"를 켜 주세요',
          s.accessibility,
          PANES.accessibility,
        ),
        permRow(
          '화면 기록',
          s.screenRecording ? '켜져 있어요' : '앱 화면을 그림으로 볼 때(승인 카드 캡처) 필요해요',
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
          text.append(el('strong', undefined, id), el('span', undefined, '두리가 조작할 수 있어요'))
          li.append(
            text,
            button('btn-link', '허용 끄기', async () => {
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
      } else
        box.append(el('p', 'setup-hint', '아직 허용한 앱이 없어요. 두리가 처음 다루는 앱은 그때 물어볼게요.'))
      return box
    }

    const loadVault = async () => {
      const r = await opts.api<{ entries: VaultEntry[] }>('/api/vault').catch(() => ({ entries: [] }))
      vault.entries = r.entries
    }

    const saveVault = async () => {
      if (vault.saving) return
      if (!vault.url.trim() || !vault.username || !vault.password) {
        vault.error = '사이트 주소, 아이디, 비밀번호를 모두 넣어 주세요'
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

    /** 두리 금고: 사이트별 로그인 정보. 비밀번호는 넣기만 하고 다시 보여 주지 않는다 (ADR 0011) */
    const vaultBlock = () => {
      const box = el('div', 'vault')
      box.append(
        el(
          'p',
          'setup-hint',
          '저장해 둔 사이트는 로그인이 풀려도 두리가 대신 채워요. AI는 비밀번호를 볼 수 없고, 두리가 주소를 확인한 뒤 직접 넣어요.',
        ),
      )
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
            ? `마지막 사용 ${new Date(e.lastUsedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
            : '아직 안 썼어요'
          text.append(el('strong', undefined, host), el('span', undefined, `${e.username} · ${used}`))
          li.append(
            text,
            button('btn-link', '지우기', async () => {
              await opts.api(`/api/vault/${encodeURIComponent(e.id)}`, { method: 'DELETE' }).catch(() => {})
              await loadVault()
              render()
            }),
          )
          list.append(li)
        }
        box.append(list)
      }
      if (!vault.adding) {
        box.append(
          button('btn-small', '사이트 추가', () => {
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
        input(
          'vault-url',
          '사이트 주소',
          'text',
          vault.url,
          (v) => (vault.url = v),
          '로그인하는 페이지 주소 (https://…)',
        ),
        input('vault-user', '아이디', 'text', vault.username, (v) => (vault.username = v), ''),
        input('vault-pw', '비밀번호', 'password', vault.password, (v) => (vault.password = v), ''),
      )
      form.onsubmit = (ev) => {
        ev.preventDefault()
        void saveVault()
      }
      const row = el('div', 'login-actions')
      const save = el('button', 'btn-small', vault.saving ? '저장하는 중…' : '저장')
      save.type = 'submit'
      save.disabled = vault.saving
      row.append(
        save,
        button('btn-link', '닫기', () => {
          vault.adding = false
          vault.password = ''
          vault.error = undefined
          render()
        }),
      )
      form.append(row)
      box.append(form)
      if (vault.error) box.append(el('p', 'login-error', vault.error))
      box.append(
        el(
          'p',
          'cap',
          '이 PC의 키체인에 암호화해 둬요. 결제 비밀번호·카드 번호·공동인증서 비밀번호는 넣지 마세요. 그런 건 늘 직접 넣어요.',
        ),
      )
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
        payg.error = 'API 키를 넣어 주세요'
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

    /** 종량제: 제공자·모델을 고르고 API 키를 넣는다. 키는 이 PC의 키체인에만 저장된다 */
    const paygPanel = () => {
      const panel = el('div', 'login-panel')
      panel.append(
        el('strong', undefined, 'API 키로 쓴 만큼만 내요'),
        el('p', undefined, '키는 이 컴퓨터의 키체인에 암호화해서 두고, 두리 화면에는 끝 네 자리만 보여요.'),
      )
      if (payg.providers.length === 0) {
        panel.append(el('p', undefined, '불러오는 중이에요…'))
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
          ? `저장된 키 ····${payg.account.keyHint ?? ''} (바꿀 때만 넣어 주세요)`
          : 'API 키 붙여 넣기'
      key.value = payg.key
      key.oninput = () => {
        payg.key = key.value
      }
      const label = (text: string, input: HTMLElement) => {
        const l = el('label', undefined, text)
        l.append(input)
        return l
      }
      form.append(label('AI 회사', provSel), label('모델', modelSel), label('API 키', key))
      form.onsubmit = (e) => {
        e.preventDefault()
        void savePayg()
      }
      const row = el('div', 'login-actions')
      const save = el('button', 'btn-small', payg.saving ? '저장하는 중…' : '저장')
      save.type = 'submit'
      save.disabled = payg.saving
      row.append(save)
      if (prov) row.append(button('btn-link', '키 받는 곳', () => window.open(prov.keyUrl)))
      row.append(
        button('btn-link', '닫기', () => {
          payg.open = false
          render()
        }),
      )
      form.append(row)
      panel.append(form)
      if (payg.error) panel.append(el('p', 'login-error', payg.error))
      panel.append(el('p', 'cap', '쓴 금액은 답마다 두리 화면에 보여 드려요. 요금은 AI 회사에 직접 내요.'))
      return panel
    }

    /** 켜고 끄는 줄 하나 */
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

    /** 준비 목록과 진행 중인 설치·로그인 패널 */
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
              ? '설치하기'
              : item.action === 'payg-key'
                ? '키 넣기'
                : item.action === 'extension-install'
                  ? '추가 방법'
                  : item.action === 'codex-login'
                    ? 'ChatGPT로 로그인'
                    : '로그인하기'
          const action = item.action
          const b = button('btn-small', label, () => void act(action))
          if (action === 'claude-login' && login.state === 'waiting') {
            b.textContent = '로그인 중…'
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
            b.textContent = '설치 중…'
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

    /** 두리 확장 추가 안내. 웹 스토어에 올리면(M5) 버튼 한 번으로 바뀐다 */
    const extensionPanel = () => {
      const panel = el('div', 'login-panel')
      panel.append(el('strong', undefined, 'Chrome에 두리 확장 추가하기'))
      const steps = el('ol', 'ext-steps')
      const li = (...parts: (string | HTMLElement)[]) => {
        const item = el('li')
        item.append(...parts)
        steps.append(item)
      }
      const copy = button('btn-link', ext.copied ? '복사했어요' : '주소 복사', async () => {
        await navigator.clipboard.writeText('chrome://extensions').catch(() => {})
        ext.copied = true
        render()
      })
      li('Chrome 주소창에 ', el('code', undefined, 'chrome://extensions'), '를 열어요 ', copy)
      li('오른쪽 위 ', el('b', undefined, '개발자 모드'), '를 켜요')
      li(
        button('btn-small', '확장 폴더 열기', () => opts.revealExtension()),
        ' 를 눌러 나온 ',
        el('b', undefined, 'chrome-extension'),
        ' 폴더를 그 화면으로 끌어다 놓아요',
      )
      panel.append(steps)
      const wait = el('p', 'ext-wait')
      wait.append(el('span', 'spin'), document.createTextNode('추가되면 여기서 바로 알아채요'))
      panel.append(
        wait,
        el(
          'p',
          'cap',
          '두리는 두리가 연 탭만 다루고, 결제·보내기 같은 마지막 버튼은 누르지 않아요. 곧 웹 스토어에서 한 번에 추가할 수 있게 바뀌어요.',
        ),
      )
      const row = el('div', 'login-actions')
      row.append(
        button('btn-link', '닫기', () => {
          ext.open = false
          if (extTimer) clearTimeout(extTimer)
          render()
        }),
      )
      panel.append(row)
      return panel
    }

    /** 부품(Claude Code, Chrome) 설치 진행 */
    const installPanel = (kind: InstallKind) => {
      const info = INSTALLS[kind]
      const st = installs[kind]
      const panel = el('div', 'login-panel')
      if (st.state === 'failed') {
        panel.append(el('strong', undefined, `${info.obj} 설치하지 못했어요`), el('p', undefined, st.message))
        const row = el('div', 'login-actions')
        row.append(
          button('btn-small', '다시 시도', () => void startInstall(kind)),
          button('btn-link', '직접 설치하는 방법', () => window.open(info.help)),
        )
        panel.append(row)
        return panel
      }
      if (st.state !== 'running') return panel
      const label: Record<string, string> = {
        prepare: '설치를 준비하는 중이에요',
        download: `내려받는 중이에요${st.percent !== undefined ? ` · ${st.percent}%` : ''}`,
        verify: '공식 파일이 맞는지 확인하는 중이에요',
        setup: '설치를 마무리하는 중이에요',
      }
      panel.append(
        el('strong', undefined, `${info.obj} 설치하고 있어요`),
        el('p', undefined, label[st.phase] ?? ''),
      )
      const bar = el('div', 'progress')
      const fill = el('span', 'progress-fill')
      const pct = st.phase === 'download' ? (st.percent ?? 0) : st.phase === 'prepare' ? 0 : 100
      fill.style.width = `${Math.max(3, pct)}%`
      bar.append(fill)
      panel.append(bar, el('p', 'cap', info.source))
      return panel
    }

    /** Claude 로그인 안내: 브라우저에서 로그인하거나, 나온 코드를 붙여 넣는다 */
    const loginPanel = () => {
      const panel = el('div', 'login-panel')
      if (login.state === 'failed') {
        panel.append(
          el('strong', undefined, 'Claude 로그인을 마치지 못했어요'),
          el('p', undefined, login.message),
        )
        const row = el('div', 'login-actions')
        row.append(
          button('btn-small', '다시 시도', () => void startClaudeLogin()),
          button('btn-link', '닫기', () => {
            login = { state: 'idle' }
            render()
          }),
        )
        panel.append(row)
        return panel
      }
      if (login.state !== 'waiting') return panel
      panel.append(
        el('strong', undefined, '브라우저에서 Claude에 로그인해 주세요'),
        el(
          'p',
          undefined,
          '로그인이 끝나면 자동으로 넘어가요. 화면에 코드가 나오면 아래에 붙여 넣어 주세요.',
        ),
      )
      const form = el('form', 'code-row')
      const input = el('input')
      input.id = 'claude-code'
      input.placeholder = '코드 붙여 넣기'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.value = codeDraft
      input.oninput = () => {
        codeDraft = input.value
      }
      const ok = el('button', 'btn-small', sending ? '확인하는 중…' : '확인')
      ok.type = 'submit'
      ok.disabled = sending
      form.onsubmit = (e) => {
        e.preventDefault()
        void sendCode()
      }
      form.append(input, ok)
      panel.append(form)
      if (login.codeRejected && !sending)
        panel.append(el('p', 'login-error', '코드가 맞지 않아요. 전부 복사했는지 확인하고 다시 넣어 주세요.'))
      const row = el('div', 'login-actions')
      const url = login.url
      if (url) row.append(button('btn-link', '로그인 창 다시 열기', () => window.open(url)))
      row.append(
        button('btn-link', '그만두기', () => {
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
  return { shown, done }
}
