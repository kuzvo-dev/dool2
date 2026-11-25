import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMacArch, lipoArch, machOFiles, wrongArchFiles } from './mac-arch-check.mjs'

const THIN_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])

function fakeApp() {
  const app = join(mkdtempSync(join(tmpdir(), 'arch-')), 'Dool2.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources', 'hands'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'MacOS', 'Dool2'), THIN_64)
  writeFileSync(join(app, 'Contents', 'Resources', 'hands', 'dool2-hands'), FAT)
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>')
  try {
    symlinkSync('Dool2', join(app, 'Contents', 'MacOS', 'link'))
  } catch {
    // Windows without symlink rights: the skip is checked on the other systems
  }
  return app
}

describe('mac arch check', () => {
  it('maps the chip to the lipo name', () => {
    expect(lipoArch('arm64')).toBe('arm64')
    expect(lipoArch('x64')).toBe('x86_64')
  })

  it('finds Mach-O files only, skipping other files and symlinks', () => {
    const files = machOFiles(fakeApp()).map((f) => f.split(/[\\/]/).pop())
    expect(files.sort()).toEqual(['Dool2', 'dool2-hands'])
  })

  it('reports a helper built for the other chip (0.4.5 dool2-hands)', () => {
    const app = fakeApp()
    const archsOf = (f) => (f.endsWith('dool2-hands') ? ['x86_64'] : ['arm64'])
    const wrong = wrongArchFiles(app, 'arm64', archsOf)
    expect(wrong).toEqual([
      { file: join('Contents', 'Resources', 'hands', 'dool2-hands'), archs: ['x86_64'] },
    ])
    expect(() => assertMacArch(app, 'arm64', archsOf)).toThrow(/dool2-hands: x86_64/)
  })

  it('accepts files that contain the target chip, universal ones too', () => {
    const app = fakeApp()
    const archsOf = (f) => (f.endsWith('dool2-hands') ? ['x86_64', 'arm64'] : ['arm64'])
    expect(() => assertMacArch(app, 'arm64', archsOf)).not.toThrow()
  })
})
