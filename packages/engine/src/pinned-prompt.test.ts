import { describe, expect, it } from 'vitest'
import { promptUpdate, sections } from './pinned-prompt.js'

describe('promptUpdate', () => {
  const base =
    'Intro\n\n## Rules\n- a\n\n## What Dool2 knows (today 11-24)\n- x\n\n## Services\n### Shops\n- one'

  it('splits at ## headings and keeps ### inside', () => {
    expect([...sections(base).keys()]).toEqual([
      '',
      '## Rules',
      '## What Dool2 knows (today 11-24)',
      '## Services',
    ])
    expect(sections(base).get('## Services')).toContain('### Shops')
  })

  it('returns nothing when nothing changed', () => {
    expect(promptUpdate(base, base)).toBeUndefined()
  })

  it('sends only the changed section, matched by heading even when the note in parentheses changed', () => {
    const next = base.replace('(today 11-24)\n- x', '(today 11-25)\n- x\n- y')
    const note = promptUpdate(base, next) ?? ''
    expect(note).toContain('## What Dool2 knows (today 11-25)')
    expect(note).toContain('- y')
    expect(note).not.toContain('## Rules')
  })

  it('names a section that no longer applies', () => {
    const next = base.replace('\n\n## Services\n### Shops\n- one', '')
    expect(promptUpdate(base, next)).toContain('No longer applies: ## Services')
  })
})
