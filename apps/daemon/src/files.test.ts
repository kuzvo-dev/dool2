import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { FileTools, officeText, pdfImages, unzip, xlsx, zip } from './files.js'
import { pdfText } from './pdf.js'

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

  it('replace: 두리 폴더의 같은 이름 파일은 고쳐 쓰고, 사용자가 고른 폴더는 그래도 덮어쓰지 않는다', async () => {
    const { home, tools } = setup()
    await tools.run('file_write', { name: '보고서', kind: 'html', text: '<p>처음</p>', look: 'report' })
    const b = text(
      await tools.run('file_write', {
        name: '보고서',
        kind: 'html',
        text: '<p>고친 판</p>',
        look: 'report',
        replace: true,
      }),
    )
    expect(b).toContain('보고서.html')
    expect(b).not.toContain('(2)')
    const html = readFileSync(join(home, 'Documents', '두리', '보고서.html'), 'utf8')
    expect(html).toContain('고친 판')
    // 디자인 틀이 들어간다
    expect(html).toContain('data-dool2-look="report"')
    await tools.run('file_write', { name: '메모', kind: 'txt', text: 'a', folder: 'desktop' })
    const d = text(
      await tools.run('file_write', {
        name: '메모',
        kind: 'txt',
        text: 'b',
        folder: 'desktop',
        replace: true,
      }),
    )
    expect(d).toContain('메모 (2).txt')
  })

  it('새 파일은 덮어쓰지 않고 (2)를 붙인다. 엑셀은 다시 읽으면 같은 표', async () => {
    const { home, tools } = setup()
    const a = text(await tools.run('file_write', { name: '기억 정리', kind: 'md', text: '# 기억\n- 성복역' }))
    const b = text(await tools.run('file_write', { name: '기억 정리', kind: 'md', text: '두 번째' }))
    expect(a).toContain('기억 정리.md')
    expect(b).toContain('기억 정리 (2).md')
    // 기본은 두리 폴더 (문서/두리)
    expect(readFileSync(join(home, 'Documents', '두리', '기억 정리.md'), 'utf8')).toBe('# 기억\n- 성복역')
    await tools.run('file_write', {
      name: '여행 정산',
      kind: 'xlsx',
      rows: [
        ['이름', '금액'],
        ['민수', 12000],
        ['지영 "A"', '8000'],
      ],
    })
    const read = text(await tools.run('file_read', { path: '~/Documents/두리/여행 정산.xlsx' }))
    expect(read).toContain('이름\t금액')
    expect(read).toContain('민수\t12000')
    expect(read).toContain('지영 "A"\t8000')
    // CSV는 엑셀이 한글을 깨지 않게 BOM
    await tools.run('file_write', { name: '표', kind: 'csv', rows: [['가', 'b,c']] })
    expect(readFileSync(join(home, 'Documents', '두리', '표.csv')).subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    )
    expect(readFileSync(join(home, 'Documents', '두리', '표.csv'), 'utf8')).toContain('가,"b,c"')
    expect((await tools.run('file_write', { name: '../밖', kind: 'md', text: 'x' })).isError).toBeFalsy()
    expect(readFileSync(join(home, 'Documents', '두리', '밖.md'), 'utf8')).toBe('x')
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

  it('PDF: 글꼴마다 다른 ToUnicode, 한글 CID 글꼴(UniKS-UCS2-H), 표 칸, 쪽 나눔', async () => {
    // 두 글꼴이 같은 글자 번호(0001·0002)를 서로 다른 한글에 쓴다. 표를 하나로 합치던 예전 방식은 여기서 깨졌다
    const pdf = makePdf(
      [
        [
          text1('F1', 50, 760, '<00010002>'), // 견적
          text1('F2', 50, 740, '<00010002>'), // 금액
          text1('F3', 50, 720, ucs2('품목')),
          text1('F3', 200, 720, ucs2('수량')),
          text1('F3', 300, 720, ucs2('금액')),
          text1('F3', 50, 700, ucs2('욕실 타일')),
          text1('F4', 200, 700, '(2)'),
          text1('F4', 300, 700, '(1,200,000)'),
        ].join('\n'),
        text1('F3', 50, 760, ucs2('합계 1,200,000원')),
      ],
      { F1: ['견', '적'], F2: ['금', '액'] },
    )
    const r = await pdfText(pdf)
    expect(r.pages).toBe(2)
    expect(r.table).toBe(true)
    expect(r.text).toBe(
      '[1쪽]\n견적\n금액\n품목 | 수량 | 금액\n욕실 타일 | 2 | 1,200,000\n\n[2쪽]\n합계 1,200,000원',
    )

    const { home, tools } = setup()
    writeFileSync(join(home, 'Documents', '욕실 견적.pdf'), pdf)
    const out = text(await tools.run('file_read', { path: '~/Documents/욕실 견적.pdf' }))
    expect(out).toContain('(PDF 2쪽,')
    expect(out).toContain('욕실 타일 | 2 | 1,200,000')
    expect(out).toContain("' | '")
  })

  it('PDF가 길면 몇 쪽까지 보여 줬는지와 이어 읽을 자리를 알려 준다', async () => {
    const line = 'Quote line with item and price 1,000 won. '.repeat(2).trim()
    const page = Array.from({ length: 60 }, (_, i) => text1('F4', 20, 780 - i * 12, `(${line})`)).join('\n')
    const pdf = makePdf(Array(7).fill(page), {})
    const { home, tools } = setup()
    writeFileSync(join(home, 'Downloads', '공고문.pdf'), pdf)
    const a = text(await tools.run('file_read', { path: '~/Downloads/공고문.pdf' }))
    const upTo = /PDF 7쪽, [\d,]+자, 이번에 1~(\d)쪽/.exec(a)?.[1]
    expect(upTo).toBeDefined()
    expect(a).toContain(`전체 7쪽 중 ${upTo}쪽까지 보여 드렸어요`)
    expect(a).toContain('이어 읽으려면 from: 30000')
    const b = text(await tools.run('file_read', { path: '~/Downloads/공고문.pdf', from: 30000 }))
    expect(b).toContain(`이번에 ${upTo}~7쪽`)
    expect(b).not.toContain('이어 읽으려면')
  })

  it('글이 없는 스캔 PDF(압축된 그림)는 쪽 그림을 PNG로 넘긴다', async () => {
    const w = 400
    const h = 300
    const pixels = Buffer.alloc(w * h * 3, 200)
    const img = deflateSync(pixels)
    const pdf = makePdf([`q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`], {}, { w, h, data: img })
    const { home, tools } = setup()
    writeFileSync(join(home, 'Downloads', '납부 확인.pdf'), pdf)
    const r = await tools.run('file_read', { path: '~/Downloads/납부 확인.pdf' })
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    const png = Buffer.from((r.content[0] as { data: string }).data, 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(w)
    expect(text(r as never)).toContain('스캔 PDF')
  })
})

// ── 시험용 PDF 만들기 (글꼴 파일 없이 글꼴 정의·ToUnicode만, 내용은 압축 없이) ──

const text1 = (font: string, x: number, y: number, s: string) => `BT /${font} 12 Tf ${x} ${y} Td ${s} Tj ET`
/** UniKS-UCS2-H 글꼴용 글자 (UTF-16BE 16진수) */
const ucs2 = (s: string) => `<${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`

/** pages: 쪽마다 그리기 명령. idFonts: 이름별로 0001·0002…에 대응하는 글자(ToUnicode). F3은 한글 CID, F4는 Helvetica */
function makePdf(
  pages: string[],
  idFonts: Record<string, string[]>,
  image?: { w: number; h: number; data: Buffer },
) {
  const objs: (string | Buffer)[] = []
  /** 객체를 넣고 번호를 돌려준다 */
  const add = (o: string | Buffer) => objs.push(o)
  const stream = (dict: string, body: string | Buffer) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
    return Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${b.length} >>\nstream\n`, 'latin1'),
      b,
      Buffer.from('\nendstream', 'latin1'),
    ])
  }
  const desc = (name: string) =>
    add(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>`,
    )
  const fonts: string[] = []
  for (const [name, chars] of Object.entries(idFonts)) {
    const map = chars.map(
      (c, i) =>
        `<${(i + 1).toString(16).padStart(4, '0')}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`,
    )
    const cmap = add(
      stream(
        '',
        `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Ko${name} def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${map.length} beginbfchar ${map.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`,
      ),
    )
    const d = desc(`Ko${name}`)
    fonts.push(
      `/${name} << /Type /Font /Subtype /Type0 /BaseFont /Ko${name} /Encoding /Identity-H /ToUnicode ${cmap} 0 R /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ko${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${d} 0 R /DW 1000 >>] >>`,
    )
  }
  const kd = desc('HYGoThic-Medium')
  fonts.push(
    `/F3 << /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor ${kd} 0 R /DW 1000 >>] >>`,
    '/F4 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  )
  const im = image
    ? add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
          image.data,
        ),
      )
    : 0
  const res = `<< /Font << ${fonts.join(' ')} >>${im ? ` /XObject << /Im1 ${im} 0 R >>` : ''} >>`
  const pagesId = objs.length + pages.length * 2 + 1
  const kids: number[] = []
  for (const content of pages) {
    const c = add(stream('', content))
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${c} 0 R >>`,
      ),
    )
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')]
  const offsets: number[] = []
  let len = parts[0]?.length ?? 0
  objs.forEach((o, i) => {
    offsets.push(len)
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    parts.push(b)
    len += b.length
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}
