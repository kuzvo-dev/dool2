import { describe, expect, it } from 'vitest'
import { pass } from './services.js'

describe('서비스 도구 결과 넘기기', () => {
  const r = (sc?: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: '구글 캘린더 일정 편집 화면이에요' }],
    ...(sc ? { structuredContent: sc } : {}),
  })

  it('출력 칸이 없는 도구는 구조화 결과를 빼서 AI가 글을 보게 한다', () => {
    expect(pass(r({}), false)).toEqual({ content: r().content })
  })

  it('출력 칸이 있는데 비어 온 결과(넘기기·멈춤)는 글을 text 칸에 담는다', () => {
    expect(pass(r({})).structuredContent).toEqual({ text: '구글 캘린더 일정 편집 화면이에요' })
  })

  it('채워진 결과는 그대로', () => {
    expect(pass(r({ rows: [1] })).structuredContent).toEqual({ rows: [1] })
  })
})
