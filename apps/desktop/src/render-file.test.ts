// HTML을 그리는 보이지 않는 창이 불러도 되는 주소 (file_render)
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { allowedUrl } = await import('./render-file.js')

const req = {
  path: '/u/Documents/두리/a.html',
  to: 'pdf' as const,
  allowFile: (p: string) => p.startsWith('/u/Documents/'),
}

describe('그리기 창이 불러오는 것', () => {
  it('사용자 폴더 안의 로컬 파일과 data·blob만, 밖의 파일은 막는다', () => {
    expect(allowedUrl('file:///u/Documents/%EB%91%90%EB%A6%AC/a.html', 'GET', req)).toBe(true)
    expect(allowedUrl('file:///u/Documents/%EB%91%90%EB%A6%AC/%EC%82%AC%EC%A7%84.png', 'GET', req)).toBe(true)
    expect(allowedUrl('file:///etc/passwd', 'GET', req)).toBe(false)
    expect(allowedUrl('data:image/png;base64,AAAA', 'GET', req)).toBe(true)
    expect(allowedUrl('blob:file:///abc', 'GET', req)).toBe(true)
  })

  it('https 글꼴·그림(GET)만, http·보내기·이 PC·집 안 주소는 막는다', () => {
    expect(allowedUrl('https://fonts.gstatic.com/s/a.woff2', 'GET', req)).toBe(true)
    expect(allowedUrl('https://fonts.gstatic.com/s/a.woff2', 'POST', req)).toBe(false)
    expect(allowedUrl('http://example.com/a.png', 'GET', req)).toBe(false)
    expect(allowedUrl('https://localhost:8787/api', 'GET', req)).toBe(false)
    expect(allowedUrl('https://127.0.0.1/api', 'GET', req)).toBe(false)
    expect(allowedUrl('https://192.168.0.1/', 'GET', req)).toBe(false)
    expect(allowedUrl('https://[::1]/', 'GET', req)).toBe(false)
    expect(allowedUrl('https://printer.local/', 'GET', req)).toBe(false)
    expect(allowedUrl('wss://example.com/', 'GET', req)).toBe(false)
  })

  it('그리는 중이 아니면 아무것도 불러오지 않는다', () => {
    expect(allowedUrl('https://fonts.gstatic.com/a.woff2', 'GET', undefined)).toBe(false)
  })
})
