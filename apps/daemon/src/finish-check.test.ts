import { appNote, readAppNote } from '@dool2/protocol/rich'
import { describe, expect, it } from 'vitest'
import { againNote, FinishCheck, judgePrompt, parseVerdict, sameBlocker } from './finish-check.js'

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
    })
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
    expect(await c.check('t', { answer: 'c', tools: ['x'] })).toMatchObject({ kind: 'stop', reason: '횟수' })

    const j2 = say(no(0), no(1), no(2), no(3), no(4))
    const c2 = new FinishCheck({ ask: j2.ask, baseCycles: 2, maxCycles: 4 })
    c2.begin('t', '부탁')
    for (const tool of ['a', 'b', 'c', 'd'])
      expect((await c2.check('t', { answer: 'x', tools: [tool] })).kind).toBe('again')
    expect(await c2.check('t', { answer: 'x', tools: ['e'] })).toMatchObject({ kind: 'stop', reason: '횟수' })
  })

  it('같은 이유로 두 번 막히면 멈춘다', async () => {
    const v = '{"done":false,"why":"통신사를 몰라 약정 만료일을 못 봤어요"}'
    const j = say(v, v)
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', '인터넷 약정')
    expect((await c.check('t', { answer: 'a', tools: ['mail_search'] })).kind).toBe('again')
    expect(await c.check('t', { answer: 'b', tools: ['browser_open'] })).toMatchObject({
      kind: 'stop',
      reason: '같은 막힘',
    })
  })

  it('오래 걸리면 멈춘다', async () => {
    let now = 0
    const j = say('{"done":false,"why":"a"}')
    const c = new FinishCheck({ ask: j.ask, now: () => now, maxMs: 1000 })
    c.begin('t', '부탁')
    now = 5000
    expect(await c.check('t', { answer: 'x', tools: ['y'] })).toMatchObject({ kind: 'stop', reason: '시간' })
  })

  it('멈추면 더 판정하지 않는다', async () => {
    const j = say()
    const c = new FinishCheck({ ask: j.ask })
    c.begin('t', '부탁')
    c.drop('t')
    expect((await c.check('t', { answer: 'x', tools: ['y'] })).kind).toBe('skip')
  })

  it('되돌려 보내는 알림에 남은 것과 다른 길을 적는다', () => {
    const note = againNote({ done: false, why: '1곳만 봤어요', next: '다른 곳' })
    expect(note).toContain('1곳만 봤어요')
    expect(note).toContain('다른 길로')
  })

  it('이미 되돌려 보냈으면 판정 글에 적는다', () => {
    expect(judgePrompt({ ask: 'a', answer: 'b', tools: [], cycle: 2 })).toContain('이미 2번')
  })
})

describe('알림 글', () => {
  it('화면에는 이어서 한다는 말만', () => {
    expect(readAppNote(appNote(againNote({ done: false, why: '1곳만 봤어요', next: '다른 곳' })))).toBe(
      '끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요.',
    )
  })
})
