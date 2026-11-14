// 두리 설치 파일 만들기 (서명 없음, 개발용). 서명·공증은 M5에서 붙인다.
//
//   pnpm build && pnpm --filter @dool2/desktop package
//
// 1. 메인 프로세스, 두리 도구 서버, 브라우저 호스트를 esbuild로 한 파일씩 묶는다 (pnpm 작업 공간 링크를 따라가지 않게)
// 2. 의존성 없는 준비 폴더(stage/)에 화면·아이콘과 함께 모은다
// 3. Codex는 넣지 않는다 (처음 쓸 때 두리가 내려받는다, agent-codex/download.ts)
// 4. electron-builder로 맥 dmg / 윈도우 설치 파일을 만든다 → release/
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stage = join(root, 'stage')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version

if (!existsSync(join(root, 'dist', 'main.js'))) {
  console.error('먼저 pnpm build를 실행해 주세요')
  process.exit(1)
}
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'dist'), { recursive: true })

// esm 묶음 안에서 require가 필요한 의존성(cjs)을 위해 넣는다
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
// Chrome이 두리 확장 요청으로 띄우는 native messaging 호스트 (ADR 0006)
const host = fileURLToPath(import.meta.resolve('@dool2/browser/host'))
await esbuild({ ...common, entryPoints: [host], outfile: join(stage, 'dist', 'native-host.mjs') })

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

const { build } = await import('electron-builder')
await build({
  projectDir: root,
  config: {
    appId: 'com.dool2.desktop',
    // 앱 내부 이름은 영문으로 둔다. 한글이면 맥에서 Electron 도우미("두리 Helper")를 못 찾고
    // 켜자마자 죽는다(SIGTRAP, 실측 2026-11-14). 사용자에게 보이는 이름은 아래에서 "두리"로 바꾼다
    productName: 'Dool2',
    executableName: 'dool2',
    // electron-builder가 채우는 자리표시자라서 일반 문자열로 둔다
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder 자리표시자
    artifactName: 'dool2-${version}-${arch}.${ext}',
    electronVersion,
    directories: { app: 'stage', output: 'release' },
    // 묶음 파일만 넣는다. node_modules는 하나도 넣지 않는다 (Codex 중복 등)
    files: ['**/*', '!**/node_modules/**'],
    asarUnpack: ['dist/mcp-server.mjs', 'dist/native-host.mjs'],
    // 두리 Chrome 확장 (웹 스토어 전까지 사용자가 직접 올린다)
    extraResources: [
      { from: '../extension/dist', to: 'extension' },
      // 두리 스킬 (CC BY-SA 4.0). 서명된 스킬 업데이트 채널은 M5
      { from: '../../skills', to: 'skills', filter: ['**/*', '!_template/**'] },
    ],
    icon: 'assets/icon.png',
    mac: {
      category: 'public.app-category.productivity',
      extendInfo: {
        CFBundleDisplayName: '두리',
        LSApplicationCategoryType: 'public.app-category.productivity',
      },
      target: [{ target: 'dmg', arch: [process.arch === 'arm64' ? 'arm64' : 'x64'] }],
      // M5 전까지는 서명하지 않는다
      identity: null,
    },
    dmg: { title: '두리' },
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: { oneClick: true, perMachine: false, shortcutName: '두리' },
    publish: null,
  },
})
console.log('설치 파일을 만들었어요: apps/desktop/release/')
