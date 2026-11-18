import { describe, expect, it } from 'vitest'
import { ctxReplaced, pageLocate } from './page.js'

describe('누르기 전 둘레 글 견주기', () => {
  it('글이 더해진 것은 괜찮다 (아이디를 넣자 지우기 버튼이 생긴 로그인 화면)', () => {
    const was = '무신사 로그인/회원가입 무신사, 29CM, 솔드아웃을 하나로 로그인하세요.'
    expect(ctxReplaced(was, `${was} 입력 내용 지우기`)).toBe(false)
    expect(ctxReplaced(was, `오늘만 특가 배너 ${was}`)).toBe(false)
    expect(ctxReplaced(was, was)).toBe(false)
  })
  it('읽을 때 있던 글이 사라지고 다른 칸이 그려졌으면 막는다 (재활용된 가게 칸)', () => {
    const was = '아세누 성수 · 일식 오마카세 ★4.8 (1,203) 디너 15만원 11.26 (목) 마감'
    const now = '라망시크레 한남 · 프렌치 코스 ★4.6 (884) 디너 18만원 11.26 (목) 마감'
    expect(ctxReplaced(was, now)).toBe(true)
  })
  it('바로 앞 짧은 가게 이름·설명만 바뀌어도 막는다 (멀리 있는 글은 그대로인 재활용 칸)', () => {
    const head = '오늘의 추천 성수 맛집 모음 지도에서 보기 필터 거리순 평점순'
    expect(ctxReplaced(`${head} 가게 가 조용한 한식집`, `${head} 가게 나 시끄러운 술집`)).toBe(true)
    // 글이 더해진 것은 여전히 괜찮다
    expect(ctxReplaced(`${head} 가게 가 조용한 한식집`, `${head} 가게 가 조용한 한식집 새로 생김`)).toBe(
      false,
    )
  })
  it('페이지에 넣는 pageLocate도 같은 규칙을 쓴다', () => {
    const src = pageLocate.toString().replace(/\s+/g, '')
    expect(src).toMatch(/gone>=3&&gone>=words\.length\*0?\.2\)?\|\|goneNear>=2/)
    expect(src).toMatch(/words\.slice\(-6\)/)
    expect(src).toMatch(/mode!==["']type["']/)
  })
})
