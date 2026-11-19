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

  it('저장된 게 없거나 이상하면 빈 목록', () => {
    const s = mem()
    expect(loadPayMethods(s)).toEqual([])
    s.setSetting('payMethods', 'x')
    expect(loadPayMethods(s)).toEqual([])
  })
})
