import { describe, expect, it } from 'vitest'
import { appNote, FINISH_CHECK_MARK, interimAnswers } from './rich.js'

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
    const { hidden } = interimAnswers([msg('u1', 'user', 'x'), msg('a1', 'assistant'), msg('n1', 'user', old), msg('a2', 'assistant')])
    expect([...hidden].sort()).toEqual(['a1', 'n1'])
  })

  it('keeps the earlier answer while the next one has not come yet', () => {
    const { hidden } = interimAnswers([
      msg('u1', 'user', 'x'),
      msg('a1', 'assistant'),
      msg('n1', 'user', check),
    ])
    expect(hidden.size).toBe(0)
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
      ]).hidden.size,
    ).toBe(0)
  })
})
