import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countDay, localDay, StatsReporter } from './stats.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const at = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString()

describe('사용 통계', () => {
  it('그날 기록에서 숫자만 센다', () => {
    const day = '2026-11-23'
    const c = countDay(
      [
        { at: at(day, 9), kind: 'turn', answered: true, tools: ['x'] },
        { at: at(day, 10), kind: 'turn', answered: false },
        { at: at(day, 10), kind: 'file-tool', tool: 'video_motion', ok: true, path: '~/비밀.mp4' },
        { at: at(day, 11), kind: 'tool', ok: false },
        { at: at(day, 11), kind: 'finish-check', result: 'done', why: '하늘이 생일 영상' },
        { at: at(day, 12), kind: 'finish-check', result: 'again' },
        { at: at('2026-11-22', 12), kind: 'turn', answered: true },
      ],
      day,
    )
    expect(c).toEqual({ turns: 2, answered: 1, toolsOk: 1, toolsFail: 1, finishDone: 1, finishAgain: 1 })
  })

  it('동의하지 않았으면 아무것도 보내지 않는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-stats-'))
    let calls = 0
    const r = new StatsReporter({
      dir,
      enabled: () => false,
      version: '0.3.3',
      entries: () => [],
      status: async () => ({ agents: [], extension: false, connections: 0 }),
      fetch: (async () => {
        calls++
        return new Response('{}')
      }) as typeof fetch,
    })
    expect(await r.tick()).toBe(0)
    expect(calls).toBe(0)
  })

  it('동의했으면 무작위 기기 번호로 오늘 숫자를 보내고, 날이 바뀌면 어제 것도 마지막으로 보낸다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-stats-'))
    const bodies: Record<string, unknown>[] = []
    let now = new Date('2026-11-23T10:00:00')
    const r = new StatsReporter({
      dir,
      enabled: () => true,
      version: '0.3.3',
      entries: () => [{ at: at('2026-11-23', 9), kind: 'turn', answered: true }],
      status: async () => ({ agents: ['claude'], extension: true, connections: 3 }),
      now: () => now,
      fetch: (async (_u: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response('{"ok":true}')
      }) as typeof fetch,
    })
    expect(await r.tick()).toBe(1)
    const first = bodies[0] as Record<string, unknown>
    expect(first).toMatchObject({
      day: '2026-11-23',
      version: '0.3.3',
      turns: 1,
      answered: 1,
      agents: ['claude'],
      extension: true,
      connections: 3,
    })
    expect(String(first.iid)).toMatch(/^[0-9a-f-]{36}$/)
    // 대화·파일 이름 같은 글은 없다
    expect(Object.keys(first).sort()).toEqual(
      [
        'agents',
        'answered',
        'arch',
        'connections',
        'day',
        'extension',
        'finishAgain',
        'finishDone',
        'iid',
        'platform',
        'toolsFail',
        'toolsOk',
        'turns',
        'version',
      ].sort(),
    )
    now = new Date('2026-11-24T09:00:00')
    expect(await r.tick()).toBe(2)
    expect(bodies.slice(1).map((b) => b.day)).toEqual(['2026-11-23', '2026-11-24'])
    expect(bodies.every((b) => b.iid === first.iid)).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8')).sent).toBe('2026-11-24')
    expect(localDay(now)).toBe('2026-11-24')
  })
})
