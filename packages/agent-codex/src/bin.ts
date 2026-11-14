import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** 두리와 함께 배포하는 Codex 버전. app-server 규약이 버전마다 바뀌어서 고정한다. */
export const CODEX_VERSION = '0.169.0'

const TRIPLES: Record<string, { triple: string; pkg: string }> = {
  'darwin-arm64': { triple: 'aarch64-apple-darwin', pkg: '@openai/codex-darwin-arm64' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', pkg: '@openai/codex-darwin-x64' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', pkg: '@openai/codex-win32-x64' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', pkg: '@openai/codex-win32-arm64' },
  'linux-x64': { triple: 'x86_64-unknown-linux-musl', pkg: '@openai/codex-linux-x64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-musl', pkg: '@openai/codex-linux-arm64' },
}

/**
 * 함께 설치된 Codex 실행 파일 위치. npm 래퍼(node 필요)를 거치지 않고 네이티브 바이너리를 바로 쓴다.
 * 못 찾으면 undefined.
 */
export function resolveBundledCodex(platform = process.platform, arch = process.arch): string | undefined {
  const target = TRIPLES[`${platform}-${arch}`]
  if (!target) return undefined
  try {
    const req = createRequire(import.meta.url)
    const codexPkg = req.resolve('@openai/codex/package.json')
    const platformPkg = createRequire(codexPkg).resolve(`${target.pkg}/package.json`)
    const exe = join(
      dirname(platformPkg),
      'vendor',
      target.triple,
      'bin',
      platform === 'win32' ? 'codex.exe' : 'codex',
    )
    return existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}
