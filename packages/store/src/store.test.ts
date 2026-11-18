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
      expect(store.sessionSize(t.id)).toEqual({ turns: 0, chars: 0, contextTokens: 0 })
      store.addMessage(t.id, 'user', '안녕')
      store.addMessage(t.id, 'assistant', '반가워요')
      expect(store.sessionSize(t.id)).toEqual({ turns: 1, chars: 6, contextTokens: 0 })
    })

    it('구간의 실제 크기(토큰)를 남기고, 마지막 말 시각은 그대로 둔다', () => {
      store = new Store(':memory:')
      const t = store.createThread('claude')
      store.addMessage(t.id, 'user', '쿠팡에서 청소기 찾아 줘')
      const before = store.getThread(t.id)?.updatedAt
      store.setContextTokens(t.id, 84_321.6)
      expect(store.sessionSize(t.id).contextTokens).toBe(84_322)
      expect(store.getThread(t.id)?.updatedAt).toBe(before)
    })
  })
})

describe('대화 기록 찾기', () => {
  function seed() {
    const db = new Store(':memory:')
    store = db
    const old = db.createThread('claude')
    db.addMessage(old.id, 'user', '로봇 청소기 30만 원 아래로 찾아 줘')
    db.addMessage(old.id, 'assistant', '로보락 Q7이 27만 9천 원이에요. 물걸레도 돼요.')
    db.addMessage(old.id, 'tool', '{"kind":"approval","what":"청소기 결제"}')
    db.addMessage(old.id, 'user', '100% 할인_쿠폰 있어?')
    db.closeSession(old.id)
    const side = db.createThread('claude', '피드', undefined, true)
    db.addMessage(side.id, 'assistant', '청소기 특가 소식이에요')
    const cur = db.createThread('claude')
    db.addMessage(cur.id, 'user', '지난주에 본 청소기 뭐였지?')
    return { db, cur }
  }

  it('모든 구간의 사용자·두리 말을 최근 것부터 찾고, 도구 기록·따로 하는 대화는 뺀다', () => {
    const { db } = seed()
    expect(db.searchConversation('청소기').map((m) => m.text)).toEqual([
      '지난주에 본 청소기 뭐였지?',
      '로봇 청소기 30만 원 아래로 찾아 줘',
    ])
  })

  it('지금 구간은 뺄 수 있다 (AI가 이미 알고 있다)', () => {
    const { db, cur } = seed()
    expect(db.searchConversation('청소기', { excludeThreadId: cur.id }).map((m) => m.text)).toEqual([
      '로봇 청소기 30만 원 아래로 찾아 줘',
    ])
  })

  it('띄어쓰기를 무시하고, 낱말이 여럿이면 많이 맞은 것부터', () => {
    const { db } = seed()
    expect(db.searchConversation('로봇청소기').map((m) => m.text)).toEqual([
      '로봇 청소기 30만 원 아래로 찾아 줘',
    ])
    // 두 낱말이 다 맞은 앞의 말이 하나만 맞은 최근 말보다 먼저
    expect(db.searchConversation('청소기 30만', { limit: 2 }).map((m) => m.text)).toEqual([
      '로봇 청소기 30만 원 아래로 찾아 줘',
      '지난주에 본 청소기 뭐였지?',
    ])
    // 한 글자 낱말("본")은 낱말이 여럿일 때 빼고 찾는다
    expect(db.searchConversation('본 로보락').map((m) => m.text)).toEqual([
      '로보락 Q7이 27만 9천 원이에요. 물걸레도 돼요.',
    ])
  })

  it('%·_는 글자 그대로 찾는다', () => {
    const { db } = seed()
    expect(db.searchConversation('100%').map((m) => m.text)).toEqual(['100% 할인_쿠폰 있어?'])
    expect(db.searchConversation('할인_').map((m) => m.text)).toEqual(['100% 할인_쿠폰 있어?'])
    expect(db.searchConversation('0%할')).toHaveLength(1)
    expect(db.searchConversation('_')).toHaveLength(1)
    expect(db.searchConversation('   ')).toEqual([])
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

  it('새로 열 때 빈 대화는 다시 쓰고, 정한 개수가 차면 더 만들지 않는다 (피드 대화는 세지 않는다)', () => {
    const db = new Store(':memory:')
    store = db
    const feed = db.createThread('claude', '두리 피드', undefined, true)
    const a = db.openSideThread('claude', 2, feed.id)
    if (!a) throw new Error('a')
    expect(a.side).toBe(true)
    // 아직 말이 없으니 또 눌러도 같은 대화
    expect(db.openSideThread('claude', 2, feed.id)?.id).toBe(a.id)
    db.addMessage(a.id, 'user', '여행 준비')
    const b = db.openSideThread('claude', 2, feed.id)
    if (!b) throw new Error('b')
    expect(b.id).not.toBe(a.id)
    db.addMessage(b.id, 'user', '이사 준비')
    expect(db.openSideThread('claude', 2, feed.id)).toBeUndefined()
    db.deleteThread(a.id)
    expect(db.openSideThread('claude', 2, feed.id)).toBeDefined()
  })
})
