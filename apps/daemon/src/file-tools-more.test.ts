// PDF 합치기·나누기, 휴지통에서 되살리기, 내려받기, 화면 잠그기·잠자기 (ADR 0024 추가).
// 모두 임시 폴더에서만 하고, 바깥 프로그램(셸·전원·인터넷)은 가짜로 바꿔 끼운다 — 이 PC를 실제로 잠그거나 재우지 않는다
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { Approvals } from './approvals.js'
import { checkUrl, dispositionName, privateAddress } from './download.js'
import type { Exec, FileOpsOptions } from './file-ops.js'
import { FileTools } from './files.js'
import { parseScreenLock } from './pc-power.js'
import { pageList } from './pdf-edit.js'
import { putBackInfo } from './trash.js'

/** 가짜 바깥 프로그램: 부른 것을 적어 두고, 정해 둔 답을 돌려준다 */
function fakeExec(
  answer: (cmd: string, args: string[], env?: Record<string, string>) => string | undefined = () => '',
) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = []
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, ...(o?.env ? { env: o.env } : {}) })
    return { code: 0, stdout: answer(cmd, args, o?.env) ?? '', stderr: '' }
  }
  return { exec, calls }
}

function setup(opts: FileOpsOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dool2-more-'))
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Secret']) mkdirSync(join(home, d))
  const approvals = new Approvals()
  const tools = new FileTools(
    {
      desktop: [join(home, 'Desktop')],
      documents: [join(home, 'Documents')],
      downloads: [join(home, 'Downloads')],
    },
    home,
    { approvals, exec: fakeExec().exec, ...opts },
  )
  return { home, tools, approvals, dl: join(home, 'Downloads'), desk: join(home, 'Desktop') }
}
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function pdfOf(pages: number) {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([200, 300])
  return Buffer.from(await d.save())
}
const pagesIn = async (p: string) => (await PDFDocument.load(readFileSync(p))).getPageCount()

describe('PDF 합치기·나누기', () => {
  it('준 순서대로 합쳐 새 PDF를 만들고 원본은 그대로 둔다 (사진도 한 쪽으로)', async () => {
    const { tools, dl } = setup()
    const a = await pdfOf(1)
    writeFileSync(join(dl, '견적 A.pdf'), a)
    writeFileSync(join(dl, '견적 B.pdf'), await pdfOf(2))
    writeFileSync(join(dl, '영수증.png'), PNG)
    const r = await tools.run('file_pdf', {
      paths: ['~/Downloads/견적 A.pdf', '~/Downloads/견적 B.pdf', '~/Downloads/영수증.png'],
    })
    expect(text(r)).toContain('3개를 하나로 합쳤어요')
    expect(text(r)).toContain('견적 A 외 2개 합침.pdf')
    expect(await pagesIn(join(dl, '견적 A 외 2개 합침.pdf'))).toBe(4)
    expect(readFileSync(join(dl, '견적 A.pdf'))).toEqual(a)
    // 같은 이름이 있으면 (1)
    const again = await tools.run('file_pdf', {
      paths: ['~/Downloads/견적 A.pdf', '~/Downloads/견적 B.pdf'],
      name: '견적 A 외 2개 합침',
    })
    expect(text(again)).toContain('견적 A 외 2개 합침 (1).pdf')
  })

  it('쪽 뽑기·범위로 나누기·쪽마다 나누기', async () => {
    const { tools, dl, desk } = setup()
    writeFileSync(join(dl, '계약서.pdf'), await pdfOf(5))
    const one = await tools.run('file_pdf', {
      paths: ['~/Downloads/계약서.pdf'],
      pages: '2-3,5',
      folder: '~/Desktop',
    })
    expect(await pagesIn(join(desk, '계약서 2-3,5쪽.pdf'))).toBe(3)
    expect(text(one)).toContain('~/Desktop')
    const parts = await tools.run('file_pdf', { paths: ['~/Downloads/계약서.pdf'], parts: ['1-2', '3-5'] })
    expect(text(parts)).toContain('2개로 나눴어요')
    expect(await pagesIn(join(dl, '계약서 3-5쪽.pdf'))).toBe(3)
    const each = await tools.run('file_pdf', { paths: ['~/Downloads/계약서.pdf'], split: true })
    expect(text(each)).toContain('5개로 나눴어요')
    expect(existsSync(join(dl, '계약서 5쪽.pdf'))).toBe(true)
    expect(text(await tools.run('file_pdf', { paths: ['~/Downloads/계약서.pdf'], pages: '4-9' }))).toContain(
      '5쪽까지',
    )
  })

  it('볼 수 있는 폴더 밖·PDF가 아닌 것·깨진 PDF는 이유를 알려 준다', async () => {
    const { home, tools, dl } = setup()
    writeFileSync(join(home, 'Secret', 'a.pdf'), await pdfOf(1))
    writeFileSync(join(dl, '메모.docx'), 'x')
    writeFileSync(join(dl, '깨진.pdf'), 'not a pdf')
    expect((await tools.run('file_pdf', { paths: ['~/Secret/a.pdf'] })).isError).toBe(true)
    expect(text(await tools.run('file_pdf', { paths: ['~/Downloads/메모.docx'] }))).toContain('PDF로 저장')
    expect(text(await tools.run('file_pdf', { paths: ['~/Downloads/깨진.pdf'], split: true }))).toContain(
      '열지 못해요',
    )
    expect(pageList('1-3,5', 5)).toEqual([0, 1, 2, 4])
    expect(typeof pageList('3-1', 5)).toBe('string')
  })
})

/** 맥 휴지통 .DS_Store의 "되돌려 놓기" 기록 한 줄 */
function dsRecord(name: string, code: 'ptbL' | 'ptbN', value: string) {
  const u16 = (s: string) => Buffer.from(s, 'utf16le').swap16()
  const n = Buffer.alloc(4)
  n.writeUInt32BE(name.length)
  const v = Buffer.alloc(4)
  v.writeUInt32BE(value.length)
  return Buffer.concat([n, u16(name), Buffer.from(`${code}ustr`, 'latin1'), v, u16(value)])
}

describe('휴지통에서 되살리기 (맥)', () => {
  function macTrash() {
    const s = setup({ platform: 'darwin' })
    const trash = join(s.home, '.Trash')
    mkdirSync(trash)
    // Finder는 볼륨 뿌리부터의 실제 경로를 적는다 (예: "Users/me/Documents/")
    const docs = `${realpathSync(s.home).replace(/^\//, '')}/Documents/`
    writeFileSync(join(trash, '발표 자료.key'), 'slides')
    writeFileSync(join(trash, '기획서 12-30-01.pdf'), 'plan')
    writeFileSync(join(trash, '옛 사진.jpg'), 'pic')
    writeFileSync(join(trash, '이름 모름.txt'), 'x')
    writeFileSync(
      join(trash, '.DS_Store'),
      Buffer.concat([
        Buffer.alloc(36, 1),
        dsRecord('발표 자료.key', 'ptbL', docs),
        Buffer.alloc(8, 0),
        dsRecord('기획서 12-30-01.pdf', 'ptbL', docs),
        dsRecord('기획서 12-30-01.pdf', 'ptbN', '기획서.pdf'),
        dsRecord('옛 사진.jpg', 'ptbL', 'Users/someone/Pictures/'),
      ]),
    )
    return s
  }

  it('.DS_Store에서 원래 자리·원래 이름을 읽는다', () => {
    const m = putBackInfo(
      Buffer.concat([
        dsRecord('a.pdf', 'ptbL', 'Users/me/Documents/'),
        dsRecord('a.pdf', 'ptbN', '원래.pdf'),
      ]),
    )
    expect(m.get('a.pdf')).toEqual({ dir: 'Users/me/Documents/', name: '원래.pdf' })
  })

  it('이름으로 찾고, 하나는 바로 원래 자리로 되살린다', async () => {
    const { tools, home } = macTrash()
    const found = text(await tools.run('file_trash', { query: '발표' }))
    expect(found).toContain('발표 자료.key')
    expect(found).toContain('restore: "발표 자료.key"')
    expect(found).toContain('original place ~/Documents')
    const r = await tools.run('file_trash', { restore: ['발표 자료.key'] })
    expect(text(r)).toContain('1개를 되살렸어요')
    expect(text(r)).toContain('원래 자리')
    expect(readFileSync(join(home, 'Documents', '발표 자료.key'), 'utf8')).toBe('slides')
    expect(existsSync(join(home, '.Trash', '발표 자료.key'))).toBe(false)
  })

  it('여럿은 승인 뒤에: 원래 이름으로, 손대지 않는 폴더·모르는 자리면 바탕화면, 같은 이름은 (1)', async () => {
    const { tools, approvals, home, desk } = macTrash()
    writeFileSync(join(desk, '이름 모름.txt'), '먼저 있던 것')
    const ask = await tools.run('file_trash', {
      restore: ['기획서 12-30-01.pdf', '옛 사진.jpg', '이름 모름.txt'],
    })
    expect(text(ask)).toContain('Approval requested')
    expect(existsSync(join(home, '.Trash', '옛 사진.jpg'))).toBe(true)
    const rec = approvals.list().find((a) => a.status === 'pending')
    expect(rec).toMatchObject({ kind: 'file', ref: 'file_trash', label: '되살리기' })
    expect(rec?.items?.[0]).toContain('기획서.pdf → ~/Documents/')
    const done = await tools.ops.approve(rec?.id ?? '')
    expect(done.ok).toBe(true)
    expect(done.message).toContain('3개를 되살렸어요')
    expect(done.message).toContain('두리가 손대는 폴더가 아니라 바탕화면')
    expect(readFileSync(join(home, 'Documents', '기획서.pdf'), 'utf8')).toBe('plan')
    expect(existsSync(join(desk, '옛 사진.jpg'))).toBe(true)
    expect(readFileSync(join(desk, '이름 모름 (1).txt'), 'utf8')).toBe('x')
    expect(readFileSync(join(desk, '이름 모름.txt'), 'utf8')).toBe('먼저 있던 것')
  })

  it.skipIf(process.getuid?.() === 0)(
    '맥이 휴지통을 막으면 이유와 Finder에서 되돌려 놓는 길을 알려 준다',
    async () => {
      const { tools, home } = macTrash()
      chmodSync(join(home, '.Trash'), 0o000)
      try {
        const r = await tools.run('file_trash', { query: '발표' })
        expect(r.isError).toBe(true)
        expect(text(r)).toContain('전체 디스크 접근 권한')
        expect(text(r)).toContain('되돌려 놓기')
      } finally {
        chmodSync(join(home, '.Trash'), 0o755)
      }
    },
  )
})

describe('휴지통에서 되살리기 (윈도우)', () => {
  it('셸 휴지통 목록을 읽고, 되살리면 셸로 꺼낸다 (같은 이름이 있으면 새 폴더에)', async () => {
    let s: ReturnType<typeof setup> | undefined
    const { exec, calls } = fakeExec((_cmd, args, env) => {
      const script = args.at(-1) ?? ''
      if (script.includes('ConvertTo-Json'))
        return JSON.stringify([
          {
            id: '$RAB12.pptx',
            name: '발표 자료',
            from: join(s?.home ?? '', 'Documents'),
            at: '2026-11-19T01:00:00Z',
            size: 10,
            dir: false,
          },
          {
            id: '$RCD34.txt',
            name: '메모.txt',
            from: 'D:\\작업',
            at: '2026-11-18T01:00:00Z',
            size: 1,
            dir: false,
          },
        ])
      // 셸이 꺼낸 것처럼 원래 이름으로 만들어 둔다
      if (env?.DOOL2_ID === '$RAB12.pptx') writeFileSync(join(env.DOOL2_DEST ?? '', '발표 자료.pptx'), 'p')
      if (env?.DOOL2_ID === '$RCD34.txt') writeFileSync(join(env.DOOL2_DEST ?? '', '메모.txt'), 'm')
      return 'ok'
    })
    s = setup({ platform: 'win32', exec })
    const found = text(await s.tools.run('file_trash', { query: '발표' }))
    expect(found).toContain('발표 자료.pptx')
    expect(found).toContain('restore: "$RAB12.pptx"')
    const one = await s.tools.run('file_trash', { restore: ['$RAB12.pptx'] })
    expect(text(one)).toContain('원래 자리')
    expect(existsSync(join(s.home, 'Documents', '발표 자료.pptx'))).toBe(true)
    // 바탕화면에 같은 이름이 있으면 새 빈 폴더에 꺼낸다 (셸은 이름을 못 바꿔서)
    writeFileSync(join(s.desk, '메모.txt'), '먼저')
    const two = await s.tools.run('file_trash', { restore: ['$RCD34.txt'] })
    expect(text(two)).toContain('원래 자리 D:\\작업는 두리가 손대는 폴더가 아니라 바탕화면')
    expect(readFileSync(join(s.desk, '휴지통에서 되살린 파일', '메모.txt'), 'utf8')).toBe('m')
    expect(readFileSync(join(s.desk, '메모.txt'), 'utf8')).toBe('먼저')
    expect(calls.every((c) => c.cmd === 'powershell.exe')).toBe(true)
  })
})

describe('파일 내려받기', () => {
  const publicIp = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as NonNullable<
    FileOpsOptions['resolve']
  >
  /** 가짜 인터넷: 주소마다 답을 정해 둔다 */
  function web(routes: Record<string, () => Response>) {
    const seen: string[] = []
    const f = (async (u: URL | string) => {
      const key = String(u)
      seen.push(key)
      const r = routes[key]
      return r ? r() : new Response('없음', { status: 404 })
    }) as typeof fetch
    return { f, seen }
  }

  it('파일을 다운로드 폴더에 받고, 사이트가 준 한글 이름·같은 이름 (1)·인터넷에서 받음 표시', async () => {
    const { f } = web({
      'https://files.example.com/d?id=7': () =>
        new Response('PDF-DATA', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition':
              "attachment; filename*=UTF-8''%EA%B0%80%EC%A0%95%ED%86%B5%EC%8B%A0%EB%AC%B8.pdf",
          },
        }),
    })
    const { exec, calls } = fakeExec()
    const { tools, dl } = setup({ platform: 'darwin', exec, fetch: f, resolve: publicIp })
    writeFileSync(join(dl, '가정통신문.pdf'), '먼저')
    const r = await tools.run('file_download', { url: 'https://files.example.com/d?id=7' })
    expect(text(r)).toContain('받았어요: ~/Downloads/가정통신문 (1).pdf')
    expect(readFileSync(join(dl, '가정통신문 (1).pdf'), 'utf8')).toBe('PDF-DATA')
    expect(readFileSync(join(dl, '가정통신문.pdf'), 'utf8')).toBe('먼저')
    expect(calls.find((c) => c.cmd === 'xattr')?.args.slice(0, 2)).toEqual(['-w', 'com.apple.quarantine'])
  })

  it('실행 파일은 받기 전에 승인: confirm 없이는 받지 않고, 승인하면 받는다', async () => {
    const { f } = web({
      'https://dl.example.com/setup.exe': () =>
        new Response('MZ', { headers: { 'content-type': 'application/octet-stream' } }),
    })
    const { tools, approvals, dl } = setup({ platform: 'darwin', fetch: f, resolve: publicIp })
    const first = await tools.run('file_download', { url: 'https://dl.example.com/setup.exe' })
    expect(first.isError).toBe(true)
    expect(text(first)).toContain('confirm: true')
    expect(existsSync(join(dl, 'setup.exe'))).toBe(false)
    const ask = await tools.run('file_download', { url: 'https://dl.example.com/setup.exe', confirm: true })
    expect(text(ask)).toContain('Approval requested')
    const rec = approvals.list().find((a) => a.status === 'pending')
    expect(rec).toMatchObject({ kind: 'file', ref: 'file_download', label: '받기', where: 'dl.example.com' })
    const done = await tools.ops.approve(rec?.id ?? '')
    expect(done.message).toContain('받았어요')
    expect(readFileSync(join(dl, 'setup.exe'), 'utf8')).toBe('MZ')
  })

  it('웹페이지·로그인이 필요한 파일이면 브라우저로 받는 길을 알려 준다', async () => {
    const { f } = web({
      'https://site.example.com/report.pdf': () =>
        new Response('<html>로그인</html>', { headers: { 'content-type': 'text/html' } }),
      'https://site.example.com/private.pdf': () => new Response('', { status: 403 }),
    })
    const { tools, dl } = setup({ fetch: f, resolve: publicIp })
    const html = text(await tools.run('file_download', { url: 'https://site.example.com/report.pdf' }))
    expect(html).toContain('웹페이지')
    expect(html).toContain('browser_open')
    expect(text(await tools.run('file_download', { url: 'https://site.example.com/private.pdf' }))).toContain(
      'browser_click',
    )
    expect(existsSync(join(dl, 'report.pdf'))).toBe(false)
  })

  it('http·이 PC·집 안 주소, 그리로 넘겨주는 주소는 받지 않는다', async () => {
    const { f, seen } = web({
      'https://files.example.com/go': () =>
        new Response(null, { status: 302, headers: { location: 'https://192.168.0.1/x.pdf' } }),
    })
    const { tools } = setup({ fetch: f, resolve: publicIp })
    expect(text(await tools.run('file_download', { url: 'http://files.example.com/a.pdf' }))).toContain(
      'https://',
    )
    expect(text(await tools.run('file_download', { url: 'https://127.0.0.1/a.pdf' }))).toContain(
      '집 안 네트워크',
    )
    expect(text(await tools.run('file_download', { url: 'https://router.local/a.pdf' }))).toContain(
      '집 안 네트워크',
    )
    expect(text(await tools.run('file_download', { url: 'https://files.example.com/go' }))).toContain(
      '넘겨준 주소',
    )
    expect(seen).toEqual(['https://files.example.com/go'])
    const internal = (async () => [{ address: '10.0.0.5', family: 4 }]) as unknown as typeof publicIp
    expect(await checkUrl('https://intranet.example.com/a', internal)).toContain('집 안 네트워크')
    expect(privateAddress('172.20.1.1')).toBe(true)
    expect(privateAddress('::ffff:192.168.1.1')).toBe(true)
    expect(privateAddress('8.8.8.8')).toBe(false)
    expect(dispositionName('attachment; filename="a b.pdf"')).toBe('a b.pdf')
  })
})

describe('화면 잠그기·잠자기', () => {
  it('맥: 승인 뒤에 화면을 잠근다 (잠금 암호 설정을 먼저 본다)', async () => {
    const { exec, calls } = fakeExec((cmd) => (cmd === 'sysadminctl' ? 'screenLock delay is immediate' : ''))
    const { tools, approvals } = setup({ platform: 'darwin', exec })
    const ask = await tools.run('pc_screen', { action: 'lock' })
    expect(text(ask)).toContain('Approval requested')
    expect(calls.map((c) => c.cmd)).toEqual(['sysadminctl'])
    const rec = approvals.list().find((a) => a.status === 'pending')
    expect(rec).toMatchObject({ kind: 'pc', ref: 'pc_screen', label: '화면 잠그기' })
    const done = await tools.ops.approve(rec?.id ?? '')
    expect(done.message).toContain('화면을 잠갔어요')
    expect(calls.at(-1)).toMatchObject({ cmd: 'pmset', args: ['displaysleepnow'] })
  })

  it('맥이 화면이 꺼져도 암호를 묻지 않으면 잠그지 않고 설정 길을 알려 준다', async () => {
    const { exec } = fakeExec((cmd) => (cmd === 'sysadminctl' ? 'screenLock is off' : ''))
    const { tools, approvals } = setup({ platform: 'darwin', exec })
    const r = await tools.run('pc_screen', { action: 'lock' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('시스템 설정 > 잠금 화면')
    expect(approvals.list()).toHaveLength(0)
    expect(parseScreenLock('screenLock delay is 300 seconds')).toBe(300)
  })

  it('잠자기는 두리가 다른 일을 하는 중이면 끝난 뒤에 하라고 한다. 끄기는 하지 않고 잠자기를 권한다', async () => {
    const { exec, calls } = fakeExec()
    let busy = { turns: 2, connecting: ['쿠팡'] }
    const { tools, approvals } = setup({ platform: 'win32', exec, busy: () => busy })
    const r = await tools.run('pc_screen', { action: 'sleep' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('1 chat in progress, connecting 쿠팡')
    expect(text(await tools.run('pc_screen', { action: 'off' }))).toContain('잠자기(action: "sleep")를 권해')
    // 윈도우 잠그기는 일을 멈추지 않아 바쁠 때도 된다
    await tools.run('pc_screen', { action: 'lock' })
    const lock = approvals.list().find((a) => a.status === 'pending')
    expect((await tools.ops.approve(lock?.id ?? '')).ok).toBe(true)
    expect(calls.at(-1)).toMatchObject({ cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] })
    // 일이 끝난 뒤에는 잠자기 승인을 받는다 (승인 때 다시 바쁘면 하지 않는다)
    busy = { turns: 1, connecting: [] }
    await tools.run('pc_screen', { action: 'sleep' })
    const sleep = approvals.list().find((a) => a.status === 'pending')
    expect(sleep?.label).toBe('잠자기')
    busy = { turns: 1, connecting: [] }
    const no = await tools.ops.approve(sleep?.id ?? '')
    expect(no.ok).toBe(false)
    expect(no.message).toContain('끝난 뒤에')
  })
})
