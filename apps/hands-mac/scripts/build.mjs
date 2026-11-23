// Builds dool2-hands (macOS) -> dist/dool2-hands. Does nothing on other OSes (the Windows helper is separate)
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') {
  console.log('dool2-hands: not macOS, skipping')
  process.exit(0)
}
mkdirSync(join(root, 'dist'), { recursive: true })
execFileSync(
  'swiftc',
  [
    '-O',
    '-swift-version',
    '5',
    '-target',
    // DOOL2_ARCH builds for another chip too (release: Intel builds on an Apple silicon machine)
    `${(process.env.DOOL2_ARCH ?? process.arch) === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    '-o',
    join(root, 'dist', 'dool2-hands'),
    join(root, 'Sources', 'main.swift'),
  ],
  { stdio: 'inherit' },
)
console.log('dool2-hands: dist/dool2-hands')
