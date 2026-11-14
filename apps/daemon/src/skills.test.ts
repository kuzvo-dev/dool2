import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Skills, validateSkill } from './skills.js'

const REPO_SKILLS = fileURLToPath(new URL('../../../skills', import.meta.url))

describe('레포의 스킬', () => {
  it('모든 스킬이 안전 규칙을 지킨다', async () => {
    const dirs = (await readdir(REPO_SKILLS, { withFileTypes: true })).filter(
      (d) => d.isDirectory() && !d.name.startsWith('_'),
    )
    expect(dirs.length).toBeGreaterThan(0)
    for (const d of dirs) {
      const text = await readFile(join(REPO_SKILLS, d.name, 'SKILL.md'), 'utf8')
      expect(validateSkill(d.name, text), d.name).toEqual([])
    }
  })
})

const GOOD = `---
name: demo
description: 시험용
---

| 상태 | 초안 |

## 절차

### 1. 조회
- [찾아보기] 화면을 연다.
- [돈 내기] 결제는 사람에게 넘긴다(\`browser_handoff\`).

## 결과 보고
- 끝
`

describe('스킬 검사', () => {
  it('규칙을 지키면 문제가 없다', () => {
    expect(validateSkill('demo', GOOD)).toEqual([])
  })

  it('등급 없는 단계, 금지된 지시, 이름 불일치를 잡는다', () => {
    const bad = GOOD.replace(
      '- [찾아보기] 화면을 연다.',
      '- 화면을 연다.\n- [찾아보기] 보안문자를 자동으로 풀어 넣는다.',
    )
    const problems = validateSkill('other', bad)
    expect(problems.some((p) => p.includes('폴더 이름'))).toBe(true)
    expect(problems.some((p) => p.includes('권한 등급'))).toBe(true)
    expect(problems.some((p) => p.includes('금지된 지시'))).toBe(true)
    expect(
      validateSkill(
        'demo',
        GOOD.replace('- [찾아보기] 화면을 연다.', '- [채워 두기] 저장된 카드 번호를 입력한다.'),
      ),
    ).toHaveLength(1)
  })
})

describe('스킬 도구', () => {
  it('찾고 읽는다', async () => {
    const s = new Skills(REPO_SKILLS)
    const found = await s.run('find', { query: '택배 조회' })
    expect(found.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(found)).toContain('cj-logistics')
    const body = await s.run('read', { name: 'cj-logistics' })
    expect(JSON.stringify(body)).toContain('배송 조회')
    expect((await s.run('read', { name: '../package' })).isError).toBe(true)
    expect((await s.run('read', { name: '_template' })).isError).toBe(true)
  })
})
