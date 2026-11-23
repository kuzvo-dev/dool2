// dool2-hands(맥) 빌드 → dist/dool2-hands. 맥이 아니면 아무것도 하지 않는다 (윈도우 도우미는 따로)
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') {
  console.log('dool2-hands: 맥이 아니라서 건너뛰어요')
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
    // DOOL2_ARCH로 다른 칩용도 만든다 (릴리스: Apple 칩 기계에서 인텔용까지)
    `${(process.env.DOOL2_ARCH ?? process.arch) === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    '-o',
    join(root, 'dist', 'dool2-hands'),
    join(root, 'Sources', 'main.swift'),
  ],
  { stdio: 'inherit' },
)
console.log('dool2-hands: dist/dool2-hands')
