// 파일 내려받기 (ADR 0024 추가): https 주소를 다운로드 폴더로. 이 PC 안·집 공유기 같은 내부 주소는 받지 않는다.
// 실행 파일(.exe .dmg .pkg .app 스크립트…)은 받기 전에 승인. 받은 파일에는 브라우저처럼 "인터넷에서 받음" 표시를 붙여
// 열 때 운영체제가 한 번 더 확인하게 한다(맥 quarantine, 윈도우 Zone.Identifier)
import { lookup } from 'node:dns/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, extname } from 'node:path'
import { cleanName, freeName } from './file-names.js'
import type { Exec } from './file-ops.js'

/** 받기 전에 승인하는 파일 (열면 프로그램이 도는 것) */
export const EXEC_EXT =
  /\.(exe|msi|msix|appx|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|lnk|reg|jar|dmg|pkg|mpkg|app|command|tool|sh|bash|zsh|csh|py|rb|pl|apk|deb|rpm|appimage|workflow)$/i

/** 받을 수 있는 크기 (넘으면 받지 않는다) */
export const DOWNLOAD_MAX = 2 * 1024 ** 3

/** 이 PC·집 안 네트워크 주소 (공유기 관리 화면 등): 두리가 대신 받지 않는다 */
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

/** 주소를 받을 수 있는지: https, 사용자 정보 없음, 바깥 인터넷 주소. 안 되면 이유 */
export async function checkUrl(raw: string, resolve = lookup): Promise<URL | string> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return '주소 모양이 아니에요. https://로 시작하는 주소를 주세요.'
  }
  if (u.protocol !== 'https:') return 'https:// 주소만 받아요(암호화되지 않은 주소는 중간에 바뀔 수 있어요).'
  if (u.username || u.password) return '주소 안에 아이디·비밀번호가 든 주소는 받지 않아요.'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host))
    return '이 PC나 집 안 네트워크 주소는 받지 않아요.'
  const ips = isIP(host)
    ? [host]
    : await resolve(host, { all: true })
        .then((r) => r.map((x) => x.address))
        .catch(() => [] as string[])
  if (!ips.length) return `${host} 주소를 찾지 못했어요. 주소가 맞는지 확인해 주세요.`
  if (ips.some(privateAddress)) return '이 PC나 집 안 네트워크 주소는 받지 않아요.'
  return u
}

/** Content-Disposition의 파일 이름 (filename*=UTF-8''… 먼저) */
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
  // 한국 사이트는 UTF-8 바이트를 그대로 보내기도 한다 (latin1로 읽힌 것을 되돌린다)
  const fixed = Buffer.from(v, 'latin1').toString('utf8')
  return fixed.includes('�') ? v : fixed
}

/** 주소 끝의 이름 */
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
  /** 결과를 기다리는 시간. 넘으면 뒤에서 이어 받고 "받는 중"으로 답한다 */
  waitMs?: number
}

export type DownloadStart =
  | { kind: 'fail'; text: string }
  | { kind: 'exec'; name: string; host: string; size?: number }
  | { kind: 'done'; text: string }

/**
 * 받기. approved가 아니면 실행 파일은 받지 않고 { kind: 'exec' }로 알린다(승인을 받으라고).
 * 오래 걸리면 뒤에서 이어 받고 "받는 중"을 돌려준다
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
  // 넘겨주기(redirect)는 직접 따라가며 주소마다 다시 확인한다
  let res: Response | undefined
  const ac = new AbortController()
  for (let hop = 0; hop < 6; hop++) {
    res = await f(url, {
      redirect: 'manual',
      signal: ac.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (dool2)', accept: '*/*' },
    }).catch((e: Error) => {
      throw new Error(`받지 못했어요: ${e.message}`)
    })
    if (res.status < 300 || res.status >= 400) break
    const next = res.headers.get('location')
    await res.body?.cancel().catch(() => undefined)
    if (!next) return { kind: 'fail', text: '사이트가 다른 주소로 보냈는데 그 주소가 없어요.' }
    const checked = await checkUrl(new URL(next, url).toString(), deps.resolve)
    if (typeof checked === 'string') return { kind: 'fail', text: `넘겨준 주소를 받지 않았어요: ${checked}` }
    url = checked
    res = undefined
  }
  if (!res) return { kind: 'fail', text: '사이트가 너무 여러 번 다른 주소로 보냈어요.' }
  const stop = () => {
    ac.abort()
    void res?.body?.cancel().catch(() => undefined)
  }
  const browserHint =
    ' 로그인해야 받는 파일이면 browser_open으로 그 페이지를 열어 다운로드 버튼을 browser_click으로 누르면 Chrome이 다운로드 폴더에 받아요.'
  if (res.status === 401 || res.status === 403) {
    stop()
    return { kind: 'fail', text: `사이트가 받기를 막았어요(${res.status}).${browserHint}` }
  }
  if (res.status === 404 || res.status === 410) {
    stop()
    return { kind: 'fail', text: '그 주소에 파일이 없어요(지워졌거나 주소가 틀렸어요).' }
  }
  if (!res.ok) {
    stop()
    return { kind: 'fail', text: `사이트가 파일을 주지 않았어요(${res.status}).${browserHint}` }
  }
  const type = res.headers.get('content-type') ?? ''
  const fromHeader = dispositionName(res.headers.get('content-disposition'))
  if (!fromHeader && /text\/html/i.test(type)) {
    stop()
    return {
      kind: 'fail',
      text: `이 주소는 파일이 아니라 웹페이지예요(로그인 화면일 수도 있어요).${browserHint} 페이지 내용이 필요하면 browser_read로 읽어요.`,
    }
  }
  const size = Number(res.headers.get('content-length')) || undefined
  if (size && size > DOWNLOAD_MAX) {
    stop()
    return {
      kind: 'fail',
      text: `${(size / (1 << 30)).toFixed(1)}GB라 너무 커요(2GB까지). 브라우저로 직접 받아 달라고 알려 주세요.`,
    }
  }
  // 이름: 사용자가 준 것(확장자는 사이트 것) > 사이트가 준 것 > 주소 끝
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
  const part = `${target}.dool2-받는중`
  const body = res.body
  if (!body) return { kind: 'fail', text: '사이트가 빈 파일을 보냈어요.' }
  let got = 0
  const work = (async () => {
    const out = createWriteStream(part, { flags: 'wx' })
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length
        if (got > DOWNLOAD_MAX) throw new Error('2GB를 넘어서 그만 받았어요')
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
      // 받는 동안 같은 이름이 생겼으면 번호를 붙인다 (덮어쓰지 않는다)
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
      text: `받는 중이에요${pct}. 다 받으면 ${o.show(target)}로 생겨요(받는 동안은 "${basename(part)}"). 조금 뒤 file_find로 확인해 주세요.`,
    }
  }
  if ('e' in r) return { kind: 'fail', text: `받다가 멈췄어요: ${r.e.message}` }
  const mb = got > 1 << 20 ? `${(got / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(got / 1024))}KB`
  return {
    kind: 'done',
    text: `받았어요: ${o.show(r.p)} (${mb}). 사용자에게 이 위치를 알려 주세요. 열어 보려면 file_read.`,
  }
}

/** 브라우저처럼 "인터넷에서 받은 파일" 표시: 열 때 맥·윈도우가 한 번 더 확인한다 */
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
