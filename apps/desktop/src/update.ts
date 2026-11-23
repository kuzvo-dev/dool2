// 새 버전 알림·설치 (ADR 0028). 앱스토어 없이 웹에서 받는 두리가 스스로 새 버전을 찾는다.
// 버전 안내(version.json)는 우리 서명키(ed25519)로 서명한다: 안내를 올려 둔 곳(GitHub Releases)이 바뀌거나
// 파일이 바꿔치기돼도 서명·확인값(sha256)이 맞지 않으면 깔지 않는다 (폰에서 PWA를 접은 것과 같은 이유).
// 최소 버전(min)보다 낮으면 "업데이트해야 계속 쓸 수 있어요"로 막는다.
import { createHash, sign, verify } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/** 버전 안내를 확인하는 공개키 (비밀키는 릴리스 CI의 비밀 값에만 있다) */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgSoqNvsFEjOwUjDiqwM2sGv7kLLKPoOXjiekL4ROyhE=
-----END PUBLIC KEY-----`

/** 최신 릴리스의 버전 안내 (GitHub가 가장 최근 릴리스 파일로 넘겨 준다) */
export const UPDATE_FEED = 'https://github.com/kuzvo-dev/dool2/releases/latest/download/version.json'

export interface ReleaseFile {
  url: string
  sha256: string
  size: number
}
export interface Release {
  version: string
  /** 이보다 낮은 버전은 업데이트해야 쓸 수 있다 */
  min?: string
  /** 바뀐 점 (사용자에게 보이는 말) */
  notes?: string
  date?: string
  /** 'darwin-arm64'·'darwin-x64'·'win32-x64' → 업데이트 파일 (맥은 zip, 윈도우는 설치 exe) */
  files: Record<string, ReleaseFile>
}
/** version.json: payload(Release JSON을 base64로)와 그 서명 */
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
  /** 최소 버전보다 낮아서 업데이트해야 계속 쓸 수 있다 */
  required?: boolean
  /** 받는 중 0~1 */
  progress?: number
  error?: string
  checkedAt?: number
}

/** "0.10.1" > "0.2.0" (앞 세 자리 숫자만, 그 뒤 꼬리표는 무시) */
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

/** 릴리스 CI가 버전 안내에 서명한다 (scripts/release-manifest.mjs) */
export function signRelease(r: Release, privateKeyPem: string): SignedRelease {
  const data = Buffer.from(JSON.stringify(r), 'utf8')
  return { payload: data.toString('base64'), signature: sign(null, data, privateKeyPem).toString('base64') }
}

/** 서명을 확인하고 안내를 꺼낸다. 틀리면 undefined */
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
  /** 'darwin-arm64' 같은 이 PC 종류 */
  platform: string
  feed?: string
  publicKey?: string
  /** 받은 파일을 둘 폴더 */
  dir: string
  fetch?: typeof fetch
  /** 받은 파일을 깔고 다시 켠다 (플랫폼마다 다름) */
  install: (file: string, release: Release) => Promise<void>
  onChange?: (s: UpdateState) => void
  now?: () => number
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

  private set(next: Partial<UpdateState>) {
    this.s = { ...this.s, ...next }
    this.o.onChange?.(this.state())
  }

  /** 새 버전이 있는지 본다 (받는 중·다 받은 뒤에는 그대로) */
  async check(): Promise<UpdateState> {
    if (this.s.status === 'downloading' || this.s.status === 'ready' || this.s.status === 'installing')
      return this.state()
    const now = (this.o.now ?? Date.now)()
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.feed ?? UPDATE_FEED, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'cache-control': 'no-cache' },
      })
      if (!res.ok) throw new Error(`버전 안내를 받지 못했어요 (${res.status})`)
      const r = openRelease(await res.json(), this.o.publicKey ?? UPDATE_PUBLIC_KEY)
      if (!r) throw new Error('버전 안내의 서명이 맞지 않아요')
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
      // 확인 실패는 조용히 (인터넷이 없을 수 있다). 이미 알던 새 버전은 그대로 둔다
      if (this.s.status !== 'available')
        this.set({ status: 'error', error: (e as Error).message, checkedAt: now })
    }
    return this.state()
  }

  /** 받고 확인값을 맞춘 뒤 깐다 */
  async install(): Promise<UpdateState> {
    const r = this.release
    const f = r?.files[this.o.platform]
    if (!r || !f) return this.state()
    if (this.s.status === 'downloading' || this.s.status === 'installing') return this.state()
    try {
      if (!this.file) {
        if (!/^https:\/\//.test(f.url)) throw new Error('업데이트 주소가 https가 아니에요')
        this.set({ status: 'downloading', progress: 0, error: undefined })
        await mkdir(this.o.dir, { recursive: true })
        const name = decodeURIComponent(new URL(f.url).pathname.split('/').pop() || 'update.bin').replace(
          /[^\w.-]/g,
          '_',
        )
        const out = join(this.o.dir, name)
        const res = await (this.o.fetch ?? fetch)(f.url, { redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error(`업데이트 파일을 받지 못했어요 (${res.status})`)
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
          throw new Error('받은 업데이트 파일의 확인값이 맞지 않아요')
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
