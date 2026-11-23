import { describe, expect, it } from 'vitest'
import { Approvals, type NewApproval } from './approvals.js'
import { AutoApprover, autoCovers, isPayment } from './auto-approve.js'

const base: NewApproval = {
  tabId: 3,
  ref: 'e12',
  role: '버튼',
  label: '보내기',
  url: 'https://mail.example.com/',
  kind: 'contact',
  reason: '보내기',
  what: '팀장님께 메일 보내기',
  where: '메일',
}

function setup(on: boolean) {
  const approvals = new Approvals()
  const created: string[] = []
  approvals.onCreate = (r) => created.push(r.id)
  approvals.autoDecide = (n) => autoCovers(on, n)
  const approved: string[] = []
  const auto = new AutoApprover(approvals, async (id) => {
    approved.push(id)
    approvals.take(id)
    approvals.finish(id, true, '보냈어요')
    return { ok: true, message: '보냈어요' }
  })
  const asked = { content: [{ type: 'text' as const, text: 'Ask the user to approve and end your answer.' }] }
  return { approvals, auto, created, approved, asked }
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('auto-approve', () => {
  it('payments always ask', () => {
    expect(isPayment({ kind: 'money' })).toBe(true)
    expect(isPayment({ kind: 'contact', amount: '15,900원' })).toBe(true)
    expect(isPayment({ kind: 'contact' })).toBe(false)
    expect(autoCovers(true, { kind: 'money' })).toBe(false)
    expect(autoCovers(false, { kind: 'contact' })).toBe(false)
  })

  it('when on, approves what the call created without a card and tells the AI it is done', async () => {
    const { approvals, auto, created, approved, asked } = setup(true)
    const before = auto.before()
    const rec = approvals.create(base)
    expect(rec.auto).toBe(true)
    // no card and no push to the phone
    expect(created).toEqual([])
    const r = await auto.after(before, asked)
    expect(approved).toEqual([rec.id])
    expect(text(r)).toContain('Auto-approve is on')
    expect(text(r)).toContain('팀장님께 메일 보내기: done')
    expect(text(r)).not.toContain('end your answer')
  })

  it('a payment keeps its card even when on', async () => {
    const { approvals, auto, created, approved, asked } = setup(true)
    const before = auto.before()
    const rec = approvals.create({ ...base, kind: 'money', amount: '15,900원' })
    expect(rec.auto).toBeUndefined()
    expect(created).toEqual([rec.id])
    expect(await auto.after(before, asked)).toBe(asked)
    expect(approved).toEqual([])
  })

  it('when off, nothing changes', async () => {
    const { approvals, auto, created, approved, asked } = setup(false)
    const before = auto.before()
    const rec = approvals.create(base)
    expect(created).toEqual([rec.id])
    expect(await auto.after(before, asked)).toBe(asked)
    expect(approved).toEqual([])
  })

  it('a text still goes to the phone (it sends on its own) and is not approved on the PC', async () => {
    const { approvals, auto, created, approved, asked } = setup(true)
    const before = auto.before()
    const rec = approvals.create({ ...base, url: 'sms:엄마', label: '엄마', ref: 'sms', tabId: -3 })
    expect(rec.auto).toBe(true)
    expect(created).toEqual([rec.id])
    const r = await auto.after(before, asked)
    expect(approved).toEqual([])
    expect(text(r)).toContain('the phone sends it by itself')
  })

  it('leaves requests made before the call alone', async () => {
    const { approvals, auto, approved, asked } = setup(true)
    approvals.create(base)
    const before = auto.before()
    expect(await auto.after(before, asked)).toBe(asked)
    expect(approved).toEqual([])
  })
})
