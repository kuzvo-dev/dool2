import { describe, expect, it } from 'vitest'
import { capResult, RESULT_CAP, textLength } from './result-cap.js'

const lines = (n: number, width = 60) =>
  Array.from({ length: n }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(width)}`).join('\n')
const res = (...texts: string[]) => ({ content: texts.map((text) => ({ type: 'text', text })) })
const textOf = (r: unknown) =>
  (r as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n')

describe('result cap', () => {
  it('leaves results that fit as they are', () => {
    const r = res('short')
    expect(capResult('browser/click', {}, r)).toEqual({ result: r })
    expect(capResult('task/start', {}, { ok: true })).toEqual({ result: { ok: true } })
  })

  it('cuts the longest part at a line end and says how much is left and how to read on', () => {
    const note = 'Pressed the button.'
    const page = lines(300)
    const { result, cut } = capResult('browser/click', {}, res(note, page, '⚠ a note after the page'))
    const out = textOf(result)
    expect(textLength(result as never)).toBeLessThanOrEqual(RESULT_CAP)
    expect(cut).toEqual({ chars: note.length + page.length + 23, cap: RESULT_CAP })
    expect(out).toContain(note)
    expect(out).toContain('⚠ a note after the page')
    expect(out).toContain('more characters were not shown. To read on, call browser_read with from')
    // Cut at a line end: the last kept line is whole
    const kept = out.split('\n\n(Cut here')[0]?.split('\n').at(-1) ?? ''
    expect(kept).toMatch(/^\d{4} x{60}$/)
  })

  it('gives more when the AI asked for more, up to what it asked', () => {
    const page = lines(300)
    expect(capResult('browser/read', { maxChars: 30_000 }, res(page)).cut).toBeUndefined()
    const { result } = capResult('browser/read', { maxChars: 10_000 }, res(page))
    expect(textLength(result as never)).toBeLessThanOrEqual(12_000)
    expect(textLength(result as never)).toBeGreaterThan(RESULT_CAP)
  })

  it('images do not count and stay', () => {
    const r = {
      content: [
        { type: 'image', data: 'x'.repeat(50_000), mimeType: 'image/png' },
        { type: 'text', text: 'ok' },
      ],
    }
    expect(capResult('browser/screenshot', {}, r).cut).toBeUndefined()
  })

  it('names the way to ask for less per tool group', () => {
    const big = res(lines(300))
    expect(textOf(capResult('service/call', {}, big).result)).toContain('offset')
    expect(textOf(capResult('mail/search', {}, big).result)).toContain('a narrower search')
  })
})
