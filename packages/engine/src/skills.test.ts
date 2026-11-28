import { makeFakeBridges } from '@dool2/sandbox'
import { describe, expect, it } from 'vitest'
import { runTurn } from './engine.js'
import { assembleSystemPrompt, type EngineSkill } from './prompt.js'
import { scriptedBrain } from './scripted-brain.js'

// A gov24 skill that asks to be injected on *.gov.kr, and an unrelated Coupang skill. Korean is fine in a test.
const GOV_BODY = '정부24에서는 본인인증 후 민원을 신청합니다. 발급받은 PDF는 page.pdf()로 저장하세요.'
const COUPANG_BODY = '쿠팡 주문 내역은 로그인 세션으로 API를 먼저 시도하세요.'

const skills: EngineSkill[] = [
  {
    meta: {
      id: 'gov24',
      name: 'Government 24',
      site: ['gov.kr'],
      autoInject: { url: ['*.gov.kr'] },
      regions: ['kr'],
    },
    body: GOV_BODY,
  },
  {
    meta: {
      id: 'coupang',
      name: 'Coupang',
      site: ['coupang.com'],
      autoInject: { url: ['*.coupang.com'] },
      regions: ['kr'],
    },
    body: COUPANG_BODY,
  },
]

describe('skill auto-injection by tab URL', () => {
  it('injects the gov24 SKILL.md body when the tab is on gov.kr', () => {
    const { system, injected } = assembleSystemPrompt(
      { url: 'https://www.gov.kr/portal/main', message: 'help' },
      skills,
    )
    expect(system).toContain(GOV_BODY)
    expect(system).not.toContain(COUPANG_BODY)
    expect(injected.map((s) => s.id)).toEqual(['gov24'])
  })

  it('does not inject gov24 on an unrelated tab', () => {
    const { system, injected } = assembleSystemPrompt(
      { url: 'https://example.com/', message: 'help' },
      skills,
    )
    expect(system).not.toContain(GOV_BODY)
    expect(system).not.toContain(COUPANG_BODY)
    expect(injected).toHaveLength(0)
  })

  it('flows the matched skill body into the turn system prompt', async () => {
    const result = await runTurn(
      { brain: scriptedBrain([[{ kind: 'turn_end', stop: 'done' }]]), bridges: makeFakeBridges(), skills },
      { message: 'apply for a document', url: 'https://www.gov.kr/portal/service' },
    )
    expect(result.system).toContain(GOV_BODY)
    expect(result.injectedSkills.map((s) => s.id)).toEqual(['gov24'])
  })
})
