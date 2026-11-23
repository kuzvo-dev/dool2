// Card pictures: so the phone and PC screens never connect to outside servers directly, the daemon fetches and passes them as data: addresses.
// - https addresses only; IP addresses, localhost and internal names are refused (so the daemon cannot become a path to home devices)
// - Only image types (jpeg, png, webp, gif, avif), up to 900KB, waiting up to 6 seconds. svg is refused
// - The same address is remembered (last 300 pictures)

const TYPES = /^image\/(jpeg|png|webp|gif|avif)$/
const MAX_BYTES = 900_000
const KEEP = 300

/** Whether the address may be fetched: https, a public address given by name */
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
  // IP addresses (v4 and v6) are refused: CDNs always come by name
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h.includes(':')) return false
  return true
}

/** Fetch and shrink through the browser (Doori extension): the site does not block it, and it becomes a JPEG of 360px on the long edge */
export type ThumbShrinker = (url: string) => Promise<string | undefined>

export class Thumbs {
  private readonly cache = new Map<string, Promise<string | undefined>>()

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly shrink?: ThumbShrinker,
  ) {}

  get(url: string): Promise<string | undefined> {
    if (!thumbAllowed(url)) return Promise.resolve(undefined)
    const hit = this.cache.get(url)
    if (hit) {
      // Move the recently used one to the back (the least recently used is dropped first)
      this.cache.delete(url)
      this.cache.set(url, hit)
      return hit
    }
    // If a browser is connected, fetch and shrink there; if that fails, the daemon fetches it as is
    const p = (this.shrink ? this.shrink(url).catch(() => undefined) : Promise.resolve(undefined))
      .then((v) => v ?? this.load(url))
      .catch(() => undefined)
    this.cache.set(url, p)
    // Failures are not remembered (if it was a brief outage, try again next time)
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
    // If redirected elsewhere, that address gets the same check
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
