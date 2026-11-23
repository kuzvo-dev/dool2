// Video from photos (video_make): an mp4 joining several photos with slow zoom (Ken Burns), soft scene transitions, captions and background music.
// For requests like "a birthday video from the kid's photos" or "make a video of the trip photos". The video part (ffmpeg) is used if the PC has one;
// otherwise a pinned build (static, sha256 checked) is downloaded on first use (easy install: the user installs nothing).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DEFAULT_VIDEO_NAME } from './region/kr/image-ui.js'

/** Video part to download: ffmpeg-static b6.0 (GPL static build). The sha256 of the downloaded .gz is pinned to prevent swapping */
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

/** ffmpeg on the PC: the one Dool downloaded first, then common install locations */
export function findFfmpeg(binDir: string, platform = process.platform): string | undefined {
  const mine = join(binDir, exe(platform))
  if (existsSync(mine)) return mine
  const common =
    platform === 'win32'
      ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
      : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  return common.find((p) => existsSync(p))
}

/** Downloads the video part (once). Not used if the fingerprint differs */
export async function installFfmpeg(
  binDir: string,
  fetcher: typeof fetch = fetch,
  platform = process.platform,
  arch = process.arch,
): Promise<string> {
  const build = FFMPEG_BUILDS[`${platform}-${arch}`]
  if (!build) throw new Error(`No video part for this PC (${platform}-${arch})`)
  const res = await fetcher(`${FFMPEG_BASE}/${build.file}`, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`Could not download the video part (${res.status})`)
  const gz = Buffer.from(await res.arrayBuffer())
  const sum = createHash('sha256').update(gz).digest('hex')
  if (sum !== build.sha256)
    throw new Error('The downloaded video part has a wrong fingerprint, so it was not used')
  await mkdir(binDir, { recursive: true })
  const target = join(binDir, exe(platform))
  const part = `${target}.part`
  await writeFile(part, gunzipSync(gz))
  await chmod(part, 0o755)
  await rename(part, target)
  return target
}

/** Caption font: a system font that shows Hangul */
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

/** File path to put inside an ffmpeg filter (escapes colons and backslashes like Windows C:) */
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
  /** Caption file per photo (one file per line, none means no caption) */
  captionFiles: (string | string[] | undefined)[]
  /** Big title files over the first photo (one file per line) */
  titleFile?: string | string[]
  /** Character count (fits the font size to the screen width) */
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

/** Video length (seconds): sec per photo, plus one transition at the end */
export function slideshowLength(n: number, sec: number) {
  return n * sec + FADE
}

/** Font size: the smaller of the default size and the size at which a line fits the width (one Hangul character is about one font size wide) */
export function fit(base: number, width: number, length = 0): number {
  return Math.round(length > 0 ? Math.min(base, width / (length * 1.02)) : base)
}

/** Splits long text into two lines at a space (nearest the middle). Also returns the character count of the longer line */
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

/** One middle frame per scene (video frame number, up to the first 6 scenes) */
export function sceneFrames(n: number, sec: number): number[] {
  const pick = n <= 6 ? [...Array(n).keys()] : [...Array(6).keys()].map((k) => Math.round((k * (n - 1)) / 5))
  return pick.map((i) => Math.round((i * sec + sec / 2) * FPS))
}

/** ffmpeg arguments (pure function, checked in tests) */
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
    // Crop to fill the screen and zoom slowly (alternating start points)
    const zoom = `zoompan=z='min(1+0.10*on/${frames},1.10)':x='iw/2-(iw/zoom/2)${i % 2 ? '+iw*0.03*on/' + frames : ''}':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`
    // Show the whole photo uncropped and fill the leftover space with a blurred copy (also landscape photos on a portrait screen)
    const bw = Math.round(W * 1.25)
    const bh = Math.round(H * 1.25)
    f.push(
      `[${i}:v]split[bg${i}][fg${i}]`,
      `[bg${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=24:2,eq=brightness=-0.06[b${i}]`,
      `[fg${i}]scale=${Math.round(bw * 0.94)}:${Math.round(bh * 0.94)}:force_original_aspect_ratio=decrease[f${i}]`,
    )
    let chain = `[b${i}][f${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,${zoom}`
    const font = p.font ? `fontfile='${filterPath(p.font)}':` : ''
    // Center each line separately (drawing several lines at once aligns them left)
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
  // The end fades to black
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
  /** Where to keep the video part (Dool data folder/bin) */
  binDir: string
  /** Resolves photo paths: real paths for files in the user folders or photos received in chat (downloads them if only in iCloud) */
  resolveAll: (paths: string[]) => Promise<string[] | { error: string }>
  saveDir: () => string | undefined
  show: (p: string) => string
  onMade?: (f: { name: string; kind: 'mp4'; path: string; image?: string }) => void
  /** First scene JPEG -> shrunk base64 (library and chat preview) */
  preview?: (jpeg: Buffer) => Promise<string | undefined>
  fetcher?: typeof fetch
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<void>
  /** Whether that ffmpeg has the needed features (captions, transitions, zoom) */
  hasFilters?: (bin: string) => Promise<boolean>
}

const NEED = ['drawtext', 'xfade', 'zoompan', 'boxblur']
const checked = new Map<string, boolean>()
/** Whether ffmpeg has all the filters used for making videos (remembers what it already checked) */
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

export function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<void> {
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
      return fail(
        'Give at least 2 photos in photos (paths found with file_find, or "photo:name" received in chat).',
      )
    if (raw.length > 40) return fail('Up to 40 photos. Pick the best ones.')
    const got = await this.d.resolveAll(raw.map((r) => r.replace(/^photo:/, '')))
    if (!Array.isArray(got)) return fail(got.error)
    const photos = got
    for (const p of photos)
      if (!/\.(jpe?g|png|webp|bmp)$/i.test(p))
        return fail(
          `${basename(p)}: only jpg and png photos work. Convert HEIC and others to jpg with file_convert, then call again.`,
        )
    let music: string | undefined
    if (typeof args.music === 'string' && args.music.trim()) {
      const m = await this.d.resolveAll([args.music.trim()])
      if (!Array.isArray(m) || !m[0] || !/\.(mp3|m4a|aac|wav)$/i.test(m[0]))
        return fail('Background music can only be an mp3 or m4a file in the user folders.')
      music = m[0]
    }
    const dir = this.d.saveDir()
    if (!dir) return fail('Could not find the Documents folder.')
    if (this.busy) return fail('Another video is being made. Call again after it finishes.')
    this.busy = true
    const work = await mkdtemp(join(tmpdir(), 'dool2-video-'))
    try {
      let bin = findFfmpeg(this.d.binDir)
      // If the ffmpeg on the PC lacks captions or transitions, download Dool's own (measured 11-23: the Homebrew build had no drawtext)
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
        (typeof args.name === 'string' && args.name.trim() ? args.name : title || DEFAULT_VIDEO_NAME)
          .replace(/\.[a-z0-9]{1,5}$/i, '')
          .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
          .trim()
          .slice(0, 60) || DEFAULT_VIDEO_NAME
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
      // Use the first scene (after the title shows) as the preview
      const poster = join(work, 'poster.jpg')
      await run(
        bin,
        ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1.2', '-i', out, '-frames:v', '1', poster],
        60_000,
      ).catch(() => undefined)
      const small = existsSync(poster)
        ? await this.d.preview?.(await readFile(poster)).catch(() => undefined)
        : undefined
      // One frame per scene gathered into a picture so Dool can check each scene (no separate check video)
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
              `Made the video: ${shown} (${photos.length} photos, ${Math.round(length)} s, ${VIDEO_SIZES[shape].join('×')}, ${(size / 1024 / 1024).toFixed(1)}MB). It is also uploaded to the library, and the user can get it on the phone with "Save to phone" in the phone library. ` +
              `Below is one frame per scene (${frames.length} scenes) in one picture. Use it to check every scene; do not make a separate check video. If captions are cut off or a photo looks wrong, fix it and make it again. Tell the user the file name and length.`,
          },
          ...(sheet
            ? [{ type: 'image' as const, data: sheet, mimeType: 'image/jpeg' }]
            : small
              ? [{ type: 'image' as const, data: small, mimeType: 'image/jpeg' }]
              : []),
        ],
      }
    } catch (e) {
      return fail(`Could not make the video: ${(e as Error).message}`)
    } finally {
      this.busy = false
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
