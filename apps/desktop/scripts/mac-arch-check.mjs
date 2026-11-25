// Checks that every program inside a built Mac app runs natively on the chip the app is for. One program built for
// the wrong chip is enough for macOS to show Apple silicon users "Intel apps won't be supported" (0.4.5 shipped an
// x86_64-only dool2-hands in the Apple silicon app because the build step lost DOOL2_ARCH, 11-25).
// package.mjs runs it on the packed app and stops the build when something is off.
//
//   node apps/desktop/scripts/mac-arch-check.mjs <path/to/Dool2.app> <arm64|x64>
import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// First 4 bytes of a Mach-O program: thin 32/64-bit in either byte order, or a fat (multi-chip) file
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

/** lipo's name for the chip: arm64 -> arm64, x64 -> x86_64 */
export function lipoArch(arch) {
  return arch === 'arm64' ? 'arm64' : 'x86_64'
}

function isMachO(file) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(4)
    if (readSync(fd, buf, 0, 4, 0) < 4) return false
    return MACHO_MAGIC.has(buf.readUInt32BE(0))
  } finally {
    closeSync(fd)
  }
}

/** Every regular Mach-O file under dir (symlinks are skipped: frameworks link to the same files) */
export function machOFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) out.push(...machOFiles(p))
    else if (st.isFile() && st.size >= 4 && isMachO(p)) out.push(p)
  }
  return out
}

/** Chips a Mach-O file contains, from lipo -archs (for example ['arm64'] or ['x86_64', 'arm64']) */
export function lipoArchs(file) {
  return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
}

/**
 * Mach-O files in the app that do not contain the target chip. Empty means the app is fine.
 * @param {string} app path to the .app
 * @param {'arm64' | 'x64'} arch target chip
 * @param {(file: string) => string[]} [archsOf] for tests
 */
export function wrongArchFiles(app, arch, archsOf = lipoArchs) {
  const want = lipoArch(arch)
  const wrong = []
  for (const file of machOFiles(app)) {
    const archs = archsOf(file)
    if (!archs.includes(want)) wrong.push({ file: relative(app, file), archs })
  }
  return wrong
}

/** Throws with the list of wrong files, so the build stops before an installer is made */
export function assertMacArch(app, arch, archsOf = lipoArchs) {
  const wrong = wrongArchFiles(app, arch, archsOf)
  if (wrong.length === 0) return
  const lines = wrong.map((w) => `  ${w.file}: ${w.archs.join(' ') || 'unknown'}`)
  throw new Error(`Built for the wrong chip (want ${lipoArch(arch)}):\n${lines.join('\n')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [app, arch] = process.argv.slice(2)
  if (!app || (arch !== 'arm64' && arch !== 'x64')) {
    console.error('usage: mac-arch-check.mjs <path/to/App.app> <arm64|x64>')
    process.exit(2)
  }
  try {
    assertMacArch(app, arch)
    console.log(`${machOFiles(app).length} Mach-O files, all ${lipoArch(arch)}`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
