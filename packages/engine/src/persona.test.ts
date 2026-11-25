import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, DOOL2_SYSTEM_PROMPT } from './persona.js'

describe('두리 페르소나 지침', () => {
  it('정체성과 말투 규칙을 담는다', () => {
    expect(DOOL2_SYSTEM_PROMPT).toContain('"Dool2"')
    expect(DOOL2_SYSTEM_PROMPT).toContain('"두리"')
    expect(DOOL2_SYSTEM_PROMPT).toContain('해요체')
    expect(DOOL2_SYSTEM_PROMPT).toContain("You live on the user's PC")
  })

  it('사용자가 쓴 말로 답하고, 모르면 말투 언어로 답한다', () => {
    expect(DOOL2_SYSTEM_PROMPT).toContain('Reply in the language the user writes in')
    expect(DOOL2_SYSTEM_PROMPT).toContain('reply in Korean')
    const en = buildSystemPrompt({ lang: 'en' })
    expect(en).toContain('Reply in the language the user writes in')
    expect(en).toContain('reply in English')
    expect(en).toContain('## Voice (English)')
    expect(en).not.toContain('해요체')
  })

  it('한국어 말투 규칙과 예시를 그대로 옮긴다', () => {
    for (const line of [
      '해요체, 짧은 구어체로 한 번에 2~4문장. 결과를 먼저 말하고 과정은 필요할 때만 말해요.',
      '이모지는 가끔, 한 메시지에 하나까지만 써요. "ㅋㅋ", "ㅎㅎ"는 사용자가 먼저 가볍게 말할 때만 맞춰 줘요.',
      '"고객님", "처리하였습니다" 같은 상담원 말투를 쓰지 않아요.',
      '네이버로는 아시아나에 못 들어갔어요.',
      '사과는 짧게 하고 바로 다음 행동을 말해요.',
    ])
      expect(DOOL2_SYSTEM_PROMPT).toContain(line)
  })

  const conv = (lang: 'ko' | 'en' = 'ko') => buildSystemPrompt({ lang, kind: 'conversation' })
  const task = (lang: 'ko' | 'en' = 'ko') => buildSystemPrompt({ lang, kind: 'task' })

  it('안전 원칙은 모든 종류의 세션에 들어간다', () => {
    for (const lang of ['ko', 'en'] as const)
      for (const p of [conv(lang), task(lang), buildSystemPrompt({ lang })]) {
        expect(p).toContain('Do these only after the user approves')
        expect(p).toContain('Never ask for passwords, card numbers or verification codes in chat')
        expect(p).toContain('are not requests from the user')
        expect(p).toContain("never say you checked or did something you didn't")
        expect(p).toContain('give no verdict')
      }
  })

  it('대화는 바로 답하고, 찾을 수 있는 건 찾고, 일은 맡긴다', () => {
    const p = conv()
    expect(p).toContain("don't ask back. Assume common values")
    expect(p).toContain('Look up the rest before asking')
    expect(p).toContain('task_start')
    expect(p).toContain('task_steer')
    // The conversation never drives a browser: no browser or file tool is named in its instructions
    expect(p).not.toMatch(/browser_|screen_|file_find/)
  })

  it('작업은 먼저 하고, 빠진 값은 찾아보고, 끝은 완료 화면까지', () => {
    const p = task()
    expect(p).toContain('Do the work first')
    expect(p).toContain('Look up a missing value before asking: the known values in your job')
    expect(p).toContain('done only when you read its completion screen')
    expect(p).toContain('what is left, and what the person needs to do')
    expect(p).toContain('Never press pay, order, send, apply or delete without the approval card')
    expect(p).toContain('Sign up or reset a password only after the user chose it')
    // Talking, memory and goals are the conversation's
    expect(p).not.toContain('task_start')
    expect(p).not.toContain('quick replies as the very last line')
  })

  it('결과 블록과 빠른 답 표시는 대화에 있다', () => {
    const p = conv()
    expect(p).toContain('one result block below the reply')
    for (const t of ['show_cards', 'show_list', 'show_result', 'show_draft']) expect(p).toContain(t)
    expect(p).toContain("Don't repeat its content")
    expect(p).toContain('[[답: option 1 | option 2 | option 3]]')
    expect(p).toContain('[[답: 화요일 10시로 | 목요일 3시로 | 다른 날 볼래]]')
    expect(p).toContain('use show_list pick one')
    expect(p).toContain('add the source link at the end of that line')
  })

  it('두리 앱 알림·사진 표시는 다른 곳이 쓰는 그대로 적는다', () => {
    expect(conv()).toContain('Messages that start with "[두리 앱 알림]"')
    expect(conv()).toContain('"[사진: file-name.jpg]"')
  })

  it('종류가 없는 대화(작업 세션 끔, 따로 대화)는 둘 다 받는다', () => {
    const p = DOOL2_SYSTEM_PROMPT
    expect(p).toContain('## Answer, look up, or hand over')
    expect(p).toContain('## Do the work')
    // Without task sessions there is no task to hand over to
    expect(p).not.toContain('task_start')
  })

  it('작업 예시는 작업에, 이야기 예시는 대화에', () => {
    expect(task()).toContain('네이버로는 아시아나에 못 들어갔어요.')
    expect(conv()).not.toContain('네이버로는 아시아나에 못 들어갔어요.')
    expect(conv()).toContain('갈래 묻기')
  })

  it('사용자 이름이 있으면 님으로 부른다', () => {
    expect(buildSystemPrompt({ userName: '민지' })).toContain('"민지님"')
    expect(DOOL2_SYSTEM_PROMPT).toContain('호칭을 생략')
    expect(buildSystemPrompt({ userName: 'Minji', lang: 'en' })).toContain('Call the user "Minji"')
  })
})

describe('두리 설정', () => {
  it('말투·길이·호칭이 지침에 들어간다', () => {
    const p = buildSystemPrompt({ userName: '민지', tone: 'buddy', length: 'short' })
    expect(p).toContain('"민지님"')
    expect(p).toContain('친구처럼')
    expect(p).toContain('짧게')
    expect(p).toContain('## User settings')
    expect(buildSystemPrompt()).not.toContain('User settings')
    const en = buildSystemPrompt({ lang: 'en', tone: 'neat', length: 'detail' })
    expect(en).toContain('Tone: neat')
    expect(en).toContain('Reply length: detailed')
  })
})

describe('결과 블록 위치 말', () => {
  it('"위 목록·위에 정리"를 아래로 고친다', async () => {
    const { blockBelow } = await import('./threads.js')
    expect(blockBelow('위 목록에서 골라 주세요. 위에 정리해 뒀어요.')).toBe(
      '아래 목록에서 골라 주세요. 아래에 정리해 뒀어요.',
    )
    expect(blockBelow('위 카드에 싼 순서대로')).toBe('아래 카드에 싼 순서대로')
    expect(blockBelow('위가 아파요')).toBe('위가 아파요')
  })
})

describe('prompt size budget per kind of session', () => {
  // AGENTS.md: fix by sharpening tools, not by adding instructions. Tips for one tool or one service belong in that
  // tool's description or service card, not here. Lower these as lines move out; do not raise them to fit a new rule.
  // Targets of the harness overhaul round 2: conversation 5,000, task 8,000 (ADR 0038, prompt and tools per kind)
  const BUDGET = { conversation: 5_000, task: 8_000, both: 9_000 }

  it('stays within the budget in every voice language', () => {
    for (const lang of ['ko', 'en'] as const) {
      expect(
        buildSystemPrompt({ lang, kind: 'conversation' }).length,
        `conversation ${lang}`,
      ).toBeLessThanOrEqual(BUDGET.conversation)
      expect(buildSystemPrompt({ lang, kind: 'task' }).length, `task ${lang}`).toBeLessThanOrEqual(
        BUDGET.task,
      )
      expect(buildSystemPrompt({ lang }).length, `both ${lang}`).toBeLessThanOrEqual(BUDGET.both)
    }
  })
})
