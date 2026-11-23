// Choosing new file names (shared by the PC file tools)
import { existsSync } from 'node:fs'
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
