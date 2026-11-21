// HTML을 PDF·PNG로 (file_render). 그리는 부품(PC 앱의 보이지 않는 창)은 가짜로 바꿔 끼운다
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { FileOpsOptions } from './file-ops.js'
import { FileTools } from './files.js'
import { type HtmlRenderer, type HtmlRenderRequest, NO_RENDERER, renderOutPath } from './render.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
async function pdfOf(pages: number) {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([595, 842])
  return Buffer.from(await d.save())
}

/** 가짜 그리기 부품: 받은 요청을 적어 두고 PDF(3쪽)·PNG를 돌려준다 */
function fakeRenderer(answer?: (r: HtmlRenderRequest) => Promise<Buffer>) {
  const calls: HtmlRenderRequest[] = []
  const renderFile: HtmlRenderer = async (r) => {
    calls.push(r)
    const data = answer ? await answer(r) : r.to === 'pdf' ? await pdfOf(3) : PNG
    return r.to === 'png' ? { data, width: 1600, height: 2400, preview: 'cHJldmlldw==' } : { data }
  }
  return { renderFile, calls }
}

function setup(opts: FileOpsOptions = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dool2-render-')))
  for (const d of ['Desktop', 'Documents/두리', 'Downloads', 'Secret'])
    mkdirSync(join(home, d), { recursive: true })
  const tools = new FileTools(
    {
      desktop: [join(home, 'Desktop')],
      documents: [join(home, 'Documents')],
      downloads: [join(home, 'Downloads')],
    },
    home,
    opts,
  )
  const written: { name: string; kind: string; path: string; image?: string }[] = []
  tools.onWritten = (f) => written.push(f)
  return { home, tools, written, doori: join(home, 'Documents', '두리') }
}
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')

describe('HTML을 PDF·PNG로 (file_render)', () => {
  it('보고서 HTML을 원본 옆 같은 이름.pdf로 만들고 쪽 수와 경로를 알려 준다', async () => {
    const fake = fakeRenderer()
    const { tools, doori, written } = setup({ renderFile: fake.renderFile })
    writeFileSync(join(doori, '11월 보고서.html'), '<h1>보고서</h1>')
    const r = await tools.run('file_render', { path: '~/Documents/두리/11월 보고서.html', to: 'pdf' })
    expect(r.isError).toBeUndefined()
    const out = join(doori, '11월 보고서.pdf')
    expect(existsSync(out)).toBe(true)
    expect((await PDFDocument.load(readFileSync(out))).getPageCount()).toBe(3)
    expect(text(r)).toContain('11월 보고서.pdf')
    expect(text(r)).toContain('A4 3쪽')
    expect(text(r)).toContain('경로를 그대로 알려')
    // 원본은 그대로, 그리기 부품에는 실제 경로와 PDF가 간다
    expect(existsSync(join(doori, '11월 보고서.html'))).toBe(true)
    expect(fake.calls[0]).toMatchObject({ path: join(doori, '11월 보고서.html'), to: 'pdf' })
    expect(fake.calls[0]?.width).toBeUndefined()
    // 보관함에도 올린다
    expect(written).toEqual([
      { name: '11월 보고서.pdf', kind: 'pdf', path: expect.stringContaining('11월 보고서.pdf') },
    ])
  })

  it('같은 이름이 있으면 "(1)"을 붙이고 덮어쓰지 않는다', async () => {
    const fake = fakeRenderer()
    const { tools, doori } = setup({ renderFile: fake.renderFile })
    writeFileSync(join(doori, '초대장.html'), '<svg></svg>')
    writeFileSync(join(doori, '초대장.png'), 'old')
    const r = await tools.run('file_render', { path: '~/Documents/두리/초대장.html', to: 'png', width: 600 })
    expect(text(r)).toContain('초대장 (1).png')
    expect(readFileSync(join(doori, '초대장.png'), 'utf8')).toBe('old')
    expect(readFileSync(join(doori, '초대장 (1).png')).equals(PNG)).toBe(true)
    expect(text(r)).toContain('1600×2400')
    expect(fake.calls[0]).toMatchObject({ to: 'png', width: 600 })
    expect(renderOutPath(join(doori, '초대장.html'), 'png')).toBe(join(doori, '초대장 (2).png'))
    expect(renderOutPath(join(doori, '초대장.html'), 'pdf')).toBe(join(doori, '초대장.pdf'))
  })

  it('PNG 미리보기는 보관함 그림으로, 가로 PDF·너비 한도도 넘긴다', async () => {
    const fake = fakeRenderer()
    const { tools, doori, written } = setup({ renderFile: fake.renderFile })
    writeFileSync(join(doori, '생일.htm'), '<p>파티</p>')
    await tools.run('file_render', { path: join(doori, '생일.htm'), to: 'png', width: 99_999 })
    expect(fake.calls[0]?.width).toBe(3000)
    expect(written[0]).toMatchObject({ kind: 'png', image: 'cHJldmlldw==' })
    await tools.run('file_render', { path: join(doori, '생일.htm'), to: 'pdf', landscape: true, width: 500 })
    expect(fake.calls[1]).toMatchObject({ to: 'pdf', landscape: true })
    expect(fake.calls[1]?.width).toBeUndefined()
  })

  it('사용자 폴더 밖·민감한 파일·HTML이 아닌 파일은 그리지 않는다', async () => {
    const fake = fakeRenderer()
    const { tools, home, doori } = setup({ renderFile: fake.renderFile })
    writeFileSync(join(home, 'Secret', 'a.html'), '<p>비밀</p>')
    expect(text(await tools.run('file_render', { path: '~/Secret/a.html', to: 'pdf' }))).toContain('밖이에요')
    // 바로가기로 밖에 나가는 것도
    symlinkSync(join(home, 'Secret', 'a.html'), join(doori, '바로가기.html'))
    expect(
      (await tools.run('file_render', { path: '~/Documents/두리/바로가기.html', to: 'pdf' })).isError,
    ).toBe(true)
    expect((await tools.run('file_render', { path: '~/Documents/두리/../../Secret/a.html' })).isError).toBe(
      true,
    )
    writeFileSync(join(doori, 'password.html'), '<p>x</p>')
    expect(text(await tools.run('file_render', { path: '~/Documents/두리/password.html' }))).toContain(
      '민감한',
    )
    writeFileSync(join(doori, '메모.md'), '# 메모')
    expect(text(await tools.run('file_render', { path: '~/Documents/두리/메모.md' }))).toContain(
      'file_write로 html',
    )
    writeFileSync(join(doori, '계약서.pdf'), await pdfOf(1))
    expect(
      text(await tools.run('file_render', { path: '~/Documents/두리/계약서.pdf', to: 'png' })),
    ).toContain('이미 PDF')
    expect(text(await tools.run('file_render', { to: 'pdf' }))).toContain('path')
    expect(fake.calls).toHaveLength(0)
  })

  it('그리는 HTML이 불러도 되는 로컬 파일은 사용자 폴더 안·민감하지 않은 것만', async () => {
    const fake = fakeRenderer()
    const { tools, home, doori } = setup({ renderFile: fake.renderFile })
    writeFileSync(join(doori, '안내.html'), '<img src="사진.png">')
    writeFileSync(join(doori, '사진.png'), PNG)
    writeFileSync(join(home, 'Secret', 'x.png'), PNG)
    await tools.run('file_render', { path: '~/Documents/두리/안내.html', to: 'pdf' })
    const allow = fake.calls[0]?.allowFile
    expect(allow?.(join(doori, '사진.png'))).toBe(true)
    expect(allow?.(join(doori, '안내.html'))).toBe(true)
    expect(allow?.(join(home, 'Secret', 'x.png'))).toBe(false)
    expect(allow?.(join(doori, '없는.png'))).toBe(false)
    expect(allow?.('/etc/passwd')).toBe(false)
  })

  it('PC 앱 없이(그리는 부품 없음) 돌면 이유를 알리고 파일은 만들지 않는다', async () => {
    const { tools, doori } = setup()
    writeFileSync(join(doori, '보고서.html'), '<h1>x</h1>')
    const r = await tools.run('file_render', { path: '~/Documents/두리/보고서.html', to: 'pdf' })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe(NO_RENDERER)
    expect(existsSync(join(doori, '보고서.pdf'))).toBe(false)
  })

  it('그리다 실패하거나 깨진 결과·너무 오래 걸리면 파일을 남기지 않는다', async () => {
    const { tools, doori } = setup({
      renderFile: fakeRenderer(async (r) => {
        if (r.path.endsWith('느림.html')) return new Promise(() => {})
        if (r.path.endsWith('오류.html')) throw new Error('창을 못 열었어요')
        return Buffer.from('not a pdf')
      }).renderFile,
      renderTimeoutMs: 50,
    })
    for (const n of ['느림', '오류', '깨짐']) writeFileSync(join(doori, `${n}.html`), '<p>x</p>')
    expect(text(await tools.run('file_render', { path: '~/Documents/두리/느림.html', to: 'pdf' }))).toContain(
      '오래 걸려',
    )
    expect(text(await tools.run('file_render', { path: '~/Documents/두리/오류.html', to: 'pdf' }))).toContain(
      '창을 못 열었어요',
    )
    expect(text(await tools.run('file_render', { path: '~/Documents/두리/깨짐.html', to: 'pdf' }))).toContain(
      '깨졌어요',
    )
    expect(text(await tools.run('file_render', { path: '~/Documents/두리/깨짐.html', to: 'png' }))).toContain(
      '깨졌어요',
    )
    for (const n of ['느림', '오류', '깨짐'])
      for (const e of ['pdf', 'png']) expect(existsSync(join(doori, `${n}.${e}`))).toBe(false)
  })
})
