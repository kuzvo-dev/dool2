// PDF 읽기: pdfjs-dist(Mozilla PDF.js, Apache-2.0)로 쪽마다 글을 뽑는다.
// 예전 방식(스트림을 직접 풀어 ToUnicode 표를 하나로 합치기)은 글꼴마다 표가 다른 한글 견적서·고지서에서
// 글자가 깨졌다. PDF.js는 글꼴별 ToUnicode·CID 글꼴 표(cmaps)·압축·객체 스트림을 모두 다룬다.
//
// - 줄: 같은 높이(y)에 놓인 글 조각을 한 줄로 모으고 왼쪽부터 잇는다
// - 표: 조각 사이가 글자 1.5개보다 넓으면 칸이 바뀐 것으로 보고 ' | '로 나눈다
// - 스캔 PDF: 글이 거의 없으면 쪽마다 가장 큰 사진을 PNG로 꺼낸다 (캔버스 없이)
// - PC 앱 묶음(esbuild)에도 들어가도록 worker는 직접 import 하고, cmaps·wasm은 dist/pdfjs/에 복사해 둔다
//   (apps/desktop/scripts/package.mjs)
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

export interface PdfText {
  /** 쪽 수 */
  pages: number
  /** 쪽마다 "[n쪽]" 머리를 붙여 이은 글 */
  text: string
  /** text 안에서 각 쪽이 시작하는 위치 (이어 읽기 안내용) */
  pageStarts: number[]
  /** 글자·숫자 수 (스캔 PDF 판단용) */
  letters: number
  /** 표처럼 칸을 ' | '로 나눈 줄이 있었는지 */
  table: boolean
}

/** 너무 큰 PDF에서 멈추지 않게 이만큼까지만 읽는다 */
const MAX_PAGES = 500

let lib: Promise<PdfJs> | undefined
/** pdfjs를 처음 쓸 때 한 번만 불러온다 (두리 본체 시작을 느리게 하지 않게) */
function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    // Node에는 캔버스가 없어 불러올 때 경고를 찍는다. 그림 그리기는 쓰지 않으니 그 경고만 잠깐 숨긴다
    const warn = console.warn
    console.warn = () => {}
    try {
      // 별도 worker 대신 같은 스레드에서 돌린다. 경로 문자열로 불러오면 묶음에 빠지므로 직접 import
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

/** cmaps(한글 CID 글꼴 표)·wasm이 있는 폴더. PC 앱 묶음이면 dist/pdfjs, 개발 중이면 node_modules */
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
    // pdfjs가 넘긴 배열을 옮겨 가므로 복사본을 준다
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
      throw new Error('암호가 걸린 PDF라 읽지 못했어요. 암호를 푼 파일로 저장해 주시면 읽을 수 있어요.')
    throw new Error(`PDF를 열지 못했어요(${(e as Error).message}). 파일이 깨졌을 수 있어요.`)
  }
}

interface Piece {
  str: string
  x: number
  y: number
  w: number
  h: number
}

/** 한 쪽의 글 조각을 줄·칸으로 정리 */
export function layout(pieces: Piece[]): { text: string; table: boolean } {
  const items = pieces.filter((t) => t.str.trim())
  // 위에서 아래로, 같은 높이면 왼쪽부터
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
        // 굵게 보이려고 같은 글을 살짝 비켜 두 번 그린 것은 한 번만
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
    // 줄 사이가 크게 벌어지면 문단이 바뀐 것으로 보고 빈 줄
    if (prevY !== undefined && prevY - l.y > Math.max(prevH, l.h) * 2.2) out.push('')
    out.push(s)
    prevY = l.y
    prevH = l.h
  }
  return { text: out.join('\n'), table }
}

/** PDF 글: 쪽마다 줄·표를 살려 뽑는다 */
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
      // 입력칸(서식 PDF)에 적힌 값은 글 조각에 없어서 따로 붙인다
      const fields = (await page.getAnnotations().catch(() => []))
        .map((a: { fieldValue?: unknown }) => a.fieldValue)
        .filter((v: unknown): v is string => typeof v === 'string' && v.trim() !== '')
      const body = [lay.text, ...(fields.length ? [`(입력칸) ${fields.join(' | ')}`] : [])]
        .filter(Boolean)
        .join('\n')
      const part = `[${n}쪽]\n${body}\n`
      pageStarts.push(len)
      parts.push(part)
      len += part.length + 1
      page.cleanup()
    }
    let text = parts.join('\n').trimEnd()
    if (pages > MAX_PAGES) text += `\n\n(전체 ${pages}쪽 중 앞 ${MAX_PAGES}쪽만 읽었어요)`
    const letters = text.replace(/\[\d+쪽\]/g, '').match(/[\p{L}\p{N}]/gu)?.length ?? 0
    return { pages, text, pageStarts, letters, table }
  } finally {
    await task.destroy().catch(() => {})
  }
}

/** 스캔 PDF: 쪽마다 가장 큰 사진을 PNG로 (앞쪽부터 max장). 그림이 크면 긴 변 maxSide로 줄인다 */
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

/** pdfjs가 풀어 준 그림 (kind 1: 흑백 1비트, 2: RGB, 3: RGBA) */
interface RawImage {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}

/** 같은 크기의 RGB로 바꾸면서 긴 변을 maxSide 아래로 줄인다 (칸 평균) */
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

/** 아주 작은 PNG 만들기 (RGB 8비트, 필터 없음) */
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
  ihdr[8] = 8 // 비트 깊이
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
