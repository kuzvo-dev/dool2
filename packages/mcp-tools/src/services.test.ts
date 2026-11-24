import { describe, expect, it } from 'vitest'
import { pass, withoutEmpty } from './services.js'

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

  it('drops empty fields from structured results (the AI reads them as JSON)', () => {
    const sc = {
      products: [
        {
          name: '청소기',
          price: 279000,
          original: null,
          rating: null,
          badges: [],
          ad: '',
          link: 'https://x',
        },
        { name: '필터', price: 9000, badges: ['ROCKET'], tags: [{ a: null, b: 1 }] },
      ],
      total: null,
    }
    expect(pass(r(sc)).structuredContent).toEqual({
      products: [
        { name: '청소기', price: 279000, link: 'https://x' },
        { name: '필터', price: 9000, badges: ['ROCKET'], tags: [{ b: 1 }] },
      ],
    })
  })

  it('a result with only empty fields carries the text instead', () => {
    expect(pass(r({ total: null, rows: [] })).structuredContent).toEqual({
      text: '구글 캘린더 일정 편집 화면이에요',
    })
  })

  it('withoutEmpty keeps zero and false', () => {
    expect(withoutEmpty({ a: 0, b: false, c: null })).toEqual({ a: 0, b: false })
  })
})
