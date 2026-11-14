// 두리 PC 앱 (Electron 메인 프로세스).
// 두리 본체(dool2d)를 같은 프로세스에서 띄우고, 화면에는 접속 주소와 토큰만 건넨다.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Daemon, startDaemon } from '@dool2/daemon'
import { app, BrowserWindow, ipcMain, shell } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const SMOKE = process.env.DOOL2_SMOKE === '1'

let daemon: Daemon | undefined

async function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: '두리',
    backgroundColor: '#ffffff',
    show: !SMOKE,
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  await win.loadFile(join(here, 'renderer', 'index.html'))
  return win
}

/** 개발·CI 점검: 창을 띄워 화면이 그려지는지 보고 캡처한 뒤 종료한다 */
async function smoke(win: BrowserWindow) {
  const ready = await new Promise<string>((resolve) => {
    ipcMain.once('dool2:ready', (_e, summary: string) => resolve(summary))
    setTimeout(() => resolve('timeout'), 20_000)
  })
  const out = process.env.DOOL2_SMOKE_OUT ?? join(here, '..', 'out')
  await mkdir(out, { recursive: true })
  const img = await win.webContents.capturePage()
  await writeFile(join(out, 'smoke.png'), img.toPNG())
  console.log(`DOOL2_SMOKE ${ready}`)
  app.exit(ready === 'timeout' ? 1 : 0)
}

app.whenReady().then(async () => {
  const dataDir = process.env.DOOL2_DATA_DIR ?? join(app.getPath('appData'), 'dool2')
  daemon = await startDaemon({ dataDir })
  ipcMain.handle('dool2:config', () => ({
    url: daemon?.url,
    token: daemon?.token,
    ...(SMOKE && process.env.DOOL2_SMOKE_OPEN ? { smokeOpen: process.env.DOOL2_SMOKE_OPEN } : {}),
  }))

  const win = await createWindow()
  if (SMOKE) await smoke(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  // M0: 창을 닫으면 끝낸다. 트레이 상주와 자동 시작은 7.1에서 붙인다
  app.quit()
})

app.on('before-quit', () => {
  void daemon?.close()
})
