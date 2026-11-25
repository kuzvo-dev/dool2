// Builds the Dool2 installers. Mac builds are signed with our fixed certificate (DOOL2_MAC_SIGN_IDENTITY), or ad-hoc
// without it (ADR 0028). Mac gets a dmg for first install and a zip for in-app updates, Windows an installer exe
// (release: .github/workflows/release.yml)
//
//   pnpm build && pnpm --filter @dool2/desktop package
//
// 1. Bundle the main process, the Dool2 tool server and the browser host into one file each with esbuild (so pnpm
//    workspace links are not followed)
// 2. Gather them with the window files and icons in a dependency-free stage folder (stage/)
// 3. Codex is not included (Dool2 downloads it on first use, agent-codex/download.ts)
// 4. electron-builder makes the Mac dmg / Windows installer → release/
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { assertMacArch } from './mac-arch-check.mjs'
import { DISPLAY_NAME } from './region/kr/app-name.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stage = join(root, 'stage')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version

if (!existsSync(join(root, 'dist', 'main.js'))) {
  console.error('Run pnpm build first')
  process.exit(1)
}
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'dist'), { recursive: true })

// For dependencies (cjs) that need require inside the esm bundle
const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
}
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner,
  logLevel: 'warning',
}
await esbuild({
  ...common,
  entryPoints: [join(root, 'dist', 'main.js')],
  outfile: join(stage, 'dist', 'main.js'),
  external: ['electron'],
})
const mcpServer = fileURLToPath(import.meta.resolve('@dool2/mcp-tools/server'))
await esbuild({ ...common, entryPoints: [mcpServer], outfile: join(stage, 'dist', 'mcp-server.mjs') })
// Native messaging host Chrome starts for the Dool2 extension (ADR 0006)
const host = fileURLToPath(import.meta.resolve('@dool2/browser/host'))
await esbuild({ ...common, entryPoints: [host], outfile: join(stage, 'dist', 'native-host.mjs') })

// Korean, Chinese and Japanese CID font maps (cmaps) and image decoders (wasm) used by PDF reading (pdfjs-dist).
// Looked up in dist/pdfjs/ next to the bundle (apps/daemon/src/pdf.ts). pdfjs itself and its worker are bundled in main.js
const pdfjsDir = dirname(
  createRequire(import.meta.resolve('@dool2/daemon')).resolve('pdfjs-dist/package.json'),
)
for (const d of ['cmaps', 'wasm'])
  cpSync(join(pdfjsDir, d), join(stage, 'dist', 'pdfjs', d), { recursive: true })
cpSync(join(pdfjsDir, 'LICENSE'), join(stage, 'dist', 'pdfjs', 'LICENSE'))

// Pack number of the skills/ this app carries (ADR 0039): a connector pack is taken only if it is newer. Unix seconds of
// the last skills/ or prompts/ commit, the same number scripts/pack-build.mjs gives a pack. Kept outside stage/ (extraResources)
const meta = join(root, 'release-meta')
mkdirSync(meta, { recursive: true })
let skillsPack = 0
try {
  skillsPack = Number(
    execFileSync('git', ['log', '-1', '--format=%ct', '--', 'skills', 'prompts'], {
      cwd: join(root, '..', '..'),
      encoding: 'utf8',
    }).trim(),
  )
} catch {}
writeFileSync(
  join(meta, 'skills-pack.json'),
  JSON.stringify({ pack: Number.isInteger(skillsPack) ? skillsPack : 0 }),
)

cpSync(join(root, 'dist', 'preload.cjs'), join(stage, 'dist', 'preload.cjs'))
cpSync(join(root, 'dist', 'renderer'), join(stage, 'dist', 'renderer'), { recursive: true })
cpSync(join(root, 'assets'), join(stage, 'assets'), { recursive: true })
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'dool2',
      productName: 'Dool2',
      version: pkg.version,
      description: pkg.description,
      license: 'Apache-2.0',
      author: 'dool2 contributors',
      type: 'module',
      main: 'dist/main.js',
    },
    null,
    2,
  ),
)

// Mac chip: this Mac by default, DOOL2_ARCH for the other one (the Intel build machine's dmg tool is broken, so the
// Apple silicon machine builds both, 11-23)
const MAC_ARCH = (process.env.DOOL2_ARCH ?? process.arch) === 'arm64' ? 'arm64' : 'x64'
// DOOL2_DMG=hdiutil: electron-builder's dmg tool (dmgbuild) breaks on Intel build machines (struct.error, 11-23),
// so there the dmg is made with macOS's own hdiutil from the signed app instead. Used when releases build on Intel
// runners because Apple silicon runners get no capacity (11-23 to 11-24: a full day of cancelled jobs)
const HDIUTIL_DMG = process.platform === 'darwin' && process.env.DOOL2_DMG === 'hdiutil'
const { build } = await import('electron-builder')
await build({
  projectDir: root,
  config: {
    appId: 'com.dool2.desktop',
    // Keep the internal name in Latin letters. With a Korean name macOS cannot find the Electron helper
    // ("<name> Helper") and the app dies at launch (SIGTRAP, measured 2026-11-14). The display name is set below
    productName: 'Dool2',
    executableName: 'dool2',
    // Placeholders electron-builder fills in, so a plain string
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder placeholders
    artifactName: 'dool2-${version}-${os}-${arch}.${ext}',
    electronVersion,
    directories: { app: 'stage', output: 'release' },
    // Only the bundles. No node_modules at all (duplicate Codex and so on)
    files: ['**/*', '!**/node_modules/**'],
    asarUnpack: ['dist/mcp-server.mjs', 'dist/native-host.mjs', 'dist/pdfjs/**'],
    // The Dool2 Chrome extension (users load it themselves until the web store release)
    extraResources: [
      { from: '../extension/dist', to: 'extension' },
      // Dool2 skills (CC BY-SA 4.0). Newer ones arrive as signed connector packs (ADR 0039)
      { from: '../../skills', to: 'skills', filter: ['**/*', '!_template/**'] },
      { from: 'release-meta/skills-pack.json', to: 'skills-pack.json' },
      // PC screen control helper (Mac, ADR 0013). The Windows helper is separate
      ...(process.platform === 'darwin' ? [{ from: '../hands-mac/dist', to: 'hands' }] : []),
    ],
    // Re-sign the whole app. Electron's default signature leaves the bundle unsealed, so macOS does not recognize the
    // app and Accessibility / Screen Recording permissions do not take effect even when turned on (measured). Releases
    // use our fixed certificate: macOS sees each version as the same app, so permissions and the vault (keychain)
    // carry over. Ad-hoc (-) changes the fingerprint every build, so permissions reset on every update (ADR 0028)
    afterPack: async (ctx) => {
      if (ctx.electronPlatformName !== 'darwin') return
      const appPath = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
      // Every program in the app must be for MAC_ARCH, or macOS warns Apple silicon users about Intel apps (0.4.5)
      assertMacArch(appPath, MAC_ARCH)
      const identity = process.env.DOOL2_MAC_SIGN_IDENTITY || '-'
      const keychain = process.env.DOOL2_MAC_SIGN_KEYCHAIN
      execFileSync(
        'codesign',
        ['--force', '--deep', '--sign', identity, ...(keychain ? ['--keychain', keychain] : []), appPath],
        { stdio: 'inherit' },
      )
    },
    icon: 'assets/icon.png',
    mac: {
      category: 'public.app-category.productivity',
      extendInfo: {
        CFBundleDisplayName: DISPLAY_NAME,
        LSApplicationCategoryType: 'public.app-category.productivity',
      },
      // dmg for first install, zip for in-app updates (update-install.ts unzips and swaps it in)
      target: (HDIUTIL_DMG ? ['zip'] : ['dmg', 'zip']).map((target) => ({
        target,
        arch: [MAC_ARCH],
      })),
      // electron-builder signing is off (no Apple developer certificate). afterPack above signs
      identity: null,
    },
    dmg: { title: DISPLAY_NAME },
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: { oneClick: true, perMachine: false, shortcutName: DISPLAY_NAME },
    publish: null,
  },
})
if (HDIUTIL_DMG) {
  // The app electron-builder left in release/mac (x64) or release/mac-arm64, already signed by afterPack
  const appDir = join(root, 'release', MAC_ARCH === 'arm64' ? 'mac-arm64' : 'mac')
  const app = readdirSync(appDir).find((f) => f.endsWith('.app'))
  if (!app) throw new Error(`No app in ${appDir}`)
  const src = join(root, 'release', `dmg-src-${MAC_ARCH}`)
  rmSync(src, { recursive: true, force: true })
  mkdirSync(src, { recursive: true })
  // ditto keeps the signature, symlinks and extended attributes
  execFileSync('ditto', [join(appDir, app), join(src, app)], { stdio: 'inherit' })
  symlinkSync('/Applications', join(src, 'Applications'))
  const dmg = join(root, 'release', `dool2-${pkg.version}-mac-${MAC_ARCH}.dmg`)
  execFileSync(
    'hdiutil',
    ['create', '-volname', DISPLAY_NAME, '-srcfolder', src, '-ov', '-format', 'UDZO', dmg],
    { stdio: 'inherit' },
  )
  rmSync(src, { recursive: true, force: true })
}
console.log('Built installers: apps/desktop/release/')
