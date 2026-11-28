// Dool2 v2 desktop — the Electron main process. It owns the in-process daemon (a @dool2/agentd Session, session.ts),
// opens one chat window, and bridges the window to the daemon over a few IPC channels (preload.cts). The browser
// Dool2 drives is INVISIBLE (Dool2's own hidden Chromium, ADR 0046); the window shows a live mirror only while the
// user opens the "watch Dool2's browser" pane. A real brain (Claude Code / Codex / the pi fork) is injected later; now a
// scripted demo brain (demo.ts) makes the app runnable offline, which is also what the smoke screenshot captures.

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AutonomyLevel } from '@dool2/core'
import type { Lang } from '@dool2/i18n'
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { DEMO_MESSAGE, demoBrain } from './demo.js'
import { demoDraftsSnapshot } from './locales/drafts-demo.js'
import { mainText } from './locales/main.js'
import { createSession, type Session } from './session.js'

const here = dirname(fileURLToPath(import.meta.url))
const SMOKE = process.env.DOOL2_SMOKE === '1'
const BUILTIN_BROWSER = process.env.DOOL2_BUILTIN_BROWSER === '1'

function uiLang(): Lang {
  const first = app.getPreferredSystemLanguages()[0]?.toLowerCase() ?? ''
  // Korean-first (ADR 0029): a Korean OS starts in Korean, everything else in English for now.
  return first.startsWith('ko') ? 'ko' : 'en'
}

function dataDir(): string {
  return process.env.DOOL2_DATA_DIR ?? join(homedir(), '.dool2')
}

let session: Session | undefined
let win: BrowserWindow | undefined
/** Stops the live browser mirror (screencast or its screenshot fallback) while the pane is open; set only then. */
let mirrorStop: (() => Promise<void>) | undefined
let starting: Promise<void> | undefined
let level: AutonomyLevel = 'ask'

async function createWindow(): Promise<BrowserWindow> {
  const w = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: mainText(uiLang()).appName,
    backgroundColor: '#ffffff',
    show: !SMOKE,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep painting while hidden, so the smoke screenshot of an unshown window still captures.
      backgroundThrottling: !SMOKE,
    },
  })
  // Links open in the default browser; the window itself never navigates away from the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  await w.loadFile(join(here, 'renderer', 'index.html'))
  return w
}

/** Open the live mirror: subscribe to the hidden browser's screencast frames and forward each to the window. */
async function startMirror(w: BrowserWindow): Promise<void> {
  if (mirrorStop || starting || !session) return
  const s = session
  starting = (async () => {
    mirrorStop = await s.watchBrowser((frame) => {
      if (!w.isDestroyed()) w.webContents.send('dool2:browser-frame', frame)
    })
  })()
  try {
    await starting
  } finally {
    starting = undefined
  }
}

/** Close the live mirror: stop the screencast and drop the subscription. */
async function stopMirror(): Promise<void> {
  await starting?.catch(() => {})
  const stop = mirrorStop
  mirrorStop = undefined
  if (stop) await stop().catch(() => {})
}

function registerIpc(): void {
  ipcMain.handle('dool2:config', () => ({ lang: uiLang(), level, smoke: SMOKE }))

  ipcMain.handle('dool2:send', async (_e, text: string) => {
    if (!session || !win) return
    const w = win
    await session.agentd.send(text, {
      level,
      onEvent: (event) => {
        if (!w.isDestroyed()) w.webContents.send('dool2:event', event)
      },
    })
  })

  ipcMain.handle('dool2:set-level', (_e, next: AutonomyLevel) => {
    level = next
    session?.agentd.setLevel(next)
  })

  ipcMain.handle('dool2:watch-browser', async (_e, on: boolean) => {
    if (!win) return
    if (on) await startMirror(win)
    else {
      await stopMirror()
      if (!win.isDestroyed()) win.webContents.send('dool2:browser-frame', null)
    }
  })

  // The review-pending learned site-skill drafts + library KPIs. Same data the HTTP daemon serves at GET /drafts;
  // here we read the in-process daemon directly (agentd.drafts()/coverage()). The smoke run has no live recording
  // (fake bridges), so it serves demo drafts instead, to screenshot the panel with real-looking content.
  ipcMain.handle('dool2:drafts', () => {
    if (SMOKE) return demoDraftsSnapshot()
    return {
      drafts: session?.agentd.drafts() ?? [],
      coverage: session?.agentd.coverage() ?? { covered: 0, total: 0, clickFreeRatio: 0 },
    }
  })

  // Approve / discard a draft. TODO(v2 daemon): the LocalDraftStore has no approve/discard yet — a follow-up PR wires
  // agentd (and the HTTP daemon's POST routes) so an approved draft is written out as an active local skill and a
  // discarded one is dropped. Until then these are no-ops that report `wired: false`; the renderer still removes the
  // card optimistically so the panel stays usable. This never mutates agentd.
  ipcMain.handle('dool2:approve-draft', (_e, _id: string) => ({ ok: true, wired: false }))
  ipcMain.handle('dool2:discard-draft', (_e, _id: string) => ({ ok: true, wired: false }))
}

/** Smoke screenshot: wait for the window to paint, send the canned turn, capture the chat, quit. No network. */
async function smoke(w: BrowserWindow): Promise<void> {
  const ready = await new Promise<string>((resolve) => {
    ipcMain.once('dool2:ready', (_e, summary: string) => resolve(String(summary)))
    setTimeout(() => resolve('timeout'), 20_000)
  })
  // Show the canned user message, then run the demo turn through the daemon and stream its events to the window.
  if (!w.isDestroyed()) w.webContents.send('dool2:user-message', DEMO_MESSAGE)
  await session?.agentd.send(DEMO_MESSAGE, {
    level,
    onEvent: (event) => {
      if (!w.isDestroyed()) w.webContents.send('dool2:event', event)
    },
  })
  // Open the "review new site-skill drafts" panel so the screenshot shows it with the demo drafts.
  if (!w.isDestroyed())
    await w.webContents.executeJavaScript("document.getElementById('review-toggle').click()").catch(() => {})
  // Let the DOM paint the new lines and the fetched drafts before capturing.
  await new Promise((r) => setTimeout(r, 800))
  const out = process.env.DOOL2_SMOKE_OUT ?? join(here, '..', 'out')
  await mkdir(out, { recursive: true })
  const img = await w.webContents.capturePage()
  await writeFile(join(out, 'smoke.png'), img.toPNG())
  console.log(`DOOL2_SMOKE ${ready}`)
  await session?.close()
  app.exit(ready === 'timeout' ? 1 : 0)
}

app.whenReady().then(async () => {
  app.setName(mainText(uiLang()).appName)
  if (SMOKE) {
    const theme = process.env.DOOL2_SMOKE_THEME
    if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
  }
  session = createSession({
    brain: demoBrain(),
    builtinBrowser: BUILTIN_BROWSER,
    dataDir: dataDir(),
    level,
  })
  registerIpc()
  win = await createWindow()
  if (SMOKE) await smoke(win)
})

app.on('window-all-closed', () => {
  void stopMirror().finally(() => session?.close().finally(() => app.quit()))
})
