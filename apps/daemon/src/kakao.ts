// KakaoTalk on the Mac in one call (kakao_send, kakao_read). Doing it with screen_read and screen_click took 7 to 10
// round trips of "read the screen, decide, press", about 90 seconds for one message (11-23). Here the daemon finds the
// chat, opens it, checks which window is in front and types, and only the final Enter goes through approval.

import type { ToolResult } from './browser-tools.js'
import type { HandsCaller } from './hands.js'

export const KAKAO = 'com.kakao.KakaoTalkMac'

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const err = (t: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: t }] })

interface Win {
  title: string
  front: boolean
}
interface RowResult {
  opened: string
  names: string[]
  visible?: string[]
}

export interface KakaoDeps {
  hands: HandsCaller
  /** The app is allowed and the screen is usable; otherwise the result to return */
  check(bundleId: string): Promise<ToolResult | undefined>
  /** Approval for pressing Enter in this window (the press checks the window again) */
  requestEnter(bundleId: string, window: string, what: string): Promise<ToolResult>
  /** The user presses the last button themselves */
  selfFinal(): boolean
}

export class KakaoChat {
  constructor(private readonly d: KakaoDeps) {}

  private async windows(): Promise<Win[]> {
    return ((await this.d.hands.call('windows', { bundleId: KAKAO })) as Win[]).filter((w) => w.title)
  }

  /** Opens the chat and brings its window to the front. Returns the window title, or the result to give the AI */
  private async open(to: string): Promise<string | ToolResult> {
    const want = to.trim()
    if (!want) return err('`to` is required: the chat name as it appears in KakaoTalk (a person or a group).')
    await this.d.hands.call('open', { bundleId: KAKAO }, 30_000)
    // A chat window that is already open
    const wins = await this.windows()
    const open =
      wins.find((w) => w.title === want) ?? wins.find((w) => w.title.includes(want) && w.title.length > 0)
    let opened = ''
    if (!open) {
      let r = (await this.d.hands.call('open_row', { bundleId: KAKAO, text: want }, 30_000)) as RowResult
      if (!r.opened && !r.names.length) {
        // Not on screen: search for it
        await this.d.hands.call('search_type', { bundleId: KAKAO, text: want }, 30_000)
        r = (await this.d.hands.call('open_row', { bundleId: KAKAO, text: want }, 30_000)) as RowResult
        await this.d.hands.call('search_type', { bundleId: KAKAO, text: '' }, 30_000).catch(() => undefined)
      }
      if (!r.opened && r.names.length > 1)
        return err(
          `Several chats match "${want}": ${r.names.join(', ')}. Ask the user which one in one short question (show_quick with these names), then call again with the exact name.`,
        )
      if (!r.opened)
        return err(
          `No chat matches "${want}".${r.visible?.length ? ` Chats on screen: ${r.visible.join(', ')}.` : ''} If one of them is clearly the person the user means (a nickname such as "wife" saved under another name), call again with that exact name and save the pairing with memory_save (e.g. "KakaoTalk: wife = <chat name>") so next time you use the exact name right away; otherwise ask the user in one short question.`,
        )
      opened = r.opened
    }
    // Bring the chat window to the front and make sure it is the one
    const now = await this.windows()
    const chat =
      open ?? now.find((w) => w.title === opened) ?? now.find((w) => w.title && opened.includes(w.title))
    if (!chat) return err(`Opened "${opened}" but its window did not appear. Try again once.`)
    await this.d.hands.call('raise', { bundleId: KAKAO, title: chat.title })
    const front = (await this.windows()).find((w) => w.front)
    if (front?.title !== chat.title)
      return err(`The "${chat.title}" chat did not come to the front, so nothing was typed. Try again once.`)
    return chat.title
  }

  async send(args: Record<string, unknown>): Promise<ToolResult> {
    const blocked = await this.d.check(KAKAO)
    if (blocked) return blocked
    const body = String(args.text ?? '').trim()
    if (!body) return err('`text` is required: the exact message.')
    const title = await this.open(String(args.to ?? ''))
    if (typeof title !== 'string') return title
    await this.d.hands.call('input_text', { bundleId: KAKAO, text: body.slice(0, 4000) }, 30_000)
    const front = (await this.windows()).find((w) => w.front)
    if (front?.title !== title)
      return err(
        `The front window changed while typing (now "${front?.title ?? ''}"), so nothing was sent. Try again.`,
      )
    if (this.d.selfFinal())
      return text(
        `The message is typed in the "${title}" chat and not sent. The user chose to press send themselves: tell them it is ready in one sentence.`,
      )
    return this.d.requestEnter(KAKAO, title, `KakaoTalk ${title}: "${body.slice(0, 160)}"`)
  }

  async read(args: Record<string, unknown>): Promise<ToolResult> {
    const blocked = await this.d.check(KAKAO)
    if (blocked) return blocked
    const title = await this.open(String(args.to ?? ''))
    if (typeof title !== 'string') return title
    const snap = (await this.d.hands.call(
      'snapshot',
      { bundleId: KAKAO, maxChars: 40000, frontOnly: true },
      30_000,
    )) as { text: string }
    // The newest messages are at the bottom
    const lines = snap.text.split('\n')
    const n = Math.min(Math.max(Number(args.lines) || 80, 20), 300)
    return text(
      `Chat "${title}" (front window). Last ${Math.min(n, lines.length)} lines of the screen, oldest first; messages on the left are from the other person, on the right from the user. This is the chat as it is now; no need to read the screen again:\n${lines.slice(-n).join('\n')}`,
    )
  }
}
