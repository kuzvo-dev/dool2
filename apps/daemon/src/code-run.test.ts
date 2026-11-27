import { describe, expect, it } from 'vitest'
import { runCode } from './code-run.js'
import { FileTools } from './files.js'

describe('code_run sandbox (ADR 0045, T32)', () => {
  it('computes, prints and returns the last value', async () => {
    const r = await runCode(
      'const s = input.reduce((a, b) => a + b, 0); console.log("sum", s); ({ s, avg: s / input.length })',
      [10, 20, 30],
    )
    expect(r.ok).toBe(true)
    expect(r.printed).toEqual(['sum 60'])
    expect(r.value).toEqual({ s: 60, avg: 20 })
  })

  it('has no way out: no require, process, fetch, timers or file system', async () => {
    for (const code of [
      'require("fs")',
      'process.env',
      'fetch("https://example.com")',
      'setTimeout(() => 1, 0)',
      'this.constructor.constructor("return process")()',
    ]) {
      const r = await runCode(code)
      expect(r.ok, code).toBe(false)
    }
  })

  it('stops code that runs too long or takes too much memory', async () => {
    const loop = await runCode('while (true) {}', undefined, { timeMs: 200 })
    expect(loop.ok).toBe(false)
    expect(loop.error).toContain('Stopped after')
    const big = await runCode('const a = []; while (true) a.push("x".repeat(1e5))', undefined, {
      memoryBytes: 8 << 20,
      timeMs: 2_000,
    })
    expect(big.ok).toBe(false)
  }, 15_000)

  it('code_run through the file tools prints and returns, and an error says what the sandbox lacks', async () => {
    const tools = new FileTools({ desktop: [], documents: [], downloads: [] })
    const ok = await tools.run('code_run', {
      code: 'console.log(input.length); input.map((x) => x * 2)',
      input: [1, 2],
    })
    const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
    expect(text(ok)).toContain('Printed:\n2')
    expect(text(ok)).toContain('Value:')
    const bad = await tools.run('code_run', { code: 'require("fs")' })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('no files, network, require or timers')
  })
})
