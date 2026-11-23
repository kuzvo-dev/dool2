// Renders an HTML file to PDF (A4, multiple pages) or PNG (Dool2 file_render, apps/daemon/src/render.ts).
// Opens it in a hidden (offscreen) window: no Node, sandboxed, and new windows, navigation, downloads and permission
// requests are blocked. Scripts are on (charts and drawings Dool2 made). It only loads local files in the user's
// folders (photos and fonts next to it) and https fonts and images: http, this PC and home network addresses are
// blocked. Renders one at a time
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { HtmlRenderer, HtmlRenderRequest, HtmlRenderResult } from '@dool2/daemon'
import { BrowserWindow, nativeImage, session } from 'electron'

const PARTITION = 'dool2-render-file'
/** A4 width (CSS px, 96dpi) */
const A4_WIDTH = 794
const A4_HEIGHT = 1123
/** PNG height limit (CSS px). Taller pages are cut to this from the top */
const MAX_PNG_HEIGHT = 16_000
/** Side limit when capturing at 2x (image buffer limit) */
const MAX_PNG_SIDE = 16_384

let current: HtmlRenderRequest | undefined
let ready = false

/** Whether this render window may load the address */
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
  // Block this PC and the home network (numeric addresses too, not just names)
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
      t = setTimeout(() => rej(new Error(`Stopped, took too long (${what})`)), ms)
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
    await withTimeout(w.loadFile(req.path), 30_000, 'open file')
    // Until fonts and images are drawn (does not wait if a script hangs)
    await withTimeout(
      wc.executeJavaScript(
        'Promise.all([document.fonts ? document.fonts.ready : 0, ...Array.from(document.images, (i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r }))]).then(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300))))',
        true,
      ),
      15_000,
      'load images',
    ).catch(() => undefined)

    if (req.to === 'pdf') {
      // Page previews: Dool2 looks at the result and fixes it (empty pages, overflowing tables). The first page also
      // shows in the Library and on the phone. Captures the screen one A4 height at a time (close to print breaks)
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
          // Follow the @page size when the HTML has one
          preferCSSPageSize: true,
        }),
        60_000,
        'make PDF',
      )
      return {
        data: Buffer.from(data),
        ...(preview ? { preview } : {}),
        ...(pages.length > 1 ? { pages } : {}),
      }
    }

    // PNG: grow the view to the full content size and capture at 2x (CDP)
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
        'capture image',
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

/** One at a time (the render session's request-blocking rules are set for that file) */
export const renderFile: HtmlRenderer = (req) => {
  const run = queue.then(() => renderOnce(req))
  queue = run.catch(() => undefined)
  return run
}
