// Dool2 desktop app (Electron main process).
// Runs the Dool2 daemon (dool2d) in the same process and gives the window only its address and token.
// Closing the window keeps Dool2 in the tray, still working. Quit from the tray menu (docs/architecture.md 7.1).
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerExternalExtension } from '@dool2/browser'
import { type Daemon, startDaemon } from '@dool2/daemon'
import { deviceRegion, initialLang, type Lang } from '@dool2/i18n'
import {
  type Settings,
  STORE_EXTENSION_ID,
  STORE_EXTENSION_PUBLISHED,
  storeExtensionPage,
} from '@dool2/protocol'
import { OFFICIAL_RELAY } from '@dool2/protocol/link'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  safeStorage,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import { mainText, smokeAmount } from './locales/main.js'
import { packOption } from './packs.js'
import { KeepAwake, loginItemSettings } from './power.js'
import { renderFile } from './render-file.js'
import { renderMotion } from './render-motion.js'
import { fileSecrets } from './secrets.js'
import { Updater, type UpdateState } from './update.js'
import { installUpdate } from './update-install.js'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
const SMOKE = process.env.DOOL2_SMOKE === '1'
/** Started automatically at login: run in the tray only, without a window */
const HIDDEN = process.argv.includes('--hidden')

let daemon: Daemon | undefined
let win: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let updater: Updater | undefined
/** UI language from settings, read each time text is shown so a change in Settings applies next time */
const uiLang = (): Lang => {
  const st = daemon?.settings()
  const os = app.getPreferredSystemLanguages()
  return initialLang(st?.language, os, st?.region ?? deviceRegion(os))
}
const keepAwake = new KeepAwake({
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => powerSaveBlocker.stop(id),
})

async function createWindow(show: boolean) {
  const w = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: mainText(uiLang()).appName,
    backgroundColor: '#ffffff',
    show,
    icon: join(assets, 'icon.png'),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // In smoke tests, keep painting even when the window is hidden
      backgroundThrottling: !SMOKE,
    },
  })
  // Links in the window open in the default browser
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    // Only the macOS Privacy settings panes (permissions to control PC apps)
    else if (
      /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_(?:Accessibility|ScreenCapture)$/.test(
        url,
      )
    )
      void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // Closing the window does not stop the daemon. The window is destroyed, not hidden: the renderer and GPU
  // processes use about 300MB, and a hidden window kept drawing the 3D Dool2 and burning CPU (measured).
  // Opening from the tray creates a new one
  w.on('closed', () => {
    if (win === w) win = undefined
  })
  await w.loadFile(join(here, 'renderer', 'index.html'))
  return w
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    void createWindow(true).then((w) => {
      win = w
    })
    return
  }
  win.show()
  win.focus()
}

function createTray() {
  const mac = process.platform === 'darwin'
  const icon = nativeImage.createFromPath(join(assets, mac ? 'trayTemplate.png' : 'tray.png'))
  if (mac) icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip(mainText(uiLang()).appName)
  tray.on('click', showWindow)
  updateTray()
}

function updateTray() {
  if (!tray) return
  const busy = daemon?.busy ?? false
  const m = mainText(uiLang())
  tray.setToolTip(m.appName)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: busy ? m.trayBusy : m.trayIdle, enabled: false },
      ...(keepAwake.active ? [{ label: m.trayAwake, enabled: false }] : []),
      { type: 'separator' },
      { label: m.trayOpen, click: showWindow },
      { type: 'separator' },
      {
        label: m.trayQuit,
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

/** Applies the power and launch-at-login settings the user agreed to */
function applySettings(settings: Settings) {
  keepAwake.update(settings, daemon?.busy ?? false)
  // In development (electron .) the login item would be Electron itself, so only change it in packaged builds
  if (app.isPackaged && settings.launchAtLogin !== undefined)
    app.setLoginItemSettings(loginItemSettings(settings))
  updateTray()
}

/**
 * Where the Dool2 tool server lives in the packaged app (scripts/package.mjs puts it there). Codex is downloaded on
 * first use. The tool server runs Electron as Node, so it sits outside the asar (app.asar.unpacked).
 */
function packagedPaths() {
  if (!app.isPackaged) return {}
  return {
    mcpServerScript: join(here, 'mcp-server.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`),
    skillsDir: join(process.resourcesPath, 'skills'),
    // PC screen control helper (Mac only). The app launches it, so macOS permissions are granted to the Dool2 app
    ...(process.platform === 'darwin' ? { hands: join(process.resourcesPath, 'hands', 'dool2-hands') } : {}),
  }
}

/**
 * Registers the Dool2 native host with Chrome (ADR 0006). The packaged app registers on every start.
 * In development it registers in the user's Chrome only with DOOL2_REGISTER_HOST=1, and never in smoke mode.
 * DOOL2_HOST_DIRS: NativeMessagingHosts folders of test Chrome profiles (several, joined by the path delimiter)
 */
function nativeHostOption() {
  const extraDirs = (process.env.DOOL2_HOST_DIRS ?? '').split(delimiter).filter(Boolean)
  // DOOL2_REGISTER_HOST=0: leave the user's Chrome alone when testing the packaged app
  const defaultTargets =
    !SMOKE &&
    process.env.DOOL2_REGISTER_HOST !== '0' &&
    (app.isPackaged || process.env.DOOL2_REGISTER_HOST === '1')
  if (!defaultTargets && !extraDirs.length) return {}
  const script = app.isPackaged
    ? join(here, 'native-host.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    : undefined
  return {
    nativeHost: { ...(script ? { script } : {}), extraDirs, defaultTargets },
    // Open the user's Chrome when Dool2 needs the browser and the extension is not there (ADR 0006 follow-up): only
    // where the host is registered with the user's own Chrome, never for a test Chrome
    launchChrome: defaultTargets,
  }
}

/**
 * Copies the Dool2 Chrome extension folder into the data folder. Until the web store release (M5) users load this
 * folder into Chrome themselves. In the data folder (not inside the app) the path never changes, and it is refreshed
 * when the app updates.
 */
async function prepareExtension(dataDir: string): Promise<string> {
  const from = app.isPackaged
    ? join(process.resourcesPath, 'extension')
    : join(here, '..', '..', 'extension', 'dist')
  const to = join(dataDir, 'chrome-extension')
  try {
    await rm(to, { recursive: true, force: true })
    await cp(from, to, { recursive: true })
  } catch (e) {
    console.error(`[dool2] could not prepare the extension folder: ${(e as Error).message}`)
  }
  return to
}

/** Web store extension id. Tests can override it with DOOL2_STORE_EXTENSION_ID */
function storeExtensionId(): string | undefined {
  const id =
    process.env.DOOL2_STORE_EXTENSION_ID ?? (STORE_EXTENSION_PUBLISHED ? STORE_EXTENSION_ID : undefined)
  return id && /^[a-p]{32}$/.test(id) ? id : undefined
}

/** Opens the address in Chrome, not the default browser (the extension must be added to Chrome). Falls back to the default browser */
function openInChrome(url: string) {
  const fallback = () => void shell.openExternal(url)
  if (process.platform === 'darwin') execFile('open', ['-a', 'Google Chrome', url], (e) => e && fallback())
  else if (process.platform === 'win32')
    execFile('cmd', ['/c', 'start', '""', 'chrome', url], { windowsHide: true }, (e) => e && fallback())
  else fallback()
}

/** Shrinks an image to a JPEG (base64) `width` wide (Library and chat previews of AI-made images) */
async function shrinkImage(data: Buffer, width: number): Promise<string | undefined> {
  const img = nativeImage.createFromBuffer(data)
  if (img.isEmpty()) return undefined
  const fit = img.getSize().width > width ? img.resize({ width, quality: 'good' }) : img
  return fit.toJPEG(80).toString('base64')
}

/**
 * Renders HTML Dool2 made (images, invitations, reports) in a hidden window and captures a JPEG (Library and phone
 * previews). Scripts are off, and no network or other files are loaded
 */
async function renderHtml(html: string): Promise<string | undefined> {
  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    // A session only for rendering, so request blocking does not spread to the app window
    webPreferences: {
      javascript: false,
      offscreen: true,
      sandbox: true,
      images: true,
      partition: 'dool2-render',
    },
  })
  try {
    w.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'file://*/*'] },
      (_d, cb) => cb({ cancel: true }),
    )
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 400))
    const img = await w.webContents.capturePage()
    const size = img.getSize()
    const fit = size.width > 800 ? img.resize({ width: 800 }) : img
    return fit.toJPEG(80).toString('base64')
  } catch {
    return undefined
  } finally {
    w.destroy()
  }
}

/** Fake update state for smoke screenshots (DOOL2_SMOKE_UPDATE=available|required) */
function smokeUpdate(): UpdateState | undefined {
  const k = SMOKE ? process.env.DOOL2_SMOKE_UPDATE : undefined
  if (k !== 'available' && k !== 'required') return undefined
  return {
    status: 'available',
    current: app.getVersion(),
    // For smoke screenshots: one version above the current one
    latest: app.getVersion().replace(/(\d+)$/, (n) => String(Number(n) + 1)),
    notes: mainText(uiLang()).smokeNotes,
    required: k === 'required',
  }
}

/** Development and CI smoke test: open the window, check it renders, capture it and quit */
async function smoke(w: BrowserWindow) {
  const ready = await new Promise<string>((resolve) => {
    ipcMain.once('dool2:ready', (_e, summary: string) => resolve(summary))
    setTimeout(() => resolve('timeout'), process.env.DOOL2_SMOKE_ASK ? 300_000 : 20_000)
  })
  const out = process.env.DOOL2_SMOKE_OUT ?? join(here, '..', 'out')
  await mkdir(out, { recursive: true })
  // To capture lower on the screen: scroll the element matching this selector into view first (e.g. .svc-fast)
  const scroll = process.env.DOOL2_SMOKE_SCROLL
  // DOOL2_SMOKE_SCROLL_TIMES: scroll several times (a long list loading its next page pushes the last row down again)
  const times = Math.min(Number(process.env.DOOL2_SMOKE_SCROLL_TIMES) || 1, 10)
  for (let i = 0; scroll && i < times; i++) {
    await w.webContents
      .executeJavaScript(
        `document.querySelector(${JSON.stringify(scroll)})?.scrollIntoView({ block: 'center' })`,
      )
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 600))
  }
  const img = await w.webContents.capturePage()
  await writeFile(join(out, 'smoke.png'), img.toPNG())
  console.log(`DOOL2_SMOKE ${ready}`)
  // app.exit skips before-quit, so close the daemon (and its child processes, like logins) here
  await daemon?.close()
  app.exit(ready === 'timeout' ? 1 : 0)
}

// Only one Dool2 runs at a time. Starting a second one shows the existing window
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  // Smoke screenshots: pick dark or light (normally it follows the device)
  const theme = process.env.DOOL2_SMOKE_THEME
  if (SMOKE && (theme === 'dark' || theme === 'light')) nativeTheme.themeSource = theme
  const dataDir = process.env.DOOL2_DATA_DIR ?? join(app.getPath('appData'), 'dool2')
  const d = await startDaemon({
    renderHtml,
    shrinkImage,
    // HTML Dool2 made (reports, invitations) to PDF or PNG files (file_render)
    renderFile,
    // Capture motion graphics video frames one by one (video_motion)
    renderMotion,
    // File links in answers and Library [Open]: once the daemon checks the file is in the user's folders, open it in the default app or show it in its folder
    openFile: async (path, how) => {
      if (SMOKE) return undefined
      if (how === 'reveal') {
        shell.showItemInFolder(path)
        return undefined
      }
      const err = await shell.openPath(path)
      return err ? mainText(uiLang()).openFileFailed(err) : undefined
    },
    // This PC's name on the phone (default: the computer name). Override it so test screenshots don't show the real name
    ...(process.env.DOOL2_PC_NAME ? { pcName: process.env.DOOL2_PC_NAME } : {}),
    appVersion: app.getVersion(),
    dataDir,
    secrets: fileSecrets(join(dataDir, 'secrets.json'), safeStorage, uiLang),
    // The phone connects through the official relay. A self-hosted one in settings (relay) or DOOL2_RELAY comes first
    relay: OFFICIAL_RELAY,
    ...packagedPaths(),
    // Connector packs (ADR 0039): newer cards and connectors without a new app version (packaged app only)
    ...packOption(app.isPackaged, process.resourcesPath),
    ...nativeHostOption(),
    // The app asks for and checks macOS permissions (Accessibility, Screen Recording) itself, so they show under the Dool2 name
    ...(process.platform === 'darwin'
      ? {
          appPermissions: {
            status: () => ({
              accessibility: systemPreferences.isTrustedAccessibilityClient(false),
              screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
            }),
            request: async () => {
              systemPreferences.isTrustedAccessibilityClient(true)
              // macOS asks for Screen Recording the first time the screen list is requested
              if (systemPreferences.getMediaAccessStatus('screen') !== 'granted')
                await desktopCapturer
                  .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
                  .catch(() => [])
            },
          },
        }
      : {}),
  })
  daemon = d
  // For tests: write the daemon address and window token to a file (0600) to drive the packaged app from outside. Only with this env var
  if (process.env.DOOL2_API_INFO)
    await writeFile(process.env.DOOL2_API_INFO, JSON.stringify({ url: d.url, token: d.token }), {
      mode: 0o600,
    })
  const extensionDir = await prepareExtension(dataDir)
  ipcMain.handle('dool2:extension-dir', () => extensionDir)
  ipcMain.on('dool2:reveal-extension', () => shell.showItemInFolder(join(extensionDir, 'manifest.json')))
  const storeId = storeExtensionId()
  ipcMain.handle('dool2:store-extension', () => storeId ?? null)
  ipcMain.on('dool2:open-store', () => {
    if (storeId && !SMOKE) openInChrome(storeExtensionPage(storeId))
  })
  // If the extension is on the web store, also register it as pending in Chrome and Edge: even if setup skipped it,
  // the browser shows [Enable] next time it starts. In tests (DOOL2_REGISTER_HOST=0) leave the user's browsers alone
  if (
    storeId &&
    !SMOKE &&
    process.env.DOOL2_REGISTER_HOST !== '0' &&
    (app.isPackaged || process.env.DOOL2_REGISTER_HOST === '1')
  )
    void registerExternalExtension({ id: storeId }).catch(() => undefined)
  ipcMain.handle('dool2:config', () => ({
    url: d.url,
    token: d.token,
    ...(SMOKE && process.env.DOOL2_SMOKE_OPEN ? { smokeOpen: process.env.DOOL2_SMOKE_OPEN } : {}),
    ...(SMOKE && process.env.DOOL2_SMOKE_SETUP ? { smokeSetup: process.env.DOOL2_SMOKE_SETUP } : {}),
    // Smoke: show the screens as if no AI were ready on this PC (DOOL2_SMOKE_NO_AI=1)
    ...(SMOKE && process.env.DOOL2_SMOKE_NO_AI === '1' ? { smokeNoAi: true } : {}),
    // Smoke: send this request, and with DOOL2_SMOKE_ASK_WAIT (ms) capture the working screen after that long
    ...(SMOKE && process.env.DOOL2_SMOKE_ASK
      ? { smokeAsk: process.env.DOOL2_SMOKE_ASK, smokeAskWait: Number(process.env.DOOL2_SMOKE_ASK_WAIT ?? 0) }
      : {}),
  }))

  // New version alerts and install (ADR 0028): packaged app only (tests can point DOOL2_UPDATE_FEED elsewhere)
  ipcMain.handle('dool2:update-state', () => updater?.state() ?? smokeUpdate() ?? null)
  ipcMain.handle('dool2:update-install', () => updater?.install() ?? null)
  // The version row in Settings: [Check for updates] checks right away. null outside the packaged app (development)
  ipcMain.handle('dool2:update-check', () => updater?.check() ?? smokeUpdate() ?? null)
  ipcMain.handle('dool2:version', () => app.getVersion())
  if (!SMOKE && (app.isPackaged || process.env.DOOL2_UPDATE_FEED)) {
    updater = new Updater({
      current: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      ...(process.env.DOOL2_UPDATE_FEED ? { feed: process.env.DOOL2_UPDATE_FEED } : {}),
      dir: join(dataDir, 'updates'),
      onChange: (s: UpdateState) => win?.webContents.send('dool2:update', s),
      lang: uiLang,
      install: (file) =>
        installUpdate(file, {
          exe: app.getPath('exe'),
          lang: uiLang(),
          relaunch: async () => {
            quitting = true
            await daemon?.close().catch(() => undefined)
            app.relaunch()
            app.exit(0)
          },
          quit: async () => {
            quitting = true
            await daemon?.close().catch(() => undefined)
            app.exit(0)
          },
        }),
    })
    const check = () => void updater?.check()
    setTimeout(check, 20_000)
    setInterval(check, 6 * 60 * 60_000)
  }

  if (!SMOKE) createTray()
  d.events.on('settings', applySettings)
  d.events.on('busy', () => applySettings(d.settings()))
  applySettings(d.settings())

  // Smoke screenshots: create one demo approval request to show the approval card (pairs with the seed-demo chat)
  if (SMOKE && process.env.DOOL2_SMOKE_APPROVAL) {
    const shot = await readFile(process.env.DOOL2_SMOKE_APPROVAL).catch(() => undefined)
    const m = mainText(uiLang())
    d.approvals.create({
      tabId: 1,
      ref: 'e4',
      role: m.smokeRole,
      label: m.smokeLabel,
      url: 'https://shop.example/item/apple',
      kind: 'money',
      reason: m.smokeReason,
      what: m.smokeWhat,
      where: m.smokeWhere,
      amount: smokeAmount(uiLang()),
      cancel: m.smokeCancel,
      ...(shot ? { shot: shot.toString('base64') } : {}),
    })
  }
  // Started at login: do not create the window (it is created when opened from the tray)
  if (!HIDDEN || SMOKE) win = await createWindow(!SMOKE)
  if (SMOKE && win) await smoke(win)

  app.on('activate', showWindow)
})

// Keep running in the tray when every window is closed
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  quitting = true
  void daemon?.close()
})
