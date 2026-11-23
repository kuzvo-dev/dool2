// PC file tools (ADR 0022): find and read in the user folders (Desktop, Documents, Downloads, Pictures, Movies),
// and make new files. The AI's built-in tools (shell, files) stay off (ADR 0003); files open only through Dool2's
// tools. No deleting or overwriting.
// Move and rename, photo conversion and printing are in file-ops.ts (ADR 0024, with approval and undo).
// Reads: text, CSV, JSON, HTML, Word (docx), Excel (xlsx), PowerPoint (pptx), Hangul (hwpx), PDF (pdf.ts, keeping
// lines and tables per page).
// Sensitive files (certificates, keys, password files, hidden folders) are never read.

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Lang } from '@dool2/i18n'
import { applyLook, DOC_LOOKS, type DocLook } from './doc-kit.js'
import { FileOps, type FileOpsOptions } from './file-ops.js'
import { filesCopy } from './locales/files.js'
import { styleGuide } from './motion-kit.js'
import { type PdfText, pdfScanImages, pdfText } from './pdf.js'
import { DOORI_FOLDER_NAME, KR_SENSITIVE_WORDS, KR_USER_FOLDERS, SENT_PHOTO_RE } from './region/kr/files.js'

export interface FileToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
/** Size limit for one image handed to the AI (what the model accepts) */
const IMAGE_MAX = 4_500_000
const ok = (text: string): FileToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): FileToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** Folder (under Documents) where Dool2 collects the files it makes */
export const DOORI_FOLDER = DOORI_FOLDER_NAME

export type FolderKey = 'desktop' | 'documents' | 'downloads' | 'pictures' | 'movies'
/**
 * The folders Dool2 handles. On Windows also Desktop and Documents moved to OneDrive. Pictures and Movies were
 * added for uploading blog photos and videos (browser_upload) (empty list when missing)
 */
export type UserFolders = Record<'desktop' | 'documents' | 'downloads', string[]> &
  Partial<Record<'pictures' | 'movies', string[]>>
/** The folder names, as told to the AI */
export const FOLDERS_TEXT = 'Desktop, Documents, Downloads, Pictures and Movies'

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
    desktop: pick('Desktop', 'OneDrive/Desktop', ...KR_USER_FOLDERS.desktop),
    documents: pick('Documents', 'OneDrive/Documents', ...KR_USER_FOLDERS.documents),
    downloads: pick('Downloads', ...KR_USER_FOLDERS.downloads),
    pictures: pick('Pictures', 'OneDrive/Pictures', ...KR_USER_FOLDERS.pictures),
    // Movies on macOS, Videos on Windows
    movies: pick('Movies', 'Videos', 'OneDrive/Videos', ...KR_USER_FOLDERS.movies),
  }
}

const FOLDER_LABEL: Record<FolderKey, string> = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  pictures: 'Pictures',
  movies: 'Movies',
}

// Never read: hidden files and folders, joint certificates (NPKI), key and certificate files, password and wallet
// files, secret config values
const SENSITIVE = new RegExp(
  `(^|[/\\\\])\\.|npki|gpki|signcert|signpri|\\.(pem|key|p12|pfx|der|cer|crt|keychain|kdbx|ovpn|ppk)$|id_rsa|id_ed25519|wallet|${KR_SENSITIVE_WORDS}|password|passwd`,
  'i',
)
// Folders skipped while finding (heavy, or not the user's documents)
const SKIP_DIR =
  /^(node_modules|Library|AppData|\.git|\$RECYCLE\.BIN|System Volume Information|Photo Booth Library)$|\.(photoslibrary|photolibrary|migratedphotolibrary|aplibrary|imovielibrary|fcpbundle|tvlibrary)$/i

/** A file to upload to a website (browser_upload) */
export interface UploadFile {
  /** Real path (shortcuts resolved) */
  path: string
  name: string
  size: number
  mtime: number
  /** Path as the user sees it (~/Pictures/a.jpg) */
  show: string
}
export const UPLOAD_MAX_FILES = 20
export const UPLOAD_MAX_BYTES = 4 * 1024 ** 3

/** File names in a comparable form (macOS stores Korean names as separate jamo: normalize to NFC) */
const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, '')

export class FileTools {
  private readonly folders: Record<FolderKey, string[]>
  private readonly home: string
  /** Language of the text people read. Korean when not given */
  private readonly lang: () => Lang
  /** Move, photo conversion, printing (approval through opts.approvals) */
  readonly ops: FileOps
  /** Where photos the user sent in chat are kept (the chat's photo mark, SENT_PHOTO_RE); they can be uploaded */
  sentPhotos?: string
  /** Motion graphics video (video_motion, set by the daemon) */
  motionMaker?: { make(args: Record<string, unknown>): Promise<FileToolResult> }
  /** Video from photos (video_make, set by the daemon) */
  videoMaker?: { make(args: Record<string, unknown>): Promise<FileToolResult> }
  /** Pictures from an image AI (image_make, set by the daemon together with the browser) */
  imageMaker?: { make(args: Record<string, unknown>): Promise<FileToolResult> }
  /** AI video clip (video_clip, Google Flow) */
  clipMaker?: { make(args: Record<string, unknown>): Promise<FileToolResult> }
  /** A new file was made (added to the Library) */
  onWritten?: (f: {
    name: string
    kind: string
    path: string
    text?: string
    rows?: unknown[][]
    /** Preview image (JPEG base64, HTML drawn as PNG) */
    image?: string
  }) => void
  constructor(folders?: UserFolders, home = homedir(), opts: FileOpsOptions = {}) {
    this.lang = opts.lang ?? (() => 'ko')
    // Use real paths (macOS has shortcuts like /var → /private/var)
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
    // Files drawn from HTML into PDF/PNG are new files too, so they go to the Library
    this.ops.onRendered = (f) => this.onWritten?.(f)
  }

  private roots() {
    return Object.values(this.folders).flat()
  }

  /**
   * A folder that may not exist yet (move destination, place for a new file): resolves the real path as far as it
   * exists and checks it is inside the user folders
   */
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
    // New names may not be hidden (start with a dot) or contain characters that cannot be used
    if (rest.some((n) => n.startsWith('.') || /[:*?"<>|]/.test(n) || !n.trim())) return undefined
    const out = join(real, ...rest)
    if (SENSITIVE.test(out)) return undefined
    return this.roots().some((r) => out === r || out.startsWith(r + sep)) ? out : undefined
  }

  /** Only real paths inside the user folders (blocks escaping with ../ or shortcuts) */
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

  /** Folder (first candidate) */
  dir(key: FolderKey): string | undefined {
    return this.folders[key]?.[0]
  }

  /** Whether the file is inside the user folders and not sensitive (photos placed in motion video scenes) */
  readable(p: string): boolean {
    return Boolean(this.realReadable(p))
  }

  /**
   * Opening a file link from an answer on the PC or sending it to the phone: the real path of a non-sensitive file
   * inside the user folders. Takes "~/…", "/Users/…" and "C:\…" forms. Folders, missing files and paths that escape
   * give undefined
   */
  realReadable(p: string): string | undefined {
    const r = this.inside(String(p ?? '').trim())
    return r && !SENSITIVE.test(r) ? r : undefined
  }

  /** The path as shown to the user */
  shown(p: string): string {
    return this.show(p)
  }

  private show(p: string) {
    return `~${sep}${relative(this.home, p)}`
  }

  /**
   * Checks files to upload to a website (browser_upload). Same fence as reading: only regular files inside the user
   * folders, never hidden folders, certificates, keys or password files. Returns the real path (shortcuts
   * resolved), name and size
   */
  async uploadable(paths: string[]): Promise<{ files: UploadFile[] } | { error: string }> {
    const list = paths.map((p) => String(p ?? '').trim()).filter(Boolean)
    if (!list.length)
      return { error: 'Give the paths of the files to upload. Find them with file_find first.' }
    if (list.length > UPLOAD_MAX_FILES) return { error: `Up to ${UPLOAD_MAX_FILES} files at a time.` }
    const files: UploadFile[] = []
    for (const raw of list) {
      // Photos received in chat go by name alone (measured 11-21: a sent photo could not be attached to a blog
      // because it was not in a PC folder)
      const sent = SENT_PHOTO_RE.exec(raw)
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
              show: filesCopy(this.lang()).sentPhoto,
            })
          continue
        }
      }
      const p = this.inside(raw)
      if (!p)
        return {
          error: `${basename(raw)}: missing or outside ${FOLDERS_TEXT}. Find the path with file_find first.`,
        }
      if (SENSITIVE.test(p))
        return {
          error: `${basename(p)}: sensitive files such as certificates, keys and passwords are never uploaded to websites.`,
        }
      const s = await stat(p).catch(() => undefined)
      if (!s?.isFile()) return { error: `${basename(p)}: not a file (folders cannot be uploaded).` }
      if (s.size > UPLOAD_MAX_BYTES) return { error: `${basename(p)}: files over 4GB are not uploaded.` }
      const away = await ensureLocal(p, undefined, 'en')
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
      if (tool === 'video_style')
        return {
          content: [
            { type: 'text', text: styleGuide(typeof args.style === 'string' ? args.style : undefined) },
          ],
        }
      if (tool === 'video_motion')
        return this.motionMaker
          ? await this.motionMaker.make(args)
          : fail('This PC cannot make motion videos.')
      if (tool === 'video_clip')
        return this.clipMaker
          ? await this.clipMaker.make(args)
          : fail('No browser is connected for AI video. Make it with video_motion alone.')
      if (tool === 'video_make')
        return this.videoMaker ? await this.videoMaker.make(args) : fail('This PC cannot make videos.')
      if (tool === 'image_make')
        return this.imageMaker
          ? await this.imageMaker.make(args)
          : fail('No browser is connected for the image AI. Draw it in HTML and make a PNG with file_render.')
      if (tool === 'file_trash') return await this.ops.trash(args)
      if (tool === 'file_download') return await this.ops.download(args)
      if (tool === 'pc_screen') return await this.ops.power(args)
      return fail(`Unknown file tool: ${tool}`)
    } catch (e) {
      return fail((e as Error).message)
    }
  }

  /**
   * Find by name: Desktop, Documents, Downloads, Pictures, Movies (up to 4 levels down), most recently changed
   * first, 30 (up to 300 with limit)
   */
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
    if (!hits.length) return ok(`Found no file with "${query}" in ${FOLDERS_TEXT}.`)
    const kb = (n: number) =>
      n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
    const day = (t: number) =>
      new Date(t).toLocaleString('en-US', {
        timeZone: 'Asia/Seoul',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    return ok(
      `${hits.length > max ? `Latest ${max} of ${hits.length}` : `${hits.length}`}:\n` +
        hits
          .slice(0, max)
          .map((h) => `- ${this.show(h.path)}${h.dir ? sep : ` (${kb(h.size)}, ${day(h.mtime)})`}`)
          .join('\n') +
        (hits.length > max ? `\nTo see them all, raise limit (up to 300) and search again.` : '') +
        '\nGive this path as is to file_read to read, file_move to move or rename, file_convert for photo formats, file_print to print, or browser_upload to upload to a website (blog, video, document attachments).',
    )
  }

  /** Read: converted to text, 30,000 characters at a time. Continue with from */
  async read(path: string, from = 0): Promise<FileToolResult> {
    const p = this.inside(path)
    if (!p) return fail(`Only files inside ${FOLDERS_TEXT} can be read. Find the path with file_find first.`)
    if (SENSITIVE.test(p))
      return fail('Dool2 never reads sensitive files such as certificates, keys and passwords.')
    const s = await stat(p)
    if (s.isDirectory()) return this.listDir(p)
    if (s.size > 30 << 20) return fail('Files over 30MB are not read.')
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
      // Almost no text (under ten characters per page) means a scanned PDF
      text = pdf && pdf.letters >= pdf.pages * 10 ? pdf.text : ''
      if (pdf?.table)
        note =
          "\n(Table cells on the same line are separated by ' | '. Empty cells can shift columns, so pair items with their amounts carefully.)"
      if (!text) {
        // Scanned PDF: show the pictures inside (scanned business registration, tax certificates). JPEG as is,
        // otherwise decoded to PNG
        let imgs = pdfImages(buf)
          .slice(0, 3)
          .map((data) => ({ data, mimeType: 'image/jpeg' }))
        if (!imgs.length && pdf)
          imgs = (await pdfScanImages(buf).catch(() => []))
            .filter((data) => data.length <= IMAGE_MAX)
            .map((data) => ({ data, mimeType: 'image/png' }))
        if (imgs.length) {
          const of = pdf && pdf.pages > imgs.length ? `the first of ${pdf.pages} ` : ''
          return {
            content: [
              ...imgs.map((m) => ({
                type: 'image' as const,
                data: m.data.toString('base64'),
                mimeType: m.mimeType,
              })),
              {
                type: 'text',
                text: `${this.show(p)}: a scanned PDF with no text, so here are ${of}page images (${imgs.length}). Answer from what the images show, and never copy sensitive values such as resident registration or card numbers.`,
              },
            ],
          }
        }
        // No images either: show whatever little text came out
        if (pdf?.letters) text = pdf.text
        else return fail(why || 'Could not get text or images out of this PDF. Tell the user.')
      }
    } else if (ext === '.hwp')
      return fail(
        'Hangul (.hwp) files cannot be read yet. Saving it as hwpx or PDF in Hangul makes it readable; tell the user.',
      )
    else if (/^\.(png|jpe?g|gif|webp|heic|heif)$/.test(ext)) return this.image(p, buf, ext)
    else if (/\.(zip|exe|dmg|mp4|mov|mp3|m4a|wav)$/i.test(ext))
      return fail('Not a text file, so it cannot be read. (A recording needs a transcript.)')
    else {
      text = buf.toString('utf8').replace(/^﻿/, '')
      // Not UTF-8 (old Korean CSVs are EUC-KR) gives many broken characters
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
    // For a PDF, say the total pages and which pages this part shows
    const pageAt = (i: number) => (pdf ? pdf.pageStarts.findLastIndex((s) => s <= i) + 1 : 0)
    const head = pdf
      ? `PDF ${pdf.pages} pages, ${text.length.toLocaleString()} characters${from || more ? `, this part pages ${pageAt(from)}-${pageAt(Math.min(text.length, from + CHUNK) - 1)}` : ''}`
      : `${text.length.toLocaleString()} characters${from ? `, from character ${from}` : ''}`
    return ok(
      `${this.show(p)} (${head})\n\n${part}` +
        (more
          ? `\n\n… ${pdf ? `Shown up to page ${pageAt(from + CHUNK - 1)} of ${pdf.pages}. ` : ''}${(text.length - from - CHUNK).toLocaleString()} more characters follow. To continue reading, from: ${from + CHUNK}`
          : '') +
        note,
    )
  }

  /** Photo files: handed over as images (license, receipt photos). iPhone HEIC becomes JPEG with sips on macOS */
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
      // Large photos and HEIC: on macOS shrink to JPEG with sips (not on Windows yet)
      if (process.platform !== 'darwin')
        return fail('This photo format or size cannot be read yet. Ask the user to save it as JPEG.')
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
        return fail('Could not convert the photo. Ask the user to save it as JPEG.')
      } finally {
        await rm(out, { force: true })
      }
    }
    if (data.length > IMAGE_MAX) return fail('The photo is too large.')
    return {
      content: [
        { type: 'image', data: data.toString('base64'), mimeType: mime },
        {
          type: 'text',
          text: `Photo ${this.show(p)}. Answer from what it shows, and never copy sensitive values such as resident registration or card numbers.`,
        },
      ],
    }
  }

  private async listDir(p: string): Promise<FileToolResult> {
    const entries = await readdir(p, { withFileTypes: true })
    return ok(
      `Folder ${this.show(p)}:\n${entries
        .filter((e) => !e.name.startsWith('.'))
        .slice(0, 60)
        .map((e) => `- ${e.name}${e.isDirectory() ? sep : ''}`)
        .join('\n')}`,
    )
  }

  /** Makes a new file: if the name exists, adds (2) after it (never overwrites) */
  async write(o: {
    name: string
    kind: string
    text?: string
    rows?: unknown[][]
    /** Empty means Dool2's folder (Documents/DOORI_FOLDER) */
    folder?: FolderKey
    /** Design template for html documents (doc-kit.ts) */
    look?: DocLook
    /** Rewrites the file of the same name in Dool2's folder (so edited versions do not pile up as "(2)") */
    replace?: boolean
  }): Promise<FileToolResult> {
    const kind = o.kind.toLowerCase()
    if (!['md', 'txt', 'csv', 'xlsx', 'html'].includes(kind))
      return fail('Only md, txt, csv, xlsx and html can be made.')
    // What Dool2 makes goes in Dool2's folder (so the desktop stays tidy), or the folder the user picked
    const docs = this.folders.documents?.[0]
    const dir = o.folder ? this.folders[o.folder]?.[0] : docs ? join(docs, DOORI_FOLDER) : undefined
    const where = o.folder ? FOLDER_LABEL[o.folder] : `the Documents/${DOORI_FOLDER} folder`
    if (!dir)
      return fail(
        `Could not find the ${o.folder ? (FOLDER_LABEL[o.folder] ?? o.folder) : 'Documents'} folder.`,
      )
    const stem = basename(o.name.replace(/\.[a-z0-9]{1,5}$/i, ''))
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/./gsu, (c) => (c.charCodeAt(0) < 32 ? ' ' : c))
      .trim()
      .slice(0, 80)
    if (!stem) return fail('Give a file name.')
    let data: Buffer
    // The Library preview is drawn from the text with the design template applied too
    let written = o.text
    if (kind === 'xlsx' || (kind === 'csv' && o.rows)) {
      const rows = (o.rows ?? csvRows(o.text ?? '')).slice(0, 20_000).map((r) => (Array.isArray(r) ? r : [r]))
      data = kind === 'xlsx' ? xlsx(rows) : Buffer.from(`﻿${rows.map(csvLine).join('\r\n')}\r\n`, 'utf8')
    } else {
      const text = kind === 'html' && o.look ? applyLook(o.text ?? '', o.look) : (o.text ?? '')
      written = text
      if (text.length > 2_000_000) return fail('Text longer than 2MB is not written.')
      // Add a BOM so Excel does not garble Korean CSV
      data = Buffer.from(kind === 'csv' ? `﻿${text}` : text, 'utf8')
    }
    await mkdir(dir, { recursive: true })
    let target = join(dir, `${stem}.${kind}`)
    // Rewriting only in Dool2's folder (files in the Desktop or Downloads the user picked are never overwritten)
    const overwrite = o.replace === true && !o.folder && existsSync(target)
    if (!overwrite)
      for (let i = 2; existsSync(target) && i < 100; i++) target = join(dir, `${stem} (${i}).${kind}`)
    await writeFile(target, data, overwrite ? {} : { flag: 'wx' })
    const shown = this.show(target)
    this.onWritten?.({ name: basename(target), kind, path: shown, text: written, rows: o.rows })
    return ok(
      `Made in ${where}: ${shown} (${data.length.toLocaleString()} bytes). It is also in the Library under Photos & files, so the phone can see it. Tell the user something like "I saved it in the Dool2 folder and added it to your Library".`,
    )
  }
}

// ── Text extraction ────────────────────────────────────────────

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')

/** Text only from HTML (Library preview text) */
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

/** Entries of a zip file (name → content). Office and hwpx documents are XML inside a zip */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  // Find the end-of-central-directory record (EOCD) from the end
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('The document file is broken (not a zip)')
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

/** Text of Word, Excel, PowerPoint and Hangul (hwpx) documents */
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
    return slides.map((k, i) => `[Slide ${i + 1}]\n${texts(xml(k), 'a:t').join('\n')}`).join('\n\n')
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
  // Excel: per sheet, rows with tab-separated cells
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
      return `[Sheet ${names[i] ?? i + 1}]\n${rows.join('\n')}`
    })
    .join('\n\n')
}

/**
 * Reads a file. Files macOS iCloud Drive keeps only in the cloud to save space (listed in Documents but not on
 * disk) fail with "Resource deadlock avoided" (EDEADLK, -11) (measured 2026-11-19, a quote PDF). Then download with
 * brctl and read again. When it cannot be read, returns the reason as text (for the AI)
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
  return 'Could not open it: the file is only in iCloud Drive and is not downloaded to this Mac. Tell the user to open the file once in Finder or click "Download Now", then ask again.'
}

/**
 * Only makes sure the file is downloaded to this Mac, without reading it all (also for large videos before
 * uploading or drawing). Reads the first byte, and if the file is only in iCloud (EDEADLK) downloads it with brctl
 * and waits. undefined when done, otherwise the reason for the user, in `lang` (shown on the phone, Korean by
 * default) (measured 11-21: a report html in Documents was only in the cloud, PDF making failed and Dool2 worked
 * around it by renaming files)
 */
export async function ensureLocal(p: string, wait = 60_000, lang: Lang = 'ko'): Promise<string | undefined> {
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
  return filesCopy(lang).icloudAway(basename(p))
}

/** Photos inside a scanned PDF (JPEG, DCTDecode) */
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
    // From the JPEG start marker (FFD8); leave out tiny ones (icons)
    const at = data.indexOf(Buffer.from([0xff, 0xd8]))
    if (at >= 0 && data.length > 20_000 && data.length - at <= IMAGE_MAX)
      out.push(Buffer.from(data.subarray(at)))
  }
  return out
}

// ── Making files ─────────────────────────────────────────────

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

/** Uncompressed zip (for making Excel files) */
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
    // Drop control characters XML cannot hold (keep tabs and line breaks)
    .replace(/./gsu, (c) => (c.charCodeAt(0) < 32 && !'\t\n\r'.includes(c) ? '' : c))

/** Excel file (one sheet, first row not bolded). Cells that look like numbers become numbers */
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
