// Motion graphics video (video_motion): when Dool2 writes scene HTML (motion kit class names), the PC app shoots it frame by frame (renderMotion)
// and the video part (ffmpeg) packs it into an mp4. Richer movement than video_make, which only joins photos (kinetic type, confetti, collage, transitions).
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Lang } from '@dool2/i18n'
import { motionText } from './locales/motion-text.js'
import { MOTION_SHAPES, type MotionShape, motionDocument, motionLength } from './motion-kit.js'
import { findFfmpeg, hasFilters, installFfmpeg, runFfmpeg } from './video-make.js'

export interface MotionRenderRequest {
  /** The HTML to draw (temp folder) */
  path: string
  width: number
  height: number
  fps: number
  /** Seconds */
  duration: number
  /** Folder to write frames to (frame_00001.jpg …) */
  outDir: string
  /** Whether that HTML may load this local file (a photo in the user's folder) */
  allowFile(path: string): boolean
}
export interface MotionRenderResult {
  frames: number
}
export type MotionRenderer = (req: MotionRenderRequest) => Promise<MotionRenderResult>

export interface MotionDeps {
  binDir: string
  render?: MotionRenderer
  /** Whether the file is inside the user's folders and not sensitive (a photo put in a scene) */
  readable: (p: string) => boolean
  /** Download a photo that exists only in iCloud (the reason if it cannot) — files.ensureLocal */
  local?: (p: string) => Promise<string | undefined>
  /** Check the background music */
  resolveAll: (paths: string[]) => Promise<string[] | { error: string }>
  saveDir: () => string | undefined
  /** Language of the saved file name (default Korean) */
  lang?: () => Lang
  show: (p: string) => string
  onMade?: (f: { name: string; kind: 'mp4'; path: string; image?: string }) => void
  preview?: (jpeg: Buffer) => Promise<string | undefined>
  fetcher?: typeof fetch
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<void>
  hasFilters?: (bin: string) => Promise<boolean>
}

type Result = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
const fail = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] })
const FPS = 30
const MAX_SECONDS = 90

/** Local files the html loads (file:///…) */
export function fileRefs(html: string): string[] {
  const out = new Set<string>()
  // Inside quotes (src="…", url('…')) up to the closing quote — a name with parentheses ("invitation (2).png") is not cut
  const found = [
    ...[...html.matchAll(/(["'])(file:\/\/\/[^"'<>]+?)\1/g)].map((m) => m[2] as string),
    ...[...html.matchAll(/url\(\s*(file:\/\/\/[^"'\s<>]+?)\s*\)/g)].map((m) => m[1] as string),
  ]
  for (const ref of found) {
    try {
      out.add(fileURLToPath(ref))
    } catch {
      /* A bad address is blocked by the drawing window */
    }
  }
  return [...out]
}

/** The middle time of each scene (seconds) — for the contact sheet where Dool2 checks scenes one by one */
export function sceneMiddles(html: string): number[] {
  const out: number[] = []
  let t = 0
  for (const m of html.matchAll(/<section[^>]*class="[^"]*\bscene\b[^"]*"[^>]*>/gi)) {
    const tag = m[0]
    const start = /data-start="([\d.]+)"/.exec(tag)
    const dur = Number(/data-dur="([\d.]+)"/.exec(tag)?.[1] ?? 3)
    const s = start ? Number(start[1]) : t
    out.push(s + Math.min(dur * 0.7, dur - 0.3))
    t = s + dur
  }
  return out
}

export class MotionMaker {
  private busy = false
  constructor(private readonly d: MotionDeps) {}

  async make(args: Record<string, unknown>): Promise<Result> {
    if (!this.d.render)
      return fail(
        'Motion video cannot be drawn on this PC (the PC app is needed). Make a photo video with video_make instead.',
      )
    const html = typeof args.html === 'string' ? args.html : ''
    if (!/class="[^"]*\bscene\b/.test(html))
      return fail('Put at least one scene like <section class="scene" data-dur="3">…</section> in the html.')
    if (html.length > 400_000)
      return fail('The html is too long (up to 400KB). Put photos in by file:/// path.')
    const length = motionLength(html)
    if (length <= 0 || length > MAX_SECONDS)
      return fail(
        `The video length (sum of scene data-dur) can be up to ${MAX_SECONDS} seconds. It is ${length} seconds now.`,
      )
    const shape: MotionShape = args.shape === 'landscape' || args.shape === 'square' ? args.shape : 'portrait'
    const [width, height] = MOTION_SHAPES[shape]
    const dir = this.d.saveDir()
    if (!dir) return fail('Could not find the documents folder.')
    let music: string | undefined
    if (typeof args.music === 'string' && args.music.trim()) {
      const m = await this.d.resolveAll([args.music.trim()])
      if (!Array.isArray(m) || !m[0] || !/\.(mp3|m4a|aac|wav)$/i.test(m[0]))
        return fail("Background music can only be an mp3 or m4a file in the user's folders.")
      music = m[0]
    }
    if (this.busy) return fail('Another video is being made. Call again when it is done.')
    // Scene photos and videos: from a place we cannot use, or missing, they become an empty scene → say so in advance. If only in iCloud, download it
    // (measured 11-23: a photo that was only in iCloud left just a white border on the 3D card)
    const missing: string[] = []
    for (const f of fileRefs(html).slice(0, 60)) {
      const why = !this.d.readable(f)
        ? 'a place Dool2 cannot use'
        : !existsSync(f)
          ? 'file missing'
          : await this.d.local?.(f).catch((e: Error) => e.message)
      if (why) missing.push(why.includes(basename(f)) ? why : `${basename(f)}(${why})`)
    }
    if (missing.length)
      return fail(
        `Cannot load files put in the scenes: ${missing.join(', ')}. Replace them with a path found by file_find or a picture path made by image_make, and call again.`,
      )
    this.busy = true
    const work = await mkdtemp(join(tmpdir(), 'dool2-motion-'))
    try {
      let bin = findFfmpeg(this.d.binDir)
      if (bin && !(await (this.d.hasFilters ?? hasFilters)(bin))) bin = undefined
      if (!bin) bin = await installFfmpeg(this.d.binDir, this.d.fetcher ?? fetch)
      const page = join(work, 'scene.html')
      await writeFile(page, motionDocument(html, shape), 'utf8')
      const frames = join(work, 'frames')
      await mkdir(frames)
      const r = await this.d.render({
        path: page,
        width,
        height,
        fps: FPS,
        duration: length,
        outDir: frames,
        allowFile: (p) => p === page || this.d.readable(p),
      })
      if (r.frames < 2) return fail('Could not draw the scenes. Check the html.')
      const stem =
        (typeof args.name === 'string' && args.name.trim()
          ? args.name
          : motionText(this.d.lang?.() ?? 'ko').defaultName
        )
          .replace(/\.[a-z0-9]{1,5}$/i, '')
          .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
          .trim()
          .slice(0, 60) || motionText(this.d.lang?.() ?? 'ko').defaultName
      await mkdir(dir, { recursive: true })
      let out = join(dir, `${stem}.mp4`)
      // Remake after fixing (replace): overwrite the same name (versions "(2)~(7)" used to pile up — measured 11-23)
      if (args.replace !== true)
        for (let i = 2; existsSync(out) && i < 100; i++) out = join(dir, `${stem} (${i}).mp4`)
      const run = this.d.run ?? runFfmpeg
      const len = r.frames / FPS
      const encoded = join(work, 'out.mp4')
      await run(
        bin,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-framerate',
          String(FPS),
          '-i',
          join(frames, 'frame_%05d.jpg'),
          ...(music ? ['-stream_loop', '-1', '-i', music] : []),
          ...(music
            ? [
                '-filter_complex',
                `[1:a]atrim=0:${len.toFixed(2)},afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, len - 1.5).toFixed(2)}:d=1.5[a]`,
                '-map',
                '0:v',
                '-map',
                '[a]',
                '-c:a',
                'aac',
                '-b:a',
                '160k',
              ]
            : []),
          '-t',
          len.toFixed(2),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          encoded,
        ],
        10 * 60_000,
      )
      // Make it in a temp folder, then swap it in — if the old version exists only in iCloud (EDEADLK) we cannot write straight over it (measured 11-23)
      await rm(out, { force: true }).catch(() => undefined)
      await rename(encoded, out).catch(() => copyFile(encoded, out))
      // One shot per scene as a contact sheet (first 6 scenes) + a preview of the first scene
      const pick = (sec: number) =>
        join(
          frames,
          `frame_${String(Math.min(r.frames, Math.max(1, Math.round(sec * FPS)))).padStart(5, '0')}.jpg`,
        )
      const mids = sceneMiddles(html).slice(0, 6)
      const sheetFile = join(work, 'scenes.jpg')
      const w = shape === 'landscape' ? 360 : 200
      await run(
        bin,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          ...mids.flatMap((t) => ['-i', pick(t)]),
          '-filter_complex',
          `${mids.map((_, i) => `[${i}:v]scale=${w}:-2,pad=iw+6:ih:0:0:white[p${i}]`).join(';')};${mids.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${mids.length}`,
          '-frames:v',
          '1',
          sheetFile,
        ],
        60_000,
      ).catch(() => undefined)
      const sheet =
        mids.length > 1 && existsSync(sheetFile) ? (await readFile(sheetFile)).toString('base64') : undefined
      const posterFile = pick(Math.min(1.5, len / 2))
      const small = existsSync(posterFile)
        ? await this.d.preview?.(await readFile(posterFile)).catch(() => undefined)
        : undefined
      const shown = this.d.show(out)
      const size = (await stat(out)).size
      this.d.onMade?.({ name: basename(out), kind: 'mp4', path: shown, ...(small ? { image: small } : {}) })
      const shot = sheet ?? small
      return {
        content: [
          {
            type: 'text',
            text:
              `Made the motion video: ${shown} (${Math.round(len)} s, ${width}×${height}, ${(size / 1024 / 1024).toFixed(1)}MB). It is also in the library. ` +
              `Below is one shot per scene (${mids.length} scenes). If text is cut off or overlaps, a scene is empty, or it differs from the chosen style or reference, fix the html and remake it under the same name with replace: true (up to twice). Do not make a separate video just to check.`,
          },
          ...(shot ? [{ type: 'image' as const, data: shot, mimeType: 'image/jpeg' }] : []),
        ],
      }
    } catch (e) {
      return fail(`Could not make the motion video: ${(e as Error).message}`)
    } finally {
      this.busy = false
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
