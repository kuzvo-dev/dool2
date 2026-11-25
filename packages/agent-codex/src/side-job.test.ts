import { readFileSync } from 'node:fs'
import { MODEL_PROFILES } from '@dool2/engine'
import { describe, expect, it } from 'vitest'
import { buildCodexArgs, CodexEventMapper, knownModel, SIDE_JOB_CONFIG } from './index.js'

/** `model/list` of the pinned Codex 0.169.0, captured without sign-in (the catalog ships with the program) */
const catalog = JSON.parse(
  readFileSync(new URL('../fixtures/model-list-0.169.0.json', import.meta.url), 'utf8'),
) as { result: unknown }
const rpcWith = (result: unknown) => ({
  request: async <T>(method: string) => {
    if (method !== 'model/list') throw new Error(method)
    return result as T
  },
})

describe('Codex side jobs (judge, reviewer)', () => {
  it('start with no tool server and without Codex context notes', () => {
    const args = buildCodexArgs([], { sideJob: true })
    const pairs = args.filter((_, i) => args[i - 1] === '-c')
    for (const c of SIDE_JOB_CONFIG) expect(pairs).toContain(c)
    expect(pairs).toContain('features.shell_tool=false')
    expect(pairs.some((p) => p.startsWith('mcp_servers.'))).toBe(false)
    // A normal turn keeps Codex's notes
    expect(buildCodexArgs([])).not.toContain(SIDE_JOB_CONFIG[0])
  })

  it('stop at anything tool-like, even a Dool2 tool or a sub-agent', () => {
    for (const item of [
      { type: 'mcpToolCall', server: 'dool2', tool: 'status' },
      { type: 'collabAgentToolCall' },
      { type: 'imageView' },
      { type: 'plan' },
    ]) {
      const m = new CodexEventMapper('th1', 'en', { sideJob: true })
      const r = m.map('item/started', { threadId: 'th1', item })
      expect(r.abort, item.type).toBe(true)
      expect(r.events[0]).toMatchObject({ type: 'error', code: 'tools_unsafe' })
    }
  })

  it('pass the answer through', () => {
    const m = new CodexEventMapper('th1', 'en', { sideJob: true })
    const evs = [
      m.map('item/started', { threadId: 'th1', item: { type: 'userMessage' } }),
      m.map('item/completed', { threadId: 'th1', item: { type: 'reasoning' } }),
      m.map('item/completed', { threadId: 'th1', item: { type: 'agentMessage', text: '{"related": true}' } }),
      m.map('turn/completed', { threadId: 'th1', turn: { status: 'completed' } }),
    ].flatMap((r) => r.events)
    expect(evs).toEqual([
      { type: 'text', delta: '{"related": true}' },
      { type: 'done', resumeId: 'th1', text: '{"related": true}' },
    ])
  })

  it('the small model of the profile table is in the pinned catalog', async () => {
    const small = MODEL_PROFILES.codex?.small
    expect(small).toBeDefined()
    expect(await knownModel(rpcWith(catalog.result), small as string)).toBe(small)
  })

  it('a model the catalog does not list falls back to the default model', async () => {
    expect(await knownModel(rpcWith(catalog.result), 'no-such-model')).toBeUndefined()
    expect(await knownModel(rpcWith({ data: [] }), 'gpt-6-luna')).toBeUndefined()
    const failing = {
      request: async () => {
        throw new Error('boom')
      },
    }
    expect(await knownModel(failing as never, 'gpt-6-luna')).toBeUndefined()
  })
})
