// HTML to PDF (A4, several pages) or a PNG picture (file_render). So the user does not have to print reports and invitations
// Dool made, or capture the screen, in the browser. Drawing is done by the PC app (Electron) in a hidden window (opts.renderFile).
// When the daemon runs without the app (tests, development) it reports that there is no drawing part. The original stays and a file with the same name .pdf/.png is made beside it
import { stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { freeName } from './file-names.js'
import type { FileScope, FileToolResult } from './file-ops.js'
import { ensureLocal } from './files.js'
import { DOORI_DIR } from './region/kr/dool-folder.js'

export type RenderTarget = 'pdf' | 'png'

export interface HtmlRenderRequest {
  /** File to draw (real path, an html/htm/svg inside the visible folders) */
  path: string
  to: RenderTarget
  /** PDF in landscape */
  landscape?: boolean
  /** PNG width (CSS px). The height follows the content */
  width?: number
  /** Whether that file may load another local file (photos and fonts beside it). Only inside the visible folders and not sensitive */
  allowFile(path: string): boolean
}

export interface HtmlRenderResult {
  data: Buffer
  /** PNG size (px) */
  width?: number
  height?: number
  /** Too long, so only this much (CSS px) from the top was captured */
  cut?: number
  /** Preview shown in the library and phone (JPEG base64) */
  preview?: string
  /** Rough look of each PDF page (JPEG base64, up to the first 6). Dool spots overflowing or empty pages and fixes them */
  pages?: string[]
}

/** Drawing part the PC app provides */
export type HtmlRenderer = (req: HtmlRenderRequest) => Promise<HtmlRenderResult>

/** Made file (uploaded to the library) */
export interface RenderedFile {
  name: string
  kind: RenderTarget
  path: string
  image?: string
}

const ok = (text: string): FileToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): FileToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const RENDER_EXT = /^\.(html?|svg)$/i
const MAX_SOURCE = 20 << 20
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const RENDER_TIMEOUT_MS = 90_000
export const NO_RENDERER =
  'The Dool daemon is running outside the PC app (for development or tests), so there is no part to draw PDF or PNG. It works right away in the Dool PC app. The HTML file is unchanged.'

const kb = (n: number) =>
  n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

/** New file location: beside the original with the same name .pdf/.png ("(1)" if the name is taken) */

export function renderOutPath(src: string, to: RenderTarget, taken?: Set<string>): string {
  return freeName(dirname(src), `${basename(src, extname(src))}.${to}`, taken)
}

export async function renderTool(
  scope: FileScope,
  args: Record<string, unknown>,
  renderer: HtmlRenderer | undefined,
  onMade?: (f: RenderedFile) => void,
  timeoutMs = RENDER_TIMEOUT_MS,
): Promise<FileToolResult> {
  const raw = typeof args.path === 'string' ? args.path.trim() : ''
  if (!raw)
    return fail('Give the HTML file to turn into PDF or PNG in path (the path file_write returned, as is).')
  const to: RenderTarget = String(args.to ?? 'pdf').toLowerCase() === 'png' ? 'png' : 'pdf'
  const p = scope.inside(raw)
  if (!p)
    return fail(
      `${basename(raw)}: missing, or outside Desktop, Documents and Downloads. Find the path with file_find first.`,
    )
  if (scope.sensitive(p)) return fail(`${basename(p)}: a sensitive file, so it is not touched.`)
  const ext = extname(p).toLowerCase()
  if (!RENDER_EXT.test(ext)) {
    if (ext === '.pdf' || /^\.(jpe?g|png|heic|webp)$/.test(ext))
      return fail(
        `${basename(p)}: already a PDF or photo. To bundle photos into a PDF use file_pdf, and for photo formats use file_convert.`,
      )
    return fail(
      `${basename(p)}: only HTML (html, htm) and SVG can be drawn to PDF or PNG. For text or tables, make an html with file_write and give that file.`,
    )
  }
  const s = await stat(p)
  if (s.isDirectory()) return fail(`${basename(p)}: give a file, not a folder.`)
  if (s.size > MAX_SOURCE) return fail(`${basename(p)}: HTML larger than 20MB is not drawn.`)
  // Files iCloud Drive keeps only in the cloud are downloaded first (opening them as is gives a blank page or fails)
  const away = await ensureLocal(p)
  if (away) return fail(away)
  if (!renderer) return fail(NO_RENDERER)

  const width =
    to === 'png' && typeof args.width === 'number' && Number.isFinite(args.width)
      ? Math.min(Math.max(Math.round(args.width), 200), 3000)
      : undefined
  const allowFile = (q: string) => {
    const r = scope.inside(q)
    return Boolean(r) && !scope.sensitive(r as string)
  }
  let timer: NodeJS.Timeout | undefined
  let out: HtmlRenderResult
  try {
    out = await Promise.race([
      renderer({
        path: p,
        to,
        ...(to === 'pdf' && args.landscape === true ? { landscape: true } : {}),
        ...(width ? { width } : {}),
        allowFile,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () =>
            rej(
              new Error(
                'Drawing took too long and was stopped. Make the HTML lighter (fewer big images and scripts) and try again.',
              ),
            ),
          timeoutMs,
        )
      }),
    ])
  } catch (e) {
    return fail(`Could not draw ${basename(p)} as ${to.toUpperCase()}: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  // Check that what came back really is that format
  let pages = 0
  if (to === 'pdf') {
    try {
      pages = (await PDFDocument.load(out.data, { updateMetadata: false })).getPageCount()
    } catch {
      return fail(`Could not draw ${basename(p)} as PDF (the PDF made is corrupt).`)
    }
  } else if (out.data.length < 8 || !out.data.subarray(0, 8).equals(PNG_SIG))
    return fail(`Could not draw ${basename(p)} as PNG (the picture made is corrupt).`)

  // Redraw after fixing (replace): inside the Dool folder the file with the same name is overwritten (so "(final)" and "(1)" copies do not pile up)
  const same = join(dirname(p), `${basename(p, extname(p))}.${to}`)
  const mine = args.replace === true && basename(dirname(p)) === DOORI_DIR
  const at = mine ? same : renderOutPath(p, to)
  await writeFile(at, out.data, mine ? {} : { flag: 'wx' })
  const shown = scope.show(at)
  onMade?.({ name: basename(at), kind: to, path: shown, ...(out.preview ? { image: out.preview } : {}) })
  const what =
    to === 'pdf'
      ? `Made a PDF: ${shown} (${args.landscape === true ? 'A4 landscape' : 'A4'}, ${pages} page(s), ${kb(out.data.length)})`
      : `Made a PNG picture: ${shown} (${out.width && out.height ? `${out.width}×${out.height}, ` : ''}${kb(out.data.length)})`
  const cut = out.cut
    ? ` The content was too long, so only the top ${out.cut.toLocaleString()}px was captured. To capture everything, split it into pages with to: "pdf".`
    : ''
  const text = `${what}. The original ${basename(p)} was left as is.${cut} Tell the user this path as is (do not ask them to print from the browser or capture the screen).${onMade ? ' It is also uploaded to the library under Photos and files, so it can be seen on the phone too.' : ''}`
  // Give the preview too so Dool looks at the result and fixes it (11-22: a report with a half-empty first page was handed over as is)
  if (!out.preview) return ok(text)
  // If the PDF has more pages than the screen capture, the last page may hold only a few overflowed lines (screen and print split pages differently)
  const over =
    to === 'pdf' && pages > (out.pages?.length ?? 1)
      ? ` Note: the PDF has ${pages} pages but the views below show only ${out.pages?.length ?? 1}. Lines that overflowed in print may have moved to the next page, so reduce margins and text or cut content to fit ${out.pages?.length ?? 1} page(s) and draw again with the same name (replace: true). Do not fit it by cutting and pasting pages with file_pdf.`
      : ''
  return {
    content: [
      {
        type: 'text',
        text:
          `${text}\n\nBelow is how it looks${to === 'pdf' ? (out.pages?.length ? ` (first ${out.pages.length} page(s), captured from the screen so page breaks are approximate)` : ' (first page)') : ''}. Look at it yourself before handing it over: ` +
          '(1) Is more than half a page empty, or is there an empty page at the end? (2) Is text too small, overlapping or cut off? (3) Do tables or bars overflow the page? (4) Are numbers, dates or names wrong? (5) Are the title and key numbers visible at a glance? ' +
          'If something needs fixing, fix the html (file_write with replace: true, same look) and run file_render (replace: true) again (up to twice). If it is fine, tell the user as is.' +
          over,
      },
      ...(out.pages?.length ? out.pages : [out.preview]).map((data) => ({
        type: 'image' as const,
        data,
        mimeType: 'image/jpeg',
      })),
    ],
  }
}
