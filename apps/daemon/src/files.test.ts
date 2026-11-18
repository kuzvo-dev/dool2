import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileTools, officeText, pdfImages, pdfText, unzip, xlsx, zip } from './files.js'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'dool2-files-'))
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Secret']) mkdirSync(join(home, d))
  const folders = {
    desktop: [join(home, 'Desktop')],
    documents: [join(home, 'Documents')],
    downloads: [join(home, 'Downloads')],
  }
  return { home, tools: new FileTools(folders, home) }
}
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')

describe('PC 파일 도구', () => {
  it('이름으로 찾고 읽는다 (한글 이름, 맥의 자모 나눈 이름도)', async () => {
    const { home, tools } = setup()
    writeFileSync(join(home, 'Downloads', '임대차 계약서.txt'), '보증금 1억 원, 월세 50만 원')
    writeFileSync(join(home, 'Documents', '11월 정산'.normalize('NFD') + '.csv'), '날짜,금액\n11/3,12000')
    const f = text(await tools.run('file_find', { query: '계약서' }))
    expect(f).toContain('임대차 계약서.txt')
    expect(text(await tools.run('file_find', { query: '정산' }))).toContain('.csv')
    const r = await tools.run('file_read', { path: '~/Downloads/임대차 계약서.txt' })
    expect(text(r)).toContain('보증금 1억 원')
  })

  it('사용자 폴더 밖·민감한 파일·바로가기로 나가는 경로는 읽지 않는다', async () => {
    const { home, tools } = setup()
    writeFileSync(join(home, 'Secret', 'a.txt'), '비밀')
    writeFileSync(join(home, 'Documents', 'id_rsa'), 'KEY')
    mkdirSync(join(home, 'Documents', 'NPKI'))
    writeFileSync(join(home, 'Documents', 'NPKI', 'signPri.key'), 'x')
    symlinkSync(join(home, 'Secret'), join(home, 'Desktop', 'link'))
    expect((await tools.run('file_read', { path: '~/Secret/a.txt' })).isError).toBe(true)
    expect((await tools.run('file_read', { path: '~/Documents/../Secret/a.txt' })).isError).toBe(true)
    expect((await tools.run('file_read', { path: '~/Desktop/link/a.txt' })).isError).toBe(true)
    expect((await tools.run('file_read', { path: '~/Documents/id_rsa' })).isError).toBe(true)
    expect((await tools.run('file_read', { path: '~/Documents/NPKI/signPri.key' })).isError).toBe(true)
  })

  it('새 파일은 덮어쓰지 않고 (2)를 붙인다. 엑셀은 다시 읽으면 같은 표', async () => {
    const { home, tools } = setup()
    const a = text(await tools.run('file_write', { name: '기억 정리', kind: 'md', text: '# 기억\n- 성복역' }))
    const b = text(await tools.run('file_write', { name: '기억 정리', kind: 'md', text: '두 번째' }))
    expect(a).toContain('기억 정리.md')
    expect(b).toContain('기억 정리 (2).md')
    expect(readFileSync(join(home, 'Desktop', '기억 정리.md'), 'utf8')).toBe('# 기억\n- 성복역')
    await tools.run('file_write', {
      name: '여행 정산',
      kind: 'xlsx',
      rows: [
        ['이름', '금액'],
        ['민수', 12000],
        ['지영 "A"', '8000'],
      ],
    })
    const read = text(await tools.run('file_read', { path: '~/Desktop/여행 정산.xlsx' }))
    expect(read).toContain('이름\t금액')
    expect(read).toContain('민수\t12000')
    expect(read).toContain('지영 "A"\t8000')
    // CSV는 엑셀이 한글을 깨지 않게 BOM
    await tools.run('file_write', { name: '표', kind: 'csv', rows: [['가', 'b,c']] })
    expect(readFileSync(join(home, 'Desktop', '표.csv')).subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    )
    expect(readFileSync(join(home, 'Desktop', '표.csv'), 'utf8')).toContain('가,"b,c"')
    expect((await tools.run('file_write', { name: '../밖', kind: 'md', text: 'x' })).isError).toBeFalsy()
    expect(readFileSync(join(home, 'Desktop', '밖.md'), 'utf8')).toBe('x')
  })

  it('워드·파워포인트·한글(hwpx) 글을 뽑는다', () => {
    const docx = zip([
      [
        'word/document.xml',
        '<w:document><w:body><w:p><w:r><w:t>첫 줄</w:t></w:r><w:r><w:t xml:space="preserve"> 이어서</w:t></w:r></w:p><w:p><w:r><w:t>둘째 &amp; 줄</w:t></w:r></w:p></w:body></w:document>',
      ],
    ])
    expect(officeText(docx, '.docx')).toBe('첫 줄 이어서\n둘째 & 줄')
    const pptx = zip([['ppt/slides/slide1.xml', '<p:sld><a:t>제목</a:t><a:t>내용</a:t></p:sld>']])
    expect(officeText(pptx, '.pptx')).toContain('[슬라이드 1]\n제목\n내용')
    const hwpx = zip([
      ['Contents/section0.xml', '<hs:sec><hp:p><hp:run><hp:t>한글 문서</hp:t></hp:run></hp:p></hs:sec>'],
    ])
    expect(officeText(hwpx, '.hwpx')).toBe('한글 문서')
    expect(unzip(xlsx([['a']])).has('xl/worksheets/sheet1.xml')).toBe(true)
  })

  it('사진은 그림으로, 스캔 PDF는 안의 사진을 그림으로 넘긴다', async () => {
    const { home, tools } = setup()
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(30_000, 7),
      Buffer.from([0xff, 0xd9]),
    ])
    writeFileSync(join(home, 'Downloads', '면허증.jpg'), jpeg)
    const r = await tools.run('file_read', { path: '~/Downloads/면허증.jpg' })
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    const pdf = Buffer.concat([
      Buffer.from(
        '%PDF-1.4\n1 0 obj <</Type /XObject /Subtype /Image /Filter /DCTDecode /Length 30006>> stream\n',
        'latin1',
      ),
      jpeg,
      Buffer.from('\nendstream endobj\n%%EOF', 'latin1'),
    ])
    expect(pdfImages(pdf)).toHaveLength(1)
    writeFileSync(join(home, 'Documents', '사업자등록증.pdf'), pdf)
    const s = await tools.run('file_read', { path: '~/Documents/사업자등록증.pdf' })
    expect(s.content[0]).toMatchObject({ type: 'image' })
    expect(text(s as never)).toContain('스캔 PDF')
  })

  it('PDF: 글 그리기 명령과 한글 글꼴 표(ToUnicode)', () => {
    const cmap =
      '/CIDInit /ProcSet findresource begin begincmap 1 beginbfchar <0001> <D55C> endbfchar 1 beginbfrange <0002> <0003> <AE00> endbfrange endcmap'
    const page = 'BT /F1 12 Tf (Hello) Tj ET\nBT <000100020003> Tj ET'
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj <<>> stream\n${cmap}\nendstream endobj\n2 0 obj <</Length 9>> stream\n${page}\nendstream endobj\n%%EOF`,
      'latin1',
    )
    expect(pdfText(pdf)).toBe('Hello\n한글긁')
  })
})
