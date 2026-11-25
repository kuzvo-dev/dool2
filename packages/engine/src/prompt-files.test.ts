import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without types
import { generated } from '../../../scripts/prompts-gen.mjs'
import { PROMPT_FILES } from './locales/prompts.gen.js'
import { buildSystemPrompt, checkPromptFiles, MONEY_RULES, setPromptFiles } from './persona.js'
import { renderTemplate } from './template.js'

/** Hashes of the instructions persona.ts made before the text moved to prompts/ (11-25), every combination */
const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('./persona.golden-hashes.json', import.meta.url)), 'utf8'),
) as Record<string, string>

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

describe('지침 파일 (ADR 0040)', () => {
  it('파일로 옮긴 지침이 옮기기 전과 글자까지 같다 (108가지 조합)', () => {
    let n = 0
    for (const [key, want] of Object.entries(GOLDEN)) {
      const [lang, kind, tone, length, name] = key.split('|')
      const text = buildSystemPrompt({
        lang: lang as 'ko' | 'en',
        ...(kind === 'both' ? {} : { kind: kind as 'conversation' | 'task' }),
        tone: tone as 'warm' | 'neat' | 'buddy',
        length: length as 'short' | 'normal' | 'detail',
        // "name" in the keys: the hashes were made with the user name 민지
        ...(name === '-' ? {} : { userName: '민지' }),
      })
      expect(hash(text), key).toBe(want)
      n++
    }
    expect(n).toBe(108)
  })

  it('엔진에 든 지침이 prompts/ 파일과 같다 (고치면 pnpm prompts)', () => {
    const now = readFileSync(fileURLToPath(new URL('./locales/prompts.gen.ts', import.meta.url)), 'utf8')
    expect(now).toBe(generated())
    expect(checkPromptFiles(PROMPT_FILES)).toEqual([])
  })

  it('돈·연락 규칙 자리가 없거나 빈칸이 남은 지침은 받지 않는다', () => {
    const noMoney = {
      ...PROMPT_FILES,
      'persona.md': PROMPT_FILES['persona.md']?.replace('{{money}}', '') ?? '',
    }
    expect(checkPromptFiles(noMoney).join()).toMatch(/money/)
    expect(setPromptFiles(noMoney)).not.toEqual([])
    const broken = { ...PROMPT_FILES, 'persona.md': `${PROMPT_FILES['persona.md']}\n{{#talks}}unclosed` }
    expect(checkPromptFiles(broken).join()).toMatch(/left unfilled/)
    const noVoice = { ...PROMPT_FILES, 'voice/en.md': '<!-- name -->\nEnglish\n' }
    expect(checkPromptFiles(noVoice).join()).toMatch(/voice\/en\.md has no voice/)
    // Refused files leave the carried ones in use
    expect(buildSystemPrompt()).toContain(MONEY_RULES)
  })

  it('새 지침을 받으면 쓰고, 되돌리면 엔진에 든 것으로 돌아간다', () => {
    const before = buildSystemPrompt({ lang: 'en' })
    const newer = {
      ...PROMPT_FILES,
      'persona.md': (PROMPT_FILES['persona.md'] ?? '').replace('a dash of wit', 'a dash of wit and patience'),
    }
    expect(setPromptFiles(newer)).toEqual([])
    expect(buildSystemPrompt({ lang: 'en' })).toContain('a dash of wit and patience')
    setPromptFiles(undefined)
    expect(buildSystemPrompt({ lang: 'en' })).toBe(before)
  })

  it('틀: 값 넣기, 있을 때만·없을 때만, 넣은 값은 다시 읽지 않는다', () => {
    expect(renderTemplate('a{{#x}}[{{x}}]{{/x}}{{^x}}none{{/x}}b', { x: 'X' })).toBe('a[X]b')
    expect(renderTemplate('a{{#x}}[{{x}}]{{/x}}{{^x}}none{{/x}}b', {})).toBe('anoneb')
    expect(renderTemplate('{{v}}', { v: '{{#y}}kept{{/y}}' })).toBe('{{#y}}kept{{/y}}')
  })
})
