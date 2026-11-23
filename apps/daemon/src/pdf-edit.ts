// Merge PDFs, split into pages, extract pages (ADR 0024 addendum). pdfjs-dist is read-only, so creating uses pdf-lib (MIT).
// The original stays as is and only new files are made ("(1)" if the name exists). Photos (jpg, png) go in one per A4 page
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import type { Lang } from '@dool2/i18n'
import { PDFDocument } from 'pdf-lib'
import { cleanName, freeName } from './file-names.js'
import type { FileScope, FileToolResult } from './file-ops.js'
import { PDF_EDIT_NAMES } from './locales/pdf-edit.js'

const ok = (text: string): FileToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): FileToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const MAX_FILE = 100 << 20
const MAX_TOTAL = 300 << 20
const MAX_PARTS = 200
const A4: [number, number] = [595.28, 841.89]

/** "1-3,5" -> zero-based page numbers. If past the page count or malformed, the reason (text) */
export function pageList(spec: string, count: number): number[] | string {
  const out: number[] = []
  for (const part of spec.replace(/\s+/g, '').split(',').filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return `Give pages like "1-3,5" (got: "${spec}")`
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a) return `"${part}" is not a valid page range`
    if (b > count) return `This PDF has only ${count} pages ("${part}")`
    for (let i = a; i <= b; i++) out.push(i - 1)
  }
  return out.length ? out : `Give pages (e.g. "1-3,5")`
}

const kb = (n: number) =>
  n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

export async function pdfTool(
  scope: FileScope,
  args: Record<string, unknown>,
  lang: Lang = 'ko',
): Promise<FileToolResult> {
  const names = PDF_EDIT_NAMES[lang]
  const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
  if (!paths.length) return fail('Give the PDFs to merge or split in paths.')
  if (paths.length > 100) return fail('At most 100 files can be merged at once.')
  const parts = Array.isArray(args.parts)
    ? (args.parts as unknown[]).map(String).slice(0, MAX_PARTS)
    : undefined
  const split = args.split === true
  const pages = typeof args.pages === 'string' && args.pages.trim() ? args.pages : undefined
  if ((parts || split || pages) && paths.length > 1)
    return fail(
      'Splitting and extracting pages (parts, split, pages) work on a single PDF only. When merging, leave pages out.',
    )

  // Reading: only PDFs and photos inside folders we may see
  const inputs: { path: string; buf: Buffer; ext: string }[] = []
  let total = 0
  for (const raw of paths) {
    const p = scope.inside(raw)
    if (!p)
      return fail(
        `${basename(raw)}: missing or outside Desktop, Documents, Downloads, Pictures and Movies. Find the path with file_find first.`,
      )
    if (scope.sensitive(p)) return fail(`${basename(p)}: sensitive file, not touched.`)
    const ext = extname(p).toLowerCase()
    if (/^\.(heic|heif|webp)$/.test(ext))
      return fail(
        `${basename(p)}: this photo format cannot go into a PDF. Convert it to JPG with file_convert, then give that file.`,
      )
    if (!/^\.(pdf|jpe?g|png)$/.test(ext))
      return fail(
        `${basename(p)}: only PDFs and photos (jpg, png) can be merged. For Word or Hangul documents, give the version saved as PDF.`,
      )
    const s = await stat(p)
    if (s.isDirectory()) return fail(`${basename(p)}: give a file, not a folder.`)
    if (s.size > MAX_FILE) return fail(`${basename(p)}: files over 100MB are not handled.`)
    total += s.size
    if (total > MAX_TOTAL) return fail('More than 300MB combined is not handled. Ask in smaller batches.')
    const buf = await scope.read(p)
    if (typeof buf === 'string') return fail(`${basename(p)}: ${buf}`)
    inputs.push({ path: p, buf, ext })
  }
  const first = inputs[0] as { path: string; buf: Buffer; ext: string }
  const outDir =
    typeof args.folder === 'string' && args.folder.trim()
      ? scope.insideNew(args.folder.trim())
      : dirname(first.path)
  if (!outDir)
    return fail('The folder for new files must be inside Desktop, Documents, Downloads, Pictures or Movies.')
  const stem = basename(first.path, extname(first.path))
  const wanted =
    typeof args.name === 'string' && args.name.trim() ? cleanName(args.name).replace(/\.pdf$/i, '') : ''

  const open = async (i: { path: string; buf: Buffer }) => {
    try {
      return await PDFDocument.load(i.buf, { updateMetadata: false })
    } catch (e) {
      const why = /encrypt/i.test((e as Error).message)
        ? 'password-protected PDF, cannot open. Tell the user to save a copy without the password'
        : 'corrupted or not a PDF, cannot open'
      throw new Error(`${basename(i.path)}: ${why}`)
    }
  }
  const taken = new Set<string>()
  const save = async (doc: PDFDocument, name: string) => {
    const bytes = await doc.save()
    await mkdir(outDir, { recursive: true })
    const at = freeName(outDir, `${name}.pdf`, taken)
    await writeFile(at, bytes, { flag: 'wx' })
    return { at, size: bytes.length, pages: doc.getPageCount() }
  }

  try {
    // Split: one new file per page or per parts range
    if (split || parts) {
      if (first.ext !== '.pdf') return fail('Splitting works on PDFs only.')
      const src = await open(first)
      const count = src.getPageCount()
      const groups: { label: string; idx: number[] }[] = []
      if (parts) {
        for (const spec of parts) {
          const idx = pageList(spec, count)
          if (typeof idx === 'string') return fail(idx)
          groups.push({ label: spec.replace(/\s+/g, ''), idx })
        }
      } else {
        if (count > MAX_PARTS)
          return fail(`${count} pages is too many to split one by one. Split by ranges with parts.`)
        for (let i = 0; i < count; i++) groups.push({ label: String(i + 1), idx: [i] })
      }
      const made: { at: string; size: number; pages: number }[] = []
      for (const g of groups) {
        const doc = await PDFDocument.create()
        for (const pg of await doc.copyPages(src, g.idx)) doc.addPage(pg)
        made.push(await save(doc, `${wanted || stem} ${names.pagesSuffix(g.label)}`))
      }
      return ok(
        `Split ${basename(first.path)} (${count} pages) into ${made.length} files (original untouched): ` +
          made
            .slice(0, 10)
            .map((m) => `${basename(m.at)} (${m.pages} pages)`)
            .join(', ') +
          `${made.length > 10 ? ` and ${made.length - 10} more` : ''} -> ${scope.show(outDir)}. Tell the user this location.`,
      )
    }

    // Merge (or extract pages from one PDF): in the given order
    const doc = await PDFDocument.create()
    const summary: string[] = []
    for (const i of inputs) {
      if (i.ext === '.pdf') {
        const src = await open(i)
        const idx = pages ? pageList(pages, src.getPageCount()) : src.getPageIndices()
        if (typeof idx === 'string') return fail(idx)
        for (const pg of await doc.copyPages(src, idx)) doc.addPage(pg)
        summary.push(`${basename(i.path)} ${idx.length} pages`)
      } else {
        const img = i.ext === '.png' ? await doc.embedPng(i.buf) : await doc.embedJpg(i.buf)
        const [w, h] = img.width > img.height ? [A4[1], A4[0]] : A4
        const k = Math.min(w / img.width, h / img.height)
        const page = doc.addPage([w, h])
        page.drawImage(img, {
          x: (w - img.width * k) / 2,
          y: (h - img.height * k) / 2,
          width: img.width * k,
          height: img.height * k,
        })
        summary.push(`${basename(i.path)} photo, 1 page`)
      }
    }
    const name =
      wanted ||
      (inputs.length > 1
        ? names.merged(stem, inputs.length - 1)
        : pages
          ? names.extracted(stem, pages.replace(/\s+/g, ''))
          : names.copy(stem))
    const m = await save(doc, name)
    return ok(
      `${inputs.length > 1 ? `Merged ${inputs.length} files into one` : 'Extracted pages into a new PDF'} (originals untouched): ` +
        `${scope.show(m.at)} (${m.pages} pages, ${kb(m.size)}). Order: ${summary.slice(0, 20).join(' -> ')}. Tell the user this path.`,
    )
  } catch (e) {
    return fail((e as Error).message)
  }
}
