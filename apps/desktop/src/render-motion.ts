// 움직이는 HTML을 영상 장면으로 한 장씩 찍는다 (두리 video_motion, apps/daemon/src/motion.ts).
// 보이지 않는 창에서 열고, 모든 CSS 애니메이션을 멈춘 뒤 시각(currentTime)을 한 장씩 옮겨 찍는다
// — 실제 시간과 상관없이 매번 같은 결과(결정적). 불러오는 것은 render-file과 같은 울타리(사용자 폴더 안 파일·https 그림)
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MotionRenderRequest, MotionRenderResult } from '@dool2/daemon'
import { BrowserWindow, session } from 'electron'
import { allowedUrl } from './render-file.js'

const PARTITION = 'dool2-render-motion'
let current: MotionRenderRequest | undefined
let ready = false

function prepareSession() {
  const ses = session.fromPartition(PARTITION)
  if (ready) return ses
  ready = true
  ses.webRequest.onBeforeRequest((d, cb) =>
    cb({ cancel: !allowedUrl(d.url, d.method, current ? { ...current, to: 'png' } : undefined) }),
  )
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  return ses
}

let queue: Promise<unknown> = Promise.resolve()

/** 한 번에 하나씩 (창 하나로 무겁다) */
export function renderMotion(req: MotionRenderRequest): Promise<MotionRenderResult> {
  const run = queue.then(() => renderOnce(req))
  queue = run.catch(() => undefined)
  return run
}

async function renderOnce(req: MotionRenderRequest): Promise<MotionRenderResult> {
  const ses = prepareSession()
  const w = new BrowserWindow({
    show: false,
    width: req.width,
    height: req.height,
    useContentSize: true,
    backgroundColor: '#000000',
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
    wc.setFrameRate(60)
    w.setContentSize(req.width, req.height)
    await w.loadFile(req.path)
    // 글꼴(디자인 글꼴은 https)·그림이 다 그려지고 큰 글자 맞춤(__dool2Fit)이 끝날 때까지
    await wc.executeJavaScript(
      'Promise.all([document.fonts ? document.fonts.ready : 0, window.__dool2Fit, ...Array.from(document.images, (i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r })), ...Array.from(document.querySelectorAll("video"), (v) => v.readyState >= 2 ? 0 : new Promise((r) => { v.onloadeddata = v.onerror = r; setTimeout(r, 8000) }))]).then(() => new Promise((r) => setTimeout(r, 300)))',
      true,
    )
    await wc.executeJavaScript(
      `window.__seek = async (t) => {
        for (const a of document.getAnimations()) { a.pause(); a.currentTime = t }
        // 장면 속 영상 클립: 장면 시작부터 흐른 만큼 (data-from 초부터)
        await Promise.all(Array.from(document.querySelectorAll('video'), (v) => {
          v.pause()
          const want = Math.max(0, t / 1000 - Number(v.dataset.sceneStart || 0)) + Number(v.dataset.from || 0)
          const at = Math.min(want, (v.duration || want) - 0.04)
          if (Math.abs(v.currentTime - at) < 0.001) return 0
          return new Promise((r) => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); v.currentTime = at })
        }))
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))
      }; 0`,
      true,
    )
    const total = Math.max(1, Math.round(req.duration * req.fps))
    let written = 0
    for (let i = 0; i < total; i++) {
      const ms = (i * 1000) / req.fps
      await wc.executeJavaScript(`window.__seek(${ms.toFixed(2)})`, true)
      let shot = await wc.capturePage()
      if (shot.isEmpty()) continue
      const s = shot.getSize()
      if (s.width !== req.width || s.height !== req.height)
        shot = shot.resize({ width: req.width, height: req.height })
      written++
      await writeFile(join(req.outDir, `frame_${String(written).padStart(5, '0')}.jpg`), shot.toJPEG(90))
    }
    return { frames: written }
  } finally {
    current = undefined
    w.destroy()
  }
}
