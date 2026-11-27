// Choosing new file names (shared by the PC file tools)
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/** If the name exists: "name (1).ext", "(2)"... (never overwrites) */
export function freeName(dir: string, name: string, taken: Set<string> = new Set()): string {
  const key = (p: string) => p.normalize('NFC').toLowerCase()
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 0; i < 1000; i++) {
    const p = join(dir, i ? `${stem} (${i})${ext}` : name)
    if (!existsSync(p) && !taken.has(key(p))) {
      taken.add(key(p))
      return p
    }
  }
  throw new Error('Too many files with the same name')
}

/** Removes characters that cannot be used in file names */
export const cleanName = (s: string) =>
  basename(s.replace(/[\\/]+/g, ' '))
    .replace(/[:*?"<>|]/g, ' ')
    .replace(/./gsu, (c) => (c.charCodeAt(0) < 32 ? ' ' : c))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)

/**
 * Writes a new file into the first folder that takes it, never overwriting; returns its full path and name. A file
 * made from a page (browser_save_pdf, browser_cdp) joined the folder to freeName's full path again and wrote to a
 * folder that does not exist, so no PDF was ever saved (test PC 11-27)
 */
export async function writeNewFile(
  dirs: string[],
  name: string,
  ext: string,
  data: Buffer,
): Promise<{ path: string; file: string }> {
  let last: unknown
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true })
      const path = freeName(dir, `${cleanName(name).slice(0, 80) || 'document'}.${ext}`)
      await writeFile(path, data, { flag: 'wx' })
      return { path, file: basename(path) }
    } catch (e) {
      last = e
    }
  }
  throw new Error(`Could not write the file (${(last as Error)?.message ?? 'no folder'})`)
}
