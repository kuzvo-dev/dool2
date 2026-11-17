import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConnectCard } from '@dool2/protocol/connect'
import { describe, expect, it } from 'vitest'
import { Skills, validateSkill } from './skills.js'

const REPO_SKILLS = fileURLToPath(new URL('../../../skills', import.meta.url))

describe('레포의 스킬', () => {
  const services = async () =>
    (await readdir(REPO_SKILLS, { withFileTypes: true })).filter(
      (d) => d.isDirectory() && !d.name.startsWith('_'),
    )

  it('모든 스킬이 안전 규칙을 지킨다', async () => {
    const dirs = await services()
    expect(dirs.length).toBeGreaterThan(0)
    for (const d of dirs) {
      // SKILL.md(절차)는 실제로 돌려 본 서비스부터 붙는다. 없으면 연결 카드만 있는 것
      const text = await readFile(join(REPO_SKILLS, d.name, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (text) expect(validateSkill(d.name, text), d.name).toEqual([])
    }
  })

  it('모든 서비스에 연결 카드(connect.json)가 있고 형식을 지킨다', async () => {
    for (const d of await services()) {
      const raw = await readFile(join(REPO_SKILLS, d.name, 'connect.json'), 'utf8').catch(() => undefined)
      expect(raw, `${d.name}/connect.json이 없어요`).toBeDefined()
      expect(checkConnectCard(d.name, JSON.parse(raw ?? '{}')), d.name).toEqual([])
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

describe('연결 카드와 스킬 도구', () => {
  const card = {
    id: 'demo-mall',
    name: '데모몰',
    site: 'demo.co.kr',
    category: 'shopping',
    how: 'browser',
    login: '아이디·비밀번호',
    summary: '데모몰을 연결하면 주문부터 배송 확인까지 두리에게 맡길 수 있어요.',
    example: { ask: '주문한 거 언제 와?', working: '배송 조회 중', reply: '내일 오전에 도착해요.' },
    abilities: [
      { title: '배송 조회', say: '주문한 거 언제 와?', tier: '찾아보기' },
      { title: '주문', say: '늘 사던 걸로 시켜 줘', tier: '돈 내기' },
    ],
  }
  const setup = async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'dool2-skills-'))
    await mkdir(join(dir, 'demo-mall'))
    await writeFile(join(dir, 'demo-mall', 'connect.json'), JSON.stringify(card))
    await mkdir(join(dir, 'demo'))
    await writeFile(join(dir, 'demo', 'SKILL.md'), GOOD)
    await mkdir(join(dir, 'broken'))
    await writeFile(join(dir, 'broken', 'connect.json'), '{"id":"broken"')
    return dir
  }

  it('목록은 카드가 있는 서비스만, 연결 상태를 붙인다', async () => {
    const skills = new Skills(await setup(), () => ({ 'demo-mall': '2026-11-15T01:00:00.000Z' }))
    const list = await skills.connections()
    expect(list.map((x) => x.card.id)).toEqual(['demo-mall'])
    expect(list[0]?.connectedAt).toBe('2026-11-15T01:00:00.000Z')
  })

  it('skill_find는 할 수 있는 일로도 찾고 연결 여부를 알려 준다', async () => {
    const skills = new Skills(await setup())
    const r = await skills.run('find', { query: '배송' })
    expect(r.content[0]?.text).toContain('demo-mall 데모몰 [연결 전, 절차 없음]')
    const both = await skills.run('find', { query: '' })
    expect(both.content[0]?.text).toContain('- demo [초안]')
  })

  it('절차가 없으면 skill_read가 카드의 할 수 있는 일과 등급을 준다', async () => {
    const skills = new Skills(await setup())
    const r = await skills.run('read', { name: 'demo-mall' })
    expect(r.content[0]?.text).toContain('[돈 내기] 주문')
    expect(r.content[0]?.text).toContain('절차 문서(SKILL.md)는 아직 없어요')
    expect((await skills.run('read', { name: 'demo' })).content[0]?.text).toContain('## 절차')
    expect((await skills.run('read', { name: 'nope' })).isError).toBe(true)
  })
})

describe('서비스 지도 (AI가 부탁에 맞는 서비스를 스스로 고르게)', () => {
  it('서비스마다 무엇을 하는 곳인지(소개)와 할 수 있는 일, 연결된 곳에 ✓', async () => {
    const s = new Skills(REPO_SKILLS, () => ({ catchtable: '2026-11-17T00:00:00.000Z' }))
    await s.connections()
    const map = s.serviceMap()
    expect(map).toMatch(/- 캐치테이블\(catchtable\)✓ — .*식당.*\[식당 예약/)
    expect(map).toMatch(/### 장보기·배달\n(- .*\n)*- 컬리\(kurly\) — /)
    // 폰 권한(연락처 등)은 빼고, 너무 길지 않게
    expect(map).not.toMatch(/contacts/)
    expect(map.length).toBeLessThan(12000)
  })

  it('연결된 서비스가 같은 이름 찾기에서 앞에 나온다', async () => {
    const s = new Skills(REPO_SKILLS, () => ({ kurly: '2026-11-17T00:00:00.000Z' }))
    const r = await s.run('find', { query: '장보기' })
    expect(r.content[0]?.text.split('\n')[0]).toMatch(/kurly .*연결됨/)
  })
})
