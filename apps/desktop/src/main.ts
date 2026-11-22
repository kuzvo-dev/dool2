// 두리 PC 앱 (Electron 메인 프로세스).
// 두리 본체(dool2d)를 같은 프로세스에서 띄우고, 화면에는 접속 주소와 토큰만 건넨다.
// 창을 닫아도 트레이에 남아 일을 계속한다. 끝내기는 트레이 메뉴에서 한다 (docs/architecture.md 7.1).
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerExternalExtension } from '@dool2/browser'
import { type Daemon, startDaemon } from '@dool2/daemon'
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
import { KeepAwake, loginItemSettings } from './power.js'
import { renderFile } from './render-file.js'
import { renderMotion } from './render-motion.js'
import { fileSecrets } from './secrets.js'

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
    width: 1320,
    height: 820,
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
    // 맥 시스템 설정의 개인정보 보호 화면만 (PC 앱 조작 권한)
    else if (
      /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_(?:Accessibility|ScreenCapture)$/.test(
        url,
      )
    )
      void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // 창을 닫아도 두리(본체)는 쉬지 않는다. 창은 숨기지 않고 없앤다: 화면·GPU 프로세스가 300MB 남짓 쓰고,
  // 숨긴 창에서도 3D 두리를 계속 그려 CPU를 먹었다(실측). 트레이에서 열면 새로 만든다
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

/**
 * 배포 앱 안의 두리 도구 서버 위치 (scripts/package.mjs가 넣는다). Codex는 처음 쓸 때 내려받는다.
 * 도구 서버는 Electron을 Node처럼 띄워 실행하므로 asar 밖(app.asar.unpacked)에 둔다.
 */
function packagedPaths() {
  if (!app.isPackaged) return {}
  return {
    mcpServerScript: join(here, 'mcp-server.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`),
    skillsDir: join(process.resourcesPath, 'skills'),
    // PC 화면 제어 도우미 (맥만). 앱이 띄우므로 맥 권한은 "두리" 앱 이름으로 받는다
    ...(process.platform === 'darwin' ? { hands: join(process.resourcesPath, 'hands', 'dool2-hands') } : {}),
  }
}

/**
 * Chrome에 두리 호스트 등록 (ADR 0006). 배포 앱은 켤 때마다 등록한다.
 * 개발 중에는 DOOL2_REGISTER_HOST=1일 때만 사용자 Chrome에 등록하고, 점검 모드는 절대 하지 않는다.
 * DOOL2_HOST_DIRS: 시험용 Chrome 프로필의 NativeMessagingHosts 폴더 (여러 개면 경로 구분자로)
 */
function nativeHostOption() {
  const extraDirs = (process.env.DOOL2_HOST_DIRS ?? '').split(delimiter).filter(Boolean)
  // DOOL2_REGISTER_HOST=0: 배포 앱을 시험할 때 사용자 Chrome 설정을 건드리지 않는다
  const defaultTargets =
    !SMOKE &&
    process.env.DOOL2_REGISTER_HOST !== '0' &&
    (app.isPackaged || process.env.DOOL2_REGISTER_HOST === '1')
  if (!defaultTargets && !extraDirs.length) return {}
  const script = app.isPackaged
    ? join(here, 'native-host.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    : undefined
  return { nativeHost: { ...(script ? { script } : {}), extraDirs, defaultTargets } }
}

/**
 * 두리 Chrome 확장 폴더를 데이터 폴더로 복사해 둔다. 웹 스토어에 올리기 전(M5)까지는 사용자가
 * Chrome에 이 폴더를 직접 올린다. 앱 안이 아니라 데이터 폴더에 두어야 경로가 바뀌지 않고, 앱을 업데이트하면 같이 바뀐다.
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
    console.error(`[두리] 확장 폴더를 준비하지 못했어요: ${(e as Error).message}`)
  }
  return to
}

/** 웹 스토어 확장 id. 시험할 때는 DOOL2_STORE_EXTENSION_ID로 바꿀 수 있다 */
function storeExtensionId(): string | undefined {
  const id =
    process.env.DOOL2_STORE_EXTENSION_ID ?? (STORE_EXTENSION_PUBLISHED ? STORE_EXTENSION_ID : undefined)
  return id && /^[a-p]{32}$/.test(id) ? id : undefined
}

/** 주소를 기본 브라우저가 아니라 Chrome에서 연다 (확장은 Chrome에 추가해야 한다). Chrome이 없으면 기본 브라우저로 */
function openInChrome(url: string) {
  const fallback = () => void shell.openExternal(url)
  if (process.platform === 'darwin') execFile('open', ['-a', 'Google Chrome', url], (e) => e && fallback())
  else if (process.platform === 'win32')
    execFile('cmd', ['/c', 'start', '""', 'chrome', url], { windowsHide: true }, (e) => e && fallback())
  else fallback()
}

/**
 * 두리가 만든 HTML(그림·초대장·보고서)을 보이지 않는 창에서 그려 JPEG로 찍는다 (보관함·폰 미리보기).
 * 스크립트는 끄고, 네트워크·다른 파일은 열지 않는다
 */
/** 그림 파일을 가로 width로 줄인 JPEG(base64)로 (그림 AI로 만든 그림의 보관함·대화 미리보기) */
async function shrinkImage(data: Buffer, width: number): Promise<string | undefined> {
  const img = nativeImage.createFromBuffer(data)
  if (img.isEmpty()) return undefined
  const fit = img.getSize().width > width ? img.resize({ width, quality: 'good' }) : img
  return fit.toJPEG(80).toString('base64')
}

async function renderHtml(html: string): Promise<string | undefined> {
  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    // 그림 그리기 전용 세션: 요청 막기가 앱 창에 번지지 않게
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

/** 개발·CI 점검: 창을 띄워 화면이 그려지는지 보고 캡처한 뒤 종료한다 */
async function smoke(w: BrowserWindow) {
  const ready = await new Promise<string>((resolve) => {
    ipcMain.once('dool2:ready', (_e, summary: string) => resolve(summary))
    setTimeout(() => resolve('timeout'), process.env.DOOL2_SMOKE_ASK ? 300_000 : 20_000)
  })
  const out = process.env.DOOL2_SMOKE_OUT ?? join(here, '..', 'out')
  await mkdir(out, { recursive: true })
  // 화면 아래쪽을 찍을 때: 이 선택자의 요소가 보이게 굴린 뒤 찍는다 (예: .svc-fast)
  const scroll = process.env.DOOL2_SMOKE_SCROLL
  // DOOL2_SMOKE_SCROLL_TIMES: 여러 번 굴린다 (긴 목록이 다음 페이지를 받으면 끝 줄이 다시 아래로 간다)
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
  // app.exit은 before-quit을 건너뛰므로 본체(로그인 등 자식 프로세스 포함)를 직접 닫는다
  await daemon?.close()
  app.exit(ready === 'timeout' ? 1 : 0)
}

// 두리는 한 번에 하나만 돈다. 두 번째로 켜면 이미 떠 있는 창을 보여 준다
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  // 점검 캡처: 다크·라이트를 골라 찍는다 (평소에는 기기 설정을 따른다)
  const theme = process.env.DOOL2_SMOKE_THEME
  if (SMOKE && (theme === 'dark' || theme === 'light')) nativeTheme.themeSource = theme
  const dataDir = process.env.DOOL2_DATA_DIR ?? join(app.getPath('appData'), 'dool2')
  const d = await startDaemon({
    renderHtml,
    shrinkImage,
    // 두리가 만든 HTML(보고서·초대장)을 PDF·PNG 파일로 (file_render)
    renderFile,
    // 모션그래픽 영상 장면을 한 장씩 찍기 (video_motion)
    renderMotion,
    // 폰에 보일 이 PC 이름 (기본: 컴퓨터 이름). 시험 캡처에 실제 컴퓨터 이름이 나오지 않게 바꿀 수 있다
    ...(process.env.DOOL2_PC_NAME ? { pcName: process.env.DOOL2_PC_NAME } : {}),
    dataDir,
    secrets: fileSecrets(join(dataDir, 'secrets.json'), safeStorage),
    // 폰 연결은 공식 중계 서버로. 직접 운영하는 서버는 설정(relay)이나 DOOL2_RELAY가 먼저다
    relay: OFFICIAL_RELAY,
    ...packagedPaths(),
    ...nativeHostOption(),
    // 맥 권한(손쉬운 사용·화면 기록)은 앱이 직접 묻고 확인한다 ("두리" 이름으로 뜨게)
    ...(process.platform === 'darwin'
      ? {
          appPermissions: {
            status: () => ({
              accessibility: systemPreferences.isTrustedAccessibilityClient(false),
              screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
            }),
            request: async () => {
              systemPreferences.isTrustedAccessibilityClient(true)
              // 화면 기록은 화면 목록을 처음 요청할 때 시스템이 묻는다
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
  // 시험용: 배포 앱을 밖에서 부려 보려고 본체 주소·화면용 토큰을 파일(0600)에 적는다. 이 환경 변수를 줄 때만
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
  // 웹 스토어에 올라간 확장이면 Chrome·Edge에 "설치 대기"로도 올려 둔다: 첫 화면에서 건너뛰어도
  // 브라우저를 다음에 켤 때 [사용 설정]이 뜬다. 시험할 때(DOOL2_REGISTER_HOST=0)는 사용자 브라우저를 건드리지 않는다
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
    // 점검: 이 부탁을 보내고, DOOL2_SMOKE_ASK_WAIT(밀리초)가 있으면 그만큼 뒤 일하는 중인 화면을 캡처한다
    ...(SMOKE && process.env.DOOL2_SMOKE_ASK
      ? { smokeAsk: process.env.DOOL2_SMOKE_ASK, smokeAskWait: Number(process.env.DOOL2_SMOKE_ASK_WAIT ?? 0) }
      : {}),
  }))

  if (!SMOKE) createTray()
  d.events.on('settings', applySettings)
  d.events.on('busy', () => applySettings(d.settings()))
  applySettings(d.settings())

  // 점검 캡처용: 승인 카드를 보여 주려고 데모 승인 요청을 하나 만든다 (seed-demo의 대화와 짝)
  if (SMOKE && process.env.DOOL2_SMOKE_APPROVAL) {
    const shot = await readFile(process.env.DOOL2_SMOKE_APPROVAL).catch(() => undefined)
    d.approvals.create({
      tabId: 1,
      ref: 'e4',
      role: '버튼',
      label: '바로 구매',
      url: 'https://shop.example/item/apple',
      kind: 'money',
      reason: '"구매"',
      what: '사과 1kg 바로 구매',
      where: '두리 시험 가게',
      amount: '9,900원',
      cancel: '배송 전 취소 가능 (상품 페이지 안내)',
      ...(shot ? { shot: shot.toString('base64') } : {}),
    })
  }
  // 로그인할 때 자동으로 켜졌으면 창을 만들지 않는다 (트레이에서 열 때 만든다)
  if (!HIDDEN || SMOKE) win = await createWindow(!SMOKE)
  if (SMOKE && win) await smoke(win)

  app.on('activate', showWindow)
})

// 창이 모두 닫혀도 트레이에서 계속 돈다
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  quitting = true
  void daemon?.close()
})
