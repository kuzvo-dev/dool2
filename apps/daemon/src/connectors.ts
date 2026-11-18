// 서비스 도구(커넥터) 실행기 (ADR 0018). skills/<id>/tools.json을 읽어 엔진 동작으로 풀어 실행한다.
//
// - 커넥터는 데이터다. 할 수 있는 일은 여기 적힌 엔진 동작뿐이고, 누르기·입력은 BrowserTools를 거쳐
//   지금과 같은 위험 판단(승인 게이트)을 받는다. 찾아보기 도구는 위험한 버튼을 아예 못 누른다.
// - AI에게는 연결한 서비스(+로그인 없는 서비스)의 도구만 바로 보이고(catalog), 나머지는 service_find → service_call.
// - 막히면 열어 둔 탭 번호와 함께 "브라우저 도구로 이어서"를 돌려준다. 사이트가 바뀐 것일 수 있어 기록해 둔다.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MIN_CONNECTOR_EXTENSION, versionAtLeast } from '@dool2/protocol'
import { CONNECT_CATEGORIES, type ConnectCard, type ConnectionTool } from '@dool2/protocol/connect'
import {
  type Connector,
  ConnectorSchema,
  type ConnectorTool,
  checkInput,
  connectorToolName,
  fill,
  fillValue,
  healthProblems,
  matches,
  type OutputField,
  onSite,
  onSites,
  pick,
  type Scope,
  type Step,
  stepKind,
  tierAnnotations,
} from '@dool2/protocol/connector'
import type { BrowserCaller, BrowserTools, RiskKind, ToolResult } from './browser-tools.js'
import type { ConnectorHealth, Outcome } from './connector-health.js'
import type { Journal } from './journal.js'

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
/** 같은 서비스를 잇달아 열 때 사이 간격. 한꺼번에 여러 번 열면 사이트가 막는다 (쿠팡, 2026-11-18) */
const SITE_GAP_MS = 1500

/** AI에게 내보이는 도구 하나 (MCP 서버가 그대로 등록한다) */
export interface ServiceToolSpec {
  name: string
  title: string
  description: string
  input: ConnectorTool['input']
  output: ConnectorTool['output']
  annotations: ReturnType<typeof tierAnnotations>
}

interface Loaded {
  card: ConnectCard
  connector?: Connector
  /** tools.json이 있는데 형식이 틀렸으면 그 문제 */
  broken?: string
}

/** 막힌 기록 (사이트가 바뀌었는지 볼 때) */
export interface Breakage {
  tool: string
  step: number
  kind: string
  reason: string
  url?: string
  at: string
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
})

/** 오늘 날짜 (한국 시간, YYYY-MM-DD) */
function today(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 단계 실패: 이 단계에서 막혔다 (optional이면 건너뛴다) */
class StepError extends Error {}
/** 위험 판단에 멈췄다 (돌려줄 말 그대로) */
class GuardStop extends Error {}

export class Connectors {
  private cache?: { at: number; items: Map<string, Loaded> }
  /** 서비스마다 다시 쓰는 탭 (탭이 너무 많아지지 않게) */
  private tabs = new Map<string, number>()
  /** 같은 입력으로 다시 부르면 지난 결과 (minIntervalSec) */
  private recent = new Map<string, { at: number; result: ToolResult }>()
  /** 서비스마다 한 번에 하나씩: 같은 탭을 여러 부름이 동시에 옮기지 않게 줄을 세운다 */
  private lanes = new Map<string, Promise<unknown>>()
  private lastRun = new Map<string, number>()
  readonly breakages: Breakage[] = []

  constructor(
    private readonly opts: {
      dir: string | undefined
      browser: BrowserCaller
      tools: BrowserTools
      /** 연결을 마친 서비스 id → 시각 */
      connected: () => Record<string, string>
      now?: () => Date
      /** 기다리기 간격 (시험에서 줄인다) */
      pollMs?: number
      /** 건강 기록 (ADR 0020): 잇달아 깨지는 도구는 잠시 쉰다 */
      health?: ConnectorHealth
      /** 일한 기록: 도구를 부를 때마다 결과·걸린 시간·막힌 까닭을 며칠 남긴다 */
      journal?: Journal
      /** 연결된 확장 버전 (예전 확장에는 커넥터 엔진이 없다) */
      extensionVersion?: () => string | undefined
      /** 같은 서비스를 잇달아 열 때 사이 간격 (시험에서 줄인다) */
      gapMs?: number
    },
  ) {}

  /** 연결된 확장이 커넥터 엔진보다 예전이면 그 버전 (모르면 undefined: 실행해 보고 판단) */
  private oldExtension(): string | undefined {
    const v = this.opts.extensionVersion?.()
    return v && !versionAtLeast(v, MIN_CONNECTOR_EXTENSION) ? v : undefined
  }

  /** 쉬는 중이 아니고 막힘 표시도 없는 도구 */
  private live(card: ConnectCard, t: ConnectorTool) {
    return this.usable(t) && !this.opts.health?.resting(connectorToolName(card.id, t.name))
  }

  private now() {
    return (this.opts.now ?? (() => new Date()))()
  }

  /** 카드·커넥터 읽기 (10초 동안은 다시 읽지 않는다) */
  async load(): Promise<Map<string, Loaded>> {
    if (this.cache && Date.now() - this.cache.at < 10_000) return this.cache.items
    const items = new Map<string, Loaded>()
    const dir = this.opts.dir
    if (dir) {
      const { ConnectCardSchema } = await import('@dool2/protocol/connect')
      for (const n of (await readdir(dir).catch(() => [] as string[])).sort()) {
        if (!NAME.test(n)) continue
        const raw = await readFile(join(dir, n, 'connect.json'), 'utf8').catch(() => undefined)
        if (!raw) continue
        let card: ConnectCard
        try {
          const r = ConnectCardSchema.safeParse(JSON.parse(raw))
          if (!r.success || r.data.id !== n) continue
          card = r.data
        } catch {
          continue
        }
        const loaded: Loaded = { card }
        const tj = await readFile(join(dir, n, 'tools.json'), 'utf8').catch(() => undefined)
        if (tj) {
          try {
            const r = ConnectorSchema.safeParse(JSON.parse(tj))
            if (r.success && r.data.id === n) loaded.connector = r.data
            else
              loaded.broken = r.success
                ? 'id가 폴더 이름과 달라요'
                : (r.error.issues[0]?.message ?? '형식 오류')
          } catch (e) {
            loaded.broken = (e as Error).message
          }
        }
        items.set(n, loaded)
      }
    }
    this.cache = { at: Date.now(), items }
    return items
  }

  /**
   * 시험용 PC: 아직 설치하지 않은 도구 정의(tools.json)를 이 PC의 진짜 Chrome에서 한 번 돌린다.
   * 시험용 Chrome은 막는 사이트(쿠팡·29CM 등)도 사용자 Chrome에서는 열리니, 고친 정의를 여기서 확인한다.
   * 상태(초안·막힘)·쉬는 중·같은 입력 간격은 보지 않는다. 결과의 빈 칸(조용한 고장)은 함께 알려 준다
   */
  async tryDraft(
    raw: unknown,
    toolName: string,
    input: Record<string, unknown>,
    o: { close?: boolean } = {},
  ): Promise<ToolResult> {
    const r = ConnectorSchema.safeParse(raw)
    if (!r.success)
      return text(
        `도구 정의 형식이 틀렸어요: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`,
        true,
      )
    const card = (await this.load()).get(r.data.id)?.card
    if (!card) return text(`이 PC에 ${r.data.id} 연결 카드가 없어요`, true)
    const tool = r.data.tools.find((t) => t.name === toolName)
    if (!tool) return text(`${r.data.id}에 ${toolName} 도구가 없어요`, true)
    const args: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(tool.input.properties))
      if (p.default !== undefined) args[k] = p.default
    for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined && v !== null) args[k] = v
    const bad = checkInput(tool.input, args)
    if (bad.length) return text(`입력을 고쳐 주세요: ${bad.join(', ')}`, true)
    const { outcome, detail, ...result } = await this.inLane(card.id, () => this.execute(card, tool, args))
    // 여러 서비스를 차례로 시험할 때 사용자 Chrome에 탭이 쌓이지 않게 (8GB 맥이 멈춘 적이 있다)
    const tab = this.tabs.get(card.id)
    if (o.close && tab !== undefined) {
      await this.opts.browser.call('close', { tabId: tab }).catch(() => undefined)
      this.tabs.delete(card.id)
    }
    const sick =
      outcome === 'ok' && result.structuredContent ? healthProblems(tool, result.structuredContent) : []
    return sick.length
      ? {
          ...result,
          content: [...result.content, { type: 'text', text: `(결과 칸이 비어 있어요: ${sick.join(', ')})` }],
        }
      : result
  }

  /** 시험·개발: 파일을 고친 뒤 바로 다시 읽게 */
  invalidate() {
    this.cache = undefined
  }

  private usable(t: ConnectorTool) {
    return !t.status.startsWith('막힘')
  }

  private isConnected(card: ConnectCard) {
    return card.how === 'open' || card.how === 'device' || Boolean(this.opts.connected()[card.id])
  }

  /** 바로 보이는 도구: 연결한 서비스와 로그인 없는 서비스(open)의 도구 */
  async catalog(): Promise<ServiceToolSpec[]> {
    const out: ServiceToolSpec[] = []
    if (this.oldExtension()) return out
    for (const { card, connector } of (await this.load()).values()) {
      if (!connector || !this.isConnected(card)) continue
      for (const t of connector.tools) if (this.live(card, t)) out.push(this.spec(card, t))
    }
    return out
  }

  /** AI가 보는 도구 안내: 설명 + 입력 예시 + 상태 */
  spec(card: ConnectCard, t: ConnectorTool): ServiceToolSpec {
    const ex = t.examples.map((e) => JSON.stringify(e)).join(' / ')
    const notes = [
      `[${card.name} · ${t.tier}${t.login ? ' · 연결 필요' : ''}]`,
      t.description,
      `입력 예: ${ex}`,
      t.status === '초안' ? '(처음 써 보는 도구예요. 결과를 한 번 더 확인해 주세요)' : '',
    ]
    return {
      name: connectorToolName(card.id, t.name),
      title: `${card.name}: ${t.title}`,
      description: notes.filter(Boolean).join('\n'),
      input: t.input,
      output: t.output,
      annotations: tierAnnotations(t.tier),
    }
  }

  /** 도구 이름으로 찾기 */
  private async resolve(name: string): Promise<{ card: ConnectCard; tool: ConnectorTool } | undefined> {
    for (const { card, connector } of (await this.load()).values()) {
      for (const t of connector?.tools ?? [])
        if (connectorToolName(card.id, t.name) === name) return { card, tool: t }
    }
    return undefined
  }

  /** 주소의 사이트에 커넥터가 있으면 (브라우저로 열었을 때 도구를 쓰라고 알린다) */
  async forUrl(url: string): Promise<{ id: string; name: string; tools: string[] } | undefined> {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return undefined
    }
    for (const { card, connector } of (await this.load()).values()) {
      const sites = [card.site, ...(card.alsoSites ?? [])]
        .filter(Boolean)
        .map((x) => (x as string).replace(/:\d+$/, ''))
      if (!connector || !sites.some((site) => host === site || host.endsWith(`.${site}`))) continue
      const tools = connector.tools
        .filter((t) => this.live(card, t))
        .map((t) => connectorToolName(card.id, t.name))
      if (tools.length) return { id: card.id, name: card.name, tools }
    }
    return undefined
  }

  /** 연결 화면에 보일 커넥터 상태 요약과 도구 이름 */
  async summary(id: string): Promise<{ status?: string; tools?: ConnectionTool[] }> {
    const c = (await this.load()).get(id)?.connector
    if (!c) return {}
    const ok = c.tools.filter((t) => t.status.startsWith('검증됨'))
    const status = ok.length
      ? `검증됨(${ok
          .map((t) => /\d{4}-\d{2}-\d{2}/.exec(t.status)?.[0] ?? '')
          .sort()
          .at(-1)})`
      : c.tools.some((t) => this.usable(t))
        ? '초안'
        : '막힘'
    const tools = c.tools
      .filter((t) => this.usable(t))
      .map((t) => ({
        name: connectorToolName(id, t.name),
        title: t.title,
        tier: t.tier,
        login: t.login,
        verified: t.status.startsWith('검증됨'),
      }))
    return { status, tools }
  }

  forgetTab(tabId: number) {
    for (const [k, v] of this.tabs) if (v === tabId) this.tabs.delete(k)
  }

  // ── 서비스 찾기 (service_find) ──

  async find(query: string): Promise<ToolResult> {
    const items = [...(await this.load()).values()].filter((x) => x.card.how !== 'device')
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const score = ({ card, connector }: Loaded) => {
      const head = [card.id, card.name, card.site ?? ''].join(' ').toLowerCase()
      const body = [
        card.summary,
        CONNECT_CATEGORIES[card.category],
        ...card.abilities.flatMap((a) => [a.title, a.say]),
        ...(connector?.tools.flatMap((t) => [t.title, t.description]) ?? []),
      ]
        .join(' ')
        .toLowerCase()
      const n = words.reduce((sum, w) => sum + (head.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0)
      return n > 0 ? n + (connector ? 2 : 0) + (this.opts.connected()[card.id] ? 3 : 0) : 0
    }
    const hit = (
      words.length
        ? items
            .map((it) => ({ it, n: score(it) }))
            .filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n)
            .map((x) => x.it)
        : items
    ).slice(0, 5)
    if (!hit.length)
      return text(
        `맞는 서비스가 없어요. 일반 검색이나 브라우저 도구로 해 보세요. (서비스: ${items.map((x) => x.card.id).join(', ')})`,
      )
    return text(hit.map((it) => this.describe(it)).join('\n\n'))
  }

  /** 서비스 하나를 AI가 읽을 글로: 연결 상태, 도구(등급·입력), 연동 안내 */
  private describe({ card, connector }: Loaded): string {
    const connected = this.isConnected(card)
    const state =
      card.how === 'open' ? '로그인 없이 씀' : this.opts.connected()[card.id] ? '연결됨' : '연결 전'
    const lines = [`## ${card.name} (${card.id}) — ${state}`, card.summary]
    const tools = connector?.tools.filter((t) => this.usable(t)) ?? []
    if (!tools.length) {
      lines.push(
        '두리 서비스 도구는 아직 없어요. 브라우저 도구로 해요' +
          (card.site ? ` (https://${card.site}/).` : '.'),
        ...(card.hints ?? []).map((h) => `- 요령: ${h}`),
      )
      if (!connected && (card.how === 'browser' || card.how === 'official'))
        lines.push(`로그인이 필요한 단계가 되면 connect_ask('${card.id}')로 연결 카드를 띄워요.`)
      return lines.join('\n')
    }
    for (const t of tools) {
      const need = this.opts.health?.resting(connectorToolName(card.id, t.name))
        ? '요즘 막혀서 쉬는 중 — 브라우저 도구로'
        : t.login && !connected
          ? '연결 필요'
          : t.login
            ? '연결됨'
            : '로그인 없이'
      const args = Object.entries(t.input.properties)
        .map(
          ([k, p]) =>
            `${k}${t.input.required.includes(k) ? '*' : ''}(${p.description.split(/[.(]/)[0]?.trim()})`,
        )
        .join(', ')
      lines.push(
        `- ${connectorToolName(card.id, t.name)} [${t.tier} · ${need}] ${t.title} — 입력: ${args || '없음'}`,
      )
    }
    const locked = tools.filter((t) => t.login && !connected)
    if (locked.length)
      lines.push(
        `연결하면 바로: ${locked.map((t) => t.title).join(', ')}. 그 단계가 되면 connect_ask('${card.id}')로 연결 카드를 띄우고 답을 끝내요. 로그인 없이 되는 도구로 먼저 찾아 주는 건 괜찮아요.`,
      )
    lines.push(
      connected
        ? '바로 보이는 도구 목록에 있으면 그대로 부르고, 없으면 service_call로 불러요.'
        : "service_call({ tool: '<도구 이름>', input: { … } })로 불러요.",
    )
    return lines.join('\n')
  }

  // ── 실행 (service_call, 바로 보이는 도구) ──

  async call(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const found = await this.resolve(name)
    if (!found) return text(`그런 서비스 도구가 없어요: ${name}. service_find로 이름을 확인해 주세요.`, true)
    const { card, tool } = found
    if (!this.usable(tool))
      return text(
        `${card.name}의 '${tool.title}' 도구는 지금 막혀 있어요(${tool.status}). 브라우저 도구로 해 주세요.`,
        true,
      )
    // 기본값 채우기 → 입력 검사
    const args: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(tool.input.properties))
      if (p.default !== undefined) args[k] = p.default
    for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined && v !== null) args[k] = v
    const bad = checkInput(tool.input, args)
    if (bad.length) return text(`입력을 고쳐 주세요: ${bad.join(', ')}`, true)
    if (tool.login && !this.isConnected(card))
      return text(
        `${card.name} 연결이 필요해요('${tool.title}'은 로그인해야 해요). connect_ask('${card.id}')로 연결 카드를 띄우고 "카드에서 연결해 주세요"라고 짧게 말한 뒤 답을 끝내세요. 연결되면 앱 알림이 와요. 그때 이 도구를 다시 불러요.`,
        true,
      )
    const key = `${name} ${JSON.stringify(args)}`
    const last = this.recent.get(key)
    if (tool.minIntervalSec && last && Date.now() - last.at < tool.minIntervalSec * 1000) {
      const min = Math.max(1, Math.round((Date.now() - last.at) / 60_000))
      return {
        ...last.result,
        content: [
          ...last.result.content,
          {
            type: 'text',
            text: `(${min}분 전에 본 결과예요. 사이트에 자주 묻지 않으려고 다시 보지 않았어요)`,
          },
        ],
      }
    }
    const old = this.oldExtension()
    if (old) this.opts.journal?.write('tool', { tool: name, outcome: 'old-extension', detail: old })
    if (old)
      return text(
        `Chrome의 두리 확장이 예전 버전(${old})이라 서비스 도구를 쓸 수 없어요. 브라우저 도구로 같은 일을 해 주세요. 확장이 ${MIN_CONNECTOR_EXTENSION} 이상으로 업데이트되면 다시 돼요.`,
        true,
      )
    const rest = this.opts.health?.resting(name)
    if (rest)
      return text(
        `${card.name}의 '${tool.title}' 도구는 요즘 사이트가 바뀌어 잠시 쉬고 있어요(${rest.reason}). 브라우저 도구로 같은 일을 해 주세요.`,
        true,
      )
    const startedAt = Date.now()
    const { outcome, detail, ...result } = await this.inLane(card.id, () => this.execute(card, tool, args))
    // 결과는 왔는데 꼭 채워질 칸이 비면 조용한 고장 (ADR 0020)
    let final: ToolResult = result
    let seen = outcome
    let why = detail
    if (outcome === 'ok' && result.structuredContent) {
      const sick = healthProblems(tool, result.structuredContent)
      if (sick.length) {
        seen = 'empty'
        why = sick.join(', ')
        final = {
          ...result,
          content: [
            ...result.content,
            {
              type: 'text',
              text: `(결과 칸이 비어 있어요: ${why}. 사이트가 바뀌었을 수 있으니 브라우저 도구로 화면을 확인해 주세요)`,
            },
          ],
        }
      }
    }
    if (seen) this.opts.health?.record(name, seen, why)
    // 입력값(찾는 말·주소 등)은 적지 않는다: 도구 이름·결과·까닭·걸린 시간만
    this.opts.journal?.write('tool', {
      tool: name,
      outcome: seen ?? (final.isError ? 'error' : 'ok'),
      ...(why ? { detail: why } : {}),
      ms: Date.now() - startedAt,
    })
    if (!final.isError && seen === 'ok' && tool.minIntervalSec)
      this.recent.set(key, { at: Date.now(), result: final })
    return final
  }

  /** 같은 서비스 부름은 앞 부름이 끝나고 간격을 둔 뒤에 (다른 서비스는 그대로 동시에) */
  private inLane<T>(id: string, run: () => Promise<T>): Promise<T> {
    const gap = this.opts.gapMs ?? SITE_GAP_MS
    const prev = this.lanes.get(id) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.lastRun.get(id) ?? 0) + gap - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        try {
          return await run()
        } finally {
          this.lastRun.set(id, Date.now())
        }
      })
    const tail = next.catch(() => undefined)
    this.lanes.set(id, tail)
    void tail.then(() => {
      if (this.lanes.get(id) === tail) this.lanes.delete(id)
    })
    return next
  }

  private async execute(
    card: ConnectCard,
    tool: ConnectorTool,
    args: Record<string, unknown>,
  ): Promise<ToolResult & { outcome?: Outcome; detail?: string }> {
    const b = this.opts.browser
    const scope: Scope = { ...args, today: today(this.now()) }
    let tabId: number | undefined = this.tabs.get(card.id)
    const need = () => {
      if (tabId === undefined) throw new StepError('먼저 주소를 열어야 해요')
      return tabId
    }
    const site = card.site ?? ''
    // 페이지가 받은 응답을 읽는 도구면 주소를 열 때부터 응답 듣기를 켠다
    const capture = tool.steps.some((x) => 'capture' in x)
    const pollMs = this.opts.pollMs ?? 300
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const read = async () => {
      const r = await this.opts.tools.run('read', { tabId: need() })
      if (r.isError) throw new StepError(firstText(r))
      return firstText(r)
    }
    for (const [i, step] of tool.steps.entries()) {
      const kind = stepKind(step)
      try {
        const done = await this.step(step, {
          scope,
          tier: tool.tier,
          site,
          pollMs,
          sleep,
          read,
          need,
          open: async (url) => {
            if (!onSites(url, [site, ...(card.alsoSites ?? [])]))
              throw new StepError(`${site} 밖의 주소는 열지 않아요: ${url}`)
            // 이 서비스에 쓰던 탭이 있으면 그 탭에서 (없어졌으면 새로 연다)
            if (tabId !== undefined) {
              const ok = await b
                .call('navigate', { tabId, url, ...(capture ? { capture } : {}) }, 40_000)
                .then(
                  () => true,
                  () => false,
                )
              if (ok) {
                this.opts.tools.watchTab(tabId)
                return
              }
            }
            const r = (await b.call('open', { url, ...(capture ? { capture } : {}) }, 40_000)) as {
              tabId: number
            }
            tabId = r.tabId
            this.tabs.set(card.id, r.tabId)
            // 일하는 동안 폰 대화에 이 화면이 보이게 (끝난 뒤에 알리면 일하는 내내 화면이 비어 있다)
            this.opts.tools.watchTab(r.tabId)
          },
        })
        if (done) {
          const r = this.finish(done, tabId)
          // 승인 요청·AI에게 넘기기는 잘 된 것, 마감·로그인 필요 같은 멈춤은 정상 멈춤
          const sc = r.structuredContent as { stopped?: unknown; blocked?: unknown } | undefined
          const stopped = r.isError || Boolean(sc?.stopped)
          return { ...r, outcome: sc?.blocked ? 'blocked' : stopped ? 'stopped' : 'ok' }
        }
      } catch (e) {
        const optional = 'optional' in step && step.optional
        if (e instanceof GuardStop)
          return {
            ...text(`${e.message}${tabId !== undefined ? ` [탭 ${tabId}]` : ''}`, true),
            outcome: 'stopped',
          }
        if (optional && e instanceof StepError) continue
        return {
          ...this.broke(card, tool, i, kind, (e as Error).message, tabId),
          outcome: 'broke',
          detail: `${i + 1}단계(${kind}): ${(e as Error).message}`,
        }
      }
    }
    // 돌려줄 값
    const out: Record<string, unknown> = {}
    for (const [k, tpl] of Object.entries(tool.result)) {
      const field = tool.output[k]
      out[k] = field ? coerce(fillValue(tpl, scope), field) : fillValue(tpl, scope)
    }
    const lines = [render(tool, out)]
    if (tool.next) lines.push('', fill(tool.next, scope))
    // 고를 후보에 사진·주소가 있으면 카드로 보여 주라고 한 줄 (도구마다 next에 쓰지 않아도 되게)
    const rows = Object.values(out).filter(Array.isArray).flat() as Record<string, unknown>[]
    if (
      rows.some((r) => r && typeof r === 'object' && (r.image || r.link)) &&
      !/show_cards/.test(tool.next ?? '')
    )
      lines.push(
        '',
        '후보를 보여 줄 땐 show_cards로 사진(image)·가격·주소(link)를 그대로 넣은 카드를 붙이고, 글로는 고른 이유만 짧게 말해요.',
      )
    if (tool.status === '초안')
      lines.push('', '(처음 써 보는 도구예요. 이상해 보이면 브라우저 도구로 화면을 확인해 주세요)')
    if (tabId !== undefined) lines.push(`[탭 ${tabId}]`)
    this.opts.tools.lastTabId = tabId
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: out, outcome: 'ok' }
  }

  /** 끝내는 단계(승인 요청·AI에게 넘기기·멈춤)의 결과 */
  private finish(done: ToolResult, tabId: number | undefined): ToolResult {
    if (tabId !== undefined) this.opts.tools.lastTabId = tabId
    return done.isError ? done : { ...done, structuredContent: done.structuredContent ?? {} }
  }

  private broke(
    card: ConnectCard,
    tool: ConnectorTool,
    i: number,
    kind: string,
    reason: string,
    tabId: number | undefined,
  ): ToolResult {
    this.breakages.push({
      tool: connectorToolName(card.id, tool.name),
      step: i + 1,
      kind,
      reason,
      at: this.now().toISOString(),
    })
    if (this.breakages.length > 200) this.breakages.shift()
    console.warn(`[커넥터] ${connectorToolName(card.id, tool.name)} ${i + 1}단계(${kind}) 막힘: ${reason}`)
    return text(
      `${card.name} '${tool.title}' 도구가 ${i + 1}단계(${kind})에서 막혔어요: ${reason}. ` +
        (tabId !== undefined
          ? `사이트 화면이 바뀌었을 수 있어요. [탭 ${tabId}]이 열려 있으니 browser_read로 읽고 브라우저 도구로 이어서 해 주세요.`
          : '브라우저 도구로 해 주세요.'),
      true,
    )
  }

  /** 단계 하나. 끝내는 단계면 돌려줄 결과를 준다 */
  private async step(
    s: Step,
    c: {
      scope: Scope
      tier: ConnectorTool['tier']
      site: string
      pollMs: number
      sleep: (ms: number) => Promise<unknown>
      read: () => Promise<string>
      need: () => number
      open: (url: string) => Promise<void>
    },
  ): Promise<ToolResult | undefined> {
    const b = this.opts.browser
    const f = (t: string) => fill(t, c.scope)
    if ('open' in s) {
      await c.open(f(s.open))
      return
    }
    if ('sleep' in s) {
      await c.sleep(s.sleep)
      return
    }
    if ('wait' in s) {
      const until = Date.now() + (s.wait.timeoutMs ?? 8000)
      const patterns: Record<string, string> = {}
      if (s.wait.text) patterns.text = f(s.wait.text)
      if (s.wait.gone) patterns.gone = f(s.wait.gone)
      for (;;) {
        let ok = true
        if (Object.keys(patterns).length) {
          const r = (await b.call('find', { tabId: c.need(), patterns })) as {
            found: Record<string, string | null>
          }
          if (patterns.text && !r.found.text) ok = false
          if (patterns.gone && r.found.gone) ok = false
        }
        if (ok && s.wait.items) {
          const r = (await b.call('extract', {
            tabId: c.need(),
            spec: { items: f(s.wait.items), fields: {}, limit: 1 },
          })) as {
            rows: unknown[]
          }
          if (!r.rows.length) ok = false
        }
        if (ok) return
        if (Date.now() > until)
          throw new StepError(
            s.wait.text || s.wait.items
              ? `기다린 것이 화면에 안 나왔어요 (${s.wait.text ?? s.wait.items})`
              : `"${s.wait.gone}"이(가) 사라지지 않았어요`,
          )
        await c.sleep(c.pollMs)
      }
    }
    if ('find' in s) {
      const patterns = Object.fromEntries(Object.entries(s.find).map(([k, v]) => [k, f(v)]))
      const r = (await b.call('find', { tabId: c.need(), patterns })) as {
        found: Record<string, string | null>
      }
      c.scope[s.as ?? 'found'] = r.found
      return
    }
    if ('stop_if' in s) {
      const r = (await b.call('find', { tabId: c.need(), patterns: { hit: f(s.stop_if) } })) as {
        found: Record<string, string | null>
      }
      if (!r.found.hit) return
      const say = f(s.say)
      if (s.login)
        return text(
          `${say} 로그인이 필요한 화면이에요. 연결이 안 됐으면 connect_ask로 연결 카드를, 연결했는데 로그인이 풀렸으면 browser_handoff로 사람에게 넘겨 주세요. [탭 ${c.need()}]`,
          true,
        )
      if (s.blocked)
        return {
          content: [
            {
              type: 'text',
              text: `${say} (같은 사이트를 곧바로 다시 열면 더 오래 막혀요. 바로 다시 부르지 말고 사용자에게 알려 주세요)`,
            },
          ],
          structuredContent: { stopped: say, blocked: true },
        }
      return { content: [{ type: 'text', text: say }], structuredContent: { stopped: say } }
    }
    if ('require' in s) {
      const until = Date.now() + (s.timeoutMs ?? 6000)
      for (;;) {
        const r = (await b.call('find', { tabId: c.need(), patterns: { hit: f(s.require) } })) as {
          found: Record<string, string | null>
        }
        if (r.found.hit) return
        if (Date.now() > until) {
          const say = f(s.say)
          return { content: [{ type: 'text', text: say }], structuredContent: { stopped: say } }
        }
        await c.sleep(c.pollMs)
      }
    }
    if ('click' in s) {
      await c.read()
      const tabId = c.need()
      const want = f(s.click.text)
      // 화면 읽기에 같은 이름의 버튼·라디오·링크가 있으면 그 표시로 (뒤에 깔린 화면의 같은 글자를 누르지 않게)
      const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
      const ref = [...(this.opts.tools.refsOf(tabId) ?? [])].find(
        ([, v]) => v.role !== '글' && norm(v.name) === norm(want),
      )?.[0]
      const r = await this.opts.tools.run('click', ref ? { tabId, ref } : { tabId, text: want })
      if (r.isError) {
        const msg = firstText(r)
        // 위험 판단에 걸린 것은 커넥터가 넘을 수 없다: 그대로 AI에게
        if (msg.startsWith('멈췄어요')) throw new GuardStop(msg)
        throw new StepError(msg)
      }
      return
    }
    if ('type' in s) {
      await c.read()
      const tabId = c.need()
      const want = new RegExp(f(s.type.field))
      const ref = [...(this.opts.tools.refsOf(tabId) ?? [])].find(
        ([, v]) => (v.role === '입력칸' || v.role === '검색칸') && want.test(v.name),
      )?.[0]
      if (!ref) throw new StepError(`입력칸(${s.type.field})을 찾지 못했어요`)
      const r = await this.opts.tools.run('type', {
        tabId,
        ref,
        text: f(s.type.text),
        submit: Boolean(s.type.submit),
      })
      if (r.isError) {
        const msg = firstText(r)
        if (msg.startsWith('멈췄어요')) throw new GuardStop(msg)
        throw new StepError(msg)
      }
      return
    }
    if ('press' in s) {
      await c.read()
      const r = await this.opts.tools.run('press', { tabId: c.need(), key: s.press })
      if (r.isError) {
        const msg = firstText(r)
        if (msg.startsWith('멈췄어요')) throw new GuardStop(msg)
        throw new StepError(msg)
      }
      return
    }
    if ('extract' in s) {
      const fields = Object.fromEntries(
        Object.entries(s.extract.fields).map(([k, v]) => [
          k,
          { ...v, ...(v.css ? { css: f(v.css) } : {}), ...(v.match ? { match: f(v.match) } : {}) },
        ]),
      )
      const spec = {
        items: f(s.extract.items),
        ...(s.extract.within ? { within: f(s.extract.within) } : {}),
        ...(s.extract.limit ? { limit: s.extract.limit } : {}),
        fields,
      }
      const min = s.min ?? 1
      const until = Date.now() + 6000
      for (;;) {
        const r = (await b.call('extract', { tabId: c.need(), spec })) as { rows: Record<string, unknown>[] }
        if (r.rows.length >= min || Date.now() > until) {
          if (r.rows.length < min)
            throw new StepError(`목록(${spec.items})이 ${min}줄 넘게 나와야 하는데 ${r.rows.length}줄이에요`)
          c.scope[s.as] = r.rows
          return
        }
        await c.sleep(c.pollMs)
      }
    }
    if ('embedded' in s) {
      const until = Date.now() + 6000
      for (;;) {
        const r = (await b.call('extract', {
          tabId: c.need(),
          spec: { items: f(s.embedded.css), hidden: true, limit: 1, fields: { t: { raw: true } } },
        })) as { rows: { t: string | null }[] }
        const text = r.rows[0]?.t
        if (text) {
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            throw new StepError(`${s.embedded.css} 안의 글이 JSON이 아니에요`)
          }
          c.scope[s.as] = s.embedded.pick ? pick(data, s.embedded.pick) : data
          return
        }
        if (Date.now() > until) throw new StepError(`화면에 ${s.embedded.css} 데이터가 없어요`)
        await c.sleep(c.pollMs)
      }
    }
    if ('capture' in s) {
      // 페이지가 스스로 받은 응답을 읽는다 (두리가 요청을 보내지 않는다)
      const r = (await b
        .call(
          'capture',
          {
            tabId: c.need(),
            url: f(s.capture.url),
            pick: s.capture.pick ?? '',
            timeoutMs: s.capture.timeoutMs ?? 10_000,
          },
          40_000,
        )
        .catch((e: Error) => {
          throw new StepError(e.message)
        })) as { json: unknown }
      c.scope[s.as] = r.json
      return
    }
    if ('filter' in s) {
      const from = pick(c.scope, s.filter.from)
      if (!Array.isArray(from)) throw new StepError(`${s.filter.from}이(가) 목록이 아니에요`)
      const want = s.filter.value !== undefined ? f(s.filter.value).trim() : ''
      c.scope[s.as] = from.filter((row) => matches(pick(row, s.filter.where), s.filter.op, want))
      return
    }
    if ('map' in s) {
      const raw = pick(c.scope, s.map.from)
      if (!Array.isArray(raw)) throw new StepError(`${s.map.from}이(가) 목록이 아니에요`)
      // 여러 묶음으로 나뉜 목록("groups.*.items")은 한 줄로 펼친다
      const from: unknown[] = raw.length && raw.every(Array.isArray) ? raw.flat() : raw
      c.scope[s.as] = from
        .slice(0, Number(typeof s.map.limit === 'string' ? f(s.map.limit) : s.map.limit) || 50)
        .map((row) =>
          Object.fromEntries(
            Object.entries(s.map.fields).map(([k, p]) => [
              k,
              // "{{…}}"가 있으면 줄 안의 값(없으면 입력·앞 단계 값)으로 채운 글, 아니면 경로
              (p.includes('{{')
                ? fill(p, { ...c.scope, ...(row as Scope) }).trim()
                : firstImage(k, pick(row, p))) ?? null,
            ]),
          ),
        )
      return
    }
    if ('approve' in s) {
      await c.read()
      const tabId = c.need()
      const m = await this.opts.tools.markText(tabId, f(s.approve.text)).catch((e: Error) => {
        throw new StepError(e.message)
      })
      const kind: RiskKind = c.tier === '연락하기' ? 'contact' : 'money'
      const r = await this.opts.tools
        .askApproval(
          tabId,
          m.ref,
          {
            what: f(s.approve.what),
            where: f(s.approve.where),
            ...(s.approve.amount ? { amount: f(s.approve.amount) } : {}),
            ...(s.approve.cancel ? { cancel: f(s.approve.cancel) } : {}),
          },
          kind,
        )
        .catch((e: Error) => text(`${e.message} [탭 ${tabId}]`, true))
      return r
    }
    if ('handoff_to_agent' in s) {
      const page = await c.read()
      return text(`${f(s.handoff_to_agent)}\n여기부터는 브라우저 도구로 이어서 해요.\n\n${page}`)
    }
    return
  }
}

function firstText(r: ToolResult): string {
  const c = r.content.find((x) => x.type === 'text')
  return c && c.type === 'text' ? c.text : ''
}

/** 출력 칸 모양에 맞추기 ('4.5' → 4.5, 빈 값은 null) */
/** 사진 칸(image)에 여러 장이 잡히면 첫 장 (색상별 사진 등) */
function firstImage(key: string, v: unknown): unknown {
  return key === 'image' && Array.isArray(v) ? v.find((x) => typeof x === 'string' && x) : v
}

export function coerce(v: unknown, field: OutputField): unknown {
  const one = (x: unknown, type: string): unknown => {
    if (x === undefined || x === null || x === '') return null
    if (type === 'strings') return Array.isArray(x) ? x.map(String) : [String(x)]
    if (type === 'number' || type === 'integer') {
      // 글 속 첫 수: "4.5 (120)" → 4.5, "12,900원" → 12900
      const m = typeof x === 'number' ? undefined : /-?\d[\d,]*(?:\.\d+)?/.exec(String(x))
      const n = typeof x === 'number' ? x : m ? Number(m[0].replace(/,/g, '')) : Number.NaN
      return Number.isFinite(n) ? (type === 'integer' ? Math.round(n) : n) : null
    }
    if (type === 'boolean') return typeof x === 'boolean' ? x : /^(true|1|예|네|있음)$/i.test(String(x))
    return typeof x === 'string' ? x : Array.isArray(x) ? x.join(', ') : String(x)
  }
  if (field.type === 'list') {
    if (!Array.isArray(v)) return []
    return v.map((row) =>
      Object.fromEntries(
        Object.entries(field.fields).map(([k, f]) => [k, one((row as Record<string, unknown>)?.[k], f.type)]),
      ),
    )
  }
  return one(v, field.type)
}

/** 결과를 AI가 읽기 쉬운 짧은 글로: 목록은 번호 줄, 나머지는 "이름: 값" */
export function render(tool: ConnectorTool, out: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(out)) {
    const field = tool.output[k]
    if (field?.type === 'list' && Array.isArray(v)) {
      lines.push(`${field.description ?? k} (${v.length}개)`)
      v.slice(0, 30).forEach((row, i) => {
        const cells = Object.entries(row as Record<string, unknown>)
          .filter(([, x]) => x !== null && x !== '' && !(Array.isArray(x) && !x.length))
          .map(([kk, x]) => `${kk}: ${Array.isArray(x) ? x.join(', ') : x}`)
        lines.push(`${i + 1}. ${cells.join(' · ')}`)
      })
      if (v.length > 30) lines.push(`… 그 밖에 ${v.length - 30}개`)
    } else if (v !== null && v !== undefined && v !== '') {
      lines.push(`${field?.description ?? k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    }
  }
  return lines.join('\n') || '(돌려줄 내용이 없어요)'
}
