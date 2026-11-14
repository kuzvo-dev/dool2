import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, DOOL2_SYSTEM_PROMPT } from './persona.js'

describe('두리 페르소나 지침', () => {
  it('정체성과 말투 규칙을 담는다', () => {
    expect(DOOL2_SYSTEM_PROMPT).toContain('"두리"')
    expect(DOOL2_SYSTEM_PROMPT).toContain('해요체')
    expect(DOOL2_SYSTEM_PROMPT).toContain('PC에 살아요')
  })

  it('안전 원칙을 빠뜨리지 않는다', () => {
    expect(DOOL2_SYSTEM_PROMPT).toContain('반드시 사용자 허락')
    expect(DOOL2_SYSTEM_PROMPT).toContain('비밀번호, 카드 번호, 인증번호')
    expect(DOOL2_SYSTEM_PROMPT).toContain('두리 도구로만')
  })

  it('사용자 이름이 있으면 님으로 부른다', () => {
    expect(buildSystemPrompt({ userName: '민지' })).toContain('"민지님"')
    expect(DOOL2_SYSTEM_PROMPT).toContain('호칭을 생략')
  })
})
