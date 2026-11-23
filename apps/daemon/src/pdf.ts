// PDF reading: pulls text page by page with pdfjs-dist (Mozilla PDF.js, Apache-2.0).
// The old approach (unpacking streams by hand and merging ToUnicode tables into one) garbled Korean quotes and bills
// where every font has its own table. PDF.js handles per-font ToUnicode, CID font tables (cmaps), compression and object streams.
//
// - Lines: text pieces at the same height (y) are gathered into one line and joined from the left
// - Tables: a gap wider than 1.5 characters between pieces means a new cell, split with ' | '
// - Scanned PDFs: with almost no text, the largest picture on each page is extracted as PNG (no canvas)
// - To work inside the desktop app bundle (esbuild), the worker is imported directly and cmaps and wasm are copied to dist/pdfjs/
//   (apps/desktop/scripts/package.mjs)
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { PDF_PAGE_MARK_RE, pdfFieldMark, pdfPageMark, pdfTruncated } from './region/kr/pdf.js'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

export interface PdfText {
  /** Page count */
  pages: number
  /** Text joined page by page, each with a page-number header */
  text: string
  /** Where each page starts inside text (for continue-reading hints) */
  pageStarts: number[]
  /** Count of letters and digits (to tell scanned PDFs) */
  letters: number
  /** Whether any line was split into cells with ' | ' like a table */
  table: boolean
}

/** Read only this many pages so huge PDFs do not hang */
const MAX_PAGES = 500

let lib: Promise<PdfJs> | undefined
/** Load pdfjs once, on first use (so the daemon starts fast) */
function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    // Node has no canvas, so loading prints a warning. We never draw, so hide just that warning for a moment
    const warn = console.warn
    console.warn = () => {}
    try {
      // Run in the same thread instead of a separate worker. Loading by path string would be left out of the bundle, so import directly
      ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(
        'pdfjs-dist/legacy/build/pdf.worker.mjs'
      )
      return await import('pdfjs-dist/legacy/build/pdf.mjs')
    } finally {
      console.warn = warn
    }
  })()
  return lib
}

/** Folder with cmaps (Korean CID font tables) and wasm: dist/pdfjs in the desktop bundle, node_modules in development */
function assetDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, 'pdfjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  if (existsSync(join(bundled, 'cmaps'))) return bundled
  try {
    return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  } catch {
    return undefined
  }
}

async function open(buf: Buffer) {
  const p = await pdfjs()
  const dir = assetDir()
  const task = p.getDocument({
    // pdfjs takes over the array it is given, so pass a copy
    data: new Uint8Array(buf),
    ...(dir ? { cMapUrl: join(dir, 'cmaps') + sep, cMapPacked: true, wasmUrl: join(dir, 'wasm') + sep } : {}),
    verbosity: 0,
    disableFontFace: true,
    stopAtErrors: false,
  })
  try {
    return { p, task, doc: await task.promise }
  } catch (e) {
    await task.destroy().catch(() => {})
    if ((e as Error).name === 'PasswordException')
      throw new Error(
        'This PDF is password-protected and cannot be read. Save a copy without the password and it can be read.',
      )
    throw new Error(`Could not open the PDF (${(e as Error).message}). The file may be corrupted.`)
  }
}

interface Piece {
  str: string
  x: number
  y: number
  w: number
  h: number
}

/** Arrange one page's text pieces into lines and cells */
export function layout(pieces: Piece[]): { text: string; table: boolean } {
  const items = pieces.filter((t) => t.str.trim())
  // Top to bottom, left to right at the same height
  items.sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: { y: number; h: number; items: Piece[] }[] = []
  for (const it of items) {
    const h = it.h || 10
    const line = lines.findLast((l) => Math.abs(l.y - it.y) <= Math.max(l.h, h) * 0.5)
    if (line) {
      line.items.push(it)
      line.h = Math.max(line.h, h)
    } else lines.push({ y: it.y, h, items: [it] })
  }
  lines.sort((a, b) => b.y - a.y)
  let table = false
  const out: string[] = []
  let prevY: number | undefined
  let prevH = 0
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x)
    let s = ''
    let last: Piece | undefined
    for (const it of l.items) {
      if (last) {
        const em = Math.max(last.h, it.h) || 10
        // Text drawn twice, slightly offset, to look bold counts once
        if (it.str === last.str && Math.abs(it.x - last.x) < em * 0.3) continue
        const gap = it.x - (last.x + last.w)
        if (gap > em * 1.5) {
          s = `${s.trimEnd()} | `
          table = true
        } else if (gap > em * 0.15 && !s.endsWith(' ') && !it.str.startsWith(' ')) s += ' '
      }
      s += it.str
      last = it
    }
    s = s.replace(/\s+/g, ' ').trim()
    if (!s) continue
    // A big gap between lines means a new paragraph: add a blank line
    if (prevY !== undefined && prevY - l.y > Math.max(prevH, l.h) * 2.2) out.push('')
    out.push(s)
    prevY = l.y
    prevH = l.h
  }
  return { text: out.join('\n'), table }
}

/** PDF text: extracted page by page, keeping lines and tables */
export async function pdfText(buf: Buffer): Promise<PdfText> {
  const { task, doc } = await open(buf)
  try {
    const pages = doc.numPages
    const parts: string[] = []
    const pageStarts: number[] = []
    let len = 0
    let table = false
    for (let n = 1; n <= Math.min(pages, MAX_PAGES); n++) {
      const page = await doc.getPage(n)
      const tc = await page.getTextContent()
      const pieces: Piece[] = []
      for (const it of tc.items) {
        if (!('str' in it)) continue
        const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = it.transform as number[]
        pieces.push({ str: it.str, x, y, w: it.width, h: it.height || Math.hypot(c, d) || Math.hypot(a, b) })
      }
      const lay = layout(pieces)
      table ||= lay.table
      // Values typed into form fields (form PDFs) are not in the text pieces, so add them separately
      const fields = (await page.getAnnotations().catch(() => []))
        .map((a: { fieldValue?: unknown }) => a.fieldValue)
        .filter((v: unknown): v is string => typeof v === 'string' && v.trim() !== '')
      const body = [lay.text, ...(fields.length ? [pdfFieldMark(fields.join(' | '))] : [])]
        .filter(Boolean)
        .join('\n')
      const part = `${pdfPageMark(n)}\n${body}\n`
      pageStarts.push(len)
      parts.push(part)
      len += part.length + 1
      page.cleanup()
    }
    let text = parts.join('\n').trimEnd()
    if (pages > MAX_PAGES) text += `\n\n${pdfTruncated(pages, MAX_PAGES)}`
    const letters = text.replace(PDF_PAGE_MARK_RE, '').match(/[\p{L}\p{N}]/gu)?.length ?? 0
    return { pages, text, pageStarts, letters, table }
  } finally {
    await task.destroy().catch(() => {})
  }
}

/** Scanned PDF: the largest picture on each page as PNG (first max pages). Big pictures are shrunk to maxSide on the long edge */
export async function pdfScanImages(buf: Buffer, max = 3, maxSide = 1600): Promise<Buffer[]> {
  const { p, task, doc } = await open(buf)
  const out: Buffer[] = []
  try {
    for (let n = 1; n <= doc.numPages && out.length < max; n++) {
      const page = await doc.getPage(n)
      const ops = await page.getOperatorList()
      let best: RawImage | undefined
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== p.OPS.paintImageXObject) continue
        const id = String((ops.argsArray[i] as unknown[])[0])
        const objs = id.startsWith('g_') ? page.commonObjs : page.objs
        const img = await new Promise<RawImage | undefined>((res) => {
          try {
            objs.get(id, res)
          } catch {
            res(undefined)
          }
        })
        if (img?.data && img.width * img.height > (best ? best.width * best.height : 200 * 200)) best = img
      }
      if (best) out.push(png(shrink(best, maxSide)))
      page.cleanup()
    }
    return out
  } finally {
    await task.destroy().catch(() => {})
  }
}

/** Image decoded by pdfjs (kind 1: 1-bit black and white, 2: RGB, 3: RGBA) */
interface RawImage {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}

/** Convert to RGB while shrinking the long edge below maxSide (box average) */
function shrink(img: RawImage, maxSide: number): { width: number; height: number; rgb: Buffer } {
  const { width: w, height: h, kind, data } = img
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxSide))
  const W = Math.max(1, Math.floor(w / f))
  const H = Math.max(1, Math.floor(h / f))
  const rgb = Buffer.alloc(W * H * 3)
  const rowBytes = (w + 7) >> 3
  const px = (x: number, y: number, ch: number): number => {
    if (kind === 1) return (data[y * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7)) ? 255 : 0
    const n = kind === 3 ? 4 : 3
    return data[(y * w + x) * n + ch] ?? 0
  }
  for (let Y = 0; Y < H; Y++)
    for (let X = 0; X < W; X++)
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += px(X * f + dx, Y * f + dy, ch)
        rgb[(Y * W + X) * 3 + ch] = Math.round(sum / (f * f))
      }
  return { width: W, height: H, rgb }
}

/** Make a tiny PNG (RGB 8-bit, no filter) */
function png({ width, height, rgb }: { width: number; height: number; rgb: Buffer }): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
