import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Journal, scrubText, scrubUrl } from './journal.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dool2-journal-'))
const at = (iso: string) => () => new Date(iso)

describe('일한 기록', () => {
  it('날마다 파일 하나에 한 줄씩 남기고 다시 읽는다', () => {
    const dir = tmp()
    const j = new Journal(dir, { now: at('2026-11-18T03:00:00Z') })
    j.write('connect-start', { id: 'kurly', how: 'login' })
    j.write('connect-end', { id: 'kurly', ok: false, reason: 'unknown', ms: 12_300 })
    j.write('tool', { tool: 'kurly_search', outcome: 'ok' })
    j.stop()
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    expect(j.read().map((e) => e.kind)).toEqual(['connect-start', 'connect-end', 'tool'])
    expect(j.read({ kind: 'connect' })).toHaveLength(2)
    expect(j.read({ kind: 'connect', limit: 1 })[0]).toMatchObject({ id: 'kurly', ok: false, ms: 12_300 })
    // 그림 파일 이름은 가리지 않는다 (기록에서 그림을 찾아갈 수 있게)
    const shot = j.shot('kurly', Buffer.from('x').toString('base64'))
    j.write('connect-screen', { id: 'kurly', shot })
    expect(j.read({ kind: 'connect-screen' })[0]?.shot).toBe(shot)
    expect(existsSync(join(dir, 'shots', shot as string))).toBe(true)
    // 시각(t)도 그대로
    j.write('phone-trail', { t: '2026-11-18T02:50:32.085Z', what: '탭 ideas' })
    expect(j.read({ kind: 'phone-trail' })[0]?.t).toBe('2026-11-18T02:50:32.085Z')
  })

  it('비밀번호·인증번호 칸은 값을 적지 않고, 글에 섞인 이메일·긴 숫자는 가린다', () => {
    const dir = tmp()
    const j = new Journal(dir, { now: at('2026-11-18T03:00:00Z') })
    j.write('note', {
      password: 's3cret!',
      otp: '482913',
      nested: { token: 'abc', text: '문의는 hong.gildong@example.com 또는 010-1234-5678로, 주문 3건' },
    })
    j.stop()
    const raw = readFileSync(join(dir, '2026-11-18.jsonl'), 'utf8')
    expect(raw).not.toContain('s3cret!')
    expect(raw).not.toContain('482913')
    expect(raw).not.toContain('abc')
    expect(raw).not.toContain('hong.gildong')
    expect(raw).not.toContain('1234')
    expect(raw).toContain('h***@example.com')
    expect(raw).toContain('주문 3건')
  })

  it('주소는 물음표 뒤를 떼고 남긴다', () => {
    expect(scrubUrl('https://login.shop.example/auth?token=abc&next=%2Fmy')).toBe(
      'https://login.shop.example/auth',
    )
    expect(scrubUrl('주소 아님')).toBe('')
    expect(scrubText('가'.repeat(900)).length).toBe(400)
  })

  it('며칠 지난 기록과 그림은 지운다 (글 7일, 그림 3일)', () => {
    const dir = tmp()
    const old = new Journal(dir, { now: at('2026-11-10T03:00:00Z') })
    old.write('note', { text: '여드레 전' })
    old.stop()
    const mid = new Journal(dir, { now: at('2026-11-14T03:00:00Z') })
    mid.write('note', { text: '나흘 전' })
    const oldShot = mid.shot('kurly', Buffer.from('old').toString('base64'))
    mid.stop()
    // 그림 파일의 시각을 나흘 전으로
    const past = new Date('2026-11-14T03:00:00Z')
    utimesSync(join(dir, 'shots', oldShot as string), past, past)

    const now = at('2026-11-18T03:00:00Z')
    const j = new Journal(dir, { now })
    const fresh = j.shot('gmail', Buffer.from('new').toString('base64'))
    const today = new Date('2026-11-18T03:00:00Z')
    utimesSync(join(dir, 'shots', fresh as string), today, today)
    j.prune()
    j.stop()
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files).toEqual(['2026-11-14.jsonl'])
    expect(readdirSync(join(dir, 'shots'))).toEqual([fresh])
  })

  it('크기 한도를 넘으면 오래된 것부터 지우고, 오늘 기록은 남긴다', () => {
    const dir = tmp()
    writeFileSync(join(dir, '2026-11-16.jsonl'), `${'x'.repeat(600)}\n`)
    writeFileSync(join(dir, '2026-11-17.jsonl'), `${'y'.repeat(600)}\n`)
    const j = new Journal(dir, { now: at('2026-11-18T03:00:00Z'), maxBytes: 900 })
    j.write('note', { text: '오늘' })
    j.prune()
    j.stop()
    expect(existsSync(join(dir, '2026-11-16.jsonl'))).toBe(false)
    expect(existsSync(join(dir, '2026-11-18.jsonl'))).toBe(true)
  })

  it('폴더를 주지 않으면 아무것도 남기지 않는다', () => {
    const j = new Journal()
    j.write('note', { text: 'x' })
    expect(j.shot('a', 'AAAA')).toBeUndefined()
    expect(j.read()).toEqual([])
  })
})
