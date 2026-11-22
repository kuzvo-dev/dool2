import { describe, expect, it } from 'vitest'
import { applyLook } from './doc-kit.js'

describe('문서 디자인 틀', () => {
  it('head가 있으면 그 안에 넣는다', () => {
    const out = applyLook(
      '<html><head><title>a</title></head><body><main class="page">x</main></body></html>',
      'report',
    )
    expect(out).toMatch(/<head><style data-dool2-look="report">/)
    expect(out).toContain('<title>a</title>')
  })
  it('조각만 쓰면 문서로 감싸고 .page 안에 둔다', () => {
    const out = applyLook('<div class="cover"><h1>보고서</h1></div>', 'notice')
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('<main class="page"><div class="cover"><h1>보고서</h1></div></main>')
    expect(out).toContain('data-dool2-look="notice"')
  })
  it('body는 있고 head가 없으면 body를 살린다', () => {
    const out = applyLook('<body><main class="page">본문</main></body>', 'letter')
    expect(out).toContain('<body><main class="page">본문</main></body>')
  })
})
