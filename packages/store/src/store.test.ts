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

  it('설정을 JSON으로 저장하고, undefined면 지운다', () => {
    store = new Store(':memory:')
    expect(store.getSetting('setupDone')).toBeUndefined()
    store.setSetting('setupDone', true)
    store.setSetting('aiChoice', 'both')
    store.setSetting('aiChoice', 'claude')
    expect(store.getSettings()).toEqual({ setupDone: true, aiChoice: 'claude' })
    store.setSetting('aiChoice', undefined)
    expect(store.getSettings()).toEqual({ setupDone: true })
  })

  describe('대화 하나 (ADR 0015)', () => {
    it('열려 있는 구간 중 가장 최근 것이 지금 구간이다', () => {
      store = new Store(':memory:')
      const a = store.createThread('claude')
      const b = store.createThread('claude', '새 대화', '앞에서 넘겨받은 내용')
      expect(store.currentSession()?.id).toBe(b.id)
      expect(store.currentSession()?.carry).toBe('앞에서 넘겨받은 내용')
      store.closeSession(b.id, '요약')
      expect(store.currentSession()?.id).toBe(a.id)
      expect(store.getThread(b.id)).toMatchObject({ summary: '요약' })
      expect(store.getThread(b.id)?.closedAt).toBeTruthy()
      store.closeOtherSessions('none')
      expect(store.currentSession()).toBeUndefined()
    })

    it('모든 구간의 말을 시간순으로 잇고, 앞의 것을 더 불러온다', () => {
      store = new Store(':memory:')
      const a = store.createThread('claude')
      store.addMessage(a.id, 'user', '1')
      store.addMessage(a.id, 'assistant', '2')
      const b = store.createThread('codex')
      store.addMessage(b.id, 'user', '3')
      const last = store.addMessage(b.id, 'assistant', '4')
      expect(store.listConversation().map((m) => m.text)).toEqual(['1', '2', '3', '4'])
      const tail = store.listConversation({ limit: 2 })
      expect(tail.map((m) => m.text)).toEqual(['3', '4'])
      expect(store.listConversation({ before: tail[0]?.createdAt }).map((m) => m.text)).toEqual(['1', '2'])
      expect(last.threadId).toBe(b.id)
    })

    it('구간 길이를 센다', () => {
      store = new Store(':memory:')
      const t = store.createThread('claude')
      expect(store.sessionSize(t.id)).toEqual({ turns: 0, chars: 0 })
      store.addMessage(t.id, 'user', '안녕')
      store.addMessage(t.id, 'assistant', '반가워요')
      expect(store.sessionSize(t.id)).toEqual({ turns: 1, chars: 6 })
    })
  })
})

describe('따로 하는 대화', () => {
  it('메인 대화의 지금 구간·기록에서 빠진다', () => {
    const db = new Store(':memory:')
    store = db
    const main = db.createThread('claude')
    db.addMessage(main.id, 'user', '메인')
    const side = db.createThread('claude', '새 대화', undefined, true)
    db.addMessage(side.id, 'user', '따로')
    expect(db.currentSession()?.id).toBe(main.id)
    expect(db.listConversation().map((m) => m.text)).toEqual(['메인'])
    expect(db.listSideThreads().map((t) => t.id)).toEqual([side.id])
    db.closeOtherSessions(main.id)
    expect(db.getThread(side.id)?.closedAt).toBeUndefined()
    db.deleteThread(side.id)
    expect(db.getThread(side.id)).toBeUndefined()
  })
})
