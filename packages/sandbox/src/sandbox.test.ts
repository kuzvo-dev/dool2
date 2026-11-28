import type { GatedAction } from '@dool2/core'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFakeBridges } from './fakes.js'
import { Sandbox } from './sandbox.js'

const boxes: Sandbox[] = []

function sandbox(onAction?: (a: GatedAction) => void | Promise<void>): Sandbox {
  const box = new Sandbox({
    bridges: makeFakeBridges(),
    // Short time limit so the runaway test is quick.
    limits: { timeMs: 1_000 },
    ...(onAction ? { onAction } : {}),
  })
  boxes.push(box)
  return box
}

afterEach(() => {
  for (const b of boxes.splice(0)) b.dispose()
})

describe('Sandbox', () => {
  it('evaluates an expression and captures console output', async () => {
    const box = sandbox()
    const r = await box.run('1 + 1')
    expect(r.ok).toBe(true)
    expect(r.value).toBe(2)

    const logged = await box.run("console.log('hello', 42)")
    expect(logged.ok).toBe(true)
    expect(logged.printed).toEqual(['hello 42'])
  })

  it('stops a runaway with a clear time-limit error', async () => {
    const box = sandbox()
    const r = await box.run('while (true) {}')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Stopped after/)
    // It must not hang much past the limit.
    expect(r.ms).toBeLessThan(5_000)
  })

  it('throws when writing to a host object (read-only)', async () => {
    const box = sandbox()
    const r = await box.run('page.snapshot = 1')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/host objects are read-only/)
  })

  it('blocks constructor and __proto__ access on host objects', async () => {
    const box = sandbox()
    const a = await box.run('page.constructor')
    expect(a.ok).toBe(false)
    expect(a.error).toMatch(/host objects are read-only/)

    const b = await box.run('vault.__proto__')
    expect(b.ok).toBe(false)
    expect(b.error).toMatch(/host objects are read-only/)

    const c = await box.run('page.prototype')
    expect(c.ok).toBe(false)
    expect(c.error).toMatch(/host objects are read-only/)
  })

  it('calls a fake page.snapshot() bridge and returns its data', async () => {
    const box = sandbox()
    const r = await box.run('await page.snapshot()')
    expect(r.ok).toBe(true)
    const snap = r.value as { url: string; nodes: unknown[] }
    expect(snap.url).toBe('https://example.com/login')
    expect(snap.nodes).toHaveLength(2)
  })

  it('returns only masked vault summaries, never a secret value', async () => {
    const box = sandbox()
    const r = await box.run('await vault.listItems()')
    expect(r.ok).toBe(true)
    const items = r.value as Array<Record<string, unknown>>
    expect(items[0]).toEqual({ id: 'v1', site: 'naver.com', username: 'user@example.com', hasTotp: true })
    // No field carries a secret.
    for (const item of items) {
      const keys = Object.keys(item).sort()
      expect(keys).toEqual(['hasTotp', 'id', 'site', 'username'])
      expect(JSON.stringify(item)).not.toMatch(/password|secret|totpSeed|card/i)
    }
  })

  it('keeps scope across calls within one session', async () => {
    const box = sandbox()
    const first = await box.run('counter = 40')
    expect(first.value).toBe(40)
    const second = await box.run('counter + 2')
    expect(second.ok).toBe(true)
    expect(second.value).toBe(42)
  })

  it('reports an acting call to the gate seam with a tier and label', async () => {
    const seen: GatedAction[] = []
    const box = sandbox((a) => {
      seen.push(a)
    })
    const r = await box.run("await vault.fillLogin('v1')")
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ tier: 'act', label: 'fill login v1' })
  })

  it('does not report a read-only call to the gate seam', async () => {
    const seen: GatedAction[] = []
    const box = sandbox((a) => {
      seen.push(a)
    })
    const r = await box.run('await page.snapshot()')
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(0)
  })

  it('lets the gate seam stop an action by throwing', async () => {
    const box = sandbox(() => {
      throw new Error('gate: signature required')
    })
    const r = await box.run("await page.click('e2')")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/signature required/)
  })

  it('collects image references from display(), not inline bytes', async () => {
    const box = sandbox()
    const r = await box.run("display({ id: 'img-1', alt: 'the cart' }); display('img-2')")
    expect(r.ok).toBe(true)
    expect(r.images).toEqual([{ id: 'img-1', alt: 'the cart' }, { id: 'img-2' }])
  })
})
