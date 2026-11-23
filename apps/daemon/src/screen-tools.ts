// Daemon-side runner of the PC screen control tools (docs/architecture.md 5.2, ADR 0013, threat model T20).
// The AI (MCP tool server) only asks here, and this code decides whether it may. The helper (dool2-hands) is a hand
// that makes no decisions.
//
// - Only apps the user allowed. An app used for the first time needs approval ("Can Dool2 control this app?")
// - Terminals, System Settings and Finder are blocked by default (otherwise turning off the shell means nothing).
//   Browsers only through the browser tools (the helper blocks them too)
// - Send, pay and delete buttons, and Enter in messengers, are pressed by the daemon itself after approval (the same
//   approval gate as the browser)
// - Password field values are never read or typed
import type { Lang } from '@dool2/i18n'
import type { ApprovalRecord, Approvals } from './approvals.js'
import { classifyRisk, parseRefs, type RiskKind, type ToolResult } from './browser-tools.js'
import type { HandsCaller } from './hands.js'
import { screenCopy } from './locales/screen.js'
import { PASSWORD_ROLE } from './region/kr/screen.js'

export const SCREEN_TOOLS = [
  'status',
  'apps',
  'open',
  'read',
  'click',
  'type',
  'login',
  'key',
  'screenshot',
  'request_app',
  'request_approval',
] as const

/** Apps not controlled until the user turns them on (the AI must not freely handle the shell, settings or files) */
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

/** Apps where pressing Enter sends a message */
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
  /** Vault accounts (site address and ID only). Picks the account for an app login */
  vaultList?(): Promise<{ id: string; origin: string; username: string }[]>
  /** Reads vault values (used only inside the daemon, never returned to the AI) */
  vaultReveal?(id: string): Promise<{ username: string; password: string } | undefined>
  /** Language for text people read (approval cards and results). Default Korean */
  lang?(): Lang
}

/** Name part of an address (accounts.kakao.com → kakao). Common prefixes and suffixes are dropped */
const HOST_NOISE = new Set([
  'www',
  'accounts',
  'account',
  'login',
  'nid',
  'auth',
  'id',
  'm',
  'com',
  'co',
  'kr',
  'net',
  'org',
  'io',
  'app',
])
export function hostWords(origin: string): string[] {
  let host = ''
  try {
    host = new URL(origin).hostname
  } catch {
    return []
  }
  return host
    .toLowerCase()
    .split('.')
    .filter((w) => w.length >= 3 && !HOST_NOISE.has(w))
}

/**
 * Vault accounts that may go into this app: only when the site name (kakao) is in the app bundle id
 * (com.kakao.KakaoTalkMac). The daemon decides, so the AI can't put another site's password into the wrong app
 */
export function vaultForApp<T extends { origin: string }>(
  bundleId: string,
  entries: T[],
  site?: string,
): T[] {
  const id = bundleId.toLowerCase()
  const want = site
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .trim()
  return entries.filter((e) => {
    const words = hostWords(e.origin)
    if (!words.some((w) => id.includes(w))) return false
    return !want || e.origin.toLowerCase().includes(want)
  })
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
  /** Downloading from the App Store (can't be opened yet) */
  installing?: boolean
}

export class ScreenTools {
  /** Elements of the last screen read per app (to check button labels against the screen, not the AI's words) */
  private screens = new Map<string, Map<string, { role: string; name: string }>>()
  private names = new Map<string, string>()

  constructor(
    private readonly hands: HandsCaller,
    readonly approvals: Approvals,
    private readonly settings: ScreenSettings,
  ) {}

  private get m() {
    return screenCopy(this.settings.lang?.() ?? 'ko')
  }

  available() {
    return this.hands.available()
  }

  private allowedApp(bundleId: string) {
    return this.settings.allowed().includes(bundleId)
  }

  /** For an app that isn't allowed, tells the AI what to do */
  private gate(bundleId: unknown): string | ToolResult {
    if (typeof bundleId !== 'string' || !/^[\w.-]+$/.test(bundleId))
      return err('bundleId is required. Look at the app list with screen_apps first.')
    if (!this.allowedApp(bundleId)) {
      const blocked = DEFAULT_BLOCKED.includes(bundleId)
      return err(
        blocked
          ? `${bundleId} is blocked by default (terminal, settings, file manager). The user has to turn it on in Dool2 settings themselves. Find another way, or ask the user to do it themselves.`
          : `The user hasn't approved Dool2 controlling this app (${bundleId}) yet. Request approval with screen_request_app and end this reply.`,
      )
    }
    return bundleId
  }

  /**
   * Whether this Enter sends in a messenger: only when focus is in the message input.
   * Enter in a search field or the chat list opens a room, so no approval (measured 11-23: approval was asked twice
   * just to open a room). When unsure, treat it as sending
   */
  private async enterSends(id: string): Promise<boolean> {
    const f = (await this.hands.call('focused', { bundleId: id }).catch(() => undefined)) as
      | { role?: string; subrole?: string }
      | undefined
    if (!f?.role) return true
    if (f.subrole === 'AXSearchField') return false
    return ['AXTextArea', 'AXTextField', 'AXComboBox', 'AXWebArea', 'AXGroup', 'AXScrollArea'].includes(
      f.role,
    )
  }

  private async status(): Promise<Status> {
    return (await this.hands.call('status')) as Status
  }

  /** Permission and lock check. The problem, if any */
  private async problem(
    needScreen = false,
  ): Promise<'unavailable' | 'locked' | 'accessibility' | 'screen' | undefined> {
    if (!this.hands.available()) return 'unavailable'
    const s = await this.status()
    if (s.locked) return 'locked'
    if (!s.accessibility) return 'accessibility'
    if (needScreen && !s.screenRecording) return 'screen'
    return undefined
  }

  /** Permission and lock check. If there's a problem, what the AI should do */
  private async ready(needScreen = false): Promise<ToolResult | undefined> {
    const p = await this.problem(needScreen)
    if (!p) return undefined
    if (p === 'unavailable') return err(UNAVAILABLE)
    if (p === 'locked')
      return err(
        "The PC screen is locked, so apps can't be controlled. Ask the user to unlock the PC and end this reply.",
      )
    return err(
      `The Mac ${p === 'accessibility' ? '"Accessibility"' : '"Screen Recording"'} permission is off. Ask the user to press [Turn on permission] in Dool2 settings → PC app control, and end this reply.`,
    )
  }

  async run(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (tool) {
      case 'status': {
        if (!this.hands.available()) return text(UNAVAILABLE)
        const s = await this.status()
        const allowed = this.settings.allowed()
        return text(
          [
            `Accessibility permission: ${s.accessibility ? 'on' : 'off'} · Screen Recording permission: ${s.screenRecording ? 'on' : 'off'} · Screen locked: ${s.locked ? 'yes' : 'no'}`,
            `Allowed apps: ${allowed.length ? allowed.join(', ') : 'none'}`,
          ].join('\n'),
        )
      }
      case 'apps': {
        if (!this.hands.available()) return err("PC screen control isn't available on this PC yet.")
        const running = (await this.hands.call('apps')) as AppInfo[]
        const q = typeof a.query === 'string' ? a.query.trim().toLowerCase() : ''
        const installed = q
          ? ((await this.hands.call('installed')) as AppInfo[]).filter(
              (x) => x.name.toLowerCase().includes(q) || x.bundleId.toLowerCase().includes(q),
            )
          : []
        const mark = (x: AppInfo) =>
          `${x.name} (${x.bundleId})${this.allowedApp(x.bundleId) ? ' · allowed' : DEFAULT_BLOCKED.includes(x.bundleId) ? ' · blocked' : ''}`
        for (const x of [...running, ...installed]) this.names.set(x.bundleId, x.name)
        return text(
          [
            'Running apps:',
            ...running.map((x) => `- ${mark(x)}${x.active ? ' · in front' : ''}`),
            ...(q
              ? [
                  '',
                  `Installed apps matching "${q}":`,
                  ...(installed.length
                    ? installed.map(
                        (x) =>
                          `- ${mark(x)}${x.installing ? " · still installing (downloading from the App Store, can't be opened yet. Don't say it's installed; check the progress on the App Store screen)" : ''}`,
                      )
                    : ['- none']),
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
        return this.read(id, undefined, 'Opened the app.')
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
        if (!el) return err(unknownRef(ref))
        const risk = classifyRisk(el.name)
        if (risk) return this.blocked(risk.kind, risk.reason, el.name, ref)
        const res = (await this.hands.call('click', { bundleId: id, ref })) as { via: string }
        await sleep(400)
        return this.read(
          id,
          undefined,
          `Pressed "${el.name || ref}" (${res.via === 'press' ? 'accessibility' : 'mouse'}).`,
        )
      }
      case 'type': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        if (typeof a.text !== 'string' || !a.text) return err('No text to type')
        const ref = typeof a.ref === 'string' ? a.ref : undefined
        if (ref) {
          const el = this.screens.get(id)?.get(ref)
          if (!el) return err(unknownRef(ref))
          if (el.role === PASSWORD_ROLE)
            return err(
              "Don't type into a password field with screen_type. On a login screen, use screen_login to fill the vault account.",
            )
        }
        await this.hands.call('type', { bundleId: id, text: a.text, ...(ref ? { ref } : {}) })
        return text('Typed the text. Nothing was sent yet. To check, read again with screen_read.')
      }
      case 'login': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        if (!this.settings.vaultList || !this.settings.vaultReveal)
          return err("The vault isn't available on this PC.")
        const all = await this.settings.vaultList()
        const fit = vaultForApp(id, all, typeof a.site === 'string' ? a.site : undefined)
        const name = this.names.get(id) ?? id
        if (!fit.length)
          return err(
            `The vault has no account for ${name}. Show a login card for the account's site address (browser_request_login, url for example https://accounts.kakao.com) so the user enters the ID and password on the phone, then call screen_login again.`,
          )
        if (fit.length > 1 && typeof a.site !== 'string')
          return err(
            `There are several accounts for ${name}: ${fit.map((e) => `${new URL(e.origin).hostname}(${e.username})`).join(', ')}. Pick one with site and call again.`,
          )
        const entry = fit[0] as (typeof fit)[number]
        const cred = await this.settings.vaultReveal(entry.id)
        if (!cred?.password)
          return err("Couldn't read the password from the vault. Get it again with a login card.")
        await this.hands.call(
          'fill_login',
          { bundleId: id, username: cred.username, password: cred.password },
          30_000,
        )
        await sleep(300)
        return this.read(
          id,
          undefined,
          `Filled the ID and password with the vault's ${new URL(entry.origin).hostname} account (${entry.username}) (only the daemon sees the values). Press the login button with screen_click, and if device verification or a verification code comes up, get it with a phone card.`,
        )
      }
      case 'key': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const r = await this.ready()
        if (r) return r
        const key = String(a.key ?? '')
        const mods = Array.isArray(a.modifiers) ? a.modifiers.map(String) : []
        // Enter in a messenger means "send"
        if (
          (key === 'Enter' || key === 'Return') &&
          MESSENGERS.includes(id) &&
          !mods.includes('shift') &&
          (await this.enterSends(id))
        )
          return this.blocked('contact', this.m.enterSends, 'Enter', 'key:Enter')
        await this.hands.call('key', { bundleId: id, key, modifiers: mods })
        await sleep(300)
        return this.read(id, undefined, `Pressed ${[...mods, key].join('+')}.`)
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
            { type: 'text', text: `${this.names.get(id) ?? id} window "${s.window}"` },
            { type: 'image', data: s.data, mimeType: 'image/jpeg' },
          ],
        }
      }
      case 'request_app': {
        if (typeof a.bundleId !== 'string' || !/^[\w.-]+$/.test(a.bundleId))
          return err('bundleId is required')
        if (DEFAULT_BLOCKED.includes(a.bundleId))
          return err(
            "This app is blocked by default, so it can't be requested. The user has to turn it on in Dool2 settings themselves.",
          )
        if (this.allowedApp(a.bundleId)) return text('This app is already allowed.')
        const name = this.names.get(a.bundleId) ?? a.bundleId
        const rec = this.approvals.create({
          tabId: -1,
          ref: 'app',
          role: this.m.appRole,
          label: name,
          url: `app:${a.bundleId}`,
          kind: 'app',
          reason: this.m.firstApp,
          what: this.m.mayControl(name),
          where: name,
          ...(typeof a.why === 'string' ? { cancel: this.m.purpose(a.why.slice(0, 200)) } : {}),
        })
        return text(
          `Requested approval (${rec.id.slice(0, 8)}). Ask the user in one sentence whether Dool2 may control ${name}, and end this reply. If they approve, the next message will say so.`,
        )
      }
      case 'request_approval': {
        const id = this.gate(a.bundleId)
        if (typeof id !== 'string') return id
        const ref = String(a.ref ?? '')
        const isEnter = ref === 'key:Enter'
        const el = isEnter ? { role: this.m.keyRole, name: 'Enter' } : this.screens.get(id)?.get(ref)
        if (!el) return err(unknownRef(ref))
        const risk = isEnter ? { kind: 'contact' as const, reason: this.m.enterSends } : classifyRisk(el.name)
        if (!risk) return err('This button can be pressed without approval. Use screen_click.')
        if (this.settings.finalStep() === 'self')
          return err(
            'The user chose "always press the last button myself". Do not show an approval card. Sum up in one or two sentences what is ready right up to the last button (what, where, how much), tell the user it is ready, and end this reply. Do not tell the user to go to another app.',
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
          what: String(a.what ?? '').slice(0, 200) || this.m.pressIn(name, el.name),
          where: name,
          ...(typeof a.amount === 'string' ? { amount: a.amount.slice(0, 60) } : {}),
          ...(shot ? { shot } : {}),
        })
        return text(
          `Requested approval (${rec.id.slice(0, 8)}). Tell the user in one or two sentences what you are asking them to approve, and end this reply here. If they approve, Dool2 does only that one thing and the next message reports the result.`,
        )
      }
    }
    return err(`Unknown screen tool: ${tool}`)
  }

  private blocked(kind: RiskKind, reason: string, label: string, ref: string): ToolResult {
    const what =
      kind === 'money'
        ? 'spends money'
        : kind === 'contact'
          ? 'sends something to another person'
          : "can't be undone"
    return err(
      `"${label}" ${what} (${reason}), so it is never done without approval. Sum up what you want to do, request approval with screen_request_approval(ref: "${ref}"), and end this reply.`,
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
        `[app ${s.app}] window: ${s.window || '(untitled)'}`,
        '',
        s.text ||
          "(No text to read. This app doesn't expose much accessibility info. Look at the screen with screen_screenshot)",
        ...(s.truncated ? ['', '(The screen is long, so only the first part was read)'] : []),
      ].join('\n'),
    )
  }

  /** Does only the one thing the user approved: allow the app, or press the approved button (only if its label is unchanged) or Enter. Messages are for people */
  async approve(id: string): Promise<{ ok: boolean; message: string }> {
    const m = this.m
    const rec: ApprovalRecord | undefined = this.approvals.take(id)
    if (!rec) return { ok: false, message: m.gone }
    const bundleId = rec.url.replace(/^app:/, '')
    const finish = (ok: boolean, message: string) => {
      this.approvals.finish(id, ok, message)
      return { ok, message }
    }
    try {
      if (rec.kind === 'app') {
        await this.settings.setAllowed([...new Set([...this.settings.allowed(), bundleId])])
        return finish(true, m.allowed(rec.label))
      }
      const p = await this.problem()
      if (p)
        return finish(
          false,
          p === 'unavailable' ? m.unavailable : p === 'locked' ? m.locked : m.permissionOff(p === 'screen'),
        )
      if (rec.ref === 'key:Enter') {
        await this.hands.call('key', { bundleId, key: 'Enter', modifiers: [] })
        return finish(true, m.pressedEnter(rec.where))
      }
      // Read the screen again right before pressing, and press only if the approved button is unchanged
      await this.read(bundleId)
      const now = this.screens.get(bundleId)?.get(rec.ref)
      if (!now || now.name !== rec.label || now.role !== rec.role) return finish(false, m.changed(rec.label))
      await this.hands.call('click', { bundleId, ref: rec.ref })
      return finish(true, m.pressed(rec.where, rec.label))
    } catch (e) {
      return finish(false, m.failed(rec.label, (e as Error).message))
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UNAVAILABLE = "PC screen control isn't available on this PC yet (Mac only for now)."
const unknownRef = (ref: string) => `Unknown ${ref}. Read the screen with screen_read first.`
