import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ADR 0045: tool results state what happened, why and what is possible next. They do not decide for Dool2 that it
 * should stop. On the test PC (11-27) "do not try other ways" and "tell them you will save it once the extension
 * updates" made Sonnet and Opus give up alike. Safety orders (approvals, hand-offs, secrets) are not these phrases.
 */
const STOP_PHRASES = [
  /do not try (other|another|any other) (ways?|routes?|methods?)/i,
  /don'?t try (other|another)/i,
  /try nothing else/i,
  /or ask the user to do it themselves/i,
  /you will (save|do|finish) it once .{0,40}updates/i,
]

const here = dirname(fileURLToPath(import.meta.url))
const roots = [here, join(here, '../../../packages/mcp-tools/src')]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

describe('tool texts state facts, not verdicts (ADR 0045)', () => {
  it('no tool or result text tells Dool2 to stop trying', () => {
    const found: string[] = []
    for (const file of roots.flatMap(sources)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        // Comments may quote the old texts to say why they went
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        for (const re of STOP_PHRASES)
          if (re.test(line)) found.push(`${file.slice(here.length - 15)}:${i + 1}`)
      })
    }
    expect(found).toEqual([])
  })
})
