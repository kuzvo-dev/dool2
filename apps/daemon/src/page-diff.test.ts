import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lineOps, pageDiff } from './page-diff.js'

/** Snapshots of a made-up shop (test data) in the extension's page text format */
const page = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'pages', `${name}.txt`), 'utf8').trimEnd()
const URL = 'https://shop.example/item/1'
const seen = (text: string, truncated = false) => ({ url: URL, text, truncated })
const now = (text: string, truncated = false, url = URL) => ({ url, text, truncated })

describe('pageDiff', () => {
  it('an opened option list gives only the new lines, under their heading', () => {
    const d = pageDiff(seen(page('product')), now(page('product-options-open'))) ?? { text: '', changed: -1 }
    expect(d.changed).toBe(5)
    expect(d.text).toContain('… under ## 옵션 선택')
    expect(d.text).toContain('[e200 선택지 "미드나잇 블랙"]')
    expect(d.text).toContain('[e203 선택지 "선셋 오렌지 (품절)"]')
    expect(d.text).toContain('(gone) 색상 [e15 선택 상자 "색상을 선택해 주세요"]')
    // Lines that did not change are not repeated
    expect(d.text).not.toContain('[e20 버튼 "장바구니 담기"]')
    expect(d.text.length).toBeLessThan(page('product-options-open').length / 5)
  })

  it('adding to the cart shows the message and the new count in two places', () => {
    const d = pageDiff(seen(page('product-option-chosen')), now(page('product-added-to-cart')))
    expect(d?.text).toContain('[e6 링크 "장바구니 1"]')
    expect(d?.text).toContain('장바구니에 상품을 담았어요.')
    expect(d?.text.match(/^…/gm)).toHaveLength(2)
  })

  it('typing shows the suggestions that appeared', () => {
    const d = pageDiff(seen(page('product')), now(page('product-search-typed')))
    expect(d?.text).toContain('값="무선 청소"')
    expect(d?.text).toContain('[e207 링크 "무선 청소기"]')
  })

  it('nothing changed: empty text and no changed lines', () => {
    expect(pageDiff(seen(page('product')), now(page('product')))).toEqual({
      lines: page('product').split('\n').length,
      changed: 0,
      text: '',
    })
  })

  it('another address gives the whole page', () => {
    expect(
      pageDiff(seen(page('product')), now(page('cart'), false, 'https://shop.example/cart')),
    ).toBeUndefined()
  })

  it('a page whose lines mostly changed at the same address gives the whole page', () => {
    expect(pageDiff(seen(page('product')), now(page('cart')))).toBeUndefined()
  })

  it('a redrawn half of the page (reviews sorted) gives the whole page', () => {
    expect(pageDiff(seen(page('product')), now(page('product-reviews-sorted')))).toBeUndefined()
  })

  it('many gone lines are shown three at a time and counted', () => {
    const lines = page('product').split('\n')
    const at = lines.indexOf('## 리뷰 (1,284)') + 2
    const d = pageDiff(
      seen(lines.join('\n')),
      now([...lines.slice(0, at), ...lines.slice(at + 6)].join('\n')),
    )
    expect(d?.changed).toBe(0)
    expect(d?.text.match(/^\(gone\) /gm)).toHaveLength(4)
    expect(d?.text).toContain('(gone) … 3 more lines')
  })

  it('a diff nearly as long as the page gives the whole page', () => {
    const a = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const b = a.replace('line 3', 'line three').replace('line 6', 'line six').replace('line 8', 'line eight')
    // 3 of 10 lines changed is under half, but the diff text is longer than most of the page
    expect(pageDiff(seen(a), now(b))).toBeUndefined()
  })

  it('lines pushed below the size limit by lines added above are not reported as gone', () => {
    const full = page('product').split('\n')
    const cut = (lines: string[]) => lines.join('\n').slice(0, 2_000)
    const before = cut(full)
    const after = cut([...full.slice(0, 2), '[e300 링크 "오늘만 특가 보러 가기"]', ...full.slice(2)])
    const d = pageDiff(seen(before, true), now(after, true))
    expect(d?.changed).toBe(1)
    expect(d?.text).toContain('[e300 링크 "오늘만 특가 보러 가기"]')
    expect(d?.text).not.toContain('(gone)')
  })

  it('lines past the earlier size limit count as new', () => {
    const full = page('product')
    const d = pageDiff(seen(full.slice(0, 2_000), true), now(full))
    expect(d?.changed).toBeGreaterThan(0)
    expect(d?.text).not.toContain('(gone)')
  })
})

describe('lineOps', () => {
  it('keeps the order of both pages', () => {
    const ops = lineOps(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']) ?? []
    expect(ops.map((o) => o.kind)).toEqual(['same', 'add', 'gone', 'same', 'same', 'add'])
  })

  it('gives up on pages too big to compare', () => {
    const a = Array.from({ length: 2_000 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 2_000 }, (_, i) => `b${i}`)
    expect(lineOps(a, b)).toBeUndefined()
  })
})
