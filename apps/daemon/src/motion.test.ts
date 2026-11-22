import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MotionMaker, sceneMiddles } from './motion.js'
import { motionDocument, motionLength } from './motion-kit.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const HTML =
  '<section class="scene" data-dur="2"><h1 class="pop">하나</h1></section><section class="scene grad" data-dur="3.5"><p class="words">둘 셋</p></section>'

describe('모션 키트', () => {
  it('장면 길이를 더하고, 장면마다 가운데쯤 시각을 고른다', () => {
    expect(motionLength(HTML)).toBe(5.5)
    expect(sceneMiddles(HTML)).toEqual([1.4, 2 + 3.5 * 0.7])
  })

  it('크기·키트를 넣고, 두리가 쓴 스크립트는 뺀다', () => {
    const doc = motionDocument(`${HTML}<script>alert(1)</script>`, 'portrait')
    expect(doc).toContain('--w:1080px;--h:1920px')
    expect(doc).not.toContain('alert(1)')
    expect(doc).toContain('@keyframes k-pop')
    expect(motionDocument(HTML, 'landscape')).toContain('--w:1920px;--h:1080px')
  })
})

describe('모션 영상 만들기', () => {
  it('장면을 찍고 묶어 두리 폴더·보관함에 넣고, 장면 모음을 돌려준다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-motion-'))
    const work = dir
    const bin = join(work, 'bin')
    await (await import('node:fs/promises')).mkdir(bin)
    await writeFile(join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '')
    const made: { name: string }[] = []
    const asked: { width: number; duration: number }[] = []
    const maker = new MotionMaker({
      binDir: bin,
      render: async (req) => {
        asked.push(req)
        for (let i = 1; i <= 10; i++)
          await writeFile(join(req.outDir, `frame_${String(i).padStart(5, '0')}.jpg`), 'x')
        return { frames: 10 }
      },
      readable: () => true,
      resolveAll: async (l) => l,
      saveDir: () => join(work, 'docs'),
      show: (p) => p,
      onMade: (m) => made.push(m),
      preview: async () => 'SMALL',
      hasFilters: async () => true,
      run: async (_b, args) => {
        await writeFile(String(args.at(-1)), 'x')
      },
    })
    const r = await maker.make({ html: HTML, name: '생일 모션' })
    expect(r.isError).toBeUndefined()
    expect(asked[0]).toMatchObject({ width: 1080, duration: 5.5 })
    expect(made[0]?.name).toBe('생일 모션.mp4')
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
  })

  it('장면이 없거나 너무 길면 거절한다', async () => {
    const maker = new MotionMaker({
      binDir: tmpdir(),
      render: async () => ({ frames: 0 }),
      readable: () => true,
      resolveAll: async (l) => l,
      saveDir: () => tmpdir(),
      show: (p) => p,
    })
    expect((await maker.make({ html: '<p>장면 없음</p>' })).isError).toBe(true)
    expect((await maker.make({ html: '<section class="scene" data-dur="120"></section>' })).isError).toBe(
      true,
    )
  })

  it('PC 앱이 없으면(그리는 부품 없음) video_make로 안내한다', async () => {
    const maker = new MotionMaker({
      binDir: tmpdir(),
      readable: () => true,
      resolveAll: async (l) => l,
      saveDir: () => tmpdir(),
      show: (p) => p,
    })
    expect(JSON.stringify((await maker.make({ html: HTML })).content)).toContain('video_make')
  })
})
