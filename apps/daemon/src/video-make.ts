// 사진으로 영상 만들기 (video_make): 사진 여러 장을 천천히 확대(켄 번스)·부드러운 장면 전환·자막·배경음악으로 이은 mp4.
// "아이 사진으로 생일 영상", "여행 사진 영상으로" 같은 부탁. 영상 부품(ffmpeg)은 PC에 있으면 쓰고, 없으면 처음 쓸 때
// 고정 판(정적 빌드, sha256 확인)을 받아 둔다 (쉬운 설치: 사용자가 따로 깔지 않는다).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** 받을 영상 부품: ffmpeg-static b6.0 (GPL 정적 빌드). 받은 .gz의 sha256을 고정해 바꿔치기를 막는다 */
const FFMPEG_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0'
export const FFMPEG_BUILDS: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: 'ffmpeg-darwin-arm64.gz',
    sha256: '6be74d6f449889c2e87a75873894f8520cad56c08ac76f2a628d85b0519daaca',
  },
  'darwin-x64': {
    file: 'ffmpeg-darwin-x64.gz',
    sha256: 'a12354fce7eb62361473bbe10d53a1893695babd35869ec8e92e5dfea8d0440b',
  },
  'win32-x64': {
    file: 'ffmpeg-win32-x64.gz',
    sha256: '450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50',
  },
  'linux-x64': {
    file: 'ffmpeg-linux-x64.gz',
    sha256: '17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f',
  },
}

const exe = (platform = process.platform) => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

/** PC에 있는 ffmpeg: 두리가 받아 둔 것 → 흔한 설치 위치 */
export function findFfmpeg(binDir: string, platform = process.platform): string | undefined {
  const mine = join(binDir, exe(platform))
  if (existsSync(mine)) return mine
  const common =
    platform === 'win32'
      ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
      : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  return common.find((p) => existsSync(p))
}

/** 영상 부품 받기 (처음 한 번). 받은 것의 지문이 다르면 쓰지 않는다 */
export async function installFfmpeg(
  binDir: string,
  fetcher: typeof fetch = fetch,
  platform = process.platform,
  arch = process.arch,
): Promise<string> {
  const build = FFMPEG_BUILDS[`${platform}-${arch}`]
  if (!build) throw new Error(`이 PC(${platform}-${arch})용 영상 부품이 없어요`)
  const res = await fetcher(`${FFMPEG_BASE}/${build.file}`, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`영상 부품을 받지 못했어요 (${res.status})`)
  const gz = Buffer.from(await res.arrayBuffer())
  const sum = createHash('sha256').update(gz).digest('hex')
  if (sum !== build.sha256) throw new Error('받은 영상 부품의 지문이 맞지 않아 쓰지 않았어요')
  await mkdir(binDir, { recursive: true })
  const target = join(binDir, exe(platform))
  const part = `${target}.part`
  await writeFile(part, gunzipSync(gz))
  await chmod(part, 0o755)
  await rename(part, target)
  return target
}

/** 자막 글꼴: 한글이 나오는 시스템 글꼴 */
export function captionFont(platform = process.platform): string | undefined {
  const list =
    platform === 'darwin'
      ? ['/System/Library/Fonts/AppleSDGothicNeo.ttc', '/System/Library/Fonts/Supplemental/AppleGothic.ttf']
      : platform === 'win32'
        ? ['C:\\Windows\\Fonts\\malgunbd.ttf', 'C:\\Windows\\Fonts\\malgun.ttf']
        : [
            '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
          ]
  return list.find((p) => existsSync(p))
}

/** ffmpeg 필터 안에 넣을 파일 경로 (윈도의 C: 같은 콜론·역슬래시를 막는다) */
export function filterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

export const VIDEO_SIZES = {
  portrait: [1080, 1920],
  landscape: [1920, 1080],
  square: [1080, 1080],
} as const
export type VideoShape = keyof typeof VIDEO_SIZES

export interface SlideshowPlan {
  photos: string[]
  /** 사진마다 자막 파일 (줄마다 한 파일, 없으면 자막 없음) */
  captionFiles: (string | string[] | undefined)[]
  /** 첫 장 위 큰 제목 파일 (줄마다 한 파일) */
  titleFile?: string | string[]
  /** 글자 수 (글자 크기를 화면 너비에 맞춘다) */
  titleLength?: number
  captionLengths?: number[]
  font?: string
  music?: string
  sec: number
  shape: VideoShape
  out: string
}

const FPS = 30
const FADE = 0.7

/** 영상 길이 (초): 사진마다 sec, 마지막에 전환 한 번 몫 */
export function slideshowLength(n: number, sec: number) {
  return n * sec + FADE
}

/** 글자 크기: 기본 크기와 한 줄이 너비 안에 드는 크기 중 작은 것 (한글 한 자 ≈ 글자 크기 너비) */
export function fit(base: number, width: number, length = 0): number {
  return Math.round(length > 0 ? Math.min(base, width / (length * 1.02)) : base)
}

/** 긴 글은 띄어쓰기에서 두 줄로 (가운데에 가까운 곳). 긴 줄의 글자 수도 돌려준다 */
export function twoLines(text: string, max: number): { lines: string[]; longest: number } {
  const chars = [...text]
  if (chars.length <= max || !text.includes(' ')) return { lines: [text], longest: chars.length }
  const mid = text.length / 2
  let at = -1
  for (let i = 0; i < text.length; i++)
    if (text[i] === ' ' && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i
  const a = text.slice(0, at)
  const b = text.slice(at + 1)
  return { lines: [a, b], longest: Math.max([...a].length, [...b].length) }
}

/** 장면마다 가운데 한 컷 (영상 프레임 번호, 앞 6장면까지) */
export function sceneFrames(n: number, sec: number): number[] {
  const pick = n <= 6 ? [...Array(n).keys()] : [...Array(6).keys()].map((k) => Math.round((k * (n - 1)) / 5))
  return pick.map((i) => Math.round((i * sec + sec / 2) * FPS))
}

/** ffmpeg 인자 (순수 함수, 시험에서 본다) */
export function slideshowArgs(p: SlideshowPlan): string[] {
  const [W, H] = VIDEO_SIZES[p.shape]
  const n = p.photos.length
  const dur = p.sec + FADE
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  for (const photo of p.photos)
    args.push('-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(2), '-i', photo)
  if (p.music) args.push('-stream_loop', '-1', '-i', p.music)
  const frames = Math.round(dur * FPS)
  const f: string[] = []
  p.photos.forEach((_, i) => {
    // 화면을 꽉 채우게 자르고, 천천히 확대(앞뒤로 번갈아 다른 곳에서)
    const zoom = `zoompan=z='min(1+0.10*on/${frames},1.10)':x='iw/2-(iw/zoom/2)${i % 2 ? '+iw*0.03*on/' + frames : ''}':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`
    // 사진은 잘리지 않게 다 보이고, 남는 자리는 같은 사진을 흐리게 깔아 채운다 (세로 화면에 가로 사진도)
    const bw = Math.round(W * 1.25)
    const bh = Math.round(H * 1.25)
    f.push(
      `[${i}:v]split[bg${i}][fg${i}]`,
      `[bg${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=24:2,eq=brightness=-0.06[b${i}]`,
      `[fg${i}]scale=${Math.round(bw * 0.94)}:${Math.round(bh * 0.94)}:force_original_aspect_ratio=decrease[f${i}]`,
    )
    let chain = `[b${i}][f${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,${zoom}`
    const font = p.font ? `fontfile='${filterPath(p.font)}':` : ''
    // 줄마다 따로 가운데 정렬 (여러 줄을 한 번에 그리면 왼쪽으로 붙는다)
    const lines = (files: string | string[], size: number, centerY: number, style: string, fade = '') => {
      const list = Array.isArray(files) ? files : [files]
      const lh = Math.round(size * 1.38)
      list.forEach((file, j) => {
        const y = Math.round(centerY - (list.length * lh) / 2 + j * lh)
        chain += `,drawtext=${font}textfile='${filterPath(file)}':fontsize=${size}:${style}:x=(w-text_w)/2:y=${y}${fade}`
      })
    }
    const cap = p.captionFiles[i]
    if (cap)
      lines(
        cap,
        fit(H * 0.036, W * 0.84, p.captionLengths?.[i]),
        H * (H > W ? 0.905 : 0.86),
        `fontcolor=white:box=1:boxcolor=black@0.42:boxborderw=${Math.round(H * 0.012)}`,
      )
    if (i === 0 && p.titleFile)
      lines(
        p.titleFile,
        fit(H * 0.06, W * 0.86, p.titleLength),
        H * (H > W ? 0.1 : 0.12),
        'fontcolor=white:shadowcolor=black@0.6:shadowx=3:shadowy=3',
        `:alpha='if(lt(t,0.4),t/0.4,1)'`,
      )
    f.push(`${chain},format=yuv420p[v${i}]`)
  })
  let last = 'v0'
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? 'vx' : `x${i}`
    f.push(`[${last}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${(i * p.sec).toFixed(2)}[${out}]`)
    last = out
  }
  const total = slideshowLength(n, p.sec)
  // 끝은 검게 사라진다
  f.push(`[${n > 1 ? 'vx' : 'v0'}]fade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8[v]`)
  if (p.music)
    f.push(
      `[${n}:a]atrim=0:${total.toFixed(2)},afade=t=in:st=0:d=1,afade=t=out:st=${(total - 2).toFixed(2)}:d=2[a]`,
    )
  args.push('-filter_complex', f.join(';'), '-map', '[v]')
  if (p.music) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k')
  args.push(
    '-t',
    total.toFixed(2),
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    p.out,
  )
  return args
}

export interface VideoMakeDeps {
  /** 영상 부품을 둘 곳 (두리 데이터 폴더/bin) */
  binDir: string
  /** 사진 경로 확인: 사용자 폴더 안의 파일·대화로 받은 사진이면 실제 경로들 (iCloud에만 있으면 내려받는다) */
  resolveAll: (paths: string[]) => Promise<string[] | { error: string }>
  saveDir: () => string | undefined
  show: (p: string) => string
  onMade?: (f: { name: string; kind: 'mp4'; path: string; image?: string }) => void
  /** 첫 장면 JPEG → 줄인 base64 (보관함·대화 미리보기) */
  preview?: (jpeg: Buffer) => Promise<string | undefined>
  fetcher?: typeof fetch
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<void>
  /** 그 ffmpeg에 필요한 기능(자막·전환·확대)이 있나 */
  hasFilters?: (bin: string) => Promise<boolean>
}

const NEED = ['drawtext', 'xfade', 'zoompan', 'boxblur']
const checked = new Map<string, boolean>()
/** ffmpeg에 영상 만들기에 쓰는 필터가 다 있는지 (한 번 본 것은 기억) */
export async function hasFilters(bin: string): Promise<boolean> {
  const hit = checked.get(bin)
  if (hit !== undefined) return hit
  const ok = await new Promise<boolean>((done) => {
    execFile(
      bin,
      ['-hide_banner', '-filters'],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        if (err) return done(false)
        done(NEED.every((f) => new RegExp(`\\s${f}\\s`).test(out)))
      },
    )
  })
  checked.set(bin, ok)
  return ok
}

type Result = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
const fail = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] })

function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((done, failed) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, _out, errText) => {
      if (err)
        failed(
          new Error(
            String(errText || err.message)
              .trim()
              .split('\n')
              .slice(-3)
              .join(' ')
              .slice(0, 300),
          ),
        )
      else done()
    })
  })
}

export class VideoMaker {
  private busy = false
  constructor(private readonly d: VideoMakeDeps) {}

  async make(args: Record<string, unknown>): Promise<Result> {
    const raw = Array.isArray(args.photos) ? (args.photos as unknown[]).map(String).filter(Boolean) : []
    if (raw.length < 2)
      return fail('사진을 2장 이상 photos에 주세요 (file_find로 찾은 경로나 대화로 받은 "photo:이름").')
    if (raw.length > 40) return fail('사진은 40장까지예요. 고르고 골라 주세요.')
    const got = await this.d.resolveAll(raw.map((r) => r.replace(/^photo:/, '')))
    if (!Array.isArray(got)) return fail(got.error)
    const photos = got
    for (const p of photos)
      if (!/\.(jpe?g|png|webp|bmp)$/i.test(p))
        return fail(
          `${basename(p)}: jpg·png 사진만 돼요. HEIC 같은 건 file_convert로 jpg로 바꾼 뒤 다시 불러요.`,
        )
    let music: string | undefined
    if (typeof args.music === 'string' && args.music.trim()) {
      const m = await this.d.resolveAll([args.music.trim()])
      if (!Array.isArray(m) || !m[0] || !/\.(mp3|m4a|aac|wav)$/i.test(m[0]))
        return fail('배경음악은 사용자 폴더의 mp3·m4a 파일만 쓸 수 있어요.')
      music = m[0]
    }
    const dir = this.d.saveDir()
    if (!dir) return fail('문서 폴더를 찾지 못했어요.')
    if (this.busy) return fail('다른 영상을 만드는 중이에요. 끝난 뒤에 다시 불러 주세요.')
    this.busy = true
    const work = await mkdtemp(join(tmpdir(), 'dool2-video-'))
    try {
      let bin = findFfmpeg(this.d.binDir)
      // PC에 있던 ffmpeg가 자막·전환 기능이 빠진 판이면 두리용을 받는다 (실측 11-23: Homebrew 판에 drawtext가 없었다)
      if (bin && !(await (this.d.hasFilters ?? hasFilters)(bin))) bin = undefined
      if (!bin) bin = await installFfmpeg(this.d.binDir, this.d.fetcher ?? fetch)
      const captions = Array.isArray(args.captions)
        ? (args.captions as unknown[]).map((c) => String(c ?? '').trim())
        : []
      const captionFiles: (string[] | undefined)[] = []
      const captionLong: number[] = []
      for (let i = 0; i < photos.length; i++) {
        const c = captions[i]?.slice(0, 80)
        if (!c) {
          captionFiles.push(undefined)
          continue
        }
        const two = twoLines(c, 16)
        captionLong[i] = two.longest
        const files: string[] = []
        for (const [j, line] of two.lines.entries()) {
          const f = join(work, `cap${i}-${j}.txt`)
          await writeFile(f, line, 'utf8')
          files.push(f)
        }
        captionFiles.push(files)
      }
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 60) : ''
      const titleTwo = twoLines(title, 11)
      const titleFile: string[] = []
      if (title)
        for (const [j, line] of titleTwo.lines.entries()) {
          const f = join(work, `title-${j}.txt`)
          await writeFile(f, line, 'utf8')
          titleFile.push(f)
        }
      const sec = Math.min(Math.max(Number(args.seconds) || 3, 1.5), 8)
      const shape: VideoShape =
        args.shape === 'landscape' || args.shape === 'square' ? args.shape : 'portrait'
      const stem =
        (typeof args.name === 'string' && args.name.trim() ? args.name : title || '두리 영상')
          .replace(/\.[a-z0-9]{1,5}$/i, '')
          .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
          .trim()
          .slice(0, 60) || '두리 영상'
      await mkdir(dir, { recursive: true })
      let out = join(dir, `${stem}.mp4`)
      for (let i = 2; existsSync(out) && i < 100; i++) out = join(dir, `${stem} (${i}).mp4`)
      const font = captionFont()
      const plan: SlideshowPlan = {
        photos,
        captionFiles,
        ...(titleFile.length ? { titleFile } : {}),
        ...(font ? { font } : {}),
        ...(music ? { music } : {}),
        sec,
        shape,
        out,
        ...(title ? { titleLength: titleTwo.longest } : {}),
        captionLengths: photos.map((_, i) => captionLong[i] ?? 0),
      }
      const run = this.d.run ?? runFfmpeg
      await run(bin, slideshowArgs(plan), 10 * 60_000)
      // 첫 장면(제목이 뜬 뒤)을 미리보기로
      const poster = join(work, 'poster.jpg')
      await run(
        bin,
        ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1.2', '-i', out, '-frames:v', '1', poster],
        60_000,
      ).catch(() => undefined)
      const small = existsSync(poster)
        ? await this.d.preview?.(await readFile(poster)).catch(() => undefined)
        : undefined
      // 두리가 장면마다 확인하게 한 컷씩 모은 그림 (확인용 영상을 따로 만들지 않게)
      const frames = sceneFrames(photos.length, sec)
      const sheetFile = join(work, 'scenes.jpg')
      const select = frames.map((x) => `eq(n\\,${x})`).join('+')
      await run(
        bin,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          out,
          '-vf',
          `select='${select}',scale=${shape === 'landscape' ? 360 : 200}:-2,tile=${frames.length}x1:padding=6:color=white`,
          '-frames:v',
          '1',
          '-fps_mode',
          'vfr',
          sheetFile,
        ],
        60_000,
      ).catch(() => undefined)
      const sheet = existsSync(sheetFile) ? (await readFile(sheetFile)).toString('base64') : undefined
      const size = (await stat(out)).size
      const shown = this.d.show(out)
      this.d.onMade?.({ name: basename(out), kind: 'mp4', path: shown, ...(small ? { image: small } : {}) })
      const length = slideshowLength(photos.length, sec)
      return {
        content: [
          {
            type: 'text',
            text:
              `영상을 만들었어요: ${shown} (${photos.length}장, ${Math.round(length)}초, ${VIDEO_SIZES[shape].join('×')}, ${(size / 1024 / 1024).toFixed(1)}MB). 보관함에도 올렸고, 폰 보관함에서 '폰에 저장'하면 폰에 받을 수 있어요. ` +
              `아래는 장면마다 한 컷씩(${frames.length}장면) 모은 그림이에요. 이걸로 모든 장면을 확인하고, 확인용 영상을 따로 만들지 않아요. 자막이 잘리거나 사진이 이상하면 고쳐 다시 만들어요. 사용자에게 파일 이름과 길이를 알려 줘요.`,
          },
          ...(sheet
            ? [{ type: 'image' as const, data: sheet, mimeType: 'image/jpeg' }]
            : small
              ? [{ type: 'image' as const, data: small, mimeType: 'image/jpeg' }]
              : []),
        ],
      }
    } catch (e) {
      return fail(`영상을 만들지 못했어요: ${(e as Error).message}`)
    } finally {
      this.busy = false
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
