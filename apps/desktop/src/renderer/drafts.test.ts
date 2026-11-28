import type { AgentdEvent, LocalDraft } from '@dool2/agentd'
import { describe, expect, it, vi } from 'vitest'
import {
  countEndpoints,
  countUiSteps,
  coverageText,
  type DraftActionResult,
  type DraftsClient,
  DraftsController,
  type DraftsSnapshot,
  draftRow,
} from './drafts.js'
import { appText } from './locales/app.js'

/** A minimal review-pending draft for a site, with a body shaped like @dool2/skill-learn produces. */
function fakeDraft(id: string, host: string, name: string, body: string): LocalDraft {
  return {
    id,
    host,
    updatedAt: 0,
    turns: 1,
    skill: {
      id,
      needsReview: true,
      frontmatter: { name, description: `${name} draft`, site: [host] },
      body,
      markdown: '',
    },
  }
}

const GOV = fakeDraft(
  'gov-portal',
  'portal.example.go.kr',
  '정부민원포털',
  '## steps\n\n1. login\n2. open menu\n3. submit\n',
)
const SHOP = fakeDraft(
  'shop-mall',
  'shop.example.com',
  '온라인 쇼핑몰',
  '## data path\n\n- `GET /api/orders`\n- `GET /api/orders/shipping`\n\n## steps\n\n1. open\n2. pick\n',
)

function snapshot(drafts: LocalDraft[]): DraftsSnapshot {
  return { drafts, coverage: { covered: 2, total: 3, clickFreeRatio: 0.5 } }
}

/** A fake daemon client that records calls and returns a canned result. */
function fakeClient(drafts: LocalDraft[]): DraftsClient & {
  approveCalls: string[]
  discardCalls: string[]
} {
  const approveCalls: string[] = []
  const discardCalls: string[] = []
  const result: DraftActionResult = { ok: true, wired: false }
  return {
    approveCalls,
    discardCalls,
    list: () => Promise.resolve(snapshot(drafts)),
    approve: (id) => {
      approveCalls.push(id)
      return Promise.resolve(result)
    },
    discard: (id) => {
      discardCalls.push(id)
      return Promise.resolve(result)
    },
  }
}

describe('counts from a drafted body', () => {
  it('counts data-path endpoint bullets, never matching other bullets', () => {
    expect(countEndpoints(SHOP.skill.body)).toBe(2)
    expect(countEndpoints(GOV.skill.body)).toBe(0)
    expect(countEndpoints('- a normal bullet\n- `get lowercase`')).toBe(0)
  })

  it('counts numbered UI steps', () => {
    expect(countUiSteps(GOV.skill.body)).toBe(3)
    expect(countUiSteps(SHOP.skill.body)).toBe(2)
  })
})

describe('draftRow (display mapping)', () => {
  it('shows host, name, the needs-review marker and a learned summary — never the endpoint paths', () => {
    const row = draftRow(SHOP, appText('ko'))
    expect(row).toEqual({
      id: 'shop-mall',
      host: 'shop.example.com',
      name: '온라인 쇼핑몰',
      learned: '바로 통로 2개와 화면 단계 2개를 배웠어요.',
      marker: '검수 대기',
    })
    // The learned summary is counts only, not the captured API paths.
    expect(JSON.stringify(row)).not.toContain('/api/orders')
  })

  it('drops the shortcut clause when a draft has no data path', () => {
    expect(draftRow(GOV, appText('ko')).learned).toBe('화면 단계 3개를 배웠어요.')
    expect(draftRow(GOV, appText('en')).learned).toBe('Learned 3 on-screen steps.')
  })
})

describe('coverageText (library KPIs)', () => {
  it('folds coverage and the click-free ratio into one line', () => {
    const line = coverageText({ covered: 2, total: 3, clickFreeRatio: 0.5 }, appText('ko'))
    expect(line).toContain('3곳 중 2곳')
    expect(line).toContain('50%')
  })
})

describe('DraftsController', () => {
  it('refreshes drafts and coverage from the client', async () => {
    const controller = new DraftsController(fakeClient([GOV, SHOP]))
    await controller.refresh()
    expect(controller.count).toBe(2)
    expect(controller.coverage).toEqual({ covered: 2, total: 3, clickFreeRatio: 0.5 })
  })

  it('approve calls client.approve and removes the card optimistically', async () => {
    const client = fakeClient([GOV, SHOP])
    const controller = new DraftsController(client)
    await controller.refresh()
    const result = await controller.approve('gov-portal')
    expect(client.approveCalls).toEqual(['gov-portal'])
    expect(client.discardCalls).toEqual([])
    expect(result).toEqual({ ok: true, wired: false })
    expect(controller.drafts.map((d) => d.id)).toEqual(['shop-mall'])
  })

  it('discard calls client.discard and removes the card', async () => {
    const client = fakeClient([GOV, SHOP])
    const controller = new DraftsController(client)
    await controller.refresh()
    await controller.discard('shop-mall')
    expect(client.discardCalls).toEqual(['shop-mall'])
    expect(controller.drafts.map((d) => d.id)).toEqual(['gov-portal'])
  })

  it('raises the nudge on a draft event while closed, and ignores other events', async () => {
    const controller = new DraftsController(fakeClient([]))
    const draftEvent: AgentdEvent = {
      type: 'draft',
      id: 'shop-mall',
      host: 'shop.example.com',
      needsReview: true,
      merged: false,
      coverage: { covered: 1, total: 2, clickFreeRatio: 1 },
    }
    expect(controller.noteEvent({ type: 'text', text: 'hi' })).toBe(false)
    expect(controller.nudge).toBe(false)
    expect(controller.noteEvent(draftEvent)).toBe(true)
    expect(controller.nudge).toBe(true)
    // The event carries fresh coverage, so the panel can show it without a refetch.
    expect(controller.coverage).toEqual({ covered: 1, total: 2, clickFreeRatio: 1 })
  })

  it('opening clears the nudge and refetches; a draft event while open does not nudge', async () => {
    const client = fakeClient([GOV])
    const list = vi.spyOn(client, 'list')
    const controller = new DraftsController(client)
    controller.noteEvent({
      type: 'draft',
      id: 'gov-portal',
      host: 'portal.example.go.kr',
      needsReview: true,
      merged: false,
      coverage: { covered: 1, total: 1, clickFreeRatio: 0 },
    })
    expect(controller.nudge).toBe(true)
    await controller.setOpen(true)
    expect(controller.nudge).toBe(false)
    expect(controller.open).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
    expect(controller.count).toBe(1)
    // A draft arriving while the panel is open should not raise the nudge again.
    controller.noteEvent({
      type: 'draft',
      id: 'gov-portal',
      host: 'portal.example.go.kr',
      needsReview: true,
      merged: true,
      coverage: { covered: 1, total: 1, clickFreeRatio: 0 },
    })
    expect(controller.nudge).toBe(false)
  })
})
