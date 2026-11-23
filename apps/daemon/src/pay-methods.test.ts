import { describe, expect, it } from 'vitest'
import { loadPayMethods, savePayMethods } from './pay-methods.js'

function mem() {
  const m = new Map<string, unknown>()
  return { getSetting: (k: string) => m.get(k), setSetting: (k: string, v: unknown) => void m.set(k, v) }
}

describe('내 결제 수단 저장', () => {
  it('순서대로 저장하고, 새 것에는 id를 붙인다', () => {
    const s = mem()
    const r = savePayMethods(s, [
      { kind: 'naverpay', inner: '신한카드(1234)' },
      { kind: 'card', issuer: '현대카드', last4: '5678' },
    ])
    expect(r.ok).toBe(true)
    const list = loadPayMethods(s)
    expect(list.map((m) => m.kind)).toEqual(['naverpay', 'card'])
    expect(list[0]?.id).toBeTruthy()
    // 순서 바꾸기: 같은 id를 거꾸로 보내면 그대로 거꾸로
    savePayMethods(s, [...list].reverse())
    expect(loadPayMethods(s).map((m) => m.id)).toEqual([list[1]?.id, list[0]?.id])
  })

  it('카드 번호가 섞여 있으면 아무것도 바꾸지 않는다', () => {
    const s = mem()
    savePayMethods(s, [{ kind: 'kakaopay' }])
    const r = savePayMethods(s, [
      { kind: 'kakaopay' },
      { kind: 'card', issuer: '신한카드', nickname: '5412750012345678' },
    ])
    expect(r.ok).toBe(false)
    expect(loadPayMethods(s).map((m) => m.kind)).toEqual(['kakaopay'])
  })

  it('너무 많으면 사용자 언어로 이유를 돌려준다', () => {
    const s = mem()
    const many = Array.from({ length: 50 }, () => ({ kind: 'kakaopay' }))
    const ko = savePayMethods(s, many)
    expect(ko.ok === false && ko.error).toMatch(/개까지 등록할 수 있어요$/)
    s.setSetting('language', 'en')
    const en = savePayMethods(s, many)
    expect(en.ok === false && en.error).toMatch(/^You can add up to \d+ payment methods$/)
  })

  it('저장된 게 없거나 이상하면 빈 목록', () => {
    const s = mem()
    expect(loadPayMethods(s)).toEqual([])
    s.setSetting('payMethods', 'x')
    expect(loadPayMethods(s)).toEqual([])
  })
})

describe('내 결제 수단 보기 (pay_method_list 도구)', () => {
  it('비어 있으면 등록하는 길을 알려 준다', async () => {
    const { payMethodsText } = await import('./pay-methods.js')
    const t = payMethodsText([])
    expect(t).toContain('No payment methods saved')
    expect(t).toContain('폰 설정 > 내 정보 · 결제 > 결제 수단')
    expect(payMethodsText([], 'en')).toContain('phone Settings > My info · Payment > Payment methods')
  })

  it('순서·주 결제 수단·가린 값만 보여 주고 다음 할 일을 담는다', async () => {
    const { payMethodsText } = await import('./pay-methods.js')
    const s = mem()
    savePayMethods(s, [
      { kind: 'naverpay', inner: '신한카드(1234)' },
      { kind: 'card', issuer: '현대카드', nickname: '생활비', last4: '5678' },
      { kind: 'kakaopay' },
    ])
    const t = payMethodsText(loadPayMethods(s))
    expect(t).toContain('3 saved payment method(s)')
    expect(t).toContain('1. [main payment method] 네이버페이 (easy pay) · uses inside: 신한카드(1234)')
    expect(t).toContain('2. 현대카드 (card) · nickname 생활비 · ends in 5678')
    expect(t).toContain('3. 카카오페이 (easy pay)')
    expect(t).toContain('confirm the final price on the payment screen')
    // id·저장한 때 같은 안쪽 값은 보내지 않는다
    expect(t).not.toMatch(/addedAt|[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  it('저장소에 카드 번호처럼 보이는 값이 섞여 있어도 AI에게 보내지 않는다', async () => {
    const { payMethodsText } = await import('./pay-methods.js')
    const s = mem()
    // 예전 판이나 손으로 고친 설정 파일 (저장할 때 검사를 거치지 않은 값)
    s.setSetting('payMethods', [
      {
        id: 'a',
        kind: 'card',
        issuer: '신한카드',
        nickname: '5412 7500 1234 5678',
        last4: '12345',
        addedAt: '',
      },
      { id: 'b', kind: 'tosspay', inner: '국민 4518-4400-1234-5678', addedAt: '' },
    ])
    const t = payMethodsText(loadPayMethods(s))
    expect(t).toContain('1. [main payment method] 신한카드 (card)')
    expect(t).toContain('2. 토스페이 (easy pay)')
    expect(t).not.toMatch(/5678|12345|4518/)
  })
})
