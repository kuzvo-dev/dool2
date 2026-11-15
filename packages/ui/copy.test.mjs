import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyUi } from './copy.mjs'

test('ui.css·캐릭터·글꼴을 복사한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dool2-ui-'))
  try {
    copyUi(join(dir, 'a'))
    assert.ok(existsSync(join(dir, 'a', 'ui.css')))
    for (const mood of ['idle', 'thinking', 'working', 'asking', 'done', 'sleeping'])
      assert.ok(existsSync(join(dir, 'a', 'doori', `${mood}.webp`)), mood)
    assert.ok(existsSync(join(dir, 'a', 'doori', 'mark.svg')))
    assert.ok(!existsSync(join(dir, 'a', 'fonts')))
    copyUi(join(dir, 'b'), { fonts: true })
    assert.ok(existsSync(join(dir, 'b', 'fonts', 'PretendardVariable.woff2')))
    assert.ok(existsSync(join(dir, 'b', 'fonts', 'OFL.txt')))
    assert.ok(existsSync(join(dir, 'b', 'fonts.css')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('토큰에 쓰지 않기로 한 것이 없다 (이모지·글자 아이콘)', () => {
  const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8')
  for (const bad of ['content: "✓"', 'content: "›"', '!important']) assert.ok(!css.includes(bad), bad)
})

test('ui.css가 부르는 캐릭터 파일이 모두 있다', () => {
  const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8')
  const urls = [...css.matchAll(/url\("(doori\/[a-z-]+\.(?:svg|webp))"\)/g)].map((m) => m[1])
  assert.ok(urls.length >= 7)
  for (const u of urls) assert.ok(existsSync(new URL(`./${u}`, import.meta.url)), u)
})
