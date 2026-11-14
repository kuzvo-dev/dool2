// 첫 실행 마법사 화면: 인사 → 어떤 AI 구독을 쓰세요? → 준비 상태 확인
import type {
  AgentId,
  AgentStatus,
  AiChoice,
  ClaudeLoginStatus,
  InstallStatus,
  Settings,
} from '@dool2/protocol'
import {
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
  /** 이 단계와 선택으로 바로 연다. action은 점검 모드에서 버튼을 대신 누른다 */
  start?: { step: SetupStep; choice?: AiChoice; action?: CheckAction }
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
  let choice: AiChoice | undefined = opts.start?.choice
  let agents: AgentStatus[] = []
  let note = ''
  let login: ClaudeLoginStatus = { state: 'idle' }
  let install: InstallStatus = { state: 'idle' }
  let installTimer: ReturnType<typeof setTimeout> | undefined
  let codeDraft = ''
  let sending = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  // 단계가 바뀔 때만 나타나는 효과를 준다 (입력 중에 다시 그려도 깜빡이지 않게)
  let enter = true
  // 점검 모드에서 버튼을 대신 누르면, 그 결과까지 그린 뒤에 캡처한다
  let holdShown = Boolean(opts.start?.action)

  const done = new Promise<SetupResult>((resolve) => {
    const stopLogin = () => {
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

    // 설치 진행률을 주기적으로 받아 온다
    const pollInstall = () => {
      if (installTimer) clearTimeout(installTimer)
      if (install.state !== 'running') return
      installTimer = setTimeout(async () => {
        const r = await opts
          .api<{ install: InstallStatus }>('/api/agents/claude/install')
          .catch(() => undefined)
        if (r) {
          const changed = JSON.stringify(r.install) !== JSON.stringify(install)
          install = r.install
          if (install.state === 'done') agents = await opts.loadAgents()
          if (changed) render()
        }
        pollInstall()
      }, 700)
    }

    const startInstall = async () => {
      install = { state: 'running', phase: 'prepare' }
      render()
      const r = await opts
        .api<{ install: InstallStatus }>('/api/agents/claude/install', { method: 'POST' })
        .catch((err: Error) => ({ install: { state: 'failed', message: err.message } as InstallStatus }))
      install = r.install
      render()
      pollInstall()
      // 내려받기가 조금 진행될 때까지만 기다린다 (점검 캡처가 진행 중인 화면을 찍게)
      const early = () =>
        install.state === 'running' &&
        (install.phase === 'prepare' || (install.phase === 'download' && (install.percent ?? 0) < 10))
      for (let i = 0; i < 80 && early(); i++) await new Promise((res) => setTimeout(res, 250))
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

    const finish = async () => {
      stopLogin()
      if (installTimer) clearTimeout(installTimer)
      const defaultAgent = choice ? pickDefault(choice, agents) : undefined
      const { settings } = await opts.api<{ settings: Settings }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ setupDone: true, ...(choice ? { aiChoice: choice } : {}), defaultAgent }),
      })
      root.hidden = true
      root.replaceChildren()
      resolve({ settings, defaultAgent })
    }

    const go = async (next: SetupStep) => {
      step = next
      note = ''
      enter = true
      if (step === 'check') {
        render(true)
        agents = await opts.loadAgents()
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
      } else {
        await startInstall()
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
      card.append(dots)

      if (step === 'welcome') {
        card.append(
          el('div', 'setup-mark'),
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
          el('h1', 'setup-title', '어떤 AI 구독을 쓰세요?'),
          el('p', 'setup-sub', '두리는 이미 쓰고 계신 AI 구독으로 일해요. 나중에 바꿀 수 있어요.'),
        )
        const list = el('div', 'choices')
        list.setAttribute('role', 'radiogroup')
        for (const c of CHOICES) {
          const b = button('choice', '', () => {
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
          const head = checkHeadline(choice, agents)
          card.append(el('h1', 'setup-title', head.title), el('p', 'setup-sub', head.sub))
          const list = el('ul', 'checks')
          for (const item of checklist(choice, agents)) {
            const li = el('li', item.ok ? 'ok' : 'todo')
            const mark = el('span', 'mark', item.ok ? '✓' : '')
            const text = el('div', 'text')
            text.append(el('strong', undefined, item.label), el('span', undefined, item.detail))
            li.append(mark, text)
            if (item.action) {
              const label =
                item.action === 'claude-install'
                  ? '설치하기'
                  : item.action === 'codex-login'
                    ? 'ChatGPT로 로그인'
                    : '로그인하기'
              const action = item.action
              const b = button('btn-small', label, () => void act(action))
              if (action === 'claude-login' && login.state === 'waiting') {
                b.textContent = '로그인 중…'
                b.disabled = true
              }
              if (action === 'claude-install' && install.state === 'running') {
                b.textContent = '설치 중…'
                b.disabled = true
              }
              li.append(b)
            }
            list.append(li)
          }
          card.append(list)
          if (install.state === 'running' || install.state === 'failed') card.append(installPanel())
          if (login.state === 'waiting' || login.state === 'failed') card.append(loginPanel())
          if (note) card.append(el('p', 'setup-note', note))
          const foot = el('div', 'setup-foot')
          const canStart = Boolean(pickDefault(choice, agents))
          const startBtn = button('btn', canStart ? '두리 시작하기' : '나중에 할게요', () => void finish())
          if (!canStart) startBtn.className = 'btn-text'
          foot.append(
            button('btn-text', '이전', () => void go('choice')),
            button('btn-text', '다시 확인', () => void go('check')),
            startBtn,
          )
          card.append(foot)
        }
      }

      // 입력 중이던 코드 칸은 다시 그린 뒤에도 커서를 유지한다
      const typing = document.activeElement?.id === 'claude-code'
      root.replaceChildren(card)
      if (typing) document.getElementById('claude-code')?.focus()
      // 나타나는 효과가 끝난 뒤에 "다 그려졌다"고 알린다 (점검 캡처가 흐리지 않게)
      if (!loading && !holdShown)
        requestAnimationFrame(() => {
          void Promise.all(card.getAnimations().map((a) => a.finished)).then(markShown, markShown)
        })
    }

    /** Claude Code 설치 진행 */
    const installPanel = () => {
      const panel = el('div', 'login-panel')
      if (install.state === 'failed') {
        panel.append(
          el('strong', undefined, 'Claude Code를 설치하지 못했어요'),
          el('p', undefined, install.message),
        )
        const row = el('div', 'login-actions')
        row.append(
          button('btn-small', '다시 시도', () => void startInstall()),
          button('btn-link', '직접 설치하는 방법', () =>
            window.open('https://code.claude.com/docs/en/setup'),
          ),
        )
        panel.append(row)
        return panel
      }
      if (install.state !== 'running') return panel
      const label: Record<string, string> = {
        prepare: '설치를 준비하는 중이에요',
        download: `내려받는 중이에요${install.percent !== undefined ? ` · ${install.percent}%` : ''}`,
        verify: '공식 파일이 맞는지 확인하는 중이에요',
        setup: '설치를 마무리하는 중이에요',
      }
      panel.append(
        el('strong', undefined, 'Claude Code를 설치하고 있어요'),
        el('p', undefined, label[install.phase] ?? ''),
      )
      const bar = el('div', 'progress')
      const fill = el('span', 'progress-fill')
      const pct =
        install.phase === 'download' ? (install.percent ?? 0) : install.phase === 'prepare' ? 0 : 100
      fill.style.width = `${Math.max(3, pct)}%`
      bar.append(fill)
      panel.append(bar, el('p', 'cap', 'Anthropic 공식 배포 서버에서 받아요. 1~2분 걸려요.'))
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
      if (step === 'check') await go('check')
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
