// Recipes (ADR 0042): the steps that got a request done, kept per PC so the next request like it is faster.
// A request that ends done (answered, not waiting for the person, not sent back or failed) leaves its useful steps:
// the tools that worked, in order, with short inputs. The same steps seen twice become a recipe. When the person
// asks something that reads like a request a recipe got done, the steps ride on the message for the AI, which judges
// whether they fit. Nothing here leaves the PC.
import { readFileSync, writeFileSync } from 'node:fs'

export interface RecipeStep {
  /** Dool2 or service tool name (a service_call is kept as the service tool it called) */
  tool: string
  /** Called through service_call (the AI would otherwise look the tool up first) */
  via?: 'service_call'
  /** Site for browser_open / browser_navigate: host + path */
  at?: string
  /** Short inputs (values that are long, private or messages are dropped) */
  input?: Record<string, string | number | boolean>
  /** Consecutive calls of the same tool folded into one step */
  times?: number
}

export interface Recipe {
  id: string
  /** The steps, as last done */
  steps: RecipeStep[]
  /** Last requests these steps got done (the person's words, newest first) */
  asks: string[]
  /** Requests these steps got done */
  ok: number
  /** Times a step of this recipe failed after it was offered */
  fails: number
  /** Times it was offered, and offered and then followed */
  offered: number
  followed: number
  lastAt: string
}

/** Seen this many times before it is offered */
export const MIN_OK = 2
/** Most recipes kept (the least recently used go first) */
export const MAX_RECIPES = 60
/** Most steps in a recipe (longer walks change too much from one time to the next) */
export const MAX_STEPS = 12
/** Most recipes offered on one message */
export const MAX_OFFER = 2
/** How alike a message and a recipe's request must read to offer it (character pairs, 0–1) */
export const MIN_LIKE = 0.34

/**
 * Tools that are not part of how a job gets done: looking a tool up (what a recipe saves), reading, remembering,
 * answering. The answer's shape (show_*) is kept as the last step
 */
const SKIP =
  /^(service_find|tool_find|tool_call|status|conversation_search|memory_\w+|know_\w+|library_find|profile_view|vault_find|pay_method_list|goal_list|task_list|task_steer|task_stop|feed_\w+|idea_suggest|ai_account_view|connect_ask|photo_view|browser_(close|screenshot|read|wait\w*|scroll|find|text|tabs|hover))$/
/** Input fields that hold what the person typed to someone, or secrets: never kept */
const PRIVATE_KEY =
  /^(text|body|message|content|comment|memo|note|password|pw|code|otp|pin|card|account|phone|email|to|cc|bcc|address)$/i

/** Strips the Dool2 tool prefix the agent shows */
export const bareTool = (name: string) => name.replace(/^(mcp__dool2__|dool2_)/, '')

function shortValue(v: unknown): string | number | boolean | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s || s.length > 40) return undefined
  // Emails, and phone, card or account numbers (dates and times are kept: they show the format the tool takes)
  if (/@/.test(s)) return undefined
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(s) && s.replace(/\D/g, '').length >= 8) return undefined
  return s
}

function shortInput(input: unknown): Record<string, string | number | boolean> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (PRIVATE_KEY.test(k) || k === 'tabId' || k === 'ref') continue
    const s = shortValue(v)
    if (s !== undefined) out[k] = s
    if (Object.keys(out).length >= 6) break
  }
  return Object.keys(out).length ? out : undefined
}

/** host + path of an address (no query, no member numbers) */
function siteOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    const path = /\d{5,}|@|%40/.test(u.pathname) ? '' : u.pathname.replace(/\/$/, '')
    return `${u.host}${path}`.slice(0, 80)
  } catch {
    return undefined
  }
}

/** One tool call as a recipe step (undefined if it is not part of how the job got done) */
export function stepOf(name: string, input: unknown): RecipeStep | undefined {
  let tool = bareTool(name)
  let args: unknown = input
  let via: RecipeStep['via']
  if (tool === 'service_call') {
    const a = (input ?? {}) as { tool?: unknown; input?: unknown }
    if (typeof a.tool !== 'string' || !/^[a-z0-9_]+$/.test(a.tool)) return undefined
    tool = a.tool
    args = a.input
    via = 'service_call'
  }
  if (SKIP.test(tool)) return undefined
  if (/^show_/.test(tool)) return { tool }
  if (tool === 'browser_open' || tool === 'browser_navigate') {
    const at = siteOf((args as { url?: unknown } | undefined)?.url)
    return at ? { tool, at } : { tool }
  }
  if (tool === 'browser_route') {
    const route = (args as { route?: unknown } | undefined)?.route
    return typeof route === 'string' ? { tool, input: { route } } : { tool }
  }
  // Other browser and PC app actions point at things on the page by refs that change every time: only the kind of action
  if (/^(browser|screen)_/.test(tool)) return { tool }
  const short = shortInput(args)
  return { tool, ...(via ? { via } : {}), ...(short ? { input: short } : {}) }
}

/** Folds repeats (three clicks in a row are one step "browser_click ×3") and drops answer shapes but the last */
export function foldSteps(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = []
  for (const s of steps) {
    const prev = out[out.length - 1]
    if (prev && prev.tool === s.tool && !s.at && !prev.at && !s.input && !prev.input) {
      prev.times = (prev.times ?? 1) + (s.times ?? 1)
      continue
    }
    out.push({ ...s })
  }
  const lastShow = out.map((s) => /^show_/.test(s.tool)).lastIndexOf(true)
  return out.filter((s, i) => !/^show_/.test(s.tool) || i === lastShow).slice(0, MAX_STEPS)
}

/** What makes two step lists the same recipe: the tools in order and the sites, not the inputs or counts */
export function signature(steps: RecipeStep[]): string {
  return steps.map((s) => `${s.tool}${s.at ? `@${s.at.split('/')[0]}` : ''}`).join('>')
}

/** Worth remembering: more than an answer shape, and either two steps or a tool the AI had to look up */
export function worthKeeping(steps: RecipeStep[]): boolean {
  const work = steps.filter((s) => !/^show_/.test(s.tool))
  if (!work.length) return false
  return work.length >= 2 || work.some((s) => s.via === 'service_call')
}

function pairs(text: string): Set<string> {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/** How alike two requests read, 0–1 (shared character pairs; works for Korean without splitting words) */
export function alike(a: string, b: string): number {
  const x = pairs(a)
  const y = pairs(b)
  if (!x.size || !y.size) return 0
  let same = 0
  for (const p of x) if (y.has(p)) same++
  return (2 * same) / (x.size + y.size)
}

function stepText(s: RecipeStep): string {
  const input = s.input
    ? ` ${JSON.stringify(s.input)}`
    : s.via === 'service_call' || s.tool === 'orders_all'
      ? ' {}'
      : ''
  const name = s.via === 'service_call' ? `service_call ${s.tool}` : s.tool
  return `${name}${s.at ? ` ${s.at}` : ''}${input}${s.times ? ` ×${s.times}` : ''}`
}

/**
 * A recipe for the memory screen: the person's words and the services or sites its steps used, by names people know
 * (nameOf gives the service a tool belongs to; browser opens show their site)
 */
export function recipeView(r: Recipe, nameOf: (tool: string) => string | undefined) {
  const names: string[] = []
  for (const s of r.steps) {
    const name = nameOf(s.tool) ?? (s.at ? s.at.split('/')[0]?.replace(/^www\./, '') : undefined)
    if (name && names[names.length - 1] !== name) names.push(name)
  }
  return { id: r.id, ask: r.asks[0] ?? '', steps: names.slice(0, 5), ok: r.ok, lastAt: r.lastAt }
}

export class RecipeBook {
  private recipes: Recipe[] = []
  private seq = 0

  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { recipes?: Recipe[] }
      this.recipes = Array.isArray(raw.recipes) ? raw.recipes : []
    } catch {}
    for (const r of this.recipes) this.seq = Math.max(this.seq, Number(r.id.slice(1)) || 0)
  }

  all(): Recipe[] {
    return [...this.recipes].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  }

  get(id: string): Recipe | undefined {
    return this.recipes.find((r) => r.id === id)
  }

  /** Recipes that are offered (seen often enough) */
  ready(): Recipe[] {
    return this.recipes.filter((r) => r.ok >= MIN_OK)
  }

  /**
   * A request ended done with these steps. Returns the recipe and how many times these steps had got a request done
   * before this one (0 = new), or undefined when the steps are not worth keeping
   */
  record(ask: string, raw: RecipeStep[]): { recipe: Recipe; before: number } | undefined {
    const steps = foldSteps(raw)
    if (!worthKeeping(steps)) return undefined
    const words = ask.replace(/\s+/g, ' ').trim().slice(0, 120)
    const at = this.now().toISOString()
    const sig = signature(steps)
    const same = this.recipes.find((r) => signature(r.steps) === sig)
    if (same) {
      const before = same.ok
      same.steps = steps
      same.ok++
      if (words) same.asks = [words, ...same.asks.filter((a) => a !== words)].slice(0, 3)
      same.lastAt = at
      this.save()
      return { recipe: same, before }
    }
    const recipe: Recipe = {
      id: `k${++this.seq}`,
      steps,
      asks: words ? [words] : [],
      ok: 1,
      fails: 0,
      offered: 0,
      followed: 0,
      lastAt: at,
    }
    this.recipes.push(recipe)
    if (this.recipes.length > MAX_RECIPES) {
      // The least used and least recent go first; ones still waiting for a second time go before ready ones
      const order = [...this.recipes].sort(
        (a, b) => Number(a.ok >= MIN_OK) - Number(b.ok >= MIN_OK) || a.lastAt.localeCompare(b.lastAt),
      )
      const drop = new Set(order.slice(0, this.recipes.length - MAX_RECIPES).map((r) => r.id))
      this.recipes = this.recipes.filter((r) => !drop.has(r.id))
    }
    this.save()
    return { recipe, before: 0 }
  }

  /** Ready recipes whose requests read like this message, most alike first */
  match(text: string, n = MAX_OFFER): Recipe[] {
    return this.ready()
      .map((r) => ({ r, like: Math.max(0, ...r.asks.map((a) => alike(a, text))) }))
      .filter((x) => x.like >= MIN_LIKE)
      .sort((a, b) => b.like - a.like || b.r.ok - a.r.ok)
      .slice(0, n)
      .map((x) => x.r)
  }

  /** The recipes were put on a message */
  offered(ids: string[]) {
    for (const id of ids) {
      const r = this.get(id)
      if (r) r.offered++
    }
    if (ids.length) this.save()
  }

  /** The request was done with the steps of an offered recipe */
  followed(id: string) {
    const r = this.get(id)
    if (!r) return
    r.followed++
    this.save()
  }

  /**
   * A step of an offered recipe failed. A recipe that fails more than it works is forgotten (the site or tool
   * changed); returns true when it was
   */
  failed(id: string): boolean {
    const r = this.get(id)
    if (!r) return false
    r.fails++
    if (r.fails >= 3 && r.fails > r.ok) {
      this.forget(id)
      return true
    }
    this.save()
    return false
  }

  forget(id: string) {
    this.recipes = this.recipes.filter((r) => r.id !== id)
    this.save()
  }

  /** The lines that ride on a message: what worked for requests like it */
  hint(list: Recipe[]): string | undefined {
    if (!list.length) return undefined
    const day = (iso: string) => iso.slice(5, 10)
    return [
      'Steps that got requests like this one done on this PC before (from what you did, not rules). If one fits, ' +
        'follow it and skip looking tools up again; change inputs to this request; where it does not fit, work as usual. ' +
        'Browser or PC app steps go in task_start (the task is given them too).',
      ...list.map(
        (r) =>
          `- [${r.id}] "${r.asks[0] ?? ''}" (done ${r.ok} times, last ${day(r.lastAt)}): ${r.steps.map(stepText).join(' → ')}`,
      ),
    ].join('\n')
  }

  private save() {
    if (!this.file) return
    try {
      writeFileSync(this.file, JSON.stringify({ recipes: this.recipes }, null, 1))
    } catch {}
  }
}

interface OpenRequest {
  ask: string
  at: number
  calls: { name: string; step?: RecipeStep; ok?: boolean }[]
  offered: string[]
  /** Offered recipes that already had a step fail on this request (counted once) */
  failedOffers: Set<string>
}

/**
 * The steps of each chat's open request, from the person's message to the answer that ends it. A request sent back by
 * the finish check or waiting for the person goes on over several turns, so the steps are gathered here
 */
export class RequestSteps {
  private open = new Map<string, OpenRequest>()

  constructor(private readonly now: () => number = Date.now) {}

  begin(threadId: string, ask: string, offered: string[] = []) {
    this.open.set(threadId, { ask, at: this.now(), calls: [], offered, failedOffers: new Set() })
  }

  has(threadId: string): boolean {
    return this.open.has(threadId)
  }

  offeredOn(threadId: string): string[] {
    return this.open.get(threadId)?.offered ?? []
  }

  tool(threadId: string, name: string, input: unknown) {
    const r = this.open.get(threadId)
    if (!r || r.calls.length >= 80) return
    const step = stepOf(name, input)
    r.calls.push({ name: bareTool(name), ...(step ? { step } : {}) })
  }

  /**
   * A tool's result. On a failure, returns the offered recipes with that tool among their steps (each once per request),
   * so they can be counted as failing
   */
  result(threadId: string, name: string | undefined, ok: boolean, book?: RecipeBook): string[] {
    const r = this.open.get(threadId)
    if (!r) return []
    const bare = name ? bareTool(name) : undefined
    const call = r.calls.find((c) => c.ok === undefined && (!bare || c.name === bare))
    if (call) call.ok = ok
    if (ok || !call?.step || !book) return []
    const tool = call.step.tool
    const hit = r.offered.filter(
      (id) => !r.failedOffers.has(id) && book.get(id)?.steps.some((s) => s.tool === tool),
    )
    for (const id of hit) r.failedOffers.add(id)
    return hit
  }

  /** The request ended: its steps that worked, how long it took and how many tool calls it made */
  end(threadId: string) {
    const r = this.open.get(threadId)
    if (!r) return undefined
    this.open.delete(threadId)
    return {
      ask: r.ask,
      ms: this.now() - r.at,
      tools: r.calls.length,
      steps: r.calls.filter((c) => c.ok !== false && c.step).map((c) => c.step as RecipeStep),
      offered: r.offered,
    }
  }

  drop(threadId: string) {
    this.open.delete(threadId)
  }
}
