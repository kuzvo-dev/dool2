import { BROWSER_HOST_NAME } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { keyDef, safeUrl } from './keys.js'

describe('키 입력', () => {
  it('키 이름과 별칭을 실제 키 값으로 바꾼다', () => {
    expect(keyDef('Enter')).toMatchObject({ key: 'Enter', keyCode: 13, text: '\r' })
    expect(keyDef('엔터')?.key).toBe('Enter')
    expect(keyDef('esc')?.key).toBe('Escape')
    expect(keyDef('pagedown')?.keyCode).toBe(34)
    expect(keyDef('F13')).toBeUndefined()
  })
})

describe('열어도 되는 주소', () => {
  it('http·https만 연다', () => {
    expect(safeUrl('https://www.naver.com')).toBe('https://www.naver.com/')
    expect(safeUrl('naver.com')).toBe('https://naver.com/')
    expect(safeUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeUrl('file:///etc/passwd')).toBeUndefined()
    expect(safeUrl('chrome://settings')).toBeUndefined()
    expect(safeUrl('data:text/html,hi')).toBeUndefined()
    expect(safeUrl('')).toBeUndefined()
    expect(safeUrl(3)).toBeUndefined()
  })
})

describe('호스트 이름', () => {
  it('본체가 등록하는 이름과 같다', async () => {
    // background.ts는 chrome API를 바로 써서 여기서 불러올 수 없다. 글자로 확인한다
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./background.ts', import.meta.url), 'utf8')
    expect(src).toContain(`export const HOST_NAME = '${BROWSER_HOST_NAME}'`)
  })

  it('manifest의 공개키에서 나온 id가 본체가 허용하는 id와 같다', async () => {
    const { readFileSync } = await import('node:fs')
    const { createHash } = await import('node:crypto')
    const { DEV_EXTENSION_ID } = await import('@dool2/protocol')
    const m = JSON.parse(readFileSync(new URL('../static/manifest.json', import.meta.url), 'utf8'))
    const hex = createHash('sha256').update(Buffer.from(m.key, 'base64')).digest('hex').slice(0, 32)
    const id = [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
    expect(id).toBe(DEV_EXTENSION_ID)
  })
})
