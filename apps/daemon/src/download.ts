// File download (ADR 0024 addendum): an https address into the Downloads folder. Internal addresses (this PC, home router) are refused.
// Executables (.exe .dmg .pkg .app, scripts...) need approval before downloading. Downloaded files get a browser-style
// "downloaded from the internet" mark so the OS asks once more when they are opened (macOS quarantine, Windows Zone.Identifier)
import { lookup } from 'node:dns/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, extname } from 'node:path'
import { cleanName, freeName } from './file-names.js'
import type { Exec } from './file-ops.js'

/** Files that need approval before downloading (opening them runs a program) */
export const EXEC_EXT =
  /\.(exe|msi|msix|appx|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|lnk|reg|jar|dmg|pkg|mpkg|app|command|tool|sh|bash|zsh|csh|py|rb|pl|apk|deb|rpm|appimage|workflow)$/i

/** Largest size we download (bigger is refused) */
export const DOWNLOAD_MAX = 2 * 1024 ** 3

/** Addresses on this PC or the home network (router admin pages etc.): Doori does not fetch them */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  const v = ip.toLowerCase()
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7))
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v)
}

/** Whether the address can be fetched: https, no user info, public internet address. If not, the reason */
export async function checkUrl(raw: string, resolve = lookup): Promise<URL | string> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'That is not an address. Give an address that starts with https://.'
  }
  if (u.protocol !== 'https:')
    return 'Only https:// addresses are downloaded (unencrypted ones can be altered on the way).'
  if (u.username || u.password) return 'Addresses that contain a username or password are not downloaded.'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host))
    return 'Addresses on this PC or the home network are not downloaded.'
  const ips = isIP(host)
    ? [host]
    : await resolve(host, { all: true })
        .then((r) => r.map((x) => x.address))
        .catch(() => [] as string[])
  if (!ips.length) return `Could not find ${host}. Check that the address is right.`
  if (ips.some(privateAddress)) return 'Addresses on this PC or the home network are not downloaded.'
  return u
}

/** File name from Content-Disposition (filename*=UTF-8''... first) */
export function dispositionName(h: string | null): string | undefined {
  if (!h) return undefined
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h)?.[1]
  if (star)
    try {
      return decodeURIComponent(star.trim().replace(/^"|"$/g, ''))
    } catch {}
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(h)
  const v = (plain?.[2] ?? plain?.[1])?.trim()
  if (!v) return undefined
  // Some Korean sites send raw UTF-8 bytes (undo the latin1 reading)
  const fixed = Buffer.from(v, 'latin1').toString('utf8')
  return fixed.includes('�') ? v : fixed
}

/** Name at the end of the address */
export function urlName(u: URL): string {
  const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

export interface DownloadDeps {
  exec: Exec
  platform: NodeJS.Platform
  fetch?: typeof fetch
  resolve?: typeof lookup
  /** How long to wait for the result. Past that, the download continues in the background and we answer "downloading" */
  waitMs?: number
}

export type DownloadStart =
  | { kind: 'fail'; text: string }
  | { kind: 'exec'; name: string; host: string; size?: number }
  | { kind: 'done'; text: string }

/**
 * Download. Unless approved, executables are not downloaded and { kind: 'exec' } is returned (ask for approval).
 * If it takes long, it continues in the background and returns "downloading"
 */
export async function download(
  dir: string,
  raw: string,
  o: { name?: string; approved?: boolean; show: (p: string) => string },
  deps: DownloadDeps,
): Promise<DownloadStart> {
  const f = deps.fetch ?? fetch
  let url = await checkUrl(raw, deps.resolve)
  if (typeof url === 'string') return { kind: 'fail', text: url }
  // Follow redirects ourselves and re-check every address
  let res: Response | undefined
  const ac = new AbortController()
  for (let hop = 0; hop < 6; hop++) {
    res = await f(url, {
      redirect: 'manual',
      signal: ac.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (dool2)', accept: '*/*' },
    }).catch((e: Error) => {
      throw new Error(`Could not download: ${e.message}`)
    })
    if (res.status < 300 || res.status >= 400) break
    const next = res.headers.get('location')
    await res.body?.cancel().catch(() => undefined)
    if (!next) return { kind: 'fail', text: 'The site redirected but gave no address.' }
    const checked = await checkUrl(new URL(next, url).toString(), deps.resolve)
    if (typeof checked === 'string')
      return { kind: 'fail', text: `The redirect address was not downloaded: ${checked}` }
    url = checked
    res = undefined
  }
  if (!res) return { kind: 'fail', text: 'The site redirected too many times.' }
  const stop = () => {
    ac.abort()
    void res?.body?.cancel().catch(() => undefined)
  }
  const browserHint =
    ' If the file needs a login, open the page with browser_open and press its download button with browser_click; Chrome saves it to the Downloads folder.'
  if (res.status === 401 || res.status === 403) {
    stop()
    return { kind: 'fail', text: `The site blocked the download (${res.status}).${browserHint}` }
  }
  if (res.status === 404 || res.status === 410) {
    stop()
    return { kind: 'fail', text: 'There is no file at that address (deleted or wrong address).' }
  }
  if (!res.ok) {
    stop()
    return { kind: 'fail', text: `The site did not give the file (${res.status}).${browserHint}` }
  }
  const type = res.headers.get('content-type') ?? ''
  const fromHeader = dispositionName(res.headers.get('content-disposition'))
  if (!fromHeader && /text\/html/i.test(type)) {
    stop()
    return {
      kind: 'fail',
      text: `This address is a web page, not a file (it may be a login screen).${browserHint} If you need the page content, read it with browser_read.`,
    }
  }
  const size = Number(res.headers.get('content-length')) || undefined
  if (size && size > DOWNLOAD_MAX) {
    stop()
    return {
      kind: 'fail',
      text: `At ${(size / (1 << 30)).toFixed(1)}GB it is too big (up to 2GB). Downloading it in the browser instead (its download button or link) has no size limit.`,
    }
  }
  // Name: given by the user (extension from the site) > given by the site > end of the address
  const site = cleanName(fromHeader ?? urlName(url)) || 'download'
  const ext = extname(site)
  let name = o.name ? cleanName(o.name) : site
  if (o.name && ext && extname(name).toLowerCase() !== ext.toLowerCase()) name += ext
  if (!name) name = site
  if (!o.approved && (EXEC_EXT.test(name) || EXEC_EXT.test(site))) {
    stop()
    return { kind: 'exec', name, host: url.host, ...(size ? { size } : {}) }
  }
  await mkdir(dir, { recursive: true })
  const target = freeName(dir, name)
  const part = `${target}.dool2-downloading`
  const body = res.body
  if (!body) return { kind: 'fail', text: 'The site sent an empty file.' }
  let got = 0
  const work = (async () => {
    const out = createWriteStream(part, { flags: 'wx' })
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length
        if (got > DOWNLOAD_MAX) throw new Error('Stopped: over 2GB')
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
      // If the same name appeared meanwhile, add a number (never overwrite)
      const final = existsSync(target) ? freeName(dir, name) : target
      await rename(part, final)
      await markFromInternet(final, url as URL, deps)
      return final
    } catch (e) {
      out.destroy()
      await rm(part, { force: true })
      throw e
    }
  })()
  const wait = deps.waitMs ?? 60_000
  const r = await Promise.race([
    work.then((p) => ({ p }) as const).catch((e: Error) => ({ e }) as const),
    new Promise<'later'>((res2) => setTimeout(() => res2('later'), wait).unref()),
  ])
  if (r === 'later') {
    work.catch(() => undefined)
    const pct = size ? ` ${Math.floor((got / size) * 100)}%` : ''
    return {
      kind: 'done',
      text: `Still downloading${pct}. When done it will be at ${o.show(target)} (meanwhile it is "${basename(part)}"). Check with file_find in a moment.`,
    }
  }
  if ('e' in r) return { kind: 'fail', text: `Download stopped: ${r.e.message}` }
  const mb = got > 1 << 20 ? `${(got / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(got / 1024))}KB`
  return {
    kind: 'done',
    text: `Downloaded: ${o.show(r.p)} (${mb}). Tell the user this location. To open it, use file_read.`,
  }
}

/** Browser-style "downloaded from the internet" mark: macOS/Windows ask once more when it is opened */
async function markFromInternet(p: string, url: URL, deps: DownloadDeps) {
  if (deps.platform === 'darwin') {
    const t = Math.floor(Date.now() / 1000).toString(16)
    await deps.exec('xattr', ['-w', 'com.apple.quarantine', `0081;${t};dool2;`, p]).catch(() => undefined)
  } else if (deps.platform === 'win32') {
    await writeFile(`${p}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url.origin}/\r\n`).catch(
      () => undefined,
    )
  }
}
