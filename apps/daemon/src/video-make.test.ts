import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FFMPEG_BUILDS,
  filterPath,
  installFfmpeg,
  slideshowArgs,
  slideshowLength,
  VideoMaker,
} from './video-make.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('사진으로 영상 만들기', () => {
  it('사진마다 입력, 장면 전환은 사진 길이마다, 음악은 길이에 맞춰 자른다', () => {
    const args = slideshowArgs({
      photos: ['a.jpg', 'b.jpg', 'c.jpg'],
      captionFiles: ['/t/c0.txt', undefined, undefined],
      titleFile: '/t/title.txt',
      music: 'm.mp3',
      sec: 3,
      shape: 'portrait',
      out: 'o.mp4',
    })
    expect(args.filter((a) => a === '-i')).toHaveLength(4)
    const graph = args[args.indexOf('-filter_complex') + 1] ?? ''
    expect(graph).toContain('xfade=transition=fade:duration=0.7:offset=3.00')
    expect(graph).toContain('offset=6.00')
    expect(graph).toContain("textfile='/t/c0.txt'")
    expect(graph).toContain("textfile='/t/title.txt'")
    expect(graph).toContain(`atrim=0:${slideshowLength(3, 3).toFixed(2)}`)
    expect(args).toContain('[a]')
    expect(args.at(-1)).toBe('o.mp4')
  })

  it('윈도 경로는 필터 안에서 깨지지 않게', () => {
    expect(filterPath('C:\\Windows\\Fonts\\malgun.ttf')).toBe('C\\:/Windows/Fonts/malgun.ttf')
  })

  it('영상 부품은 지문이 맞을 때만 쓴다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-ff-'))
    const bin = Buffer.from('#!/bin/sh\necho ffmpeg\n')
    const gz = gzipSync(bin)
    const key = 'linux-x64'
    const real = FFMPEG_BUILDS[key]
    if (!real) throw new Error('no build')
    const fake = (async () => new Response(gz)) as unknown as typeof fetch
    await expect(installFfmpeg(dir, fake, 'linux', 'x64')).rejects.toThrow('지문')
    const saved = real.sha256
    real.sha256 = createHash('sha256').update(gz).digest('hex')
    try {
      const p = await installFfmpeg(dir, fake, 'linux', 'x64')
      expect(existsSync(p)).toBe(true)
    } finally {
      real.sha256 = saved
    }
  })

  it('만든 영상을 두리 폴더·보관함에 넣고 첫 장면을 돌려준다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-vid-'))
    const work = dir
    const bin = join(work, 'bin')
    await (await import('node:fs/promises')).mkdir(bin)
    await writeFile(join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '')
    const made: { name: string }[] = []
    const ran: string[][] = []
    const maker = new VideoMaker({
      binDir: bin,
      resolveAll: async (list) => list.map((p) => join(work, p)),
      saveDir: () => join(work, 'docs'),
      show: (p) => p,
      onMade: (m) => made.push(m),
      preview: async () => 'SMALL',
      hasFilters: async () => true,
      run: async (_b, args) => {
        ran.push(args)
        await writeFile(String(args.at(-1)), 'x')
      },
    })
    const r = await maker.make({ photos: ['a.jpg', 'b.png'], title: '하늘이 생일', name: '생일 영상' })
    expect(r.isError).toBeUndefined()
    expect(made[0]?.name).toBe('생일 영상.mp4')
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
    expect(ran).toHaveLength(3)
    const bad = await maker.make({ photos: ['a.heic', 'b.jpg'] })
    expect(bad.isError).toBe(true)
  })
})
