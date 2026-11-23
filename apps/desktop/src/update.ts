// New version alerts and install (ADR 0028). Dool2 is downloaded from the web, not an app store, so it finds new
// versions itself. The version info (version.json) is signed with our key (ed25519): if the host (GitHub Releases)
// changes or a file is swapped, nothing is installed unless the signature and checksum (sha256) match (the same
// reason the phone PWA was dropped).
// Below the minimum version (min), the app blocks with "update to keep using it".
import { createHash, sign, verify } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { Lang } from '@dool2/i18n'
import { updateText } from './locales/update.js'

/** Public key that checks the version info (the private key lives only in the release CI secrets) */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgSoqNvsFEjOwUjDiqwM2sGv7kLLKPoOXjiekL4ROyhE=
-----END PUBLIC KEY-----`

/** Version info of the latest release (GitHub redirects to the newest release file) */
export const UPDATE_FEED = 'https://github.com/kuzvo-dev/dool2/releases/latest/download/version.json'

export interface ReleaseFile {
  url: string
  sha256: string
  size: number
}
export interface Release {
  version: string
  /** Versions below this must update to keep working */
  min?: string
  /** What changed (shown to users) */
  notes?: string
  date?: string
  /** 'darwin-arm64', 'darwin-x64', 'win32-x64' → update file (zip on Mac, installer exe on Windows) */
  files: Record<string, ReleaseFile>
}
/** version.json: payload (Release JSON in base64) and its signature */
export interface SignedRelease {
  payload: string
  signature: string
}

export type UpdateStatus = 'idle' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
export interface UpdateState {
  status: UpdateStatus
  current: string
  latest?: string
  notes?: string
  /** Below the minimum version, so an update is needed to keep using the app */
  required?: boolean
  /** Download progress, 0 to 1 */
  progress?: number
  error?: string
  checkedAt?: number
}

/** "0.10.1" > "0.2.0" (first three numbers only, any suffix is ignored) */
export function newer(a: string, b: string): boolean {
  const p = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((x) => Number.parseInt(x, 10) || 0)
  const [x, y] = [p(a), p(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** The release CI signs the version info (scripts/release-manifest.mjs) */
export function signRelease(r: Release, privateKeyPem: string): SignedRelease {
  const data = Buffer.from(JSON.stringify(r), 'utf8')
  return { payload: data.toString('base64'), signature: sign(null, data, privateKeyPem).toString('base64') }
}

/** Checks the signature and returns the release. undefined when it does not match */
export function openRelease(signed: unknown, publicKey: string): Release | undefined {
  if (!signed || typeof signed !== 'object') return undefined
  const { payload, signature } = signed as Partial<SignedRelease>
  if (typeof payload !== 'string' || typeof signature !== 'string') return undefined
  const data = Buffer.from(payload, 'base64')
  let ok = false
  try {
    ok = verify(null, data, publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return undefined
  }
  if (!ok) return undefined
  try {
    const r = JSON.parse(data.toString('utf8')) as Release
    if (typeof r.version !== 'string' || !r.files || typeof r.files !== 'object') return undefined
    return r
  } catch {
    return undefined
  }
}

export interface UpdaterOptions {
  current: string
  /** This PC's kind, like 'darwin-arm64' */
  platform: string
  feed?: string
  publicKey?: string
  /** Folder for downloaded files */
  dir: string
  fetch?: typeof fetch
  /** Installs the downloaded file and restarts (per platform) */
  install: (file: string, release: Release) => Promise<void>
  onChange?: (s: UpdateState) => void
  now?: () => number
  /** Language of the error shown in the update notice (default Korean) */
  lang?: () => Lang
}

export class Updater {
  private s: UpdateState
  private release?: Release
  private file?: string
  constructor(private readonly o: UpdaterOptions) {
    this.s = { status: 'idle', current: o.current }
  }

  state(): UpdateState {
    return { ...this.s }
  }

  private text() {
    return updateText(this.o.lang?.() ?? 'ko')
  }

  private set(next: Partial<UpdateState>) {
    this.s = { ...this.s, ...next }
    this.o.onChange?.(this.state())
  }

  /** Checks for a new version (no change while downloading or once downloaded) */
  async check(): Promise<UpdateState> {
    if (this.s.status === 'downloading' || this.s.status === 'ready' || this.s.status === 'installing')
      return this.state()
    const now = (this.o.now ?? Date.now)()
    const m = this.text()
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.feed ?? UPDATE_FEED, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'cache-control': 'no-cache' },
      })
      if (!res.ok) throw new Error(m.feedFailed(res.status))
      const r = openRelease(await res.json(), this.o.publicKey ?? UPDATE_PUBLIC_KEY)
      if (!r) throw new Error(m.badSignature)
      const file = r.files[this.o.platform]
      if (!newer(r.version, this.o.current) || !file) {
        this.release = undefined
        this.set({ status: 'none', latest: r.version, required: false, error: undefined, checkedAt: now })
        return this.state()
      }
      this.release = r
      this.set({
        status: 'available',
        latest: r.version,
        notes: r.notes,
        required: Boolean(r.min && newer(r.min, this.o.current)),
        error: undefined,
        checkedAt: now,
      })
    } catch (e) {
      // Check failures stay quiet (maybe no internet). A new version already found stays as is
      if (this.s.status !== 'available')
        this.set({ status: 'error', error: (e as Error).message, checkedAt: now })
    }
    return this.state()
  }

  /** Downloads, checks the checksum, then installs */
  async install(): Promise<UpdateState> {
    const r = this.release
    const f = r?.files[this.o.platform]
    if (!r || !f) return this.state()
    if (this.s.status === 'downloading' || this.s.status === 'installing') return this.state()
    const m = this.text()
    try {
      if (!this.file) {
        if (!/^https:\/\//.test(f.url)) throw new Error(m.notHttps)
        this.set({ status: 'downloading', progress: 0, error: undefined })
        await mkdir(this.o.dir, { recursive: true })
        const name = decodeURIComponent(new URL(f.url).pathname.split('/').pop() || 'update.bin').replace(
          /[^\w.-]/g,
          '_',
        )
        const out = join(this.o.dir, name)
        const res = await (this.o.fetch ?? fetch)(f.url, { redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error(m.downloadFailed(res.status))
        const hash = createHash('sha256')
        let got = 0
        const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
        body.on('data', (c: Buffer) => {
          hash.update(c)
          got += c.length
          if (f.size) this.set({ progress: Math.min(1, got / f.size) })
        })
        await pipeline(body, createWriteStream(out))
        const size = (await stat(out)).size
        if (hash.digest('hex') !== f.sha256.toLowerCase() || (f.size && size !== f.size)) {
          await rm(out, { force: true })
          throw new Error(m.badChecksum)
        }
        this.file = out
        this.set({ status: 'ready', progress: 1 })
      }
      this.set({ status: 'installing' })
      await this.o.install(this.file, r)
    } catch (e) {
      this.file = undefined
      this.set({ status: 'error', error: (e as Error).message })
    }
    return this.state()
  }
}
