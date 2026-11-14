import { describe, expect, it } from 'vitest'
import { previewText } from './index.js'
import { richBlocks } from './rich.js'

describe('richBlocks', () => {
  it('빈 줄로 문단을 나누고 **굵게**를 살린다', () => {
    expect(richBlocks('안녕하세요.\n\n**토요일**은 비가 와요.')).toEqual([
      { type: 'p', lines: [[{ text: '안녕하세요.' }]] },
      {
        type: 'p',
        lines: [[{ text: '토요일', bold: true }, { text: '은 비가 와요.' }]],
      },
    ])
  })

  it('문단 바로 아래 "- " 줄은 목록으로 묶는다', () => {
    expect(richBlocks('알려 주세요.\n- 몇 분\n- 몇 시')).toEqual([
      { type: 'p', lines: [[{ text: '알려 주세요.' }]] },
      { type: 'ul', items: [[{ text: '몇 분' }], [{ text: '몇 시' }]] },
    ])
  })

  it('번호 목록은 시작 번호를 지킨다', () => {
    expect(richBlocks('3. 셋\n4. 넷')).toEqual([
      { type: 'ol', start: 3, items: [[{ text: '셋' }], [{ text: '넷' }]] },
    ])
  })

  it('HTML은 글자 그대로 둔다', () => {
    expect(richBlocks('<b>x</b>')).toEqual([{ type: 'p', lines: [[{ text: '<b>x</b>' }]] }])
  })

  it('쓰는 중인 답(끝이 잘린 **)도 깨지지 않는다', () => {
    expect(richBlocks('**토요')).toEqual([{ type: 'p', lines: [[{ text: '**토요' }]] }])
  })
})

describe('previewText', () => {
  it('마크다운 기호를 빼고 한 줄로 줄인다', () => {
    expect(previewText('**토요일**은 비가 와요.\n\n- 우산\n1. 우비')).toBe('토요일은 비가 와요. 우산 우비')
    expect(previewText('가'.repeat(200), 10)).toBe(`${'가'.repeat(9)}…`)
  })
})
