// 모션그래픽 영상 (video_motion): 두리가 장면 HTML(모션 키트 이름표)을 쓰면 PC 앱이 한 장씩 찍고(renderMotion)
// 영상 부품(ffmpeg)이 mp4로 묶는다. 사진을 잇기만 하는 video_make보다 움직임이 풍부하다(키네틱 타이포·색종이·콜라주·전환).
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MOTION_SHAPES, type MotionShape, motionDocument, motionLength } from './motion-kit.js'
import { findFfmpeg, hasFilters, installFfmpeg, runFfmpeg } from './video-make.js'

export interface MotionRenderRequest {
  /** 그릴 HTML (임시 폴더) */
  path: string
  width: number
  height: number
  fps: number
  /** 초 */
  duration: number
  /** 장면을 쓸 폴더 (frame_00001.jpg …) */
  outDir: string
  /** 그 HTML이 불러도 되는 로컬 파일인지 (사용자 폴더의 사진) */
  allowFile(path: string): boolean
}
export interface MotionRenderResult {
  frames: number
}
export type MotionRenderer = (req: MotionRenderRequest) => Promise<MotionRenderResult>

export interface MotionDeps {
  binDir: string
  render?: MotionRenderer
  /** 사용자 폴더 안·민감하지 않은 파일인지 (장면에 넣는 사진) */
  readable: (p: string) => boolean
  /** 배경음악 확인 */
  resolveAll: (paths: string[]) => Promise<string[] | { error: string }>
  saveDir: () => string | undefined
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

/** 장면마다 가운데 시각 (초) — 두리가 장면을 하나씩 확인하는 모음 그림 */
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
        '이 PC에서는 모션 영상을 그릴 수 없어요(PC 앱이 필요해요). video_make로 사진 영상을 만들어요.',
      )
    const html = typeof args.html === 'string' ? args.html : ''
    if (!/class="[^"]*\bscene\b/.test(html))
      return fail('html에 <section class="scene" data-dur="3">…</section> 장면을 하나 이상 넣어 주세요.')
    if (html.length > 400_000) return fail('html이 너무 길어요(400KB까지). 사진은 file:/// 경로로 넣어요.')
    const length = motionLength(html)
    if (length <= 0 || length > MAX_SECONDS)
      return fail(`영상 길이(장면 data-dur 합)는 ${MAX_SECONDS}초까지예요. 지금 ${length}초예요.`)
    const shape: MotionShape = args.shape === 'landscape' || args.shape === 'square' ? args.shape : 'portrait'
    const [width, height] = MOTION_SHAPES[shape]
    const dir = this.d.saveDir()
    if (!dir) return fail('문서 폴더를 찾지 못했어요.')
    let music: string | undefined
    if (typeof args.music === 'string' && args.music.trim()) {
      const m = await this.d.resolveAll([args.music.trim()])
      if (!Array.isArray(m) || !m[0] || !/\.(mp3|m4a|aac|wav)$/i.test(m[0]))
        return fail('배경음악은 사용자 폴더의 mp3·m4a 파일만 쓸 수 있어요.')
      music = m[0]
    }
    if (this.busy) return fail('다른 영상을 만드는 중이에요. 끝난 뒤에 다시 불러 주세요.')
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
      if (r.frames < 2) return fail('장면을 그리지 못했어요. html을 확인해 주세요.')
      const stem =
        (typeof args.name === 'string' && args.name.trim() ? args.name : '두리 모션 영상')
          .replace(/\.[a-z0-9]{1,5}$/i, '')
          .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
          .trim()
          .slice(0, 60) || '두리 모션 영상'
      await mkdir(dir, { recursive: true })
      let out = join(dir, `${stem}.mp4`)
      for (let i = 2; existsSync(out) && i < 100; i++) out = join(dir, `${stem} (${i}).mp4`)
      const run = this.d.run ?? runFfmpeg
      const len = r.frames / FPS
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
          out,
        ],
        10 * 60_000,
      )
      // 장면마다 한 컷 모음 (앞 6장면) + 첫 장면 미리보기
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
              `모션 영상을 만들었어요: ${shown} (${Math.round(len)}초, ${width}×${height}, ${(size / 1024 / 1024).toFixed(1)}MB). 보관함에도 올렸어요. ` +
              `아래는 장면마다 한 컷(${mids.length}장면)이에요. 글자가 잘리거나 겹치고, 장면이 비거나, 부탁한 분위기(레퍼런스)와 다르면 html을 고쳐 다시 만들어요(두 번까지). 확인용 영상을 따로 만들지 않아요.`,
          },
          ...(shot ? [{ type: 'image' as const, data: shot, mimeType: 'image/jpeg' }] : []),
        ],
      }
    } catch (e) {
      return fail(`모션 영상을 만들지 못했어요: ${(e as Error).message}`)
    } finally {
      this.busy = false
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
