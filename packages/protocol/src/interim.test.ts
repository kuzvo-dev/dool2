import { describe, expect, it } from 'vitest'
import { appNote, FINISH_CHECK_MARK, finishNext, finishProgress, interimAnswers } from './rich.js'

const check = appNote(
  `끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요. ${FINISH_CHECK_MARK} Something is left`,
)
const msg = (id: string, role: string, text = id) => ({ id, role, text })

describe('one answer per request', () => {
  it('folds earlier answers and check notes once a newer answer comes', () => {
    const { hidden, replaced } = interimAnswers([
      msg('u1', 'user', '테니스장 찾아 줘'),
      msg('t1', 'tool', '{"kind":"work"}'),
      msg('a1', 'assistant'),
      msg('n1', 'user', check),
      msg('a2', 'assistant'),
      msg('n2', 'user', check),
      msg('t2', 'tool', '{"kind":"work"}'),
      msg('a3', 'assistant'),
    ])
    expect([...hidden].sort()).toEqual(['a1', 'a2', 'n1', 'n2'])
    expect(replaced.get('a3')).toEqual(['a1', 'n1', 'a2', 'n2'])
    expect(replaced.has('a2')).toBe(false)
  })

  it('also reads notes saved before the move to English', () => {
    const old = appNote('끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요. (끝내기 전 검사) 아직 남았어요')
    const { hidden } = interimAnswers([
      msg('u1', 'user', 'x'),
      msg('a1', 'assistant'),
      msg('n1', 'user', old),
      msg('a2', 'assistant'),
    ])
    expect([...hidden].sort()).toEqual(['a1', 'n1'])
  })

  it('hides the check note always, and the earlier answer while Dool2 is still working', () => {
    const list = [msg('u1', 'user', 'x'), msg('a1', 'assistant'), msg('n1', 'user', check)]
    expect([...interimAnswers(list).hidden]).toEqual(['n1'])
    expect([...interimAnswers(list, { running: true }).hidden].sort()).toEqual(['a1', 'n1'])
  })

  it('does not fold across approvals or a new request', () => {
    const approved = appNote('폰에서 승인했어요. 결과를 확인하고 이어서 해 주세요.')
    expect(
      interimAnswers([
        msg('u1', 'user', 'x'),
        msg('a1', 'assistant'),
        msg('n1', 'user', approved),
        msg('a2', 'assistant'),
      ]).hidden.size,
    ).toBe(0)
    expect(
      interimAnswers([
        msg('u1', 'user', 'x'),
        msg('a1', 'assistant'),
        msg('u2', 'user', 'y'),
        msg('n1', 'user', check),
        msg('a2', 'assistant'),
      ]).hidden,
    ).toEqual(new Set(['n1']))
  })
})

describe('answers before another app note are separate steps', () => {
  it('folds only the answer the check sent back, not the connect steps before it (11-25)', () => {
    const verified = appNote('Gmail is connected and Doori has verified the sign-in.')
    const { hidden, replaced } = interimAnswers([
      msg('u1', 'user', 'summarize my mail every morning'),
      msg('c1', 'tool', '{"kind":"connect","service":"gmail"}'),
      msg('a1', 'assistant'), // "connect Gmail first"
      msg('a2', 'assistant'), // "Gmail is connected"
      msg('n1', 'user', verified),
      msg('a3', 'assistant'), // scheduled, the preview could not run
      msg('n2', 'user', check),
      msg('k1', 'tool', '{"kind":"task","id":"t1","title":"Mail summary"}'),
      msg('a4', 'assistant'), // handed to a task
    ])
    expect([...hidden].sort()).toEqual(['a3', 'n2'])
    expect(replaced.get('a4')).toEqual(['a3', 'n2'])
  })

  it('an app note after a check note keeps the chain (the same request, still being finished)', () => {
    const approved = appNote('Approved on the phone.')
    const { hidden } = interimAnswers([
      msg('u1', 'user', 'x'),
      msg('a1', 'assistant'),
      msg('n1', 'user', check),
      msg('n2', 'user', approved),
      msg('a2', 'assistant'),
    ])
    expect([...hidden].sort()).toEqual(['a1', 'n1'])
  })
})

describe('the draft in the progress card (finishProgress)', () => {
  const note = (why: string, next?: string) =>
    appNote(
      [
        `끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요. ${FINISH_CHECK_MARK}`,
        `Something is still left: ${why}`,
        next ? `A way to try: ${next}` : '',
        'Do not repeat the same method.',
      ]
        .filter(Boolean)
        .join('\n'),
    )

  it('reads the next step from the note, or the reason without one', () => {
    expect(finishNext(note('보험사 1곳만 봤어요', '보험사 2곳 더 비교'))).toBe('보험사 2곳 더 비교')
    expect(finishNext(note('보험사 1곳만 봤어요'))).toBe('보험사 1곳만 봤어요')
    // Notes written on one line before the change
    expect(
      finishNext(
        appNote(`x ${FINISH_CHECK_MARK} Something is still left: a A way to try: b Do not repeat it.`),
      ),
    ).toBe('b')
  })

  it('while judging, the last answer is the draft', () => {
    const list = [
      msg('u1', 'user', '보험 비교해 줘'),
      msg('w1', 'tool', '{"kind":"work"}'),
      msg('a1', 'assistant'),
    ]
    expect(finishProgress(list, { checking: true, running: true })).toEqual({ draft: 'a1', rounds: 0 })
    expect(finishProgress(list, { running: true })).toBeUndefined()
    expect(finishProgress(list, {})).toBeUndefined()
  })

  it('after a send-back, the earlier answer is the draft and the note says what comes next', () => {
    const list = [
      msg('u1', 'user', '보험 3곳 비교해 줘'),
      msg('a1', 'assistant'),
      msg('n1', 'user', note('1곳만 봤어요', '보험사 2곳 더 비교')),
    ]
    expect(finishProgress(list, { running: true })).toEqual({
      draft: 'a1',
      next: '보험사 2곳 더 비교',
      rounds: 1,
    })
    // The round answered and that answer is judged in turn
    expect(finishProgress([...list, msg('a2', 'assistant')], { running: true, checking: true })).toEqual({
      draft: 'a2',
      next: '보험사 2곳 더 비교',
      rounds: 1,
    })
    // A new request starts over
    expect(finishProgress([...list, msg('u2', 'user', '고마워')], { running: true })).toBeUndefined()
  })
})
