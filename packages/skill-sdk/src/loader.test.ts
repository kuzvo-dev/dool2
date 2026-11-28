import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSkillsFromDir } from './loader.js'
import { resolveSkills } from './resolve.js'

// SKILL.md fixtures are written to a temp dir at runtime (Korean keywords are
// DATA; a committed .md with glob patterns would be reflowed by the markdown
// formatter, so we build it here instead).
const GOV24 = `---
name: gov24
description: 정부24에서 증명서 발급·민원 조회를 돕는 사이트 스킬
site:
  - gov.kr
autoInject:
  url:
    - "*.gov.kr"
    - "*.gov.kr/*"
  keywords: ["발급", "증명서", "민원"]
regions: [kr]
---

# gov24

정부24(gov.kr)에서 증명서를 발급하고 민원을 조회하는 요령.
`

const COUPANG = `---
name: coupang
description: 쿠팡에서 상품 검색·주문 조회를 돕는 사이트 스킬
site: coupang.com
autoInject:
  url: ["coupang.com/*", "*.coupang.com/*"]
  keywords: ["쿠팡"]
---

# coupang
`

const PAY = `---
name: pay
description: 결제·구매 흐름을 돕는 키워드 전용 스킬
autoInject:
  keywords:
    - 결제
    - 구매
---

# pay
`

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dool2-skills-'))
  for (const [id, md] of [
    ['gov24', GOV24],
    ['coupang', COUPANG],
    ['pay', PAY],
  ] as const) {
    mkdirSync(join(dir, id))
    writeFileSync(join(dir, id, 'SKILL.md'), md)
  }
  // A stray non-directory entry and a dir without SKILL.md must be ignored.
  writeFileSync(join(dir, 'README.txt'), 'not a skill')
  mkdirSync(join(dir, 'empty'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadSkillsFromDir', () => {
  it('loads every SKILL.md under the directory, sorted by id', () => {
    const skills = loadSkillsFromDir(dir)
    expect(skills.map((s) => s.meta.id)).toEqual(['coupang', 'gov24', 'pay'])
    const gov = skills.find((s) => s.meta.id === 'gov24')
    expect(gov?.meta.autoInject?.url).toEqual(['*.gov.kr', '*.gov.kr/*'])
    expect(gov?.meta.autoInject?.keywords).toEqual(['발급', '증명서', '민원'])
    expect(gov?.body).toContain('gov24')
  })

  it('feeds the resolver end to end', () => {
    const skills = loadSkillsFromDir(dir).map((s) => s.meta)
    const result = resolveSkills({ url: 'https://www.gov.kr/portal/main' }, skills)
    expect(result[0]?.skill.id).toBe('gov24')
  })

  it('returns an empty array for a missing directory', () => {
    expect(loadSkillsFromDir(join(dir, 'does-not-exist'))).toEqual([])
  })
})
