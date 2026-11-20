// PC 화면 제어 도구의 본체 쪽 실행기 (docs/architecture.md 5.2, ADR 0013, 위협 모델 T20).
// AI(MCP 도구 서버)는 여기로 부탁만 하고, 해도 되는지는 여기서 정한다. 도우미(dool2-hands)는 판단하지 않는 손이다.
//
// - 사용자가 허용한 앱만 다룬다. 처음 쓰는 앱은 "이 앱을 두리가 조작해도 될까요?" 승인을 받는다
// - 터미널·시스템 설정·Finder는 기본으로 막는다(셸을 끈 의미가 없어진다). 브라우저는 브라우저 도구로만 (도우미도 막는다)
// - 보내기·결제·삭제 성격의 버튼, 메신저에서 Enter는 승인을 받은 뒤 본체가 직접 누른다 (브라우저와 같은 승인 게이트)
// - 비밀번호 칸 값은 읽지도 넣지도 않는다
import { josa } from '@dool2/protocol/rich'
import type { ApprovalRecord, Approvals } from './approvals.js'
import { classifyRisk, parseRefs, type RiskKind, type ToolResult } from './browser-tools.js'
import type { HandsCaller } from './hands.js'

export const SCREEN_TOOLS = [
  'status',
  'apps',
  'open',
  'read',
  'click',
  'type',
  'key',
  'screenshot',
  'request_app',
  'request_approval',
] as const

/** 사용자가 켜기 전에는 다루지 않는 앱 (셸·설정·파일을 AI가 마음대로 다루면 안 된다) */
export const DEFAULT_BLOCKED = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'com.apple.systempreferences',
  'com.apple.finder',
  'com.apple.ActivityMonitor',
  'com.apple.ScriptEditor2',
  'com.apple.Automator',
]

/** Enter를 누르면 메시지가 나가는 앱 */
export const MESSENGERS = [
  'com.kakao.KakaoTalkMac',
  'com.tinyspeck.slackmacgap',
  'com.apple.MobileSMS',
  'com.apple.mail',
  'jp.naver.line.mac',
  'ru.keepcoder.Telegram',
  'org.telegram.desktop',
  'com.hnc.Discord',
  'net.whatsapp.WhatsApp',
  'com.microsoft.teams2',
  'com.microsoft.Outlook',
]

export interface ScreenSettings {
  allowed(): string[]
  setAllowed(list: string[]): Promise<void> | void
  finalStep(): 'approve' | 'self'
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const err = (t: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: t }] })

interface Status {
  accessibility: boolean
  screenRecording: boolean
  locked: boolean
}

interface AppInfo {
  bundleId: string
  name: string
  active?: boolean
}

export class ScreenTools {
  /** 앱별 마지막으로 읽은 화면의 요소 (누를 버튼 글자를 AI 말이 아니라 화면에서 확인하려고) */
  private screens = new Map<string, Map<string, { role: string; name: string }>>()
  private names = new Map<string, string>()

  constructor(
    private readonly hands: HandsCaller,
    readonly approvals: Approvals,
    private readonly settings: ScreenSettings,
  ) {}

  available() {
    return this.hands.available()
  }

  private allowedApp(bundleId: string) {
    return this.settings.allowed().includes(bundleId)
  }

  /** 허용 안 한 앱이면 AI에게 할 일을 알려 준다 */
  private gate(bundleId: unknown): string | ToolResult {
    if (typeof bundleId !== 'string' || !/^[\w.-]+$/.test(bundleId))
      return err('bundleId가 필요해요. screen_apps로 앱 목록을 먼저 보세요.')
    if (!this.allowedApp(bundleId)) {
      const blocked = DEFAULT_BLOCKED.includes(bundleId)
      return err(
        blocked
          ? `${bundleId}는 기본으로 막아 둔 앱이에요(터미널·설정·파일 관리자). 사용자가 두리 설정에서 직접 켜야 해요. 다른 방법을 찾거나 사용자에게 직접 해 달라고 부탁하세요.`
          : `사용자가 이 앱(${bundleId})을 두리가 조작하도록 아직 허용하지 않았어요. screen_request_app으로 허용을 요청하고 이번 답을 끝내세요.`,
      )
    }
    return bundleId
  }

  private async status(): Promise<Status> {
    return (await this.hands.call('status')) as Status
  }

  /** 권한·잠금 확인. 문제가 있으면 AI가 할 말 */
  private async ready(needScreen = false): Promise<ToolResult | undefined> {
    if (!this.hands.available())
      return err('이 PC에서는 아직 PC 화면 제어를 쓸 수 없어요 (지금은 맥만 돼요).')
    const s = await this.status()
    if (s.locked)
      return err(
        'PC 화면이 잠겨 있어서 앱을 다룰 수 없어요. 사용자에게 PC 잠금을 풀어 달라고 부탁하고 이번 답을 끝내세요.',
      )
    if (!s.accessibility || (needScreen && !s.screenRecording))
      return err(
        `맥의 ${!s.accessibility ? '"손쉬운 사용"' : '"화면 기록"'} 권한이 꺼져 있어요. 사용자에게 두리 설정 → PC 앱 조작에서 [권한 켜기]를 눌러 달라고 부탁하고 이번 답을 끝내세요.`,
      )
    return undefined
  }

  async run(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (tool) {
      case 'status': {
        if (!this.hands.available())
          return text('이 PC에서는 아직 PC 화면 제어를 쓸 수 없어요 (지금은 맥만 돼요).')
        const s = await this.status()
        const allowed = this.settings.allowed()
        return text(
          [
            `손쉬운 사용 권한: ${s.accessibility ? '켜짐' : '꺼짐'} · 화면 기록 권한: ${s.screenRecording ? '켜짐' : '꺼짐'} · 화면 잠김: ${s.locked ? '예' : '아니요'}`,
            `허용한 앱: ${allowed.length ? allowed.join(', ') : '없음'}`,
          ].join('\n'),
        )
      }
      case 'apps': {
        if (!this.hands.available()) return err('이 PC에서는 아직 PC 화면 제어를 쓸 수 없어요.')
        const running = (await this.hands.call('apps')) as AppInfo[]
        const q = typeof a.query === 'string' ? a.query.trim().toLowerCase() : ''
        const installed = q
          ? ((await this.hands.call('installed')) as AppInfo[]).filter(
              (x) => x.name.toLowerCase().includes(q) || x.bundleId.toLowerCase().includes(q),
            )
          : []
        const mark = (x: AppInfo) =>
          `${x.name} (${x.bundleId})${this.allowedApp(x.bundleId) ? ' · 허용됨' : DEFAULT_BLOCKED.includes(x.bundleId) ? ' · 막힘' : ''}`
        for (const x of [...running, ...installed]) this.names.set(x.bundleId, x.name)
        return text(
          [
            '켜져 있는 앱:',
            ...running.map((x) => `- ${mark(x)}${x.active ? ' · 앞에 있음' : ''}`),
            ...(q
              ? [
                  '',
                  `설치된 앱 중 "${q}":`,
                  ...(installed.length ? installed.map((x) => `- ${mark(x)}`) : ['- 없음']),
                ]
              : []),
          ].join('\n'),
        )
      }
      case 'open': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        await this.hands.call('open', { bundleId: id }, 30_000)
        return this.read(id, undefined, '앱을 열었어요.')
      }
      case 'read': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        return this.read(id, a.maxChars)
      }
      case 'click': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        const ref = String(a.ref ?? '')
        const el = this.screens.get(id)?.get(ref)
        if (!el) return err(`${ref}를 모르겠어요. screen_read로 화면을 먼저 읽어 주세요.`)
        const risk = classifyRisk(el.name, '')
        if (risk) return this.blocked(risk.kind, risk.reason, el.name, ref)
        const res = (await this.hands.call('click', { bundleId: id, ref })) as { via: string }
        await sleep(400)
        return this.read(
          id,
          undefined,
          `"${el.name || ref}"을(를) 눌렀어요 (${res.via === 'press' ? '접근성' : '마우스'}).`,
        )
      }
      case 'type': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        if (typeof a.text !== 'string' || !a.text) return err('넣을 글자가 없어요')
        const ref = typeof a.ref === 'string' ? a.ref : undefined
        if (ref) {
          const el = this.screens.get(id)?.get(ref)
          if (!el) return err(`${ref}를 모르겠어요. screen_read로 화면을 먼저 읽어 주세요.`)
          if (el.role === '비밀번호칸')
            return err('비밀번호 칸에는 넣지 않아요. 사용자에게 직접 해 달라고 부탁하세요.')
        }
        await this.hands.call('type', { bundleId: id, text: a.text, ...(ref ? { ref } : {}) })
        return text(`글자를 넣었어요. 아직 보내지는 않았어요. 확인하려면 screen_read로 다시 읽으세요.`)
      }
      case 'key': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        const key = String(a.key ?? '')
        const mods = Array.isArray(a.modifiers) ? a.modifiers.map(String) : []
        // 메신저에서 Enter는 "보내기"다
        if ((key === 'Enter' || key === 'Return') && MESSENGERS.includes(id) && !mods.includes('shift'))
          return this.blocked('contact', '메신저에서 Enter(보내기)', 'Enter', 'key:Enter')
        await this.hands.call('key', { bundleId: id, key, modifiers: mods })
        await sleep(300)
        return this.read(id, undefined, `${[...mods, key].join('+')} 키를 눌렀어요.`)
      }
      case 'screenshot': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready(true)
        if (r) return r
        const s = (await this.hands.call('screenshot', { bundleId: id }, 30_000)) as {
          data: string
          window: string
        }
        return {
          content: [
            { type: 'text', text: `${this.names.get(id) ?? id} 창 "${s.window}"` },
            { type: 'image', data: s.data, mimeType: 'image/jpeg' },
          ],
        }
      }
      case 'request_app': {
        if (typeof a.bundleId !== 'string' || !/^[\w.-]+$/.test(a.bundleId)) return err('bundleId가 필요해요')
        if (DEFAULT_BLOCKED.includes(a.bundleId))
          return err('기본으로 막아 둔 앱이라 요청할 수 없어요. 사용자가 두리 설정에서 직접 켜야 해요.')
        if (this.allowedApp(a.bundleId)) return text('이미 허용된 앱이에요.')
        const name = this.names.get(a.bundleId) ?? a.bundleId
        const rec = this.approvals.create({
          tabId: -1,
          ref: 'app',
          role: '앱',
          label: name,
          url: `app:${a.bundleId}`,
          kind: 'app',
          reason: '처음 다루는 앱',
          what: `두리가 ${josa(name, '을/를')} 조작해도 될까요?`,
          where: name,
          ...(typeof a.why === 'string' ? { cancel: `하려는 일: ${a.why.slice(0, 200)}` } : {}),
        })
        return text(
          `허용을 요청했어요(${rec.id.slice(0, 8)}). 사용자에게 ${name}을(를) 조작해도 되는지 한 문장으로 묻고 이번 답을 끝내세요. 허용하면 다음 메시지로 알려 줘요.`,
        )
      }
      case 'request_approval': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const ref = String(a.ref ?? '')
        const isEnter = ref === 'key:Enter'
        const el = isEnter ? { role: '키', name: 'Enter' } : this.screens.get(id)?.get(ref)
        if (!el) return err(`${ref}를 모르겠어요. screen_read로 화면을 먼저 읽어 주세요.`)
        const risk = isEnter
          ? { kind: 'contact' as const, reason: '메신저에서 Enter(보내기)' }
          : classifyRisk(el.name, '')
        if (!risk) return err('이 버튼은 승인 없이 눌러도 돼요. screen_click을 쓰세요.')
        if (this.settings.finalStep() === 'self')
          return err(
            '사용자가 "마지막 버튼은 항상 직접 누르기"로 정해 두었어요. 승인 카드는 띄우지 않아요. 마지막 버튼 바로 앞까지 준비해 둔 것(무엇을·어디서·얼마)을 한두 문장으로 정리해 "준비해 뒀어요"라고 알리고 이번 답을 끝내세요. 다른 앱으로 가라고 하지 않아요.',
          )
        const shot = await this.hands
          .call('screenshot', { bundleId: id, maxWidth: 1000 }, 30_000)
          .then((s) => (s as { data: string }).data)
          .catch(() => undefined)
        const name = this.names.get(id) ?? id
        const rec = this.approvals.create({
          tabId: -1,
          ref,
          role: el.role,
          label: el.name,
          url: `app:${id}`,
          kind: risk.kind,
          reason: risk.reason,
          what: String(a.what ?? '').slice(0, 200) || `${name}에서 "${el.name}" 누르기`,
          where: name,
          ...(typeof a.amount === 'string' ? { amount: a.amount.slice(0, 60) } : {}),
          ...(shot ? { shot } : {}),
        })
        return text(
          `승인을 요청했어요(${rec.id.slice(0, 8)}). 사용자에게 무엇을 승인해 달라는지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 두리가 그것 하나만 하고 다음 메시지로 결과를 알려 줘요.`,
        )
      }
    }
    return err(`모르는 화면 도구예요: ${tool}`)
  }

  private blocked(kind: RiskKind, reason: string, label: string, ref: string): ToolResult {
    const what =
      kind === 'money'
        ? '돈이 나가는 일'
        : kind === 'contact'
          ? '다른 사람에게 보내는 일'
          : '되돌릴 수 없는 일'
    return err(
      `"${label}"은(는) ${what}(${reason})이라 승인 없이는 하지 않아요. 무엇을 하려는지 정리해 screen_request_approval(ref: "${ref}")로 승인을 요청하고 이번 답을 끝내세요.`,
    )
  }

  private async read(bundleId: string, maxChars?: unknown, note?: string): Promise<ToolResult> {
    const s = (await this.hands.call('snapshot', {
      bundleId,
      maxChars: Math.min(Math.max(Number(maxChars) || 12_000, 1_000), 40_000),
    })) as { app: string; window: string; text: string; truncated: boolean }
    this.names.set(bundleId, s.app)
    this.screens.set(bundleId, parseRefs(s.text))
    return text(
      [
        ...(note ? [note] : []),
        `[앱 ${s.app}] 창: ${s.window || '(제목 없음)'}`,
        '',
        s.text ||
          '(읽을 글이 없어요. 이 앱은 접근성 정보를 잘 주지 않아요. screen_screenshot으로 화면을 보세요)',
        ...(s.truncated ? ['', '(화면이 길어서 앞부분만 읽었어요)'] : []),
      ].join('\n'),
    )
  }

  /** 사용자가 승인한 것 하나만 한다: 앱 허용, 또는 승인한 버튼(글자가 그대로일 때만)·Enter */
  async approve(id: string): Promise<{ ok: boolean; message: string }> {
    const rec: ApprovalRecord | undefined = this.approvals.take(id)
    if (!rec) return { ok: false, message: '이미 처리했거나 시간이 지난 승인 요청이에요' }
    const bundleId = rec.url.replace(/^app:/, '')
    const finish = (ok: boolean, message: string) => {
      this.approvals.finish(id, ok, message)
      return { ok, message }
    }
    try {
      if (rec.kind === 'app') {
        await this.settings.setAllowed([...new Set([...this.settings.allowed(), bundleId])])
        return finish(true, `${josa(rec.label, '을/를')} 두리가 조작하도록 허용했어요.`)
      }
      const r = await this.ready()
      if (r) return finish(false, r.content.map((c) => (c.type === 'text' ? c.text : '')).join(' '))
      if (rec.ref === 'key:Enter') {
        await this.hands.call('key', { bundleId, key: 'Enter', modifiers: [] })
        return finish(true, `${rec.where}에서 Enter를 눌렀어요.`)
      }
      // 누르기 직전 화면을 다시 읽어, 승인한 버튼이 그대로일 때만 누른다
      await this.read(bundleId)
      const now = this.screens.get(bundleId)?.get(rec.ref)
      if (!now || now.name !== rec.label || now.role !== rec.role)
        return finish(
          false,
          `승인한 뒤 화면이 바뀌어서 "${rec.label}" 버튼을 누르지 않았어요. 화면을 다시 확인해 주세요.`,
        )
      await this.hands.call('click', { bundleId, ref: rec.ref })
      return finish(true, `${rec.where}의 "${rec.label}" 버튼을 눌렀어요.`)
    } catch (e) {
      return finish(false, `"${rec.label}"을(를) 하지 못했어요: ${(e as Error).message}`)
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
