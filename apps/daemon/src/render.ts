// HTML을 PDF(A4, 여러 쪽)·PNG 그림으로 (file_render). 두리가 만든 보고서·초대장을 사용자가 브라우저에서
// 인쇄하거나 화면을 캡처하지 않아도 되게 한다. 그리기는 PC 앱(Electron)이 보이지 않는 창에서 한다(opts.renderFile).
// 앱 없이 본체만 돌면(시험·개발) 그리는 부품이 없다고 알린다. 원본은 그대로 두고 옆에 같은 이름.pdf/.png를 만든다
import { stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { freeName } from './file-names.js'
import type { FileScope, FileToolResult } from './file-ops.js'
import { ensureLocal } from './files.js'

export type RenderTarget = 'pdf' | 'png'

export interface HtmlRenderRequest {
  /** 그릴 파일 (실제 경로, 볼 수 있는 폴더 안의 html·htm·svg) */
  path: string
  to: RenderTarget
  /** PDF를 가로로 */
  landscape?: boolean
  /** PNG 가로 (CSS px). 세로는 내용 길이만큼 */
  width?: number
  /** 그 파일이 불러도 되는 다른 로컬 파일인지 (옆에 둔 사진·글꼴). 볼 수 있는 폴더 안·민감하지 않은 것만 */
  allowFile(path: string): boolean
}

export interface HtmlRenderResult {
  data: Buffer
  /** PNG 크기 (px) */
  width?: number
  height?: number
  /** 너무 길어 위에서부터 이만큼(CSS px)만 담았다 */
  cut?: number
  /** 보관함·폰에 보일 미리보기 (JPEG base64) */
  preview?: string
}

/** PC 앱이 주는 그리기 부품 */
export type HtmlRenderer = (req: HtmlRenderRequest) => Promise<HtmlRenderResult>

/** 만든 파일 (보관함에 올린다) */
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
  '지금 두리 본체가 PC 앱 밖에서(개발·시험용으로) 돌고 있어 PDF·PNG로 그리는 부품이 없어요. 두리 PC 앱에서는 바로 돼요. HTML 파일은 그대로 있어요.'

const kb = (n: number) =>
  n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

/** 새 파일 자리: 원본 옆 같은 이름.pdf/.png (같은 이름이 있으면 "(1)") */
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
  if (!raw) return fail('PDF·PNG로 만들 HTML 파일을 path에 주세요 (file_write가 알려 준 경로 그대로).')
  const to: RenderTarget = String(args.to ?? 'pdf').toLowerCase() === 'png' ? 'png' : 'pdf'
  const p = scope.inside(raw)
  if (!p)
    return fail(
      `${basename(raw)}: 없거나 바탕화면·문서·다운로드 밖이에요. file_find로 경로를 먼저 찾아 주세요.`,
    )
  if (scope.sensitive(p)) return fail(`${basename(p)}: 민감한 파일이라 손대지 않아요.`)
  const ext = extname(p).toLowerCase()
  if (!RENDER_EXT.test(ext)) {
    if (ext === '.pdf' || /^\.(jpe?g|png|heic|webp)$/.test(ext))
      return fail(
        `${basename(p)}: 이미 PDF·사진이에요. 사진을 PDF로 묶으려면 file_pdf, 사진 형식은 file_convert를 써요.`,
      )
    return fail(
      `${basename(p)}: HTML(html·htm)·SVG만 PDF·PNG로 그려요. 글·표 내용이면 file_write로 html을 만든 뒤 그 파일을 주세요.`,
    )
  }
  const s = await stat(p)
  if (s.isDirectory()) return fail(`${basename(p)}: 폴더 말고 파일을 주세요.`)
  if (s.size > MAX_SOURCE) return fail(`${basename(p)}: 20MB보다 큰 HTML은 그리지 않아요.`)
  // iCloud Drive가 클라우드에만 둔 파일은 먼저 내려받는다 (그대로 열면 빈 화면·실패)
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
                '그리는 데 너무 오래 걸려 멈췄어요. HTML을 가볍게(큰 그림·스크립트 줄여) 다시 만들어 보세요.',
              ),
            ),
          timeoutMs,
        )
      }),
    ])
  } catch (e) {
    return fail(`${basename(p)}을(를) ${to.toUpperCase()}로 그리지 못했어요: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  // 받은 것이 정말 그 형식인지 본다
  let pages = 0
  if (to === 'pdf') {
    try {
      pages = (await PDFDocument.load(out.data, { updateMetadata: false })).getPageCount()
    } catch {
      return fail(`${basename(p)}을(를) PDF로 그리지 못했어요 (만든 PDF가 깨졌어요).`)
    }
  } else if (out.data.length < 8 || !out.data.subarray(0, 8).equals(PNG_SIG))
    return fail(`${basename(p)}을(를) PNG로 그리지 못했어요 (만든 그림이 깨졌어요).`)

  const at = renderOutPath(p, to)
  await writeFile(at, out.data, { flag: 'wx' })
  const shown = scope.show(at)
  onMade?.({ name: basename(at), kind: to, path: shown, ...(out.preview ? { image: out.preview } : {}) })
  const what =
    to === 'pdf'
      ? `PDF로 만들었어요: ${shown} (${args.landscape === true ? 'A4 가로' : 'A4'} ${pages}쪽, ${kb(out.data.length)})`
      : `PNG 그림으로 만들었어요: ${shown} (${out.width && out.height ? `${out.width}×${out.height}, ` : ''}${kb(out.data.length)})`
  const cut = out.cut
    ? ` 내용이 너무 길어 위에서 ${out.cut.toLocaleString()}px까지만 담았어요. 전부 담으려면 to: "pdf"로 쪽을 나눠 만들어요.`
    : ''
  return ok(
    `${what}. 원본 ${basename(p)}은 그대로 뒀어요.${cut} 사용자에게 이 경로를 그대로 알려 주세요(브라우저 인쇄·화면 캡처를 부탁하지 않아요).${onMade ? " 보관함의 '사진·파일'에도 올려서 폰에서도 볼 수 있어요." : ''}`,
  )
}
