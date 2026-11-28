// Dool2 v2 desktop — the Electron main process. It owns the in-process daemon (a @dool2/agentd Session, session.ts),
// opens one chat window, and bridges the window to the daemon over a few IPC channels (preload.cts). The browser
// Dool2 drives is INVISIBLE (Dool2's own hidden Chromium, ADR 0046); the window shows a live mirror only while the
// user opens the "watch Dool2's browser" pane. A real brain (Claude Code / Codex / the pi fork) is injected later; now a
// scripted demo brain (demo.ts) makes the app runnable offline, which is also what the smoke screenshot captures.

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RelayBridge, startRelayBridge } from '@dool2/agentd'
import type { AutonomyLevel } from '@dool2/core'
import type { Lang } from '@dool2/i18n'
import { OFFICIAL_RELAY } from '@dool2/protocol/link'
import { PAIRING_OFFER_VERSION, pairingUrl } from '@dool2/protocol/pair-rpc'
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import * as QRCode from 'qrcode'
import { demoBrain } from './demo.js'
import { demoDraftsSnapshot } from './locales/drafts-demo.js'
import { mainText } from './locales/main.js'
import { createSession, type Session } from './session.js'

const here = dirname(fileURLToPath(import.meta.url))
const SMOKE = process.env.DOOL2_SMOKE === '1'
const BUILTIN_BROWSER = process.env.DOOL2_BUILTIN_BROWSER === '1'
/** The tab the smoke run should capture (DOOL2_SMOKE_VIEW=me screenshots the phone-pairing screen). Empty = the chat. */
const SMOKE_VIEW = process.env.DOOL2_SMOKE_VIEW ?? ''

/** A short code the phone enters to pair, generated once per launch (not a secret on its own — the loopback token is
 *  the actual authorization). Shown on the pairing screen so the phone and PC confirm they mean the same session. */
const PAIRING_CODE = SMOKE
  ? '428 155'
  : String(Math.floor(100_000 + Math.random() * 900_000)).replace(/(\d{3})(\d{3})/, '$1 $2')
/** The code without the display space — what the phone actually sends and the relay bridge checks. */
const PAIRING_DIGITS = PAIRING_CODE.replace(/\D/g, '')
/** The relay to reach phones through. Set DOOL2_RELAY to a reachable relay to turn the QR into a working one; without
 *  it the screen shows the code and (in smoke) a sample QR, but no live relay connection is opened. */
const RELAY_URL = process.env.DOOL2_RELAY ?? ''

function uiLang(): Lang {
  const first = app.getPreferredSystemLanguages()[0]?.toLowerCase() ?? ''
  // Korean-first (ADR 0029): a Korean OS starts in Korean, everything else in English for now.
  return first.startsWith('ko') ? 'ko' : 'en'
}

function dataDir(): string {
  return process.env.DOOL2_DATA_DIR ?? join(homedir(), '.dool2')
}

let session: Session | undefined
/** The outbound relay connection a phone pairs through, when a relay is configured (DOOL2_RELAY). */
let relayBridge: RelayBridge | undefined
let win: BrowserWindow | undefined
/** Stops the live browser mirror (screencast or its screenshot fallback) while the pane is open; set only then. */
let mirrorStop: (() => Promise<void>) | undefined
let starting: Promise<void> | undefined
let level: AutonomyLevel = 'ask'

async function createWindow(): Promise<BrowserWindow> {
  const w = new BrowserWindow({
    // Matches the design preview (docs/design/screens/src/PC.dc.html, 1440×900) so the 3-column layout breathes.
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
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

/** The phone-app URL the QR encodes: the live relay offer when a relay is connected, else a sample offer in smoke
 *  (so the screenshot shows a QR with no network), else none. */
function pairingOfferUrl(): string | undefined {
  if (relayBridge && RELAY_URL) return relayBridge.offerUrl(`${RELAY_URL}/app`)
  if (SMOKE) {
    return pairingUrl(`${OFFICIAL_RELAY}/app`, {
      v: PAIRING_OFFER_VERSION,
      relay: OFFICIAL_RELAY,
      room: 'SAMPLEroomSAMPLEr',
      boxPub: 'SAMPLEboxSAMPLEboxSAMPLEboxSAMPL',
      code: PAIRING_DIGITS,
    })
  }
  return undefined
}

/** Render a URL as an inline SVG QR, cached per URL (the offer is stable for the life of the relay connection). */
const qrCache = new Map<string, string>()
async function qrSvgFor(url: string): Promise<string | undefined> {
  const hit = qrCache.get(url)
  if (hit) return hit
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    qrCache.set(url, svg)
    return svg
  } catch {
    return undefined
  }
}

/** Open the outbound relay connection so a real phone can pair + sign over the internet, when DOOL2_RELAY is set. */
async function startRelayIfConfigured(): Promise<void> {
  if (!RELAY_URL || SMOKE || !session) return
  try {
    relayBridge = await startRelayBridge({
      agentd: session.agentd,
      relayUrl: RELAY_URL,
      pairingCode: PAIRING_DIGITS,
      log: (l) => console.log(`[relay] ${l}`),
    })
    console.log(`[relay] joined ${RELAY_URL} room ${relayBridge.room.slice(0, 8)}…`)
  } catch (err) {
    console.error(`[relay] could not join ${RELAY_URL}:`, err instanceof Error ? err.message : err)
  }
}

function registerIpc(): void {
  ipcMain.handle('dool2:config', () => ({ lang: uiLang(), level, smoke: SMOKE, view: SMOKE_VIEW }))

  // The pairing screen: the QR the phone scans (relay + room + daemon key + code), the 6-digit code as a fallback, and
  // whether a phone has already paired (a device key is registered via the relay). The QR encodes the phone-app URL
  // with the offer in its fragment — never the daemon's loopback token. When a relay is configured the offer is live
  // (from the outbound relay bridge); in the smoke run a sample offer stands in so the screenshot shows a QR offline.
  ipcMain.handle('dool2:pairing', async () => {
    const paired = relayBridge?.paired() ?? session?.agentd.hasDevice() ?? false
    const offerUrl = pairingOfferUrl()
    const qrSvg = offerUrl ? await qrSvgFor(offerUrl) : undefined
    return {
      code: PAIRING_CODE,
      paired,
      ...(offerUrl ? { offerUrl } : {}),
      ...(qrSvg ? { qrSvg } : {}),
    }
  })

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

  // The approval cards still awaiting a phone signature (same data the HTTP daemon serves at GET /pending). The
  // renderer shows these in the up-next queue; offline/smoke this is empty and the seeded demo queue stands in.
  ipcMain.handle('dool2:pending', () => session?.agentd.pending() ?? [])

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

/** Smoke screenshot: wait for the window to paint the seeded chat view (the full 3-column screen), capture it, quit.
 *  No network. The seeded thread + Now tasks + Dool2's-screen card come from the renderer's demo seed (locales/seed.ts),
 *  so the screenshot matches docs/design/screens/pc-light.png. The live demo brain stays reachable by typing. */
async function smoke(w: BrowserWindow): Promise<void> {
  const ready = await new Promise<string>((resolve) => {
    ipcMain.once('dool2:ready', (_e, summary: string) => resolve(String(summary)))
    setTimeout(() => resolve('timeout'), 20_000)
  })
  // Let the fonts, character images and seeded DOM settle before capturing.
  await new Promise((r) => setTimeout(r, 800))
  const out = process.env.DOOL2_SMOKE_OUT ?? join(here, '..', 'out')
  await mkdir(out, { recursive: true })
  const img = await w.webContents.capturePage()
  const name = SMOKE_VIEW === 'me' ? 'smoke-pair.png' : 'smoke.png'
  await writeFile(join(out, name), img.toPNG())
  console.log(`DOOL2_SMOKE ${ready}`)
  await session?.close()
  app.exit(ready === 'timeout' ? 1 : 0)
}

app.whenReady().then(async () => {
  app.setName(mainText(uiLang()).appName)
  if (SMOKE) {
    // The canonical smoke is the light view, to compare against docs/design/screens/pc-light.png. Override with
    // DOOL2_SMOKE_THEME=dark for the dark capture.
    const theme = process.env.DOOL2_SMOKE_THEME ?? 'light'
    if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
  }
  session = createSession({
    brain: demoBrain(),
    builtinBrowser: BUILTIN_BROWSER,
    dataDir: dataDir(),
    level,
  })
  registerIpc()
  await startRelayIfConfigured()
  win = await createWindow()
  if (SMOKE) await smoke(win)
})

app.on('window-all-closed', () => {
  relayBridge?.close()
  void stopMirror().finally(() => session?.close().finally(() => app.quit()))
})
