// Approval gate (docs/architecture.md chapter 4, M3).
// The AI cannot press risky buttons (money, contact, irreversible). It only asks "may I press this button?",
// and when the user approves after seeing the screenshot and details, **the Dool2 daemon** presses that one button.
// - Single use, and it ends after 10 minutes (1 hour for payments). One approval = one button press
// - A payment stays 'approved (paying)' after the press, and ends with the order number at order done (browser_order_done)
// - Right before pressing, the page is read again, and the button is pressed only if the approved label and URL are unchanged
// - Amounts and details the AI writes can be wrong (prompt injection), so the approval card also shows a real screenshot
// Biometric signing on the phone comes with the phone app (M6). For now only the holder of the desktop app's screen token (the user's screen) can approve.
import { randomUUID } from 'node:crypto'
import type { ApprovalView } from '@dool2/protocol'

export const APPROVAL_TTL_MS = 10 * 60_000
/**
 * Payment cards last 1 hour: approval happens once at payment, so the user needs time to open the card, choose and think.
 * The screen (URL and button label) is checked again right before pressing, so a long wait never presses the wrong thing
 * (measured 11-20: approving after 23 minutes gave an 'expired approval' and the card had to be requested again)
 */
export const MONEY_APPROVAL_TTL_MS = 60 * 60_000
/** How long finished requests are kept (for the phone's history). Deleted after that, so they don't pile up while the daemon runs all day */
export const APPROVAL_KEEP_MS = 60 * 60_000

export interface ApprovalRecord extends ApprovalView {
  /** Screenshot shown on the approval card (JPEG base64) */
  shot?: string
  /** Choice id → that field on the payment screen (ref and label). Not sent to the screen */
  choiceRefs?: Record<string, { ref: string; role: string; name: string; near?: string }>
  /** Sub-choice group → that dropdown's ref and the option labels */
  subRefs?: Record<string, { ref: string; options: string[] }>
}

export interface NewApproval {
  tabId: number
  ref: string
  role: string
  label: string
  url: string
  kind: ApprovalView['kind']
  reason: string
  what: string
  where: string
  amount?: string
  cancel?: string
  items?: string[]
  shot?: string
  choices?: ApprovalView['choices']
  choiceTitle?: string
  chose?: string[]
  choice?: string
  choiceRefs?: ApprovalRecord['choiceRefs']
  subChoices?: ApprovalView['subChoices']
  subRefs?: ApprovalRecord['subRefs']
  shipOptions?: ApprovalView['shipOptions']
  shipWarn?: string
  title?: string
  goods?: ApprovalView['goods']
  after?: string
  lines?: ApprovalView['lines']
  info?: ApprovalView['info']
  /** Set by the caller when auto-approve already decided (a text the phone sends on its own) */
  auto?: boolean
}

export class Approvals {
  private items = new Map<string, ApprovalRecord>()
  /** When a new approval request is created (notify the phone) */
  onCreate?: (rec: ApprovalRecord) => void
  /**
   * Auto-approve (ADR 0030): true when this request will be approved right away without the user. Such requests
   * are not sent to the phone as cards (no push), and the tool route approves them before answering the AI
   */
  autoDecide?: (n: NewApproval) => boolean

  constructor(private readonly now: () => number = Date.now) {}

  create(n: NewApproval): ApprovalRecord {
    const t = this.now()
    this.prune(t)
    // A pending request for the same tab and button is replaced by the new one
    for (const r of this.items.values())
      if (r.status === 'pending' && r.tabId === n.tabId && r.ref === n.ref && r.url === n.url)
        r.status = 'expired'
    const rec: ApprovalRecord = {
      ...n,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + (n.kind === 'money' ? MONEY_APPROVAL_TTL_MS : APPROVAL_TTL_MS)).toISOString(),
    }
    if (!rec.auto && this.autoDecide?.(n)) rec.auto = true
    this.items.set(rec.id, rec)
    // A request auto-approve handles on the PC is not shown as a card. A text the phone sends on its own still goes
    // to the phone (it does the sending)
    if (!rec.auto || rec.url.startsWith('sms:')) this.onCreate?.(rec)
    // Close the phone card when time runs out (otherwise tapping an expired card only gets 'approval expired')
    const ttl = Date.parse(rec.expiresAt) - t
    const timer = setTimeout(() => {
      if (this.get(rec.id)?.status === 'expired') this.onChange?.(rec)
    }, ttl + 500)
    timer.unref?.()
    return rec
  }

  get(id: string): ApprovalRecord | undefined {
    const r = this.items.get(id)
    if (r?.status === 'pending' && Date.parse(r.expiresAt) <= this.now()) {
      r.status = 'expired'
      r.shot = undefined
    }
    return r
  }

  list(): ApprovalView[] {
    return [...this.items.keys()].map((id) => {
      const { shot: _s, ...view } = this.get(id) as ApprovalRecord
      return view
    })
  }

  /** Takes one pending request and marks it in progress. undefined if already handled or expired */
  take(id: string): ApprovalRecord | undefined {
    const r = this.get(id)
    if (!r || r.status !== 'pending') return undefined
    r.status = 'approved'
    return r
  }

  reject(id: string): boolean {
    const r = this.get(id)
    if (!r || r.status !== 'pending') return false
    r.status = 'rejected'
    r.shot = undefined
    return true
  }

  /** When a tab closes, its pending requests can no longer be pressed. Also used when a new request replaces an older one in the same tab */
  expireTab(tabId: number) {
    for (const r of this.items.values())
      if (r.status === 'pending' && r.tabId === tabId) {
        r.status = 'expired'
        r.shot = undefined
        this.onChange?.(r)
      }
  }
  /** When a pending request expires (closes the phone card) */
  onChange?: (rec: ApprovalRecord) => void

  /** Deletes long-finished requests, and drops screenshots (hundreds of KB) of finished requests right away */
  private prune(now: number) {
    for (const [id, r] of this.items) {
      this.get(id)
      if (r.status === 'pending') continue
      r.shot = undefined
      if (now - Date.parse(r.createdAt) > APPROVAL_KEEP_MS) this.items.delete(id)
    }
  }

  /** An approval that was pressed but isn't finished yet (payment: until the order is done). Status stays 'approved', only the result so far is kept */
  progress(id: string, result: string) {
    const r = this.items.get(id)
    if (!r) return
    r.result = result
    r.shot = undefined
  }

  /** Ends the approval and tells the phone and screen (when a payment ends in a completed or failed order) */
  settle(id: string, ok: boolean, result: string) {
    const r = this.items.get(id)
    if (!r) return
    this.finish(id, ok, result)
    this.onChange?.(r)
  }

  finish(id: string, ok: boolean, result: string) {
    const r = this.items.get(id)
    if (!r) return
    r.status = ok ? 'done' : 'failed'
    r.result = result
    r.shot = undefined
  }
}
