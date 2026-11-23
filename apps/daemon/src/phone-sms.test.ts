import { describe, expect, it } from 'vitest'
import { Approvals } from './approvals.js'
import { PhoneSms } from './phone-sms.js'

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

function setup(support = { paired: 1, sms: 1, old: 0 }) {
  const approvals = new Approvals()
  const sms = new PhoneSms(approvals, () => support, 50)
  return { approvals, sms }
}

describe('문자 보내기 (내 폰 번호로)', () => {
  it('받는 사람·글로 승인 카드를 만들고, 폰이 보낸 결과로 끝낸다', async () => {
    const { approvals, sms } = setup()
    const r = sms.request({ to: '엄마', text: '10분 늦어요' })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('end this answer')
    const rec = approvals.list().find((a) => a.url === 'sms:엄마')
    expect(rec).toMatchObject({ kind: 'contact', label: '엄마', what: '10분 늦어요', status: 'pending' })
    // 폰은 보낸 뒤 결과를 승인 서명보다 먼저 보낸다
    sms.result(rec?.id ?? '', { ok: true, message: '엄마(010-****-5678)에게 보냈어요' })
    const done = await sms.approve(rec?.id ?? '', true)
    expect(done).toEqual({ ok: true, message: '엄마(010-****-5678)에게 보냈어요' })
    expect(approvals.get(rec?.id ?? '')?.status).toBe('done')
  })

  it('PC 화면에서는 승인되지 않는다 (보내는 건 폰, 번호도 폰만 안다)', async () => {
    const { approvals, sms } = setup()
    sms.request({ to: '010-1234-5678', text: '도착했어요' })
    const id = approvals.list()[0]?.id ?? ''
    const r = await sms.approve(id, false)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('폰에서 승인')
    expect(approvals.get(id)?.status).toBe('pending')
  })

  it('결과가 오지 않으면 실패로 끝낸다 (예전 폰 앱)', async () => {
    const { approvals, sms } = setup()
    sms.request({ to: '엄마', text: '안녕' })
    const id = approvals.list()[0]?.id ?? ''
    const r = await sms.approve(id, true)
    expect(r.ok).toBe(false)
    expect(approvals.get(id)?.status).toBe('failed')
  })

  it('결과는 승인 서명 뒤에 와도 받는다', async () => {
    const { approvals, sms } = setup()
    sms.request({ to: '엄마', text: '안녕' })
    const id = approvals.list()[0]?.id ?? ''
    const p = sms.approve(id, true)
    sms.result(id, { ok: false, message: '신호가 없어 못 보냈어요' })
    expect(await p).toEqual({ ok: false, message: '신호가 없어 못 보냈어요' })
  })

  it('폰이 없거나 예전 앱이면 카드를 만들지 않고 보낼 글을 붙여 두게 한다', () => {
    expect(text(setup({ paired: 0, sms: 0, old: 0 }).sms.request({ to: '엄마', text: 'a' }))).toContain(
      'no phone app is paired',
    )
    expect(text(setup({ paired: 1, sms: 0, old: 1 }).sms.request({ to: '엄마', text: 'a' }))).toContain(
      'older version',
    )
    // 폰 둘 중 하나만 예전 앱이면 막지 않는다
    expect(setup({ paired: 2, sms: 0, old: 1 }).sms.request({ to: '엄마', text: 'a' }).isError).toBeFalsy()
    // 아직 인사한 폰이 없으면(앱을 안 열었으면) 일단 카드를 띄운다
    expect(setup({ paired: 1, sms: 0, old: 0 }).sms.request({ to: '엄마', text: 'a' }).isError).toBeFalsy()
  })
})
