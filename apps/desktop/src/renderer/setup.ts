// 첫 실행 마법사 화면: 인사 → 어떤 AI 구독을 쓰세요? → 준비 상태 확인
import type { AgentId, AgentStatus, AiChoice, Settings } from '@dool2/protocol'
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
  /** 점검 모드: 이 단계와 선택으로 바로 연다 */
  start?: { step: SetupStep; choice?: AiChoice }
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

  const done = new Promise<SetupResult>((resolve) => {
    const finish = async () => {
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
        note = 'Claude 로그인 버튼은 곧 붙어요. 그전까지는 Claude Code에서 직접 로그인해 주세요.'
      } else {
        note = 'Claude Code 자동 설치는 곧 붙어요. 그전까지는 claude.com에서 설치해 주세요.'
      }
      render()
    }

    const render = (loading = false) => {
      const card = el('div', 'setup-card')
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
              li.append(button('btn-small', label, () => void act(action)))
            }
            list.append(li)
          }
          card.append(list)
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

      root.replaceChildren(card)
      // 나타나는 효과가 끝난 뒤에 "다 그려졌다"고 알린다 (점검 캡처가 흐리지 않게)
      if (!loading)
        requestAnimationFrame(() => {
          void Promise.all(card.getAnimations().map((a) => a.finished)).then(markShown, markShown)
        })
    }

    if (step === 'check') void go('check')
    else render()
  })
  return { shown, done }
}
