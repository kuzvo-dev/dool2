// 카드 사진: 폰·PC 화면이 바깥 서버에 직접 붙지 않게 본체가 대신 받아 data: 주소로 넘긴다.
// - https 주소만, IP 주소·localhost·내부 이름은 받지 않는다 (본체가 집 안 기기에 붙는 길이 되지 않게)
// - 그림 종류(jpeg·png·webp·gif·avif)만, 900KB까지, 6초까지 기다린다. svg는 받지 않는다
// - 같은 주소는 기억해 둔다 (최근 300장)

const TYPES = /^image\/(jpeg|png|webp|gif|avif)$/
const MAX_BYTES = 900_000
const KEEP = 300

/** 받아도 되는 주소인가: https, 이름으로 된 바깥 주소 */
export function thumbAllowed(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const h = u.hostname.toLowerCase()
  if (!h.includes('.') || h === 'localhost' || /\.(local|localhost|internal|lan|home|arpa)$/.test(h))
    return false
  // IP 주소(4·6)는 받지 않는다: CDN은 늘 이름으로 온다
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h.includes(':')) return false
  return true
}

export class Thumbs {
  private readonly cache = new Map<string, Promise<string | undefined>>()

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  get(url: string): Promise<string | undefined> {
    if (!thumbAllowed(url)) return Promise.resolve(undefined)
    const hit = this.cache.get(url)
    if (hit) {
      // 최근에 쓴 것을 뒤로 (오래 안 쓴 것부터 지운다)
      this.cache.delete(url)
      this.cache.set(url, hit)
      return hit
    }
    const p = this.load(url).catch(() => undefined)
    this.cache.set(url, p)
    // 못 받은 것은 기억하지 않는다 (잠깐 끊겼다면 다음에 다시)
    void p.then((v) => {
      if (v === undefined) this.cache.delete(url)
    })
    while (this.cache.size > KEEP) {
      const first = this.cache.keys().next().value
      if (first === undefined) break
      this.cache.delete(first)
    }
    return p
  }

  private async load(url: string): Promise<string | undefined> {
    const res = await this.fetcher(url, {
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
      headers: { accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8' },
    })
    // 다른 곳으로 넘겨졌으면 그 주소도 같은 규칙으로 본다
    if (!res.ok || (res.url && !thumbAllowed(res.url))) return undefined
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!TYPES.test(type)) return undefined
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_BYTES) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return undefined
    return `data:${type};base64,${buf.toString('base64')}`
  }
}
