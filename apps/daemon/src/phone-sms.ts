// Sending a text (SMS) from the user's own number. The AI only picks the recipient (a contact name or a number) and
// the text. The user checks both on the phone's approval card and approves; the phone app then sends it itself (no
// other app opens). A contact name is looked up in the phone's own contacts, so the number never reaches the PC or
// the AI. The phone reports the result (sms-result) before its signed approval (decide), and the PC records the
// result only once the signature checks out.
import type { Approvals } from './approvals.js'
import type { ToolResult } from './browser-tools.js'
import { PHONE_SMS_TEXT } from './locales/phone-sms.js'

/** Tab slot for text approvals (screen control uses -1, PC files -2) */
export const PHONE_TAB = -3

const T = PHONE_SMS_TEXT.ko

export interface PhoneSupport {
  /** Paired phones */
  paired: number
  /** Phones that said hello since start and can send texts / cannot (older app). Both 0 if none said hello yet */
  sms: number
  old: number
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const err = (t: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: t }] })

export function isSmsApproval(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('sms:')
}

export class PhoneSms {
  private results = new Map<string, { ok: boolean; message: string }>()
  private waiters = new Map<string, (r: { ok: boolean; message: string }) => void>()

  constructor(
    private readonly approvals: Approvals,
    private readonly support: () => PhoneSupport,
    private readonly waitMs = 15_000,
  ) {}

  /** phone_sms: creates the approval card (the phone does the sending) */
  request(args: Record<string, unknown>): ToolResult {
    const to = String(args.to ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    const body = String(args.text ?? '').trim()
    if (!to)
      return err(
        '`to` is required: the contact name as the user said it (e.g. mom, a name) or a phone number.',
      )
    if (!body) return err('`text` is required: the exact message to send.')
    if (body.length > 1000) return err('A text can be at most 1000 characters. Shorten it and call again.')
    const s = this.support()
    if (!s.paired)
      return err(
        "Texts are sent by the user's phone app, and no phone app is paired yet. Attach the message with show_draft (via: sms) and tell the user in one sentence that pairing the phone app lets Dool2 send it.",
      )
    // Block only when every phone is an older app (a newer phone, or one that has not said hello yet, gets the card)
    if (!s.sms && s.old >= s.paired)
      return err(
        'The paired phone app is an older version that cannot send texts. Attach the message with show_draft (via: sms) and tell the user in one sentence that updating the phone app lets Dool2 send it.',
      )
    const rec = this.approvals.create({
      tabId: PHONE_TAB,
      ref: 'sms',
      role: T.role,
      label: to,
      url: `sms:${to}`,
      kind: 'contact',
      reason: T.reason,
      what: body,
      where: T.where,
      cancel: T.cancel,
    })
    return text(
      `The text approval card is on the phone (${rec.id.slice(0, 8)}). The phone finds the number in its contacts and shows it on the card; if several people match, the user picks one. ` +
        'Tell the user in one sentence to check the recipient and the text on the phone and approve, then end this answer. Once approved, the phone sends it and the result follows.',
    )
  }

  /** Result from the phone. The signed approval has not arrived yet, so only keep it */
  result(id: string, r: { ok: boolean; message: string }) {
    const rec = this.approvals.get(id)
    if (!rec || !isSmsApproval(rec.url) || rec.status !== 'pending') return
    this.results.set(id, r)
    this.waiters.get(id)?.(r)
  }

  /**
   * Handles an approval. fromPhone: the phone's signature was verified (that phone has sent, or is sending).
   * Approvals from the PC screen do not send: the phone sends, and only the phone knows the number
   */
  async approve(id: string, fromPhone: boolean): Promise<{ ok: boolean; message: string }> {
    const rec = this.approvals.get(id)
    if (!rec || rec.status !== 'pending') return { ok: false, message: T.gone }
    if (!fromPhone) return { ok: false, message: T.phoneOnly }
    const r =
      this.results.get(id) ??
      (await new Promise<{ ok: boolean; message: string } | undefined>((done) => {
        const timer = setTimeout(() => done(undefined), this.waitMs)
        timer.unref?.()
        this.waiters.set(id, (x) => {
          clearTimeout(timer)
          done(x)
        })
      }))
    this.waiters.delete(id)
    this.results.delete(id)
    const out = r ?? { ok: false, message: T.noResult }
    this.approvals.take(id)
    this.approvals.finish(id, out.ok, out.message)
    return out
  }
}
