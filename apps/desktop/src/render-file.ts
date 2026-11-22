// HTML 파일을 PDF(A4, 여러 쪽)·PNG로 그린다 (두리 file_render, apps/daemon/src/render.ts).
// 보이지 않는 창(offscreen)에서 연다: 노드 기능 없음·샌드박스·창 열기·이동·내려받기·권한 요청은 막는다.
// 스크립트는 켠다(두리가 그린 차트·그림). 불러오는 것은 사용자 폴더 안의 로컬 파일(옆에 둔 사진·글꼴)과
// https 글꼴·그림만: http·이 PC·집 안 네트워크 주소는 막는다. 한 번에 하나씩 그린다
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { HtmlRenderer, HtmlRenderRequest, HtmlRenderResult } from '@dool2/daemon'
import { BrowserWindow, nativeImage, session } from 'electron'

const PARTITION = 'dool2-render-file'
/** A4 너비 (CSS px, 96dpi) */
const A4_WIDTH = 794
const A4_HEIGHT = 1123
/** PNG 세로 한도 (CSS px). 넘으면 위에서 이만큼만 */
const MAX_PNG_HEIGHT = 16_000
/** 2배로 찍을 때 한 변 한도 (그림 버퍼 한도) */
const MAX_PNG_SIDE = 16_384

let current: HtmlRenderRequest | undefined
let ready = false

/** 이 그리기 창이 불러도 되는 주소인지 */
export function allowedUrl(url: string, method: string, req: HtmlRenderRequest | undefined): boolean {
  if (!req) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true
  if (u.protocol === 'file:') {
    try {
      return req.allowFile(fileURLToPath(u))
    } catch {
      return false
    }
  }
  if (u.protocol !== 'https:' || method !== 'GET') return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // 이 PC·집 안 네트워크는 막는다 (주소 이름 대신 숫자 주소로 부르는 것도)
  return !(host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host))
}

function prepareSession() {
  const ses = session.fromPartition(PARTITION)
  if (ready) return ses
  ready = true
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowedUrl(d.url, d.method, current) }))
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  return ses
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`너무 오래 걸려 멈췄어요(${what})`)), ms)
    }),
  ]).finally(() => clearTimeout(t))
}

async function renderOnce(req: HtmlRenderRequest): Promise<HtmlRenderResult> {
  const ses = prepareSession()
  const width = req.to === 'png' ? (req.width ?? 800) : A4_WIDTH
  const w = new BrowserWindow({
    show: false,
    width,
    height: req.to === 'png' ? 600 : A4_HEIGHT,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: ses,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      webSecurity: true,
      images: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  current = req
  try {
    const wc = w.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('will-redirect', (e) => e.preventDefault())
    await withTimeout(w.loadFile(req.path), 30_000, '파일 열기')
    // 글꼴·그림이 다 그려질 때까지 (스크립트가 멈춰 있으면 기다리지 않는다)
    await withTimeout(
      wc.executeJavaScript(
        'Promise.all([document.fonts ? document.fonts.ready : 0, ...Array.from(document.images, (i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r }))]).then(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300))))',
        true,
      ),
      15_000,
      '그림 불러오기',
    ).catch(() => undefined)

    if (req.to === 'pdf') {
      // 쪽 미리보기: 두리가 그린 모습을 보고 고친다(빈 쪽·넘친 표). 첫 쪽은 보관함·폰에도 보인다.
      // 화면을 A4 높이만큼씩 내려 찍는다 (인쇄 쪽 나눔과 대략 같다)
      const pages: string[] = []
      const total = Number(
        await wc.executeJavaScript('document.documentElement.scrollHeight').catch(() => A4_HEIGHT),
      )
      const count = Math.min(6, Math.max(1, Math.ceil(total / A4_HEIGHT)))
      for (let i = 0; i < count; i++) {
        await wc.executeJavaScript(`window.scrollTo(0, ${i * A4_HEIGHT})`).catch(() => undefined)
        await new Promise((r) => setTimeout(r, 120))
        const shot = await wc.capturePage().catch(() => undefined)
        if (!shot || shot.isEmpty()) break
        const w = i === 0 ? 800 : 560
        pages.push(
          (shot.getSize().width > w ? shot.resize({ width: w }) : shot)
            .toJPEG(i === 0 ? 80 : 70)
            .toString('base64'),
        )
      }
      await wc.executeJavaScript('window.scrollTo(0, 0)').catch(() => undefined)
      const preview = pages[0]
      const data = await withTimeout(
        wc.printToPDF({
          pageSize: 'A4',
          landscape: req.landscape === true,
          printBackground: true,
          // HTML에 @page 크기가 있으면 그것을 따른다
          preferCSSPageSize: true,
        }),
        60_000,
        'PDF 만들기',
      )
      return {
        data: Buffer.from(data),
        ...(preview ? { preview } : {}),
        ...(pages.length > 1 ? { pages } : {}),
      }
    }

    // PNG: 내용 전체 크기로 화면을 늘려 2배로 찍는다 (CDP)
    const dbg = wc.debugger
    dbg.attach('1.3')
    try {
      const m = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize: { width: number; height: number }
      }
      const size = m.cssContentSize ?? m.contentSize
      const cw = Math.min(Math.max(width, Math.ceil(size.width)), 4000)
      const full = Math.max(1, Math.ceil(size.height))
      const ch = Math.min(full, MAX_PNG_HEIGHT)
      const scale = cw * 2 <= MAX_PNG_SIDE && ch * 2 <= MAX_PNG_SIDE ? 2 : 1
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: cw,
        height: ch,
        deviceScaleFactor: scale,
        mobile: false,
      })
      await new Promise((r) => setTimeout(r, 200))
      const shot = (await withTimeout(
        dbg.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: cw, height: ch, scale: 1 },
        }),
        60_000,
        '그림 찍기',
      )) as { data: string }
      const data = Buffer.from(shot.data, 'base64')
      const img = nativeImage.createFromBuffer(data)
      const px = img.getSize()
      const preview = (px.width > 800 ? img.resize({ width: 800 }) : img).toJPEG(80).toString('base64')
      return {
        data,
        width: px.width,
        height: px.height,
        preview,
        ...(full > ch ? { cut: ch } : {}),
      }
    } finally {
      try {
        dbg.detach()
      } catch {}
    }
  } finally {
    current = undefined
    w.destroy()
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** 한 번에 하나씩 (그리기 세션의 요청 막기 규칙을 그 파일에 맞춰 둔다) */
export const renderFile: HtmlRenderer = (req) => {
  const run = queue.then(() => renderOnce(req))
  queue = run.catch(() => undefined)
  return run
}
