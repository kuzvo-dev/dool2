// 새 파일 이름 정하기 (PC 파일 도구가 함께 쓴다)
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** 같은 이름이 있으면 "이름 (1).확장자", "(2)"… (덮어쓰지 않는다) */
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
  throw new Error('같은 이름이 너무 많아요')
}

/** 파일 이름으로 못 쓰는 글자를 뺀다 */
export const cleanName = (s: string) =>
  basename(s.replace(/[\\/]+/g, ' '))
    .replace(/[:*?"<>|]/g, ' ')
    .replace(/./gsu, (c) => (c.charCodeAt(0) < 32 ? ' ' : c))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
