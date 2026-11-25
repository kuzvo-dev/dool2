import { Store } from '@dool2/store'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, limitsFor } from './conversation.js'
import { MODEL_PROFILES, modelForRole, modelProfile } from './models.js'
import type { AgentRuntime, TurnInput } from './runtime.js'
import { ThreadService } from './threads.js'

describe('model profiles (ADR 0037)', () => {
  it('the default limits come from the profile table', () => {
    expect(DEFAULT_LIMITS).toMatchObject(modelProfile('claude').limits)
    expect(DEFAULT_LIMITS.staleMs).toBe(12 * 60 * 60 * 1000)
    expect(limitsFor('codex')).toMatchObject({ turns: 40, chars: 60_000, contextTokens: 120_000 })
    expect(limitsFor('claude', { turns: 3 }).turns).toBe(3)
  })

  it('a model entry overrides only the fields it names', () => {
    MODEL_PROFILES['claude:test-model'] = { limits: { turns: 10 } as never }
    try {
      const p = modelProfile('claude', 'test-model')
      expect(p.limits).toEqual({ turns: 10, chars: 60_000, contextTokens: 120_000 })
      expect(p.small).toBe('haiku')
    } finally {
      delete MODEL_PROFILES['claude:test-model']
    }
  })

  it('side jobs go to the small model, requests and summaries stay on the chosen model', () => {
    expect(modelForRole('claude', 'task')).toBeUndefined()
    expect(modelForRole('claude', 'task', 'opus')).toBe('opus')
    expect(modelForRole('claude', 'summary', 'opus')).toBe('opus')
    expect(modelForRole('claude', 'judge')).toBe('haiku')
    expect(modelForRole('claude', 'watch', 'opus')).toBe('haiku')
    expect(modelForRole('claude', 'review')).toBe('haiku')
    // Codex takes a model per thread: its small one from the pinned catalog
    expect(modelForRole('codex', 'judge')).toBe('gpt-6-luna')
    expect(modelForRole('codex', 'task')).toBeUndefined()
    // Pay-as-you-go: the small model of the provider the user picked, keyed by their model
    expect(modelForRole('opencode', 'review', 'claude-sonnet-5-5')).toBe('claude-haiku-5-5')
    expect(modelForRole('opencode', 'judge', 'gpt-5.6')).toBe('gpt-5.4-mini')
    expect(modelForRole('opencode', 'task', 'gpt-5.6')).toBe('gpt-5.6')
    // A model with no known small one keeps itself
    expect(modelForRole('opencode', 'watch', 'gpt-x')).toBe('gpt-x')
  })

  it('ThreadService passes the model for the turn role', async () => {
    const inputs: TurnInput[] = []
    const rt: AgentRuntime = {
      id: 'claude',
      detect: async () => ({ id: 'claude', installed: true, loggedIn: true }),
      async *runTurn(input) {
        inputs.push(input)
        yield { type: 'done', resumeId: 's1', text: 'ok' }
      },
    }
    const store = new Store(':memory:')
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [],
      modelFor: (agent, role) => modelForRole(agent, role),
    })
    const t = store.createThread('claude')
    for await (const _ of svc.send(t.id, 'hello')) {
    }
    for await (const _ of svc.send(t.id, 'a change was found', { role: 'watch' })) {
    }
    expect(inputs.map((i) => i.model)).toEqual([undefined, 'haiku'])
  })
})

describe('stopping a turn without keeping it', () => {
  it('cancel with discard saves no partial answer and no stopped line', async () => {
    let release = () => {}
    const rt: AgentRuntime = {
      id: 'claude',
      detect: async () => ({ id: 'claude', installed: true, loggedIn: true }),
      async *runTurn(input) {
        yield { type: 'text', delta: 'half an ans' }
        await new Promise<void>((r) => {
          release = r
          input.signal?.addEventListener('abort', () => r())
        })
        yield { type: 'error', code: 'aborted', message: 'stopped' }
      },
    }
    const store = new Store(':memory:')
    const svc = new ThreadService({
      timeLine: () => undefined,
      store,
      runtimes: { claude: rt },
      workspaceDir: '/tmp/ws',
      mcpServers: [],
    })
    const t = store.createThread('claude')
    const run = (async () => {
      for await (const _ of svc.send(t.id, 'go on')) {
      }
    })()
    await new Promise((r) => setTimeout(r, 10))
    svc.cancel(t.id, { discard: true })
    release()
    await run
    expect(store.listMessages(t.id).map((m) => m.role)).toEqual(['user'])
  })
})
