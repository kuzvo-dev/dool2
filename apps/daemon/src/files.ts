// PC 파일 도구 (ADR 0022): 사용자 폴더(바탕화면·문서·다운로드·사진·동영상)에서 찾기·읽기, 새 파일 만들기.
// AI 기본 도구(셸·파일)는 끈 채로(ADR 0003) 두리 도구로만 연다. 지우기·덮어쓰기는 없다.
// 옮기기·이름 바꾸기, 사진 형식 바꾸기, 출력은 file-ops.ts (ADR 0024, 승인·되돌리기와 함께).
// 읽기: 글·CSV·JSON·HTML, 워드(docx)·엑셀(xlsx)·파워포인트(pptx)·한글(hwpx), PDF(pdf.ts, 쪽마다 줄·표를 살려).
// 민감한 파일(인증서·키·비밀번호 파일·숨은 폴더)은 읽지 않는다.

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { FileOps, type FileOpsOptions } from './file-ops.js'
import { type PdfText, pdfScanImages, pdfText } from './pdf.js'

export interface FileToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
/** AI에게 넘기는 그림 한 장의 한도 (모델이 받는 크기) */
const IMAGE_MAX = 4_500_000
const ok = (text: string): FileToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): FileToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** 두리가 다루는 사용자 폴더. 윈도우는 OneDrive로 옮겨진 바탕화면·문서도 */
/** 두리가 만든 파일을 모으는 폴더 (문서 아래) */
import { applyLook, DOC_LOOKS, type DocLook } from './doc-kit.js'

export const DOORI_FOLDER = '두리'

export type FolderKey = 'desktop' | 'documents' | 'downloads' | 'pictures' | 'movies'
/** 두리가 다루는 폴더들. 사진·동영상은 블로그 사진·영상 올리기(browser_upload) 때문에 더했다 (없으면 빈 목록) */
export type UserFolders = Record<'desktop' | 'documents' | 'downloads', string[]> &
  Partial<Record<'pictures' | 'movies', string[]>>
/** 사용자에게 알리는 폴더 이름들 */
export const FOLDERS_TEXT = '바탕화면·문서·다운로드·사진·동영상'

export function userFolders(home = homedir()): Record<FolderKey, string[]> {
  const pick = (...names: string[]) =>
    [...new Set(names.map((n) => join(home, n)).filter((p) => existsSync(p)))].map((p) => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    })
  return {
    desktop: pick('Desktop', 'OneDrive/Desktop', 'OneDrive/바탕 화면', '바탕 화면'),
    documents: pick('Documents', 'OneDrive/Documents', 'OneDrive/문서', '문서'),
    downloads: pick('Downloads', '다운로드'),
    pictures: pick('Pictures', 'OneDrive/Pictures', 'OneDrive/사진', '사진'),
    // 맥은 Movies, 윈도우는 Videos
    movies: pick('Movies', 'Videos', 'OneDrive/Videos', 'OneDrive/동영상', '동영상'),
  }
}

const FOLDER_LABEL: Record<FolderKey, string> = {
  desktop: '바탕화면',
  documents: '문서',
  downloads: '다운로드',
  pictures: '사진',
  movies: '동영상',
}

// 읽지 않는 것: 숨은 파일·폴더, 공동인증서(NPKI), 키·인증서 파일, 비밀번호·지갑 파일, 환경 설정 비밀값
const SENSITIVE =
  /(^|[/\\])\.|npki|gpki|signcert|signpri|\.(pem|key|p12|pfx|der|cer|crt|keychain|kdbx|ovpn|ppk)$|id_rsa|id_ed25519|wallet|비밀번호|password|passwd/i
// 찾을 때 건너뛰는 폴더 (무겁거나 사용자 문서가 아닌 것)
const SKIP_DIR =
  /^(node_modules|Library|AppData|\.git|\$RECYCLE\.BIN|System Volume Information|Photo Booth Library)$|\.(photoslibrary|photolibrary|migratedphotolibrary|aplibrary|imovielibrary|fcpbundle|tvlibrary)$/i

/** 웹사이트에 올릴 파일 (browser_upload) */
export interface UploadFile {
  /** 실제 경로 (바로가기를 푼 것) */
  path: string
  name: string
  size: number
  mtime: number
  /** 사용자에게 보이는 경로 (~/Pictures/a.jpg) */
  show: string
}
export const UPLOAD_MAX_FILES = 20
export const UPLOAD_MAX_BYTES = 4 * 1024 ** 3

/** 파일 이름을 비교할 모양으로 (맥은 한글 이름을 자모로 나눠 저장한다: NFC로 맞춘다) */
const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, '')

export class FileTools {
  private readonly folders: Record<FolderKey, string[]>
  private readonly home: string
  /** 옮기기·사진 바꾸기·출력 (승인은 opts.approvals로) */
  readonly ops: FileOps
  /** 사용자가 대화로 보낸 사진을 두는 곳 ("[사진: 이름.jpg]") — 웹사이트에 올릴 수 있다 */
  sentPhotos?: string
  /** 새 파일을 만들었을 때 (보관함에 올린다) */
  /** 사진으로 영상 만들기 (video_make, 본체가 넣어 준다) */
  videoMaker?: { make(args: Record<string, unknown>): Promise<FileToolResult> }
  /** 그림 AI로 그림 만들기 (image_make, 본체가 브라우저와 함께 넣어 준다) */
  imageMaker?: { make(args: Record<string, unknown>): Promise<FileToolResult> }
  onWritten?: (f: {
    name: string
    kind: string
    path: string
    text?: string
    rows?: unknown[][]
    /** 미리보기 그림 (JPEG base64, HTML을 PNG로 그린 것) */
    image?: string
  }) => void
  constructor(folders?: UserFolders, home = homedir(), opts: FileOpsOptions = {}) {
    // 실제 경로로 맞춘다 (맥은 /var → /private/var 같은 바로가기가 있다)
    const real = (p: string) => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    const f = folders ?? userFolders(home)
    this.folders = {
      desktop: f.desktop.map(real),
      documents: f.documents.map(real),
      downloads: f.downloads.map(real),
      pictures: (f.pictures ?? []).map(real),
      movies: (f.movies ?? []).map(real),
    }
    this.home = real(home)
    this.ops = new FileOps(
      {
        inside: (p) => this.inside(p),
        insideNew: (p) => this.insideNew(p),
        show: (p) => this.show(p),
        roots: () => this.roots(),
        sensitive: (p) => SENSITIVE.test(p),
        home: this.home,
        folder: (key) => this.folders[key]?.[0],
        read: (p) => readLocal(p),
      },
      opts,
    )
    // HTML을 PDF·PNG로 그린 파일도 새로 만든 파일이라 보관함에 올린다
    this.ops.onRendered = (f) => this.onWritten?.(f)
  }

  private roots() {
    return Object.values(this.folders).flat()
  }

  /** 아직 없을 수도 있는 폴더(옮길 곳·새 파일 둘 곳): 있는 데까지 실제 경로로 바꿔 사용자 폴더 안인지 본다 */
  private insideNew(p: string): string | undefined {
    const raw = p.startsWith('~') ? join(this.home, p.slice(1)) : resolve(this.home, p)
    const rest: string[] = []
    let at = raw
    while (!existsSync(at)) {
      const up = resolve(at, '..')
      if (up === at) return undefined
      rest.unshift(basename(at))
      at = up
    }
    let real: string
    try {
      real = realpathSync(at)
    } catch {
      return undefined
    }
    // 새로 만들 이름에 숨은 이름(.으로 시작)·못 쓰는 글자는 받지 않는다
    if (rest.some((n) => n.startsWith('.') || /[:*?"<>|]/.test(n) || !n.trim())) return undefined
    const out = join(real, ...rest)
    if (SENSITIVE.test(out)) return undefined
    return this.roots().some((r) => out === r || out.startsWith(r + sep)) ? out : undefined
  }

  /** 사용자 폴더 안의 실제 경로만 (../·바로가기로 밖에 나가는 것 막기) */
  private inside(p: string): string | undefined {
    const raw = p.startsWith('~') ? join(this.home, p.slice(1)) : resolve(this.home, p)
    let real: string
    try {
      real = realpathSync(raw)
    } catch {
      return undefined
    }
    return this.roots().some((r) => real === r || real.startsWith(r + sep)) ? real : undefined
  }

  /** 폴더 (첫 번째 후보) */
  dir(key: FolderKey): string | undefined {
    return this.folders[key]?.[0]
  }

  /** 사용자에게 보여 줄 경로 모양 */
  shown(p: string): string {
    return this.show(p)
  }

  private show(p: string) {
    return `~${sep}${relative(this.home, p)}`
  }

  /**
   * 웹사이트에 올릴 파일 확인 (browser_upload). 읽기와 같은 울타리: 사용자 폴더 안의 보통 파일만,
   * 숨은 폴더·인증서·키·비밀번호 파일은 안 된다. 실제 경로(바로가기를 푼 것)·이름·크기를 돌려준다
   */
  async uploadable(paths: string[]): Promise<{ files: UploadFile[] } | { error: string }> {
    const list = paths.map((p) => String(p ?? '').trim()).filter(Boolean)
    if (!list.length) return { error: '올릴 파일 경로를 주세요. file_find로 먼저 찾아요.' }
    if (list.length > UPLOAD_MAX_FILES) return { error: `한 번에 ${UPLOAD_MAX_FILES}개까지만 올려요.` }
    const files: UploadFile[] = []
    for (const raw of list) {
      // 대화로 받은 사진은 이름만으로 (실측 11-21: 보낸 사진이 PC 폴더에 없다며 블로그에 못 붙임)
      const sent = /^(?:\[사진:\s*)?([\w-]+\.jpg)\]?$/.exec(raw)
      if (sent && this.sentPhotos) {
        const sp = join(this.sentPhotos, sent[1] as string)
        const st = await stat(sp).catch(() => undefined)
        if (st?.isFile()) {
          if (!files.some((f) => f.path === sp))
            files.push({
              path: sp,
              name: basename(sp),
              size: st.size,
              mtime: st.mtimeMs,
              show: '대화로 보낸 사진',
            })
          continue
        }
      }
      const p = this.inside(raw)
      if (!p)
        return {
          error: `${basename(raw)}: 없거나 ${FOLDERS_TEXT} 밖이에요. file_find로 경로를 먼저 찾아 주세요.`,
        }
      if (SENSITIVE.test(p))
        return { error: `${basename(p)}: 인증서·키·비밀번호 같은 민감한 파일은 웹사이트에 올리지 않아요.` }
      const s = await stat(p).catch(() => undefined)
      if (!s?.isFile()) return { error: `${basename(p)}: 파일이 아니에요(폴더는 올릴 수 없어요).` }
      if (s.size > UPLOAD_MAX_BYTES) return { error: `${basename(p)}: 4GB보다 큰 파일은 올리지 않아요.` }
      const away = await ensureLocal(p)
      if (away) return { error: away }
      if (!files.some((f) => f.path === p))
        files.push({ path: p, name: basename(p), size: s.size, mtime: s.mtimeMs, show: this.show(p) })
    }
    return { files }
  }

  async run(tool: string, args: Record<string, unknown>): Promise<FileToolResult> {
    try {
      if (tool === 'file_find')
        return await this.find(
          String(args.query ?? ''),
          args.folder as FolderKey | undefined,
          Number(args.limit ?? 0) || undefined,
        )
      if (tool === 'file_read') return await this.read(String(args.path ?? ''), Number(args.from ?? 0) || 0)
      if (tool === 'file_write')
        return await this.write({
          name: String(args.name ?? ''),
          kind: String(args.kind ?? 'md'),
          text: typeof args.text === 'string' ? args.text : undefined,
          rows: Array.isArray(args.rows) ? (args.rows as unknown[][]) : undefined,
          ...(args.folder ? { folder: args.folder as FolderKey } : {}),
          ...(DOC_LOOKS.includes(args.look as DocLook) ? { look: args.look as DocLook } : {}),
          ...(args.replace === true ? { replace: true } : {}),
        })
      if (tool === 'file_move') return await this.ops.move(args)
      if (tool === 'file_convert') return await this.ops.convert(args)
      if (tool === 'file_print') return await this.ops.print(args)
      if (tool === 'file_pdf') return await this.ops.pdf(args)
      if (tool === 'file_render') return await this.ops.render(args)
      if (tool === 'video_make')
        return this.videoMaker ? await this.videoMaker.make(args) : fail('이 PC에서는 영상을 만들 수 없어요.')
      if (tool === 'image_make')
        return this.imageMaker
          ? await this.imageMaker.make(args)
          : fail('그림 AI를 쓸 브라우저가 연결돼 있지 않아요. HTML로 그려 file_render로 PNG를 만들어요.')
      if (tool === 'file_trash') return await this.ops.trash(args)
      if (tool === 'file_download') return await this.ops.download(args)
      if (tool === 'pc_screen') return await this.ops.power(args)
      return fail(`모르는 파일 도구예요: ${tool}`)
    } catch (e) {
      return fail((e as Error).message)
    }
  }

  /** 이름으로 찾기: 바탕화면·문서·다운로드·사진·동영상(4단계 아래까지), 최근에 바뀐 것 먼저 30개(limit으로 300개까지) */
  async find(query: string, folder?: FolderKey, limit = 30): Promise<FileToolResult> {
    const max = Math.min(Math.max(Math.floor(limit), 1), 300)
    const words = norm(query)
      .split(/[,·]/)
      .map((w) => w.trim())
      .filter(Boolean)
    const roots = folder && this.folders[folder] ? this.folders[folder] : this.roots()
    const hits: { path: string; size: number; mtime: number; dir: boolean }[] = []
    let seen = 0
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || seen > 8000) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        seen++
        if (e.name.startsWith('.') || SKIP_DIR.test(e.name)) continue
        const p = join(dir, e.name)
        const n = norm(e.name)
        if (!words.length || words.every((w) => n.includes(w))) {
          const s = await stat(p).catch(() => undefined)
          if (s) hits.push({ path: p, size: s.size, mtime: s.mtimeMs, dir: e.isDirectory() })
        }
        if (e.isDirectory()) await walk(p, depth + 1)
      }
    }
    for (const r of roots) await walk(r, 0)
    hits.sort((a, b) => b.mtime - a.mtime)
    if (!hits.length) return ok(`"${query}"이(가) 들어간 파일을 ${FOLDERS_TEXT}에서 찾지 못했어요.`)
    const kb = (n: number) =>
      n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
    const day = (t: number) =>
      new Date(t).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    return ok(
      `${hits.length > max ? `${hits.length}개 중 최근 ${max}개` : `${hits.length}개`}:\n` +
        hits
          .slice(0, max)
          .map((h) => `- ${this.show(h.path)}${h.dir ? sep : ` (${kb(h.size)}, ${day(h.mtime)})`}`)
          .join('\n') +
        (hits.length > max ? `\n다 보려면 limit을 늘려(300까지) 다시 찾아 주세요.` : '') +
        '\n읽으려면 file_read, 옮기거나 이름을 바꾸려면 file_move, 사진 형식은 file_convert, 출력은 file_print, 웹사이트(블로그·영상·서류 첨부)에 올리려면 browser_upload에 이 경로를 그대로 주세요.',
    )
  }

  /** 읽기: 글로 바꿔 3만 자씩. from으로 이어 읽는다 */
  async read(path: string, from = 0): Promise<FileToolResult> {
    const p = this.inside(path)
    if (!p) return fail(`${FOLDERS_TEXT} 안의 파일만 읽을 수 있어요. file_find로 경로를 먼저 찾아 주세요.`)
    if (SENSITIVE.test(p)) return fail('인증서·키·비밀번호 같은 민감한 파일은 두리가 읽지 않아요.')
    const s = await stat(p)
    if (s.isDirectory()) return this.listDir(p)
    if (s.size > 30 << 20) return fail('30MB보다 큰 파일은 읽지 않아요.')
    const buf = await readLocal(p)
    if (typeof buf === 'string') return fail(buf)
    const ext = extname(p).toLowerCase()
    let text: string
    let note = ''
    let pdf: PdfText | undefined
    if (['.docx', '.xlsx', '.pptx', '.hwpx'].includes(ext)) text = officeText(buf, ext)
    else if (ext === '.pdf') {
      let why = ''
      try {
        pdf = await pdfText(buf)
      } catch (e) {
        why = (e as Error).message
      }
      // 글이 거의 없으면(쪽마다 열 자 미만) 스캔한 PDF로 본다
      text = pdf && pdf.letters >= pdf.pages * 10 ? pdf.text : ''
      if (pdf?.table)
        note =
          "\n(표는 같은 줄의 칸을 ' | '로 나눴어요. 빈칸이 있으면 칸이 밀려 보일 수 있으니 항목과 금액을 짝지어 읽어 주세요.)"
      if (!text) {
        // 스캔한 PDF: 안에 든 사진을 보여 준다 (사업자등록증·납세증명서 스캔). JPEG는 그대로, 아니면 풀어서 PNG로
        let imgs = pdfImages(buf)
          .slice(0, 3)
          .map((data) => ({ data, mimeType: 'image/jpeg' }))
        if (!imgs.length && pdf)
          imgs = (await pdfScanImages(buf).catch(() => []))
            .filter((data) => data.length <= IMAGE_MAX)
            .map((data) => ({ data, mimeType: 'image/png' }))
        if (imgs.length) {
          const of = pdf && pdf.pages > imgs.length ? `${pdf.pages}쪽 중 앞 ` : ''
          return {
            content: [
              ...imgs.map((m) => ({
                type: 'image' as const,
                data: m.data.toString('base64'),
                mimeType: m.mimeType,
              })),
              {
                type: 'text',
                text: `${this.show(p)}: 글이 없는 스캔 PDF라 ${of}쪽 그림 ${imgs.length}장을 보여 드려요. 그림에 보이는 내용으로 답하고, 주민번호·카드 번호 같은 민감한 값은 옮겨 적지 않아요.`,
              },
            ],
          }
        }
        // 그림도 없으면 몇 글자라도 나온 글을 그대로 보여 준다
        if (pdf?.letters) text = pdf.text
        else return fail(why || '이 PDF에서는 글도 그림도 뽑지 못했어요. 사용자에게 알려 주세요.')
      }
    } else if (ext === '.hwp')
      return fail('한글(.hwp) 파일은 아직 못 읽어요. 한글에서 hwpx나 PDF로 저장해 주시면 읽을 수 있어요.')
    else if (/^\.(png|jpe?g|gif|webp|heic|heif)$/.test(ext)) return this.image(p, buf, ext)
    else if (/\.(zip|exe|dmg|mp4|mov|mp3|m4a|wav)$/i.test(ext))
      return fail('글이 아닌 파일이라 읽을 수 없어요. (녹음은 받아쓰기한 글이 있어야 해요)')
    else {
      text = buf.toString('utf8').replace(/^﻿/, '')
      // UTF-8이 아니면(옛 한국어 CSV는 EUC-KR) 깨진 글자가 많다
      if ((text.match(/�/g)?.length ?? 0) > 20) {
        try {
          text = new TextDecoder('euc-kr').decode(buf)
        } catch {}
      }
      if (ext === '.html' || ext === '.htm') text = stripTags(text)
    }
    const CHUNK = 30_000
    const part = text.slice(from, from + CHUNK)
    const more = from + CHUNK < text.length
    // PDF는 전체 쪽 수와 이번에 보여 준 쪽을 알려 준다
    const pageAt = (i: number) => (pdf ? pdf.pageStarts.findLastIndex((s) => s <= i) + 1 : 0)
    const head = pdf
      ? `PDF ${pdf.pages}쪽, ${text.length.toLocaleString()}자${from || more ? `, 이번에 ${pageAt(from)}~${pageAt(Math.min(text.length, from + CHUNK) - 1)}쪽` : ''}`
      : `${text.length.toLocaleString()}자${from ? `, ${from}자부터` : ''}`
    return ok(
      `${this.show(p)} (${head})\n\n${part}` +
        (more
          ? `\n\n… ${pdf ? `전체 ${pdf.pages}쪽 중 ${pageAt(from + CHUNK - 1)}쪽까지 보여 드렸어요. ` : ''}뒤에 ${(text.length - from - CHUNK).toLocaleString()}자 더 있어요. 이어 읽으려면 from: ${from + CHUNK}`
          : '') +
        note,
    )
  }

  /** 사진 파일: 그림으로 넘긴다 (면허증·영수증 사진). 아이폰 HEIC는 맥에서 sips로 JPEG로 바꾼다 */
  private async image(p: string, buf: Buffer, ext: string): Promise<FileToolResult> {
    let data = buf
    let mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/jpeg'
    if (ext === '.heic' || ext === '.heif' || buf.length > IMAGE_MAX) {
      // 큰 사진·HEIC: 맥이면 sips로 줄여 JPEG로 (윈도우는 아직)
      if (process.platform !== 'darwin')
        return fail('이 사진 형식·크기는 아직 못 읽어요. JPEG로 저장해 주세요.')
      const out = join(tmpdir(), `dool2-img-${process.pid}-${Date.now()}.jpg`)
      try {
        await new Promise<void>((res, rej) =>
          execFile(
            'sips',
            ['-s', 'format', 'jpeg', '-Z', '2000', p, '--out', out],
            { timeout: 20_000 },
            (e) => (e ? rej(e) : res()),
          ),
        )
        data = await readFile(out)
        mime = 'image/jpeg'
      } catch {
        return fail('사진을 바꾸지 못했어요. JPEG로 저장해 주세요.')
      } finally {
        await rm(out, { force: true })
      }
    }
    if (data.length > IMAGE_MAX) return fail('사진이 너무 커요.')
    return {
      content: [
        { type: 'image', data: data.toString('base64'), mimeType: mime },
        {
          type: 'text',
          text: `${this.show(p)} 사진이에요. 보이는 내용으로 답하고, 주민번호·카드 번호 같은 민감한 값은 옮겨 적지 않아요.`,
        },
      ],
    }
  }

  private async listDir(p: string): Promise<FileToolResult> {
    const entries = await readdir(p, { withFileTypes: true })
    return ok(
      `${this.show(p)} 폴더:\n${entries
        .filter((e) => !e.name.startsWith('.'))
        .slice(0, 60)
        .map((e) => `- ${e.name}${e.isDirectory() ? sep : ''}`)
        .join('\n')}`,
    )
  }

  /** 새 파일 만들기: 이미 있으면 이름 뒤에 (2)를 붙인다 (덮어쓰지 않는다) */
  async write(o: {
    name: string
    kind: string
    text?: string
    rows?: unknown[][]
    /** 비우면 두리 폴더(문서/두리) */
    folder?: FolderKey
    /** html 문서 디자인 틀 (doc-kit.ts) */
    look?: DocLook
    /** 두리 폴더의 같은 이름 파일을 고쳐 쓴다 (고친 판이 "(2)"로 쌓이지 않게) */
    replace?: boolean
  }): Promise<FileToolResult> {
    const kind = o.kind.toLowerCase()
    if (!['md', 'txt', 'csv', 'xlsx', 'html'].includes(kind))
      return fail('md·txt·csv·xlsx·html만 만들 수 있어요.')
    // 두리가 만든 것은 두리 폴더에 모은다 (바탕화면을 어지르지 않게). 사용자가 고른 폴더가 있으면 그곳
    const docs = this.folders.documents?.[0]
    const dir = o.folder ? this.folders[o.folder]?.[0] : docs ? join(docs, DOORI_FOLDER) : undefined
    const where = o.folder ? FOLDER_LABEL[o.folder] : `문서/${DOORI_FOLDER} 폴더`
    if (!dir) return fail(`${o.folder ? (FOLDER_LABEL[o.folder] ?? o.folder) : '문서'} 폴더를 찾지 못했어요.`)
    const stem = basename(o.name.replace(/\.[a-z0-9]{1,5}$/i, ''))
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/./gsu, (c) => (c.charCodeAt(0) < 32 ? ' ' : c))
      .trim()
      .slice(0, 80)
    if (!stem) return fail('파일 이름을 주세요.')
    let data: Buffer
    // 보관함 미리보기도 디자인 틀을 넣은 글로 그린다
    let written = o.text
    if (kind === 'xlsx' || (kind === 'csv' && o.rows)) {
      const rows = (o.rows ?? csvRows(o.text ?? '')).slice(0, 20_000).map((r) => (Array.isArray(r) ? r : [r]))
      data = kind === 'xlsx' ? xlsx(rows) : Buffer.from(`﻿${rows.map(csvLine).join('\r\n')}\r\n`, 'utf8')
    } else {
      const text = kind === 'html' && o.look ? applyLook(o.text ?? '', o.look) : (o.text ?? '')
      written = text
      if (text.length > 2_000_000) return fail('2MB보다 긴 글은 만들지 않아요.')
      // 엑셀이 한글 CSV를 깨지 않게 BOM을 붙인다
      data = Buffer.from(kind === 'csv' ? `﻿${text}` : text, 'utf8')
    }
    await mkdir(dir, { recursive: true })
    let target = join(dir, `${stem}.${kind}`)
    // 고쳐 쓰기는 두리 폴더에서만 (사용자가 고른 바탕화면·다운로드의 파일은 덮어쓰지 않는다)
    const overwrite = o.replace === true && !o.folder && existsSync(target)
    if (!overwrite)
      for (let i = 2; existsSync(target) && i < 100; i++) target = join(dir, `${stem} (${i}).${kind}`)
    await writeFile(target, data, overwrite ? {} : { flag: 'wx' })
    const shown = this.show(target)
    this.onWritten?.({ name: basename(target), kind, path: shown, text: written, rows: o.rows })
    return ok(
      `${where}에 만들었어요: ${shown} (${data.length.toLocaleString()}바이트). 보관함의 '사진·파일'에도 올려서 폰에서도 볼 수 있어요. 사용자에게 "두리 폴더에 두고 보관함에 올렸어요"처럼 알려 주세요.`,
    )
  }
}

// ── 글 뽑기 ────────────────────────────────────────────

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')

/** HTML에서 글만 (보관함 미리보기 글) */
export function htmlText(html: string) {
  return stripTags(html)
}

function stripTags(html: string) {
  return decodeXml(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

/** zip 파일의 항목들 (이름 → 내용). 오피스·hwpx 문서는 zip 안의 XML이다 */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  // 끝에서 중앙 목록 끝 표시(EOCD)를 찾는다
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('문서 파일이 깨졌어요 (zip 아님)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    const lNameLen = buf.readUInt16LE(local + 26)
    const lExtra = buf.readUInt16LE(local + 28)
    const start = local + 30 + lNameLen + lExtra
    const raw = buf.subarray(start, start + csize)
    try {
      out.set(name, method === 8 ? inflateRawSync(raw) : raw)
    } catch {}
  }
  return out
}

/** 워드·엑셀·파워포인트·한글(hwpx)의 글 */
export function officeText(buf: Buffer, ext: string): string {
  const z = unzip(buf)
  const xml = (name: string) => z.get(name)?.toString('utf8') ?? ''
  const texts = (s: string, tag: string) =>
    [...s.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) =>
      decodeXml(m[1] ?? ''),
    )
  if (ext === '.docx') {
    return [...xml('word/document.xml').matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)]
      .map((p) => texts(p[0], 'w:t').join(''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  if (ext === '.pptx') {
    const slides = [...z.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))
    return slides.map((k, i) => `[슬라이드 ${i + 1}]\n${texts(xml(k), 'a:t').join('\n')}`).join('\n\n')
  }
  if (ext === '.hwpx') {
    const sections = [...z.keys()].filter((k) => /^Contents\/section\d+\.xml$/i.test(k)).sort()
    return sections
      .map((k) =>
        [...xml(k).matchAll(/<hp:p[\s>][\s\S]*?<\/hp:p>/g)]
          .map((p) => texts(p[0], 'hp:t').join(''))
          .join('\n'),
      )
      .join('\n\n')
      .trim()
  }
  // 엑셀: 시트마다 줄을 탭으로
  const shared = texts(xml('xl/sharedStrings.xml'), 'si').map((si) => si.replace(/<[^>]+>/g, ''))
  const names = [...xml('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) =>
    decodeXml(m[1] ?? ''),
  )
  const sheets = [...z.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))
  return sheets
    .map((k, i) => {
      const rows = [...xml(k).matchAll(/<row[\s>][\s\S]*?<\/row>/g)].map((r) =>
        [...r[0].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const attrs = c[1] ?? ''
            const body = c[2] ?? ''
            const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
            if (/t="s"/.test(attrs)) return shared[Number(v)] ?? ''
            if (/t="inlineStr"/.test(attrs)) return texts(body, 't').join('')
            return decodeXml(v ?? '')
          })
          .join('\t'),
      )
      return `[시트 ${names[i] ?? i + 1}]\n${rows.join('\n')}`
    })
    .join('\n\n')
}

/**
 * 파일 내용 읽기. 맥의 iCloud Drive가 공간을 아끼려고 내용을 클라우드에만 둔 파일(목록에는 보이는 '문서' 속 파일)은
 * 읽으면 "Resource deadlock avoided"(EDEADLK, -11)로 실패한다(실측 2026-11-19, 견적 PDF). 이때 brctl로 내려받고 다시 읽는다.
 * 못 읽으면 사용자에게 전할 이유를 글로 돌려준다
 */
export async function readLocal(p: string, wait = 30_000): Promise<Buffer | string> {
  try {
    return await readFile(p)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (process.platform !== 'darwin' || !(err.errno === -11 || err.code === 'EDEADLK')) throw e
  }
  await new Promise<void>((res) => execFile('brctl', ['download', p], { timeout: 10_000 }, () => res()))
  for (const end = Date.now() + wait; Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      return await readFile(p)
    } catch {}
  }
  return 'iCloud Drive에만 있고 이 Mac에 내려받아지지 않은 파일이라 열지 못했어요. Finder에서 파일을 한 번 열거나 "지금 다운로드"를 누른 뒤 다시 부탁해 달라고 사용자에게 알려 주세요.'
}

/**
 * 내용을 다 읽지 않고 이 Mac에 내려받아져 있게만 한다 (큰 영상도 올리기·그리기 전에). 첫 바이트를 읽어 보고,
 * iCloud에만 있으면(EDEADLK) brctl로 내려받고 기다린다. 됐으면 undefined, 못 했으면 사용자에게 전할 이유
 * (실측 11-21: '문서'의 보고서 html이 클라우드에만 있어 PDF 만들기가 실패해 두리가 이름을 바꿔 가며 우회했다)
 */
export async function ensureLocal(p: string, wait = 60_000): Promise<string | undefined> {
  const peek = async () => {
    const fh = await open(p, 'r')
    try {
      await fh.read(Buffer.alloc(1), 0, 1, 0)
    } finally {
      await fh.close()
    }
  }
  try {
    await peek()
    return undefined
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (process.platform !== 'darwin' || !(err.errno === -11 || err.code === 'EDEADLK')) return undefined
  }
  await new Promise<void>((res) => execFile('brctl', ['download', p], { timeout: 10_000 }, () => res()))
  for (const end = Date.now() + wait; Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      await peek()
      return undefined
    } catch {}
  }
  return `${basename(p)}: iCloud Drive에만 있고 이 Mac에 아직 내려받아지지 않았어요. 조금 뒤 다시 해 볼게요.`
}

/** 스캔 PDF 안의 사진(JPEG, DCTDecode) */
export function pdfImages(buf: Buffer): Buffer[] {
  const src = buf.toString('latin1')
  const out: Buffer[] = []
  const re = /<<([\s\S]{0,2000}?)>>\s*stream\r?\n/g
  for (let m = re.exec(src); m && out.length < 6; m = re.exec(src)) {
    const dict = m[1] ?? ''
    const start = m.index + m[0].length
    const end = src.indexOf('endstream', start)
    if (end < 0) break
    re.lastIndex = end
    if (!/\/Subtype\s*\/Image/.test(dict) || !/DCTDecode/.test(dict) || /FlateDecode/.test(dict)) continue
    const data = buf.subarray(start, end)
    // JPEG 시작 표시(FFD8)부터, 너무 작은 것(아이콘)은 뺀다
    const at = data.indexOf(Buffer.from([0xff, 0xd8]))
    if (at >= 0 && data.length > 20_000 && data.length - at <= IMAGE_MAX)
      out.push(Buffer.from(data.subarray(at)))
  }
  return out
}

// ── 만들기 ─────────────────────────────────────────────

function csvRows(text: string): string[][] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.length)
    .map((l) => l.split(','))
}
const csvLine = (r: unknown[]) =>
  r
    .map((v) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    })
    .join(',')

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Buffer) {
  let c = 0xffffffff
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 압축 없는 zip (엑셀 파일 만들 때) */
export function zip(files: [string, string][]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, body] of files) {
    const data = Buffer.from(body, 'utf8')
    const nameB = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameB.length, 26)
    parts.push(local, nameB, data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(0x0800, 8)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(nameB.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, nameB)
    offset += 30 + nameB.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

const esc = (s: string) =>
  s
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
    // XML에 못 넣는 제어 문자는 뺀다 (탭·줄바꿈은 둔다)
    .replace(/./gsu, (c) => (c.charCodeAt(0) < 32 && !'\t\n\r'.includes(c) ? '' : c))

/** 엑셀 파일 (시트 하나, 첫 줄은 굵게 하지 않은 그대로). 숫자처럼 생긴 칸은 숫자로 */
export function xlsx(rows: unknown[][]): Buffer {
  const col = (i: number) => {
    let s = ''
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    return s
  }
  const sheet = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${col(ci)}${ri + 1}`
            if (typeof v === 'number' || (typeof v === 'string' && /^-?\d{1,15}(\.\d+)?$/.test(v.trim())))
              return `<c r="${ref}"><v>${Number(v)}</v></c>`
            const s = v === null || v === undefined ? '' : String(v)
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`
          })
          .join('')}</row>`,
    )
    .join('')
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
    ],
  ])
}
