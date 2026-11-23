import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Codex version shipped with Dool2. Pinned because the app-server protocol changes between versions. */
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
 * Location of the bundled Codex executable. Uses the native binary directly, without the npm wrapper (which needs node).
 * Undefined when not found.
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
