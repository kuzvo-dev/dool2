// PC 파일 옮기기·사진 바꾸기·출력 (ADR 0024). 모두 임시 폴더에서만 하고, 출력은 가짜 프린터 명령으로 본다
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Approvals } from './approvals.js'
import type { Exec, FileOpsOptions } from './file-ops.js'
import { FileTools } from './files.js'

function setup(opts: FileOpsOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dool2-fileops-'))
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Secret']) mkdirSync(join(home, d))
  const folders = {
    desktop: [join(home, 'Desktop')],
    documents: [join(home, 'Documents')],
    downloads: [join(home, 'Downloads')],
  }
  const approvals = new Approvals()
  const tools = new FileTools(folders, home, {
    approvals,
    movesLog: join(home, 'data', 'file-moves.json'),
    ...opts,
  })
  return { home, tools, approvals, dl: join(home, 'Downloads') }
}
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
/** 1×1 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('PC 파일 옮기기', () => {
  it('여러 개는 승인 카드(무엇을 어디로)를 받고 옮긴다. 같은 이름은 (1), 되돌리면 원래 자리로', async () => {
    const { tools, approvals, dl } = setup()
    writeFileSync(join(dl, '영수증_0312.pdf'), 'a')
    writeFileSync(join(dl, '임대차 계약서.pdf'), 'b')
    mkdirSync(join(dl, '영수증'))
    writeFileSync(join(dl, '영수증', '영수증_0312.pdf'), '먼저 있던 것')
    const ask = await tools.run('file_move', {
      moves: [
        { from: '~/Downloads/영수증_0312.pdf', folder: '~/Downloads/영수증' },
        { from: '~/Downloads/임대차 계약서.pdf', folder: '~/Downloads/계약서' },
        { from: '~/Secret/x.pdf', folder: '~/Downloads/기타' },
      ],
    })
    expect(ask.isError).toBeFalsy()
    expect(text(ask)).toContain('Approval requested')
    expect(text(ask)).toContain('Skipped 1')
    // 승인 전에는 아무것도 옮기지 않는다
    expect(existsSync(join(dl, '영수증_0312.pdf'))).toBe(true)
    expect(existsSync(join(dl, '계약서'))).toBe(false)
    const rec = approvals.list().find((a) => a.status === 'pending')
    expect(rec).toMatchObject({ kind: 'file', tabId: -2, ref: 'file_move', url: 'file:move' })
    expect(rec?.items).toEqual([
      `영수증_0312.pdf → ~/Downloads/영수증/영수증_0312 (1).pdf`,
      `임대차 계약서.pdf → ~/Downloads/계약서/`,
    ])
    expect(rec?.what).toContain('파일 2개 옮기기')

    const r = await tools.ops.approve(rec?.id ?? '')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('2개를 옮겼어요')
    expect(r.message).toContain('영수증_0312 (1).pdf')
    expect(r.message).toContain('undo: true')
    expect(readFileSync(join(dl, '영수증', '영수증_0312.pdf'), 'utf8')).toBe('먼저 있던 것')
    expect(readFileSync(join(dl, '영수증', '영수증_0312 (1).pdf'), 'utf8')).toBe('a')
    expect(readFileSync(join(dl, '계약서', '임대차 계약서.pdf'), 'utf8')).toBe('b')
    expect(approvals.get(rec?.id ?? '')?.status).toBe('done')
    // 같은 승인을 두 번 쓸 수 없다
    expect((await tools.ops.approve(rec?.id ?? '')).ok).toBe(false)

    const back = await tools.run('file_move', { undo: true })
    expect(text(back)).toContain('Moved 2 of the 2 moved on')
    expect(readFileSync(join(dl, '영수증_0312.pdf'), 'utf8')).toBe('a')
    expect(readFileSync(join(dl, '임대차 계약서.pdf'), 'utf8')).toBe('b')
    // 이번에 만든 빈 폴더는 치우고, 원래 있던 폴더와 그 안 파일은 그대로
    expect(existsSync(join(dl, '계약서'))).toBe(false)
    expect(readdirSync(join(dl, '영수증'))).toEqual(['영수증_0312.pdf'])
    expect((await tools.run('file_move', { undo: true })).isError).toBe(true)
  })

  it('하나는 바로 한다: 이름 바꾸기는 확장자를 지키고, 기록은 다시 켜도 남아 되돌릴 수 있다', async () => {
    const { home, tools, approvals, dl } = setup()
    writeFileSync(join(dl, 'scan001.pdf'), 'x')
    const r = await tools.run('file_move', {
      moves: [{ from: '~/Downloads/scan001.pdf', name: '11월 관리비' }],
    })
    expect(text(r)).toContain('1개를 옮겼어요')
    expect(existsSync(join(dl, '11월 관리비.pdf'))).toBe(true)
    expect(approvals.list()).toHaveLength(0)
    // 본체를 다시 켠 것처럼 새로 만들어도 기록 파일로 되돌린다
    const again = new FileTools(
      { desktop: [join(home, 'Desktop')], documents: [join(home, 'Documents')], downloads: [dl] },
      home,
      { approvals, movesLog: join(home, 'data', 'file-moves.json') },
    )
    expect(text(await again.run('file_move', { undo: true }))).toContain('back to where they were')
    expect(existsSync(join(dl, 'scan001.pdf'))).toBe(true)
  })

  it('볼 수 있는 폴더 밖·폴더 자체·민감한 파일·밖으로 옮기기는 하지 않는다', async () => {
    const { home, tools, dl } = setup()
    writeFileSync(join(home, 'Secret', 'a.txt'), '비밀')
    writeFileSync(join(dl, 'id_rsa'), 'KEY')
    writeFileSync(join(dl, 'a.txt'), 'a')
    const one = async (m: Record<string, unknown>) => tools.run('file_move', { moves: [m] })
    expect((await one({ from: '~/Secret/a.txt', folder: '~/Downloads' })).isError).toBe(true)
    expect((await one({ from: '~/Downloads', folder: '~/Desktop' })).isError).toBe(true)
    expect((await one({ from: '~/Downloads/id_rsa', folder: '~/Desktop' })).isError).toBe(true)
    expect((await one({ from: '~/Downloads/a.txt', folder: '~/Secret' })).isError).toBe(true)
    expect((await one({ from: '~/Downloads/a.txt', folder: '~/Downloads/../../밖' })).isError).toBe(true)
    expect((await one({ from: '~/Downloads/a.txt', folder: '~/Downloads/.숨김' })).isError).toBe(true)
    expect(readFileSync(join(dl, 'a.txt'), 'utf8')).toBe('a')
    expect(existsSync(join(home, 'Secret', 'a.txt'))).toBe(true)
  })

  it('찾기는 limit으로 30개보다 많이 보여 준다', async () => {
    const { tools, dl } = setup()
    for (let i = 0; i < 40; i++) writeFileSync(join(dl, `영수증 ${i}.pdf`), 'x')
    expect(text(await tools.run('file_find', { query: '영수증' }))).toContain('Latest 30 of 40')
    const all = text(await tools.run('file_find', { query: '영수증', limit: 100 }))
    expect(all).toContain('40:')
    expect(all.match(/영수증 \d+\.pdf/g)).toHaveLength(40)
  })
})

describe('사진 형식 바꾸기', () => {
  it.skipIf(process.platform !== 'darwin')(
    '맥: 폴더의 PNG를 JPG로 새로 만들고 원본은 두며, 다시 하면 건너뛴다',
    async () => {
      const { tools, dl } = setup()
      mkdirSync(join(dl, '사진'))
      writeFileSync(join(dl, '사진', 'a.png'), PNG)
      writeFileSync(join(dl, '사진', 'b.png'), PNG)
      writeFileSync(join(dl, '사진', '메모.txt'), 'x')
      const r = await tools.run('file_convert', { paths: ['~/Downloads/사진'], only: ['png'] })
      expect(text(r)).toContain('Converted 2 to JPG')
      const jpg = readFileSync(join(dl, '사진', 'a.jpg'))
      expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8])
      expect(existsSync(join(dl, '사진', 'a.png'))).toBe(true)
      const again = await tools.run('file_convert', { paths: ['~/Downloads/사진'] })
      expect(text(again)).toContain('Skipped 2')
      // 다른 폴더에 두기
      const out = await tools.run('file_convert', {
        paths: ['~/Downloads/사진/a.png'],
        folder: '~/Desktop/JPG',
      })
      expect(text(out)).toContain('Converted 1 to JPG')
      expect(existsSync(join(dl, '..', 'Desktop', 'JPG', 'a.jpg'))).toBe(true)
      // 아이폰 HEIC: sips로 하나 만들어 HEIC만 골라 바꾼다
      execFileSync('sips', [
        '-s',
        'format',
        'heic',
        join(dl, '사진', 'a.png'),
        '--out',
        join(dl, '사진', 'IMG_0001.HEIC'),
      ])
      const heic = await tools.run('file_convert', { paths: ['~/Downloads/사진'], only: ['heic'] })
      expect(text(heic)).toContain('Converted 1 to JPG')
      expect(existsSync(join(dl, '사진', 'IMG_0001.jpg'))).toBe(true)
      expect(existsSync(join(dl, '사진', 'IMG_0001.HEIC'))).toBe(true)
    },
  )

  it('바꿀 방법이 없는 PC·사진이 아닌 파일은 이유를 알려 준다', async () => {
    const { tools, dl } = setup({ platform: 'linux' })
    writeFileSync(join(dl, 'a.heic'), 'x')
    writeFileSync(join(dl, 'a.txt'), 'x')
    expect(text(await tools.run('file_convert', { paths: ['~/Downloads/a.heic'] }))).toContain(
      'macOS and Windows only',
    )
    expect(text(await tools.run('file_convert', { paths: ['~/Downloads/a.txt'] }))).toContain(
      'not a photo file',
    )
  })

  it('윈도우: 형식을 여는 부품이 없으면 이유와 다음 길을 알려 준다', async () => {
    const calls: string[] = []
    const exec: Exec = async (cmd, _args, o) => {
      calls.push(cmd)
      const jobs = JSON.parse(o?.env?.DOOL2_JOBS ?? '[]') as { i: number }[]
      return { code: 0, stdout: jobs.map((j) => `err ${j.i} -2003292336`).join('\r\n'), stderr: '' }
    }
    const { tools, dl } = setup({ platform: 'win32', exec })
    writeFileSync(join(dl, 'IMG_1.HEIC'), 'x')
    const r = await tools.run('file_convert', { paths: ['~/Downloads/IMG_1.HEIC'] })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('HEIF Image Extensions')
    expect(calls).toEqual(['powershell.exe'])
  })
})

describe('출력', () => {
  /** 가짜 CUPS: 프린터 목록·상태와 lp 호출을 기록한다 (실제 프린터로 보내지 않는다) */
  function cups(printers: Record<string, string>, def?: string) {
    const calls: string[][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'lpstat' && args[0] === '-e')
        return Object.keys(printers).length
          ? { code: 0, stdout: `${Object.keys(printers).join('\n')}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'lpstat: 추가된 대상이 없습니다.' }
      if (cmd === 'lpstat' && args[0] === '-d')
        return { code: 0, stdout: def ? `시스템 기본 대상: ${def}\n` : '시스템 기본 대상 없음\n', stderr: '' }
      if (cmd === 'lpoptions') return { code: 0, stdout: printers[args[1] ?? ''] ?? '', stderr: '' }
      if (cmd === 'lp') return { code: 0, stdout: 'request id is Brother_HL-7 (1 file(s))\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'unknown' }
    }
    return { exec, calls }
  }
  const IDLE = 'printer-is-accepting-jobs=true printer-state=3 printer-state-reasons=none'

  it('프린터가 없으면 이유와 추가하는 곳을 알려 준다', async () => {
    const { exec } = cups({})
    const { tools, dl } = setup({ platform: 'darwin', exec })
    writeFileSync(join(dl, '학습지.pdf'), '%PDF')
    const r = await tools.run('file_print', { path: '~/Downloads/학습지.pdf' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('No printer is connected')
    expect(text(r)).toContain('Printers & Scanners')
  })

  it('승인을 받은 뒤에만 기본 프린터로 보낸다 (매수·쪽)', async () => {
    const { exec, calls } = cups({ Brother_HL: IDLE, Canon: IDLE }, 'Brother_HL')
    const { tools, approvals, dl } = setup({ platform: 'darwin', exec })
    writeFileSync(join(dl, '학습지.pdf'), '%PDF')
    const list = text(await tools.run('file_print', {}))
    expect(list).toContain('Brother_HL (default): ready')
    const ask = await tools.run('file_print', { path: '~/Downloads/학습지.pdf', copies: 2, pages: '1-3' })
    expect(text(ask)).toContain('Approval requested')
    expect(calls.some((c) => c[0] === 'lp')).toBe(false)
    const rec = approvals.list().find((a) => a.status === 'pending')
    expect(rec).toMatchObject({
      kind: 'print',
      ref: 'file_print',
      where: 'Brother_HL',
      what: '"학습지.pdf" 2부 출력 (1-3쪽)',
    })
    const r = await tools.ops.approve(rec?.id ?? '')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('작업 Brother_HL-7')
    expect(calls.find((c) => c[0] === 'lp')).toEqual([
      'lp',
      '-d',
      'Brother_HL',
      '-n',
      '2',
      '-o',
      'page-ranges=1-3',
      '--',
      join(dl, '학습지.pdf').replace(/^\/var\//, '/private/var/'),
    ])
  })

  it('꺼진 프린터·못 여는 형식은 승인 전에 이유를 알려 준다', async () => {
    const { exec } = cups({ HP: 'printer-state=3 printer-state-reasons=offline-report' }, 'HP')
    const { tools, approvals, dl } = setup({ platform: 'darwin', exec })
    writeFileSync(join(dl, '학습지.pdf'), '%PDF')
    writeFileSync(join(dl, '학습지.docx'), 'x')
    writeFileSync(join(dl, 'IMG.heic'), 'x')
    expect(text(await tools.run('file_print', { path: '~/Downloads/학습지.pdf' }))).toContain('offline')
    expect(text(await tools.run('file_print', { path: '~/Downloads/학습지.docx' }))).toContain('saved as PDF')
    expect(text(await tools.run('file_print', { path: '~/Downloads/IMG.heic' }))).toContain('file_convert')
    expect(approvals.list()).toHaveLength(0)
  })

  it('윈도우: 프린터 목록에서 가상 프린터(PDF)는 종이로 치지 않는다', async () => {
    const exec: Exec = async () => ({
      code: 0,
      stdout: JSON.stringify([
        { Name: 'Microsoft Print to PDF', Default: true, WorkOffline: false, PrinterStatus: 3 },
        { Name: '삼성 SL-M2030', Default: false, WorkOffline: true, PrinterStatus: 7 },
      ]),
      stderr: '',
    })
    const { tools, dl } = setup({ platform: 'win32', exec })
    writeFileSync(join(dl, 'a.pdf'), '%PDF')
    const r = text(await tools.run('file_print', { path: '~/Downloads/a.pdf' }))
    expect(r).toContain('삼성 SL-M2030: off or disconnected')
  })
})
