import type { RecordingBrowserCaller } from '@dool2/browser'
import type { TurnEvent } from '@dool2/engine'
import { scriptedBrain } from '@dool2/engine'
import type { SessionRecording } from '@dool2/skill-learn'
import { describe, expect, it } from 'vitest'
import { Agentd, type AgentdEvent } from './agentd.js'
import { buildHostBridges } from './bridges.js'
import { LearnController, LocalDraftStore } from './learn.js'

/**
 * A fake browser caller that emits CDP Network events for a same-site XHR + a tracker whenever a page is opened or
 * navigated, so a (faked) turn exercises the recorder without a real browser or network.
 */
class FakeRecordingCaller implements RecordingBrowserCaller {
  readonly sinks = new Set<(method: string, params: Record<string, unknown>) => void>()
  enabled = false
  #reqId = 0
  #tab = 0
  #lastUrl = ''

  async call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (cmd) {
      case 'open': {
        this.#tab++
        this.#visit(String(args.url ?? 'about:blank'))
        return { tabId: this.#tab }
      }
      case 'navigate': {
        const url = String(args.url ?? '')
        this.#visit(url)
        return { url }
      }
      case 'snapshot':
        return { url: this.#lastUrl, title: '내 정보', text: '내 정보 [e1 버튼 "내 목록"]' }
      case 'click':
      case 'type':
      case 'press':
        return {}
      case 'fetch':
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
      default:
        return {}
    }
  }

  async enableNetwork(): Promise<void> {
    this.enabled = true
  }

  onNetwork(cb: (method: string, params: Record<string, unknown>) => void): () => void {
    this.sinks.add(cb)
    return () => this.sinks.delete(cb)
  }

  #visit(url: string): void {
    this.#lastUrl = url
    if (!this.enabled) return
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return
    }
    // the site's own internal API (kept), and a cross-site tracker (dropped by the recorder's origin filter)
    this.#xhr(origin, 'GET', '/api/v1/orders')
    this.#xhr('https://ads.doubleclick.net', 'GET', '/collect')
  }

  #xhr(origin: string, method: string, path: string): void {
    const id = String(++this.#reqId)
    this.#fire('Network.requestWillBeSent', {
      requestId: id,
      request: {
        method,
        url: `${origin}${path}`,
        headers: { 'X-App': 'dool2', Cookie: 'session=SECRET_abc' },
      },
      type: 'XHR',
    })
    this.#fire('Network.responseReceived', {
      requestId: id,
      type: 'XHR',
      response: { status: 200, mimeType: 'application/json' },
    })
  }

  #fire(method: string, params: Record<string, unknown>): void {
    for (const cb of [...this.sinks]) cb(method, params)
  }
}

// The goto URL and the clicked node name deliberately avoid the English pay-words the engine's default classifier
// upgrades to a `pay` tier (pay/checkout/order/buy/…), so the acting steps run at the default `ask` level and record.
const CODE =
  "await page.goto('https://www.coupang.com/np/mypage/list'); await page.snapshot(); await page.click('e1');"

const codeRounds = (code: string): TurnEvent[][] => [
  [
    { kind: 'text', text: '볼게요' },
    { kind: 'tool_call', call: { id: 'c1', name: 'code', args: { code } } },
    { kind: 'turn_end', stop: 'tool' },
  ],
  [{ kind: 'turn_end', stop: 'done' }],
]

describe('Agentd learn-by-watching: a turn produces a review-pending local draft', () => {
  // One caller + learn controller + bridges, shared across turns so the store accumulates; a fresh brain per turn.
  function harness() {
    const caller = new FakeRecordingCaller()
    const learn = new LearnController()
    const built = buildHostBridges({ caller, learn: true, recorderSink: learn })
    expect(built.newRecorder).toBeDefined()
    learn.setFactory(built.newRecorder)
    const turn = async (): Promise<{ agentd: Agentd; events: AgentdEvent[] }> => {
      const agentd = new Agentd({ brain: scriptedBrain(codeRounds(CODE)), bridges: built.bridges, learn })
      const events: AgentdEvent[] = []
      await agentd.send('쿠팡 주문내역 보여줘', { onEvent: (e) => events.push(e) })
      return { agentd, events }
    }
    return { learn, turn }
  }

  it('drafts a needsReview skill from a goto+click+XHR turn, stored locally (not published), coverage reflects it', async () => {
    const { learn, turn } = harness()
    const { agentd, events } = await turn()

    const draftEv = events.find((e) => e.type === 'draft')
    expect(draftEv?.type).toBe('draft')
    if (draftEv?.type !== 'draft') throw new Error('no draft event')
    expect(draftEv.needsReview).toBe(true)
    expect(draftEv.merged).toBe(false)
    expect(draftEv.host).toBe('coupang.com')

    // Stored locally, not published: it is a review-pending draft in the in-memory store.
    const drafts = agentd.drafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.skill.needsReview).toBe(true)
    const body = drafts[0]?.skill.body ?? ''
    // The data path (same-site API) is captured; the cross-site tracker is NOT.
    expect(body).toContain('GET /api/v1/orders')
    expect(body).not.toContain('doubleclick')
    expect(drafts[0]?.skill.markdown).not.toContain('SECRET') // no cookie value anywhere in the draft
    // The UI step that worked is recorded.
    expect(body).toContain('coupang.com/np/mypage/list')

    // Coverage: the one visited site is covered, and the draft has a data path (click-free).
    const coverage = learn.store.coverage()
    expect(coverage).toEqual({ covered: 1, total: 1, clickFreeRatio: 1 })
    expect(agentd.coverage()).toEqual(coverage)
  })

  it('a second turn on the same host merges into the one draft rather than duplicating', async () => {
    const { learn, turn } = harness()
    await turn()
    const { agentd, events } = await turn()

    const draftEv = events.find((e) => e.type === 'draft')
    if (draftEv?.type !== 'draft') throw new Error('no draft event')
    expect(draftEv.merged).toBe(true)

    const drafts = agentd.drafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.turns).toBe(2)
    // The endpoint is not duplicated by the merge.
    const body = drafts[0]?.skill.body ?? ''
    const occurrences = body.split('GET /api/v1/orders').length - 1
    expect(occurrences).toBe(1)
    // Still a single covered site.
    expect(learn.store.coverage()).toEqual({ covered: 1, total: 1, clickFreeRatio: 1 })
  })

  it('is off for the fake browser: no recorder factory, no drafts', async () => {
    const built = buildHostBridges() // no caller, no learn
    expect(built.newRecorder).toBeUndefined()
    const learn = new LearnController()
    expect(learn.enabled).toBe(false)
    const agentd = new Agentd({ brain: scriptedBrain(codeRounds(CODE)), bridges: built.bridges, learn })
    const events: AgentdEvent[] = []
    await agentd.send('쿠팡 주문내역 보여줘', { onEvent: (e) => events.push(e) })
    expect(events.some((e) => e.type === 'draft')).toBe(false)
    expect(agentd.drafts()).toHaveLength(0)
  })
})

describe('LocalDraftStore', () => {
  const recording = (host: string): SessionRecording => ({
    url: `https://${host}/list`,
    host,
    apiCalls: [{ method: 'GET', url: `https://${host}/api/orders`, status: 200 }],
    uiSteps: [{ action: 'goto', label: `https://${host}/list` }],
  })

  it('drafts a new site and merges a repeat of the same site', () => {
    const store = new LocalDraftStore(() => 1000)
    const first = store.learn(recording('order.coupang.com'))
    expect(first.merged).toBe(false)
    expect(first.draft.turns).toBe(1)

    const second = store.learn(recording('mc.coupang.com')) // same base domain
    expect(second.merged).toBe(true)
    expect(second.draft.turns).toBe(2)
    expect(store.list()).toHaveLength(1)
  })

  it('reports coverage over distinct visited sites and the click-free ratio', () => {
    const store = new LocalDraftStore()
    store.learn(recording('coupang.com')) // has a data path
    store.noteVisited('gmarket.co.kr') // visited but no draft yet
    const cov = store.coverage()
    expect(cov.total).toBe(2)
    expect(cov.covered).toBe(1)
    expect(cov.clickFreeRatio).toBe(1)
  })
})
