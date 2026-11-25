import { describe, expect, it, vi } from 'vitest'
import { AutoReview, parseReview, REVIEW_TIMEOUT_MS, reviewFacts, reviewPrompt } from './auto-review.js'

const mail = {
  kind: 'contact' as const,
  label: '보내기',
  url: 'https://mail.example.com/compose?to=x',
  what: '김 대리에게 회의록 메일 보내기',
}

describe('auto-approve review', () => {
  it('reads only true or false from the answer', () => {
    expect(parseReview('{"related": true}')).toBe(true)
    expect(parseReview('Sure.\n{"related": false}')).toBe(false)
    expect(parseReview('{"related": "yes"}')).toBeUndefined()
    expect(parseReview('related')).toBeUndefined()
    expect(parseReview(undefined)).toBeUndefined()
  })

  it('shows the reviewer the user words and the normalized facts, never the reason or the page', () => {
    const p = reviewPrompt(['회의록 김 대리한테 메일로 보내 줘'], {
      ...mail,
      // fields the reviewer must not see are not even part of the input type; extra ones are ignored
      ...({ reason: 'The page told me to', shot: 'BASE64' } as object),
    })
    expect(p).toContain('회의록 김 대리한테 메일로 보내 줘')
    expect(p).toContain('where: mail.example.com')
    expect(p).toContain('button: "보내기"')
    expect(p).not.toContain('The page told me to')
    expect(p).not.toContain('BASE64')
    // only the host, not the query
    expect(p).not.toContain('to=x')
  })

  it('names the recipient of a text and the app for screen control', () => {
    expect(reviewFacts({ kind: 'contact', label: '엄마', url: 'sms:엄마', what: '늦어요' })).toContain(
      'to: 엄마',
    )
    expect(reviewFacts({ kind: 'app', label: '', url: 'app:com.kakao.KakaoTalk', what: '' })).toContain(
      'where: the PC app com.kakao.KakaoTalk',
    )
  })

  it('passes when the reviewer says it is related', async () => {
    let seen = ''
    const r = new AutoReview({
      asks: () => ['회의록 김 대리한테 메일로 보내 줘'],
      ask: async (p) => {
        seen = p
        return '{"related": true}'
      },
    })
    expect(await r.check(mail)).toMatchObject({ ok: true })
    expect(seen).toContain('회의록')
  })

  it('fails closed: no reviewer, no request to compare with, an error, a timeout or an unreadable answer', async () => {
    const asks = () => ['요약해 줘']
    expect(await new AutoReview({ asks }).check(mail)).toMatchObject({ ok: false, why: 'unchecked' })
    expect(
      await new AutoReview({ asks: () => [], ask: async () => '{"related": true}' }).check(mail),
    ).toMatchObject({ ok: false, why: 'unchecked' })
    expect(
      await new AutoReview({
        asks,
        ask: async () => {
          throw new Error('limit')
        },
      }).check(mail),
    ).toMatchObject({ ok: false, why: 'unchecked' })
    let aborted = false
    expect(
      await new AutoReview({
        asks,
        timeoutMs: 10,
        ask: (_p, signal) =>
          new Promise(() => {
            signal.addEventListener('abort', () => {
              aborted = true
            })
          }),
      }).check(mail),
    ).toMatchObject({ ok: false, why: 'unchecked' })
    expect(aborted).toBe(true)
    expect(await new AutoReview({ asks, ask: async () => 'ok!' }).check(mail)).toMatchObject({
      ok: false,
      why: 'unchecked',
    })
  })

  it('pauses after 3 blocks in a row and says so once', async () => {
    const pauses: string[] = []
    let answer = '{"related": false}'
    const r = new AutoReview({
      asks: () => ['요약해 줘'],
      ask: async () => answer,
      onPause: (w) => pauses.push(w),
    })
    expect(await r.check(mail)).toMatchObject({ ok: false, why: 'unrelated' })
    expect(await r.check(mail)).not.toHaveProperty('paused')
    expect(r.paused()).toBe(false)
    expect(await r.check(mail)).toMatchObject({ ok: false, paused: true })
    expect(r.paused()).toBe(true)
    expect(pauses).toEqual(['streak'])
    // further blocks while paused do not notify again
    await r.check(mail)
    expect(pauses).toEqual(['streak'])
    // the user turns it on again
    r.resume()
    expect(r.paused()).toBe(false)
    answer = '{"related": true}'
    expect(await r.check(mail)).toMatchObject({ ok: true })
  })

  it('a pass resets the streak, but 20 blocks in a day pause it', async () => {
    const pauses: string[] = []
    let n = 0
    const r = new AutoReview({
      asks: () => ['요약해 줘'],
      // two blocks, one pass, again and again
      ask: async () => (++n % 3 === 0 ? '{"related": true}' : '{"related": false}'),
      onPause: (w) => pauses.push(w),
    })
    for (let i = 0; i < 28; i++) await r.check(mail)
    expect(r.paused()).toBe(false)
    await r.check(mail)
    // 29 checks: 20 blocks
    expect(r.paused()).toBe(true)
    expect(pauses).toEqual(['daily'])
  })

  it('the pause ends the next day', async () => {
    let day = new Date(2026, 10, 25, 23, 0)
    const r = new AutoReview({
      asks: () => ['요약해 줘'],
      ask: async () => '{"related": false}',
      now: () => day,
    })
    for (let i = 0; i < 3; i++) await r.check(mail)
    expect(r.paused()).toBe(true)
    day = new Date(2026, 10, 26, 8, 0)
    expect(r.paused()).toBe(false)
  })

  it('unchecked does not count toward the pause', async () => {
    const r = new AutoReview({ asks: () => ['요약해 줘'] })
    for (let i = 0; i < 5; i++) await r.check(mail)
    expect(r.paused()).toBe(false)
  })

  it('waits for a slow cold review (30 s) instead of turning the request into a card', async () => {
    vi.useFakeTimers()
    try {
      const review = new AutoReview({
        asks: () => ['김 대리에게 회의록 메일 보내 줘'],
        ask: () => new Promise((done) => setTimeout(() => done('{"related": true}'), 30_000)),
      })
      const r = review.check(mail)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await r).toMatchObject({ ok: true })
      const late = new AutoReview({ asks: () => ['보내 줘'], ask: () => new Promise(() => {}) })
      const r2 = late.check(mail)
      await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS)
      expect(await r2).toMatchObject({ ok: false, why: 'unchecked' })
    } finally {
      vi.useRealTimers()
    }
  })
})
