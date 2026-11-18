// PC 앱 화면은 묶지 않고 브라우저가 파일을 그대로 불러온다. 그래서 '@dool2/protocol/…' 같은 패키지 이름을
// 실행할 때 불러오면 화면 전체가 뜨지 않는다 (#248 뒤 socialOrder로 실제로 그랬다). 타입만 가져오는 건 괜찮다.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = __dirname

describe('화면 파일의 import', () => {
  it('패키지 이름에서는 타입만 가져온다 (실행할 값은 ./파일에서)', () => {
    const bad: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue
      const src = readFileSync(join(dir, f), 'utf8')
      for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
        const [, clause = '', from = ''] = m
        if (from.startsWith('.')) continue
        if (clause.startsWith('type ')) continue
        const names = clause
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        if (clause.startsWith('{') && names.every((n) => n.startsWith('type '))) continue
        bad.push(`${f}: ${from}`)
      }
    }
    expect(bad).toEqual([])
  })
})
