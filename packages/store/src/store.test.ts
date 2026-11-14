import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './index.js'

let store: Store | undefined
afterEach(() => store?.close())

describe('Store', () => {
  it('대화와 메시지를 순서대로 저장하고 읽는다', () => {
    store = new Store(':memory:')
    const t = store.createThread('claude')
    store.addMessage(t.id, 'user', '안녕')
    store.addMessage(t.id, 'assistant', '안녕하세요')
    const msgs = store.listMessages(t.id)
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', '안녕'],
      ['assistant', '안녕하세요'],
    ])
  })

  it('이어 하기 id와 제목을 갱신한다', () => {
    store = new Store(':memory:')
    const t = store.createThread('codex')
    store.updateThread(t.id, { resumeId: 'sess-1', title: 'SRT 예매' })
    expect(store.getThread(t.id)).toMatchObject({ agent: 'codex', resumeId: 'sess-1', title: 'SRT 예매' })
  })

  it('최근에 대화한 순서로 목록을 준다', () => {
    store = new Store(':memory:')
    const a = store.createThread('claude', 'A')
    const b = store.createThread('claude', 'B')
    store.addMessage(a.id, 'user', '다시 A')
    expect(store.listThreads().map((t) => t.title)).toEqual(['A', 'B'])
    expect(b.id).not.toBe(a.id)
  })

  it('없는 대화를 갱신하면 알려 준다', () => {
    store = new Store(':memory:')
    expect(() => store?.updateThread('nope', { title: 'x' })).toThrow('대화를 찾을 수 없어요')
  })
})
