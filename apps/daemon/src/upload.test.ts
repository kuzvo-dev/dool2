import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserTools } from './browser-tools.js'
import { FileTools } from './files.js'
import { mimeOf, notAccepted, UPLOAD_CHUNK } from './upload.js'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dool2-upload-'))
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Secret'])
    mkdirSync(join(home, d))
  const files = new FileTools(
    {
      desktop: [join(home, 'Desktop')],
      documents: [join(home, 'Documents')],
      downloads: [join(home, 'Downloads')],
      pictures: [join(home, 'Pictures')],
      movies: [join(home, 'Movies')],
    },
    home,
  )
  return { home, files }
}
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

const PAGE = `# 블로그 글쓰기
제목 [e1 입력칸 "제목"] [e2 버튼 "사진 추가"] [e3 입력칸 "첨부" 파일 칸] [e4 버튼 "발행"]`

/** 확장 흉내: upload는 needBytes면 조각을 받고, 아니면 경로를 그대로 받은 것처럼 이름을 돌려준다 */
function fakeBrowser(opts: { needBytes?: boolean; drop?: boolean } = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const parts: string[] = []
  return {
    calls,
    parts,
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args])
      if (cmd === 'snapshot')
        return {
          tabId: 3,
          url: 'https://blog.example/write',
          title: '글쓰기',
          text: PAGE,
          truncated: false,
          captcha: false,
        }
      if (cmd === 'screenshot') return { data: 'AAAA' }
      if (cmd === 'upload') {
        if (typeof args?.part === 'string') {
          parts.push(args.part)
          return { parts: parts.length }
        }
        if (args && Array.isArray(args.finish))
          return {
            names: (args.finish as { name: string }[]).map((f) => f.name),
            accept: 'image/*',
            how: 'page',
          }
        if (opts.needBytes) return { needBytes: true, token: 'tok', found: 'near', why: 'Not allowed' }
        const names = ((args?.paths ?? []) as string[]).map((p) => p.split('/').pop() as string)
        return { names: opts.drop ? names.slice(1) : names, accept: '', how: 'cdp', found: 'near' }
      }
      return { tabId: 3 }
    },
  }
}

function tools(files: FileTools, b = fakeBrowser()) {
  const t = new BrowserTools(b)
  t.uploadFiles = (p) => files.uploadable(p)
  return t
}

describe('올릴 파일 울타리 (browser_upload)', () => {
  it('사진·동영상 폴더도 찾고 올릴 수 있다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Pictures', '제주 바다.jpg'), 'jpg')
    writeFileSync(join(home, 'Movies', '쇼츠 1.mp4'), 'mp4')
    expect(text(await files.run('file_find', { query: '쇼츠' }))).toContain('쇼츠 1.mp4')
    expect(text(await files.run('file_find', { query: '', folder: 'pictures' }))).toContain('제주 바다.jpg')
    const v = await files.uploadable(['~/Pictures/제주 바다.jpg', '~/Movies/쇼츠 1.mp4'])
    expect('files' in v && v.files.map((f) => [f.name, f.size, f.show])).toEqual([
      ['제주 바다.jpg', 3, join('~', 'Pictures', '제주 바다.jpg')],
      ['쇼츠 1.mp4', 3, join('~', 'Movies', '쇼츠 1.mp4')],
    ])
  })

  it('폴더 밖·숨은 폴더·민감한 파일·폴더·바로가기로 나가는 경로는 올리지 않는다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Secret', 'a.jpg'), 'x')
    mkdirSync(join(home, 'Pictures', '.hidden'))
    writeFileSync(join(home, 'Pictures', '.hidden', 'b.jpg'), 'x')
    writeFileSync(join(home, 'Documents', 'signPri.key'), 'x')
    writeFileSync(join(home, 'Documents', '비밀번호 모음.txt'), 'x')
    symlinkSync(join(home, 'Secret'), join(home, 'Pictures', 'link'))
    const err = async (p: string) => {
      const v = await files.uploadable([p])
      return 'error' in v ? v.error : ''
    }
    expect(await err('~/Secret/a.jpg')).toContain('밖이에요')
    expect(await err('/etc/hosts')).toContain('밖이에요')
    expect(await err('~/Pictures/../Secret/a.jpg')).toContain('밖이에요')
    expect(await err('~/Pictures/link/a.jpg')).toContain('밖이에요')
    expect(await err('~/Pictures/.hidden/b.jpg')).toContain('민감한')
    expect(await err('~/Documents/signPri.key')).toContain('민감한')
    expect(await err('~/Documents/비밀번호 모음.txt')).toContain('민감한')
    expect(await err('~/Pictures')).toContain('파일이 아니에요')
    expect(await err('')).toContain('경로를 주세요')
  })

  it('사진 보관함 같은 앱 묶음 폴더는 찾을 때 건너뛴다', async () => {
    const { home, files } = setup()
    mkdirSync(join(home, 'Pictures', 'Photos Library.photoslibrary', 'originals'), { recursive: true })
    writeFileSync(join(home, 'Pictures', 'Photos Library.photoslibrary', 'originals', '바다.jpg'), 'x')
    writeFileSync(join(home, 'Pictures', '바다 2.jpg'), 'x')
    const f = text(await files.run('file_find', { query: '바다' }))
    expect(f).toContain('바다 2.jpg')
    expect(f).not.toContain('photoslibrary')
  })

  it('파일 종류와 칸이 받는 종류', () => {
    expect(mimeOf('a.JPG')).toBe('image/jpeg')
    expect(mimeOf('a.mov')).toBe('video/quicktime')
    expect(notAccepted('image/*', ['a.jpg', 'b.mp4'])).toEqual(['b.mp4'])
    expect(notAccepted('.pdf, .hwp', ['a.pdf', 'b.hwp', 'c.jpg'])).toEqual(['c.jpg'])
    expect(notAccepted('', ['a.exe'])).toEqual([])
  })
})

describe('파일 올리기 승인 (browser_upload)', () => {
  it('처음엔 넣지 않고 승인 카드(파일 이름·사이트)를 띄운다. 승인하면 그 칸에 넣는다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Pictures', '제주 바다.jpg'), 'jpg')
    const b = fakeBrowser()
    const t = tools(files, b)
    await t.run('read', { tabId: 3 })
    const r = await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Pictures/제주 바다.jpg'] })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('승인을 요청했어요')
    expect(b.calls.map((c) => c[0])).not.toContain('upload')
    const [rec] = t.approvals.list()
    expect(rec).toMatchObject({
      kind: 'contact',
      where: 'blog.example',
      label: '사진 추가',
      items: [`${join('~', 'Pictures', '제주 바다.jpg')} (1KB)`],
    })
    expect(rec?.what).toContain('제주 바다.jpg')
    const ok = await t.approve(rec?.id as string)
    expect(ok.ok).toBe(true)
    expect(ok.message).toContain('제주 바다.jpg')
    expect(ok.message).toContain('아직 글 올리기·제출은 하지 않았어요')
    const up = b.calls.find((c) => c[0] === 'upload')?.[1]
    expect(up).toMatchObject({ tabId: 3, ref: 'e2' })
    expect(String(((up?.paths ?? []) as string[])[0])).toContain(join('Pictures', '제주 바다.jpg'))
    // 같은 사이트에 같은 파일은 30분 동안 다시 묻지 않는다
    const again = await t.run('upload', { tabId: 3, ref: 'e3', paths: ['~/Pictures/제주 바다.jpg'] })
    expect(text(again)).toContain('파일 칸에 제주 바다.jpg을(를) 넣었어요')
    expect(t.approvals.list()).toHaveLength(1)
  })

  it('다른 파일은 다시 묻는다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Pictures', 'a.jpg'), 'a')
    writeFileSync(join(home, 'Pictures', 'b.jpg'), 'b')
    const t = tools(files)
    await t.run('read', { tabId: 3 })
    await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Pictures/a.jpg'] })
    await t.approve(t.approvals.list()[0]?.id as string)
    const r = await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Pictures/a.jpg', '~/Pictures/b.jpg'] })
    expect(text(r)).toContain('승인을 요청했어요')
  })

  it('폴더 밖 파일·읽지 않은 표시는 승인 카드도 띄우지 않는다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Secret', 'a.jpg'), 'x')
    const t = tools(files)
    await t.run('read', { tabId: 3 })
    const out = await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Secret/a.jpg'] })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('밖이에요')
    const unknown = await t.run('upload', { tabId: 3, ref: 'e99', paths: ['~/Pictures/a.jpg'] })
    expect(unknown.isError).toBe(true)
    expect(t.approvals.list()).toHaveLength(0)
  })

  it('확장이 경로로 못 넣으면(파일 접근 꺼짐) 조각으로 나눠 보낸다', async () => {
    const { home, files } = setup()
    const big = Buffer.alloc(UPLOAD_CHUNK * 2 + 10, 7)
    writeFileSync(join(home, 'Movies', '쇼츠.mp4'), big)
    const b = fakeBrowser({ needBytes: true })
    const t = tools(files, b)
    await t.run('read', { tabId: 3 })
    await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Movies/쇼츠.mp4'] })
    const ok = await t.approve(t.approvals.list()[0]?.id as string)
    expect(ok.ok).toBe(true)
    expect(b.parts).toHaveLength(3)
    expect(Buffer.concat(b.parts.map((p) => Buffer.from(p, 'base64'))).equals(big)).toBe(true)
    const fin = b.calls.find((c) => Array.isArray(c[1]?.finish))?.[1]
    expect(fin?.finish).toEqual([
      { name: '쇼츠.mp4', type: 'video/mp4', lastModified: expect.any(Number), parts: 3 },
    ])
    // 칸이 사진만 받는다고 적혀 있으면 알린다
    expect(ok.message).toContain('"image/*"만 받는다')
  })

  it('칸에 들어가지 않은 파일이 있으면 넣었다고 하지 않는다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Pictures', 'a.jpg'), 'a')
    writeFileSync(join(home, 'Pictures', 'b.jpg'), 'b')
    const t = tools(files, fakeBrowser({ drop: true }))
    await t.run('read', { tabId: 3 })
    await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Pictures/a.jpg', '~/Pictures/b.jpg'] })
    const r = await t.approve(t.approvals.list()[0]?.id as string)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('a.jpg did not go into the file input')
  })

  it('승인한 뒤 화면이 바뀌었으면 넣지 않는다', async () => {
    const { home, files } = setup()
    writeFileSync(join(home, 'Pictures', 'a.jpg'), 'a')
    const b = fakeBrowser()
    const t = tools(files, b)
    await t.run('read', { tabId: 3 })
    await t.run('upload', { tabId: 3, ref: 'e2', paths: ['~/Pictures/a.jpg'] })
    const real = b.call
    b.call = async (cmd, args) => {
      const r = (await real(cmd, args)) as Record<string, unknown>
      return cmd === 'snapshot' ? { ...r, url: 'https://blog.example/other' } : r
    }
    const r = await t.approve(t.approvals.list()[0]?.id as string)
    expect(r.ok).toBe(false)
    expect(b.calls.map((c) => c[0])).not.toContain('upload')
  })
})

describe('대화로 보낸 사진 올리기', () => {
  it('[사진: 이름.jpg]·이름만 줘도 받은 사진 폴더에서 찾는다', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { FileTools } = await import('./files.js')
    const home = mkdtempSync(join(tmpdir(), 'dool2-sent-'))
    const photos = join(home, 'ws', 'photos')
    mkdirSync(photos, { recursive: true })
    writeFileSync(join(photos, '2026-11-21T01-00-00-000Z.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const ft = new FileTools(undefined, home)
    ft.sentPhotos = photos
    const r = await ft.uploadable(['[사진: 2026-11-21T01-00-00-000Z.jpg]'])
    expect('files' in r && r.files[0]?.show).toBe('대화로 보낸 사진')
    const bad = await ft.uploadable(['../secret.jpg'])
    expect('error' in bad).toBe(true)
  })
})
