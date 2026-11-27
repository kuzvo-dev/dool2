import { appNote, readAppNote } from '@dool2/protocol/rich'
import { describe, expect, it } from 'vitest'
import {
  againNote,
  claimsDone,
  donePage,
  FinishCheck,
  JUDGE_SYSTEM,
  judgePrompt,
  parseVerdict,
  sameBlocker,
} from './finish-check.js'

const say = (...answers: string[]) => {
  const asked: string[] = []
  return {
    asked,
    ask: async (p: string) => {
      asked.push(p)
      return answers.shift()
    },
  }
}

describe('끝내기 전 검사', () => {
  it('판정 글에서 JSON만 읽는다', () => {
    expect(
      parseVerdict('네 {"done": false, "why": "3곳 중 1곳만 봤어요", "next": "다른 2곳"} 입니다'),
    ).toEqual({
      done: false,
      why: '3곳 중 1곳만 봤어요',
      next: '다른 2곳',
      kind: 'other',
    })
    expect(parseVerdict('{"done":false,"why":"x","kind":"asked-user"}')?.kind).toBe('asked-user')
    expect(parseVerdict('{"done":true,"why":"x","kind":"asked-user"}')?.kind).toBeUndefined()
    expect(parseVerdict('모르겠어요')).toBeUndefined()
    expect(parseVerdict('{"why":"x"}')).toBeUndefined()
  })

  it('같은 막힘은 같다고 본다', () => {
    expect(
      sameBlocker('통신사를 몰라 약정 만료일을 못 봤어요', '통신사를 몰라서 약정 만료일을 못 봤어요'),
    ).toBe(true)
    expect(sameBlocker('통신사를 몰라요', '보험 3곳 중 1곳만 비교했어요')).toBe(false)
  })

  it('도구를 안 쓴 말은 판정하지 않는다', async () => {
    const j = say()
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', '안녕')
    expect((await c.check('t', { answer: '안녕하세요', tools: [] })).kind).toBe('skip')
    expect(j.asked).toHaveLength(0)
  })

  it('안 끝났으면 되돌려 보내고, 끝나면 멈춘다', async () => {
    const j = say(
      '{"done":false,"why":"보험 1곳만 봤어요","next":"다른 보험사 사이트"}',
      '{"done":true,"why":"3곳 비교함"}',
    )
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', '차 보험 3곳 비교해 줘')
    const r1 = await c.check('t', { answer: '한 곳 봤어요. 나머지는 전화해 보세요', tools: ['browser_open'] })
    expect(r1.kind).toBe('again')
    expect(j.asked[0]).toContain('차 보험 3곳 비교해 줘')
    const r2 = await c.check('t', { answer: '3곳 비교했어요', tools: ['browser_open'] })
    expect(r2).toMatchObject({ kind: 'done', cycles: 1 })
    expect(c.current('t')).toBeUndefined()
  })

  it("a task's done-when conditions reach the judge (ADR 0038)", async () => {
    const j = say('{"done":true,"why":"booked"}')
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', 'Book a KTX to Busan on Friday', {
      doneWhen: ['a ticket number is read on the completion screen'],
    })
    await c.check('t', { answer: 'Booked, ticket 123', tools: ['browser_click'] })
    expect(j.asked[0]).toContain('Done when')
    expect(j.asked[0]).toContain('- a ticket number is read on the completion screen')
    expect(judgePrompt({ ask: 'x', answer: 'y', tools: [], cycle: 0 })).not.toContain('Done when')
  })

  it('진전이 없으면 기본 횟수에서, 있으면 최대까지 간다', async () => {
    const whys = [
      '보험 한 곳만 봤어요',
      '약정 만료일이 없어요',
      '서류 칸이 비었어요',
      '예약 시간을 못 골랐어요',
      '영수증을 못 찾았어요',
    ]
    const no = (i: number) => JSON.stringify({ done: false, why: whys[i] })
    const j = say(no(0), no(1), no(2))
    const c = new FinishCheck({ ask: j.ask, baseCycles: 2, maxCycles: 4 })
    c.begin('t', '부탁')
    expect((await c.check('t', { answer: 'a', tools: ['x'] })).kind).toBe('again')
    expect((await c.check('t', { answer: 'b', tools: ['x'] })).kind).toBe('again')
    // 새 도구 없이 세 번째: 기본 2번을 넘었으니 멈춘다
    expect(await c.check('t', { answer: 'c', tools: ['x'] })).toMatchObject({
      kind: 'stop',
      reason: 'rounds',
    })

    const j2 = say(no(0), no(1), no(2), no(3), no(4))
    const c2 = new FinishCheck({ ask: j2.ask, baseCycles: 2, maxCycles: 4 })
    c2.begin('t', '부탁')
    for (const tool of ['a', 'b', 'c', 'd'])
      expect((await c2.check('t', { answer: 'x', tools: [tool] })).kind).toBe('again')
    expect(await c2.check('t', { answer: 'x', tools: ['e'] })).toMatchObject({
      kind: 'stop',
      reason: 'rounds',
    })
  })

  it("never counts keeping Dool2 itself working as the person's part", () => {
    // 11-27: "open chrome://extensions, turn on developer mode and press update" was passed as done
    expect(JUDGE_SYSTEM).toContain("Keeping Dool2 itself working is never the person's part")
    expect(JUDGE_SYSTEM).toContain('chrome://')
  })

  it('keeps going while the judge gives a way not tried yet, and says when a turn tried nothing', async () => {
    // The family certificate (test PC 11-27): same blocker, no new tool, but each verdict had another way to try
    const blocked = 'PDF가 아직 저장되지 않았고 저장 경로도 알리지 못했어요'
    const v = (next: string) => JSON.stringify({ done: false, why: blocked, next })
    const j = say(
      v('증명서 창의 인쇄 화면에서 PDF로 저장을 시도해요'),
      v('문서 폴더 대신 다운로드 폴더에 저장해 봐요'),
      v('발급 화면에서 전자증명서로 받는 길을 찾아봐요'),
      v('발급 화면에서 전자증명서로 받는 길을 찾아봐요'),
    )
    const c = new FinishCheck({ ask: j.ask, baseCycles: 2, maxCycles: 6 })
    c.begin('t', '가족관계증명서 PDF로 저장해줘')
    expect((await c.check('t', { answer: 'a', tools: ['browser_save_pdf'] })).kind).toBe('again')
    const second = await c.check('t', { answer: 'b', tools: [] })
    expect(second.kind).toBe('again')
    // That turn called no tool: the next note says nothing was tried
    expect(second.kind === 'again' && second.note).toContain('called no tool')
    expect((await c.check('t', { answer: 'c', tools: ['browser_read'] })).kind).toBe('again')
    // The same way again and no new tool: nothing left to try
    expect((await c.check('t', { answer: 'd', tools: ['browser_read'] })).kind).toBe('stop')
  })

  it('같은 이유로 두 번 막히면 멈춘다', async () => {
    const v = '{"done":false,"why":"통신사를 몰라 약정 만료일을 못 봤어요"}'
    const j = say(v, v)
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', '인터넷 약정')
    expect((await c.check('t', { answer: 'a', tools: ['mail_search'] })).kind).toBe('again')
    expect(await c.check('t', { answer: 'b', tools: ['browser_open'] })).toMatchObject({
      kind: 'stop',
      reason: 'same blocker',
    })
  })

  it('오래 걸리면 멈춘다', async () => {
    let now = 0
    const j = say('{"done":false,"why":"a"}')
    const c = new FinishCheck({ ask: j.ask, now: () => now, maxMs: 1000 })
    c.begin('t', '부탁')
    now = 5000
    expect(await c.check('t', { answer: 'x', tools: ['y'] })).toMatchObject({ kind: 'stop', reason: 'time' })
  })

  it('기본으로 부탁 하나는 10분까지만 되돌려 보낸다', async () => {
    let now = 0
    const c = new FinishCheck({
      ask: say('{"done":false,"why":"a"}', '{"done":false,"why":"b"}').ask,
      now: () => now,
    })
    c.begin('t', '부탁')
    now = 9 * 60_000
    expect((await c.check('t', { answer: 'x', tools: ['y'] })).kind).toBe('again')
    now = 11 * 60_000
    expect(await c.check('t', { answer: 'x', tools: ['z'] })).toMatchObject({ kind: 'stop', reason: 'time' })
  })

  it('멈추면 더 판정하지 않는다', async () => {
    const j = say()
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', '부탁')
    c.drop('t')
    expect((await c.check('t', { answer: 'x', tools: ['y'] })).kind).toBe('skip')
  })

  it('판정하는 중에 멈추면 판정을 끊고, 늦게 온 판정은 쓰지 않는다', async () => {
    let signal: AbortSignal | undefined
    const c = new FinishCheck({
      ask: (_p, s) =>
        new Promise((resolve) => {
          signal = s
          s.addEventListener('abort', () => resolve('{"done":false,"why":"a"}'))
        }),
    })
    c.begin('t', '부탁')
    const r = c.check('t', { answer: 'x', tools: ['y'] })
    c.drop('t')
    expect(signal?.aborted).toBe(true)
    expect(await r).toEqual({ kind: 'skip', reason: 'stopped' })
    expect(c.current('t')).toBeUndefined()
  })

  it('되돌려 보내는 알림에 남은 것과 다른 길을 적는다', () => {
    const note = againNote({ done: false, why: '1곳만 봤어요', next: '다른 곳' })
    expect(note).toContain('1곳만 봤어요')
    expect(note).toContain('continue another way')
  })

  it('이미 되돌려 보냈으면 판정 글에 적는다', () => {
    expect(judgePrompt({ ask: 'a', answer: 'b', tools: [], cycle: 2 })).toContain('Already sent back 2')
    const handed = judgePrompt({
      ask: 'a',
      answer: 'b',
      tools: ['browser_handoff'],
      cycle: 0,
      evidence: {
        approvals: 0,
        handoffs: [{ blocker: 'identity_check', tried: 'the service tool stopped at a check' }],
      },
    })
    expect(handed).toContain(
      'Handed to the person (identity_check) after trying: the service tool stopped at a check',
    )
  })
})

describe('알림 글', () => {
  it('화면에는 이어서 한다는 말만', () => {
    expect(readAppNote(appNote(againNote({ done: false, why: '1곳만 봤어요', next: '다른 곳' })))).toBe(
      '끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요.',
    )
  })
})

describe('false completion, caught by code (no judge)', () => {
  it('finds claims of a finished outside action in Korean and English', () => {
    for (const yes of [
      '내일 7시로 예약했어요.',
      '주문해 뒀어요',
      '신청을 마쳤어요!',
      '결제 완료했어요',
      '엄마에게 문자 보냈어요.',
      '예약이 완료됐어요',
      'I booked a table for two at 7.',
      "I've sent the message to Mina.",
      'Your order has been placed.',
    ])
      expect(claimsDone(yes), yes).toBe(true)
    for (const no of [
      '예약할게요. 승인해 주세요.',
      '지난달에 주문했던 내역이에요.',
      '아직 못 보냈어요.',
      '문자는 안 보냈어요',
      '예약하지 않았어요. 시간을 골라 주세요.',
      '3곳을 비교했어요.',
      'I could not book it: the site asks for a phone check.',
      'Shall I order it?',
    ])
      expect(claimsDone(no), no).toBe(false)
  })

  it('knows a page that shows a finished action', () => {
    expect(donePage({ title: '주문이 완료되었습니다', url: 'https://shop.example/x' })).toBe(true)
    expect(donePage({ title: 'Booking confirmed', url: 'https://x.example/' })).toBe(true)
    expect(donePage({ title: 'x', url: 'https://x.example/order/complete?id=1' })).toBe(true)
    expect(donePage({ title: '장바구니', url: 'https://shop.example/cart' })).toBe(false)
  })

  it('sends back a claim with no approval and no finished page at once, without asking the judge', async () => {
    const j = say()
    const c = new FinishCheck({ ask: j.ask, evidence: () => ({ approvals: 0, donePage: false }) })
    c.begin('t', '내일 7시 2명 예약해 줘')
    const r = await c.check('t', { answer: '내일 7시로 예약했어요.', tools: ['browser_click'] })
    expect(r).toMatchObject({ kind: 'again', because: 'unverified', source: 'code', cycles: 1 })
    expect(j.asked).toHaveLength(0)
  })

  it('a claim backed by an approval or a finished page goes to the judge', async () => {
    for (const evidence of [
      { approvals: 1, donePage: false },
      { approvals: 0, donePage: true },
    ]) {
      const j = say('{"done":true,"why":"booked"}')
      const c = new FinishCheck({ ask: j.ask, evidence: () => evidence })
      c.begin('t', '예약해 줘')
      expect((await c.check('t', { answer: '예약했어요', tools: ['browser_click'] })).kind).toBe('done')
      expect(j.asked).toHaveLength(1)
    }
  })

  it('the judge reads the daemon facts', async () => {
    const j = say('{"done":true,"why":"ok"}')
    const c = new FinishCheck({
      ask: j.ask,
      evidence: () => ({ approvals: 0, lastPage: { title: 'Cart', url: 'https://shop.example/cart' } }),
    })
    c.begin('t', 'buy socks')
    await c.check('t', { answer: 'Here are 3 options.', tools: ['browser_open'], failures: 2 })
    expect(j.asked[0]).toContain('Approval requests during this request: none')
    expect(j.asked[0]).toContain('Last page read: Cart — https://shop.example/cart')
    expect(j.asked[0]).toContain('Tool calls that failed this turn: 2')
  })
})

describe('simple requests are not judged', () => {
  it('one or two lookups and nothing else: no judge', async () => {
    const j = say()
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', 'when does my parcel arrive?')
    expect(
      await c.check('t', { answer: 'Tomorrow morning.', tools: ['cj_logistics_track'], lookups: 1 }),
    ).toEqual({ kind: 'skip', reason: 'simple' })
    expect(j.asked).toHaveLength(0)
  })

  it('a browser step, a non-lookup or a third call is judged', async () => {
    for (const turn of [
      { tools: ['browser_open'], lookups: 0 },
      { tools: ['know_find', 'goal_create'], lookups: 1 },
      { tools: ['know_find', 'gmail_search', 'orders_all'], lookups: 3 },
    ]) {
      const j = say('{"done":true,"why":"ok"}')
      const c = new FinishCheck({ ask: j.ask })
      c.begin('t', 'x')
      expect((await c.check('t', { answer: 'a', ...turn })).kind).toBe('done')
    }
  })
})
