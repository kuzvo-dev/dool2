// Phone-app smoke screenshot (parallels apps/desktop's DOOL2_SMOKE run). It loads the built phone app in a hidden,
// phone-sized Electron window, waits for the first paint, and captures the APPROVAL CARD screen (the bottom sheet over
// the Dool2 home) with the generic demo card, to apps/phone/out/smoke.png — the shot compared against
// docs/design/screens/m-approve-light.png. No network: the app is in offline demo mode.
//
// Run with:  pnpm --filter @dool2/phone-app smoke   (build + this)
// Override:  DOOL2_SMOKE_SCREEN=pair  captures the phone pairing screen instead.
//            DOOL2_SMOKE_THEME=dark   captures the dark view.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, nativeTheme } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const SCREEN = process.env.DOOL2_SMOKE_SCREEN ?? 'approve'
// 390×844 is the design frame (docs/design/screens/src/MApprove.dc.html). Force a 2× scale for a crisp 780×1688 shot,
// matching the 2× reference PNG.
const WIDTH = 390
const HEIGHT = 844

app.commandLine.appendSwitch('force-device-scale-factor', '2')

async function main() {
  const theme = process.env.DOOL2_SMOKE_THEME === 'dark' ? 'dark' : 'light'
  nativeTheme.themeSource = theme

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    backgroundColor: theme === 'dark' ? '#121418' : '#ffffff',
    webPreferences: { backgroundThrottling: false },
  })

  const query = SCREEN === 'pair' ? '?screen=pair' : ''
  await win.loadFile(join(appRoot, 'dist/renderer/index.html'), { search: query })
  // Let fonts, the character webp and the seeded DOM settle before capturing.
  await new Promise((r) => setTimeout(r, 1200))

  const outDir = process.env.DOOL2_SMOKE_OUT ?? join(appRoot, 'out')
  const name = SCREEN === 'pair' ? 'smoke-pair.png' : 'smoke.png'
  await mkdir(outDir, { recursive: true })
  const img = await win.webContents.capturePage()
  await writeFile(join(outDir, name), img.toPNG())
  console.log(`DOOL2_SMOKE phone ${SCREEN} -> ${join(outDir, name)}`)
  app.exit(0)
}

app
  .whenReady()
  .then(main)
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
