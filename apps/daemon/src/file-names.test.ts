import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeNewFile } from './file-names.js'

describe('writeNewFile', () => {
  it('writes into the folder itself, never overwrites, and falls back to the next folder (test PC 11-27)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dool2-names-'))
    const a = join(root, '두리')
    const r1 = await writeNewFile([a], '가족관계증명서 | 발급', 'pdf', Buffer.from('%PDF-1'))
    expect(r1.path).toBe(join(a, '가족관계증명서 발급.pdf'))
    expect(readFileSync(r1.path, 'utf8')).toBe('%PDF-1')
    const r2 = await writeNewFile([a], '가족관계증명서 | 발급', 'pdf', Buffer.from('%PDF-2'))
    expect(r2.file).toBe('가족관계증명서 발급 (1).pdf')
    // A folder that cannot take it (a file in the way): the next one does
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'x')
    const r3 = await writeNewFile([blocked, a], 'x', 'mhtml', Buffer.from('m'))
    expect(r3.path).toBe(join(a, 'x.mhtml'))
  })
})
