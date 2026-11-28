import type { AgentdEvent } from '@dool2/agentd'
import { describe, expect, it } from 'vitest'
import { classifyCode, lineFor, type UiLine } from './lines.js'
import { appText } from './locales/app.js'

describe('classifyCode', () => {
  it('maps page reads and navigation to friendly keys', () => {
    expect(classifyCode('JSON.stringify(await page.snapshot())')).toBe('read')
    expect(classifyCode("await page.goto('https://starbucks.co.kr')")).toBe('open')
    expect(classifyCode("await page.fetch('https://api.example.com')")).toBe('read')
  })

  it('maps vault and page actions to their own keys', () => {
    expect(classifyCode("await vault.fillLogin('v1')")).toBe('login')
    expect(classifyCode("await page.fill('e1', secret)")).toBe('fill')
    expect(classifyCode("await page.type('e1', 'hello')")).toBe('fill')
    expect(classifyCode("await page.click('e2')")).toBe('click')
    expect(classifyCode('await page.pdf()')).toBe('pdf')
  })

  it('falls back to a generic work step for unknown code', () => {
    expect(classifyCode('1 + 1')).toBe('run')
  })
})

describe('lineFor', () => {
  it('shows a code tool call as a work step and NEVER the raw code/args', () => {
    const event: AgentdEvent = {
      type: 'tool_call',
      id: 'c1',
      name: 'code',
      args: { code: "await page.goto('https://secret.example.com?token=abc'); await page.snapshot()" },
    }
    const line = lineFor(event)
    expect(line).toEqual({ role: 'work', key: 'open' })
    // The returned line must not carry any of the code/args through to the UI.
    expect(JSON.stringify(line)).not.toContain('page.goto')
    expect(JSON.stringify(line)).not.toContain('token=abc')
  })

  it('renders a Korean phrase for each work key, with no JSON leaking', () => {
    const ko = appText('ko')
    const read = lineFor({
      type: 'tool_call',
      id: 'c2',
      name: 'code',
      args: { code: 'await page.snapshot()' },
    })
    expect(read).toEqual({ role: 'work', key: 'read' })
    const phrase = (read as Extract<UiLine, { role: 'work' }>).key
    expect(ko.work[phrase]).toBe('페이지를 읽었어요')
  })

  it('never shows a tool result (would dump JSON)', () => {
    expect(lineFor({ type: 'tool_result', id: 'c1', content: '{"url":"https://example.com"}' })).toBeNull()
  })

  it('passes Dool2 text through as a message bubble', () => {
    expect(lineFor({ type: 'text', text: '잔액은 12,300원이에요.' })).toEqual({
      role: 'dool2',
      text: '잔액은 12,300원이에요.',
    })
    expect(lineFor({ type: 'text', text: '   ' })).toBeNull()
  })

  it('turns an approval into a card with its label and amount, not a secret', () => {
    const event: AgentdEvent = {
      type: 'approvalNeeded',
      card: {
        hash: 'abc',
        envelope: { tier: 'pay', label: 'Pay 12,000 won', amountKrw: 12000 } as never,
        label: 'Pay 12,000 won',
        tier: 'pay',
        reason: 'payment needs a signature',
        amountKrw: 12000,
        expiresAt: 0,
      },
    }
    expect(lineFor(event)).toEqual({ role: 'approval', label: 'Pay 12,000 won', amountKrw: 12000 })
  })

  it('reports a blocked action as a note', () => {
    expect(lineFor({ type: 'blocked', label: 'Pay 5,000,000 won', tier: 'pay', reason: 'over cap' })).toEqual(
      {
        role: 'blocked',
        label: 'Pay 5,000,000 won',
      },
    )
  })

  it('hides internal events (thinking, gate, turn_end)', () => {
    expect(lineFor({ type: 'thinking', text: 'hmm' })).toBeNull()
    expect(lineFor({ type: 'turn_end', stop: 'done' })).toBeNull()
    expect(
      lineFor({ type: 'gate', label: 'x', tier: 'read', decision: 'run', reason: 'ok', allowed: true }),
    ).toBeNull()
  })
})
