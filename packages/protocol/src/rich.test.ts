import { describe, expect, it } from 'vitest'
import { previewText } from './index.js'
import { appNote, narrationLine, readAppNote, richBlocks } from './rich.js'

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

describe('앱 알림', () => {
  it('화면에는 AI에게만 필요한 꼬리말을 빼고 보여 준다', () => {
    const t = appNote('폰에서 승인했어요. "바로 구매"를 눌렀어요. 결과를 확인하고 이어서 해 주세요.')
    expect(readAppNote(t)).toBe('폰에서 승인했어요. "바로 구매"를 눌렀어요.')
    expect(readAppNote('다 했어요. 이어서 해 주세요.')).toBeUndefined()
    expect(
      readAppNote(
        appNote(
          '폰에서 시험 가게 로그인 정보를 두리 금고에 저장했어요. browser_login으로 채우고 로그인한 뒤 하던 일을 이어서 해 주세요.',
        ),
      ),
    ).toBe('폰에서 시험 가게 로그인 정보를 두리 금고에 저장했어요.')
  })
})

describe('narrationLine', () => {
  it('영어 속생각은 버리고 한국어 마지막 문장만', () => {
    expect(
      narrationLine('Focus is on the pin. Three more Tabs to reach the date.날짜를 내일로 맞췄어요.'),
    ).toBe('날짜를 내일로 맞췄어요.')
    expect(narrationLine('SRT 사이트를 열게요. 출발역을 동탄으로 고르는 중이에요.')).toBe(
      '출발역을 동탄으로 고르는 중이에요.',
    )
  })
  it('한국어가 없으면 없음', () => {
    expect(narrationLine('No skill; go to SRT site directly.')).toBeUndefined()
    expect(narrationLine('')).toBeUndefined()
  })
  it('길면 자른다', () => {
    const line = narrationLine('가'.repeat(80))
    expect(line?.length).toBe(60)
    expect(line?.endsWith('…')).toBe(true)
  })
})
