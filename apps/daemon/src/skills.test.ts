import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkConnectCard } from '@dool2/protocol/connect'
import { describe, expect, it } from 'vitest'
import { Skills } from './skills.js'

const REPO_SKILLS = fileURLToPath(new URL('../../../skills', import.meta.url))

describe('레포의 스킬', () => {
  const services = async () =>
    (await readdir(REPO_SKILLS, { withFileTypes: true })).filter(
      (d) => d.isDirectory() && !d.name.startsWith('_'),
    )

  it('모든 서비스에 연결 카드(connect.json)가 있고 형식을 지킨다', async () => {
    for (const d of await services()) {
      const raw = await readFile(join(REPO_SKILLS, d.name, 'connect.json'), 'utf8').catch(() => undefined)
      expect(raw, `${d.name}/connect.json이 없어요`).toBeDefined()
      expect(checkConnectCard(d.name, JSON.parse(raw ?? '{}')), d.name).toEqual([])
    }
  })
})

describe('연결 카드', () => {
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
})

describe('서비스 지도 (AI가 부탁에 맞는 서비스를 스스로 고르게)', () => {
  it('서비스마다 무엇을 하는 곳인지(소개)와 할 수 있는 일, 연결된 곳에 ✓', async () => {
    const s = new Skills(
      REPO_SKILLS,
      () => ({ catchtable: '2026-11-17T00:00:00.000Z' }),
      async (id) =>
        id === 'catchtable'
          ? {
              status: '검증됨(2026-11-17)',
              tools: [
                {
                  name: 'catchtable_search',
                  title: '식당 빈자리 찾기',
                  tier: '찾아보기',
                  login: false,
                  verified: true,
                },
              ],
            }
          : {},
    )
    await s.connections()
    const map = s.serviceMap()
    expect(map).toMatch(/- 캐치테이블\(catchtable\)✓⚡ — .*식당.*\[식당 예약[^\n]*\]$/m)
    expect(map).toMatch(/### 장보기·배달\n(- .*\n)*- 컬리\(kurly\) — /)
    // 폰 권한(연락처 등)은 빼고, 너무 길지 않게
    expect(map).not.toMatch(/contacts/)
    expect(map.length).toBeLessThan(12500) // 서비스가 늘면 조금씩 (11-20 고향사랑e음·정책브리핑)
  })
})

describe('로그인 없이 되는 도구 알리기', () => {
  it('연결 전 서비스는 로그인 없이 쓰는 도구 이름을 지도에 붙인다', async () => {
    const s = new Skills(
      REPO_SKILLS,
      () => ({}),
      async (id) =>
        id === 'catchtable'
          ? {
              tools: [
                {
                  name: 'catchtable_search',
                  title: '식당 빈자리 찾기',
                  tier: '찾아보기',
                  login: false,
                  verified: true,
                },
                { name: 'catchtable_my', title: '내 예약', tier: '찾아보기', login: true, verified: false },
              ],
            }
          : {},
    )
    await s.connections()
    expect(s.serviceMap()).toMatch(/캐치테이블\(catchtable\)⚡ — .*\(로그인 없이: catchtable_search\)$/m)
  })
})

describe('계정 가리기', () => {
  it('이메일은 앞 한 글자만, 아이디는 그대로', async () => {
    const { maskAccount } = await import('./skills.js')
    expect(maskAccount('felix990810@gmail.com')).toBe('f***@gmail.com')
    expect(maskAccount('f***@gmail.com')).toBe('f***@gmail.com')
    expect(maskAccount('wwd')).toBe('wwd')
  })
})

describe('같은 계정으로 로그인하는 서비스', () => {
  it('네이버가 연결돼 있으면 네이버 메일도 연결된 것으로 보이고 지도에 ✓', async () => {
    const s = new Skills(REPO_SKILLS, () => ({ naver: '2026-11-20T00:00:00.000Z' }))
    const list = await s.connections()
    expect(list.find((x) => x.card.id === 'naver-mail')?.connectedAt).toBe('2026-11-20T00:00:00.000Z')
    expect(s.serviceMap()).toMatch(/네이버 메일\(naver-mail\)✓/)
  })
})
