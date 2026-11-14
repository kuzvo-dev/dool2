// 두리 PC 앱 (Electron 메인 프로세스).
// 두리 본체(dool2d)를 같은 프로세스에서 띄우고, 화면에는 접속 주소와 토큰만 건넨다.
// 창을 닫아도 트레이에 남아 일을 계속한다. 끝내기는 트레이 메뉴에서 한다 (docs/architecture.md 7.1).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Daemon, startDaemon } from '@dool2/daemon'
import type { Settings } from '@dool2/protocol'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerSaveBlocker, shell, Tray } from 'electron'
import { KeepAwake, loginItemSettings } from './power.js'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
const SMOKE = process.env.DOOL2_SMOKE === '1'
/** 로그인할 때 자동으로 켜졌으면 창 없이 트레이로만 시작한다 */
const HIDDEN = process.argv.includes('--hidden')

let daemon: Daemon | undefined
let win: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
const keepAwake = new KeepAwake({
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => powerSaveBlocker.stop(id),
})

async function createWindow(show: boolean) {
  const w = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: '두리',
    backgroundColor: '#ffffff',
    show,
    icon: join(assets, 'icon.png'),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 점검 때는 숨긴 창도 계속 그리게 한다
      backgroundThrottling: !SMOKE,
    },
  })
  // 화면 안의 링크는 기본 브라우저로 연다
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // 창을 닫아도 두리는 쉬지 않는다. 트레이에서 다시 열 수 있다
  w.on('close', (e) => {
    if (quitting || SMOKE) return
    e.preventDefault()
    w.hide()
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
  tray.setToolTip('두리')
  tray.on('click', showWindow)
  updateTray()
}

function updateTray() {
  if (!tray) return
  const busy = daemon?.busy ?? false
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: busy ? '두리가 일하는 중이에요' : '두리가 기다리고 있어요', enabled: false },
      ...(keepAwake.active ? [{ label: '일하는 동안 PC가 잠들지 않아요', enabled: false }] : []),
      { type: 'separator' },
      { label: '두리 열기', click: showWindow },
      { type: 'separator' },
      {
        label: '두리 끝내기',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

/** 사용자가 허락한 전원·자동 시작 설정을 반영한다 */
function applySettings(settings: Settings) {
  keepAwake.update(settings, daemon?.busy ?? false)
  // 개발 중(electron .)에는 로그인 항목에 Electron 자체가 등록되므로 배포 빌드에서만 바꾼다
  if (app.isPackaged && settings.launchAtLogin !== undefined)
    app.setLoginItemSettings(loginItemSettings(settings))
  updateTray()
}

/** 개발·CI 점검: 창을 띄워 화면이 그려지는지 보고 캡처한 뒤 종료한다 */
async function smoke(w: BrowserWindow) {
  const ready = await new Promise<string>((resolve) => {
    ipcMain.once('dool2:ready', (_e, summary: string) => resolve(summary))
    setTimeout(() => resolve('timeout'), 20_000)
  })
  const out = process.env.DOOL2_SMOKE_OUT ?? join(here, '..', 'out')
  await mkdir(out, { recursive: true })
  const img = await w.webContents.capturePage()
  await writeFile(join(out, 'smoke.png'), img.toPNG())
  console.log(`DOOL2_SMOKE ${ready}`)
  // app.exit은 before-quit을 건너뛰므로 본체(로그인 등 자식 프로세스 포함)를 직접 닫는다
  await daemon?.close()
  app.exit(ready === 'timeout' ? 1 : 0)
}

// 두리는 한 번에 하나만 돈다. 두 번째로 켜면 이미 떠 있는 창을 보여 준다
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  const dataDir = process.env.DOOL2_DATA_DIR ?? join(app.getPath('appData'), 'dool2')
  const d = await startDaemon({ dataDir })
  daemon = d
  ipcMain.handle('dool2:config', () => ({
    url: d.url,
    token: d.token,
    ...(SMOKE && process.env.DOOL2_SMOKE_OPEN ? { smokeOpen: process.env.DOOL2_SMOKE_OPEN } : {}),
    ...(SMOKE && process.env.DOOL2_SMOKE_SETUP ? { smokeSetup: process.env.DOOL2_SMOKE_SETUP } : {}),
  }))

  if (!SMOKE) createTray()
  d.events.on('settings', applySettings)
  d.events.on('busy', () => applySettings(d.settings()))
  applySettings(d.settings())

  win = await createWindow(!SMOKE && !HIDDEN)
  if (SMOKE) await smoke(win)

  app.on('activate', showWindow)
})

// 창이 모두 닫혀도 트레이에서 계속 돈다
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  quitting = true
  void daemon?.close()
})
