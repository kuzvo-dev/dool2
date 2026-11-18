import { describe, expect, it } from 'vitest'
import { Thumbs, thumbAllowed } from './thumbs.js'

describe('카드 사진', () => {
  it('https 바깥 주소만 받는다 (IP·localhost·내부 이름은 받지 않는다)', () => {
    expect(thumbAllowed('https://thumbnail.coupangcdn.com/a.jpg')).toBe(true)
    expect(thumbAllowed('http://thumbnail.coupangcdn.com/a.jpg')).toBe(false)
    expect(thumbAllowed('https://127.0.0.1/a.jpg')).toBe(false)
    expect(thumbAllowed('https://192.168.0.10/a.jpg')).toBe(false)
    expect(thumbAllowed('https://[::1]/a.jpg')).toBe(false)
    expect(thumbAllowed('https://localhost/a.jpg')).toBe(false)
    expect(thumbAllowed('https://nas.local/a.jpg')).toBe(false)
    expect(thumbAllowed('https://router/a.jpg')).toBe(false)
    expect(thumbAllowed('https://user:pw@cdn.example.com/a.jpg')).toBe(false)
  })

  it('그림이면 data: 주소로, 그림이 아니거나 크면 받지 않고, 같은 주소는 한 번만 받는다', async () => {
    let calls = 0
    const fake = (async (url: string) => {
      calls++
      if (url.endsWith('big.jpg'))
        return new Response(new Uint8Array(1_000_000), { headers: { 'content-type': 'image/jpeg' } })
      if (url.endsWith('page.html'))
        return new Response('<html>', { headers: { 'content-type': 'text/html' } })
      if (url.endsWith('x.svg'))
        return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    }) as typeof fetch
    const t = new Thumbs(fake)
    expect(await t.get('https://cdn.example.com/a.png')).toBe('data:image/png;base64,AQID')
    expect(await t.get('https://cdn.example.com/a.png')).toBe('data:image/png;base64,AQID')
    expect(calls).toBe(1)
    expect(await t.get('https://cdn.example.com/big.jpg')).toBeUndefined()
    expect(await t.get('https://cdn.example.com/page.html')).toBeUndefined()
    expect(await t.get('https://cdn.example.com/x.svg')).toBeUndefined()
    expect(await t.get('https://10.0.0.1/a.png')).toBeUndefined()
  })
  it('브라우저가 줄여 주면 그걸 쓰고, 안 되면 본체가 직접 받는다', async () => {
    const fake = (async () =>
      new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } })) as typeof fetch
    const viaBrowser = new Thumbs(fake, async () => 'data:image/jpeg;base64,AAA')
    expect(await viaBrowser.get('https://cdn.example.com/b.png')).toBe('data:image/jpeg;base64,AAA')
    const noBrowser = new Thumbs(fake, async () => {
      throw new Error('예전 확장')
    })
    expect(await noBrowser.get('https://cdn.example.com/b.png')).toBe('data:image/png;base64,CQ==')
  })
})
