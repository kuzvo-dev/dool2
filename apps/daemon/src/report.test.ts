import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildReport, reportEntry, sendReport } from './report.js'

describe('문제 알리기 기록', () => {
  it('정해 둔 칸만 남기고 대화·파일 이름·주소·이유 글은 뺀다', () => {
    const e = reportEntry({
      at: '2026-11-23T01:00:00Z',
      kind: 'file-tool',
      tool: 'video_motion',
      ok: false,
      path: '~/Documents/두리/하늘이 생일.mp4',
      why: '하늘이 다섯 살 생일 영상을 만들다가 실패',
      prompt: '하늘이 생일 축하 영상 만들어 줘',
      url: 'https://shop.example.com/my?token=abc',
      ms: 1200,
      tools: ['file_find', 'video_motion'],
    })
    expect(e).toEqual({
      at: '2026-11-23T01:00:00Z',
      kind: 'file-tool',
      tool: 'video_motion',
      ok: false,
      ms: 1200,
      tools: ['file_find', 'video_motion'],
    })
  })

  it('오류 글은 남기되 홈 폴더·이메일·긴 숫자를 가린다', () => {
    const e = reportEntry({
      at: 'x',
      kind: 'tool',
      error: `ENOENT ${homedir()}/Documents/a.txt kim@example.com 01012345678`,
    })
    expect(e.error).toContain('~/Documents')
    expect(e.error).not.toContain(homedir())
    expect(e.error).toContain('k***@example.com')
    expect(e.error).not.toContain('01012345678')
  })

  it('기록을 고르지 않으면 기록 없이, 메일은 맞는 모양만 담는다', () => {
    const ctx = {
      version: '0.3.1',
      agents: [{ id: 'claude' as const, installed: true, loggedIn: false, problem: '로그인이 필요해요' }],
      extension: { connected: true, version: '0.3.0' },
      entries: [{ at: 'a', kind: 'turn', ms: 10 }],
    }
    const p = buildReport({ text: '  로그인을 계속 하래요 ', contact: 'not-mail', includeLogs: false }, ctx)
    expect(p.text).toBe('로그인을 계속 하래요')
    expect(p.contact).toBeUndefined()
    expect(p.logs).toEqual([])
    expect(p.app.version).toBe('0.3.1')
    expect(p.agents[0]).toMatchObject({ id: 'claude', loggedIn: false })
    const q = buildReport({ text: 'x', contact: 'me@example.com', includeLogs: true }, ctx)
    expect(q.contact).toBe('me@example.com')
    expect(q.logs).toHaveLength(1)
  })

  it('보내고 받은 번호를 돌려주고, 실패는 알린다', async () => {
    const payload = buildReport(
      { text: 'x', includeLogs: false },
      { version: '0.3.1', agents: [], extension: {}, entries: [] },
    )
    const ok = (async () => new Response(JSON.stringify({ ok: true, id: 'A1B2' }))) as typeof fetch
    expect(await sendReport(payload, ok, 'https://example.com/r')).toEqual({ ok: true, id: 'A1B2' })
    const bad = (async () => new Response('{}', { status: 500 })) as typeof fetch
    expect((await sendReport(payload, bad, 'https://example.com/r')).ok).toBe(false)
  })
})
