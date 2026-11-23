// Auto-approve (ADR 0030): a user setting under which everything except payments runs without an approval card.
// Approval requests are still created the usual way (one gate for every tool), then the tool route approves the
// ones auto-approve covers before it answers the AI, and tells the AI what was done instead of "ask the user".
// Payments always go to the user: a request with kind money or an amount is never auto-approved.
// A text (sms:) is sent by the phone itself, so the PC only flags it; the phone sends it when its app is open.
import type { ApprovalView } from '@dool2/protocol'
import type { Approvals, NewApproval } from './approvals.js'
import type { ToolResult } from './browser-tools.js'

/** Money leaves the user's account: always asks, whatever the setting */
export function isPayment(a: Pick<ApprovalView, 'kind' | 'amount'>): boolean {
  return a.kind === 'money' || Boolean(a.amount?.trim())
}

const isSms = (url: string) => url.startsWith('sms:')

/** Whether auto-approve takes this request (the setting is on and it is not a payment) */
export function autoCovers(on: boolean, n: Pick<NewApproval, 'kind' | 'amount'>): boolean {
  return on && !isPayment(n)
}

export class AutoApprover {
  constructor(
    private readonly approvals: Approvals,
    /** Approves on the PC the way the user's approval would (index.ts approveAny) */
    private readonly approve: (id: string) => Promise<{ ok: boolean; message: string }>,
    private readonly log: (entry: {
      kind: ApprovalView['kind']
      ok: boolean
      sms?: boolean
    }) => void = () => {},
  ) {}

  /** Pending request ids before a tool call (to find the ones the call created) */
  before(): Set<string> {
    return new Set(this.approvals.list().map((a) => a.id))
  }

  /**
   * After a tool call: approves the requests it created that auto-approve took, and replaces the tool's "ask the
   * user and end your answer" with what was done. Requests it did not take (payments) keep the original result
   */
  async after(before: Set<string>, result: ToolResult): Promise<ToolResult> {
    const fresh = this.approvals
      .list()
      .filter((a) => !before.has(a.id) && a.status === 'pending' && a.auto === true)
    if (!fresh.length) return result
    const lines: string[] = []
    let failed = false
    for (const a of fresh) {
      if (isSms(a.url)) {
        this.log({ kind: a.kind, ok: true, sms: true })
        lines.push(
          `Text to ${a.label}: the phone sends it by itself as soon as its app is open, and the result comes back as a note. Tell the user it is being sent; do not ask them to approve.`,
        )
        continue
      }
      const r = await this.approve(a.id)
      this.log({ kind: a.kind, ok: r.ok })
      if (!r.ok) failed = true
      lines.push(`${a.what || a.label}: ${r.ok ? 'done' : 'failed'}. ${r.message}`)
    }
    return {
      ...(failed ? { isError: true } : {}),
      content: [
        {
          type: 'text',
          text:
            'Auto-approve is on (the user chose to run everything except payments without an approval card), so this ran without asking.\n' +
            lines.map((l) => `- ${l}`).join('\n') +
            '\nCheck the result on screen and continue. Do not ask the user to approve; just mention briefly what you did.',
        },
      ],
    }
  }
}
