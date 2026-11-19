// PDF 합치기·쪽 나누기·쪽 뽑기 (ADR 0024 추가). pdfjs-dist는 읽기 전용이라 만들기는 pdf-lib(MIT)로 한다.
// 원본은 그대로 두고 새 파일만 만든다(같은 이름이면 "(1)"). 사진(jpg·png)은 한 장씩 A4 쪽으로 넣는다
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { cleanName, freeName } from './file-names.js'
import type { FileScope, FileToolResult } from './file-ops.js'

const ok = (text: string): FileToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): FileToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const MAX_FILE = 100 << 20
const MAX_TOTAL = 300 << 20
const MAX_PARTS = 200
const A4: [number, number] = [595.28, 841.89]

/** "1-3,5" → 0부터 센 쪽 번호들. 쪽 수를 넘거나 모양이 틀리면 이유(글) */
export function pageList(spec: string, count: number): number[] | string {
  const out: number[] = []
  for (const part of spec.replace(/\s+/g, '').split(',').filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return `쪽은 "1-3,5"처럼 주세요 (받은 것: "${spec}")`
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a) return `"${part}"는 쪽 범위가 맞지 않아요`
    if (b > count) return `이 PDF는 ${count}쪽까지 있어요 ("${part}")`
    for (let i = a; i <= b; i++) out.push(i - 1)
  }
  return out.length ? out : `쪽을 주세요 (예: "1-3,5")`
}

const kb = (n: number) =>
  n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

export async function pdfTool(scope: FileScope, args: Record<string, unknown>): Promise<FileToolResult> {
  const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : []
  if (!paths.length) return fail('합치거나 나눌 PDF를 paths에 주세요.')
  if (paths.length > 100) return fail('한 번에 100개까지만 합쳐요.')
  const parts = Array.isArray(args.parts)
    ? (args.parts as unknown[]).map(String).slice(0, MAX_PARTS)
    : undefined
  const split = args.split === true
  const pages = typeof args.pages === 'string' && args.pages.trim() ? args.pages : undefined
  if ((parts || split || pages) && paths.length > 1)
    return fail('쪽 나누기·뽑기(parts·split·pages)는 PDF 하나에만 돼요. 합칠 때는 쪽을 빼고 주세요.')

  // 읽기: 볼 수 있는 폴더 안의 PDF·사진만
  const inputs: { path: string; buf: Buffer; ext: string }[] = []
  let total = 0
  for (const raw of paths) {
    const p = scope.inside(raw)
    if (!p)
      return fail(
        `${basename(raw)}: 없거나 바탕화면·문서·다운로드 밖이에요. file_find로 경로를 먼저 찾아 주세요.`,
      )
    if (scope.sensitive(p)) return fail(`${basename(p)}: 민감한 파일이라 손대지 않아요.`)
    const ext = extname(p).toLowerCase()
    if (/^\.(heic|heif|webp)$/.test(ext))
      return fail(
        `${basename(p)}: 이 사진 형식은 PDF에 못 넣어요. file_convert로 JPG로 바꾼 뒤 그 파일을 주세요.`,
      )
    if (!/^\.(pdf|jpe?g|png)$/.test(ext))
      return fail(
        `${basename(p)}: PDF와 사진(jpg·png)만 합칠 수 있어요. 워드·한글 문서는 PDF로 저장한 것을 주세요.`,
      )
    const s = await stat(p)
    if (s.isDirectory()) return fail(`${basename(p)}: 폴더 말고 파일을 주세요.`)
    if (s.size > MAX_FILE) return fail(`${basename(p)}: 100MB보다 큰 파일은 다루지 않아요.`)
    total += s.size
    if (total > MAX_TOTAL) return fail('합쳐서 300MB보다 크면 다루지 않아요. 나눠서 부탁해 주세요.')
    const buf = await scope.read(p)
    if (typeof buf === 'string') return fail(`${basename(p)}: ${buf}`)
    inputs.push({ path: p, buf, ext })
  }
  const first = inputs[0] as { path: string; buf: Buffer; ext: string }
  const outDir =
    typeof args.folder === 'string' && args.folder.trim()
      ? scope.insideNew(args.folder.trim())
      : dirname(first.path)
  if (!outDir) return fail('새 파일을 둘 폴더는 바탕화면·문서·다운로드 안이어야 해요.')
  const stem = basename(first.path, extname(first.path))
  const wanted =
    typeof args.name === 'string' && args.name.trim() ? cleanName(args.name).replace(/\.pdf$/i, '') : ''

  const open = async (i: { path: string; buf: Buffer }) => {
    try {
      return await PDFDocument.load(i.buf, { updateMetadata: false })
    } catch (e) {
      const why = /encrypt/i.test((e as Error).message)
        ? '암호가 걸린 PDF라 열지 못해요. 암호를 푼 PDF로 저장해 달라고 알려 주세요'
        : '깨졌거나 PDF가 아니라 열지 못해요'
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
    // 나누기: 쪽마다 또는 parts 범위마다 새 파일
    if (split || parts) {
      if (first.ext !== '.pdf') return fail('나누기는 PDF만 돼요.')
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
          return fail(`쪽이 ${count}개라 한 쪽씩 나누기엔 많아요. parts로 범위를 나눠 주세요.`)
        for (let i = 0; i < count; i++) groups.push({ label: String(i + 1), idx: [i] })
      }
      const made: { at: string; size: number; pages: number }[] = []
      for (const g of groups) {
        const doc = await PDFDocument.create()
        for (const pg of await doc.copyPages(src, g.idx)) doc.addPage(pg)
        made.push(await save(doc, `${wanted || stem} ${g.label}쪽`))
      }
      return ok(
        `${count}쪽짜리 ${basename(first.path)}를 ${made.length}개로 나눴어요(원본은 그대로): ` +
          made
            .slice(0, 10)
            .map((m) => `${basename(m.at)}(${m.pages}쪽)`)
            .join(', ') +
          `${made.length > 10 ? ` 외 ${made.length - 10}개` : ''} → ${scope.show(outDir)}. 사용자에게 이 위치를 알려 주세요.`,
      )
    }

    // 합치기(또는 PDF 하나에서 쪽 뽑기): 준 순서대로
    const doc = await PDFDocument.create()
    const summary: string[] = []
    for (const i of inputs) {
      if (i.ext === '.pdf') {
        const src = await open(i)
        const idx = pages ? pageList(pages, src.getPageCount()) : src.getPageIndices()
        if (typeof idx === 'string') return fail(idx)
        for (const pg of await doc.copyPages(src, idx)) doc.addPage(pg)
        summary.push(`${basename(i.path)} ${idx.length}쪽`)
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
        summary.push(`${basename(i.path)} 사진 1쪽`)
      }
    }
    const name =
      wanted ||
      (inputs.length > 1
        ? `${stem} 외 ${inputs.length - 1}개 합침`
        : pages
          ? `${stem} ${pages.replace(/\s+/g, '')}쪽`
          : `${stem} 사본`)
    const m = await save(doc, name)
    return ok(
      `${inputs.length > 1 ? `${inputs.length}개를 하나로 합쳤어요` : '쪽을 뽑아 새 PDF를 만들었어요'}(원본은 그대로): ` +
        `${scope.show(m.at)} (${m.pages}쪽, ${kb(m.size)}). 순서: ${summary.slice(0, 20).join(' → ')}. 사용자에게 이 경로를 알려 주세요.`,
    )
  } catch (e) {
    return fail((e as Error).message)
  }
}
