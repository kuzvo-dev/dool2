// 서비스 커넥터 (skills/<id>/tools.json, ADR 0018).
// 서비스 하나에서 할 수 있는 일을 타입 있는 도구로 적는다. 코드가 아니라 데이터라서, 두리 본체가 읽어
// 정해진 엔진 동작(열기·기다리기·글자로 누르기·입력·목록 뽑기·같은 사이트 데이터 요청·승인 요청)으로 풀어 실행한다.
// 커넥터는 승인 게이트를 끄거나 비켜 갈 수 없다: 누르기는 본체의 위험 판단을 그대로 거친다.
import { z } from 'zod'
import { type Tier, TierSchema } from './connect.js'

// ── 입력·출력 모양 (JSON 스키마의 작은 부분집합) ──

const KEY = /^[a-z][a-zA-Z0-9_]{0,30}$/
const Key = z.string().regex(KEY, '영어 소문자로 시작하는 이름 (예: keyword, people)')
const Text = (max: number) => z.string().trim().min(1).max(max)

export const InputPropSchema = z
  .object({
    type: z.enum(['string', 'integer', 'number', 'boolean']),
    /** AI가 보는 칸 설명. 형식과 예를 적는다: "날짜 YYYY-MM-DD (예: 2026-11-27)" */
    description: Text(200),
    enum: z.array(Text(40)).min(1).max(30).optional(),
    /** 글 형식: date = YYYY-MM-DD, time = HH:MM (24시간) */
    format: z.enum(['date', 'time']).optional(),
    pattern: z.string().max(200).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    maxLength: z.number().int().min(1).max(2000).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict()
export type InputProp = z.infer<typeof InputPropSchema>

export const InputSchema = z
  .object({
    properties: z.record(Key, InputPropSchema),
    /** 꼭 받아야 하는 칸. AI가 모르면 사용자에게 먼저 묻는다 */
    required: z.array(Key).default([]),
  })
  .strict()
export type ConnectorInput = z.infer<typeof InputSchema>

const Scalar = z.enum(['string', 'integer', 'number', 'boolean'])
export const OutputFieldSchema = z.union([
  z.object({ type: Scalar, description: Text(200).optional() }).strict(),
  z.object({ type: z.literal('strings'), description: Text(200).optional() }).strict(),
  z
    .object({
      /** 줄 목록: 줄마다 같은 칸 (검색 결과, 주문 목록) */
      type: z.literal('list'),
      description: Text(200).optional(),
      fields: z.record(
        Key,
        z
          .object({ type: z.union([Scalar, z.literal('strings')]), description: Text(200).optional() })
          .strict(),
      ),
    })
    .strict(),
])
export type OutputField = z.infer<typeof OutputFieldSchema>

// ── 실행 순서 (엔진 동작) ──

/** 목록 뽑기의 칸 (확장 pageExtract와 같은 모양) */
const ExtractFieldSchema = z
  .object({
    css: z.string().max(300).optional(),
    attr: z.string().max(40).optional(),
    line: z.number().int().min(-20).max(50).optional(),
    match: z.string().max(300).optional(),
    list: z.boolean().optional(),
  })
  .strict()

const As = { as: Key.optional() }
/** 이 단계가 실패해도 다음으로 (팝업 닫기처럼 있을 때만 하는 일) */
const Optional = { optional: z.boolean().optional() }

export const StepSchema = z.union([
  /** 주소 열기 ({{keyword|url}} 같은 채우기). 이 서비스의 사이트 주소만 */
  z.object({ open: Text(500) }).strict(),
  /** 이 말이 보일 때까지(또는 사라질 때까지) 기다리기 */
  z
    .object({
      wait: z
        .object({
          text: z.string().max(300).optional(),
          gone: z.string().max(300).optional(),
          items: z.string().max(300).optional(),
          timeoutMs: z.number().int().min(500).max(20_000).optional(),
        })
        .strict(),
      ...Optional,
    })
    .strict(),
  /** 화면 글에서 찾기 (정규식, 묶음 1). 결과는 as 이름으로 */
  z.object({ find: z.record(Key, z.string().max(300)), ...As }).strict(),
  /** 화면 글자로 누르기 (본체 위험 판단을 거친다) */
  z.object({ click: z.object({ text: Text(200) }).strict(), ...Optional }).strict(),
  /** 입력칸에 쓰기. field = 입력칸 이름·안내 글의 정규식 */
  z
    .object({
      type: z.object({ field: Text(200), text: Text(500), submit: z.boolean().optional() }).strict(),
    })
    .strict(),
  z.object({ press: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown']) }).strict(),
  z.object({ sleep: z.number().int().min(100).max(5_000) }).strict(),
  /** 목록 뽑기 */
  z
    .object({
      extract: z
        .object({
          items: Text(300),
          within: z.string().max(300).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          fields: z.record(Key, ExtractFieldSchema),
        })
        .strict(),
      as: Key,
      /** 적어도 몇 줄 나와야 하나 (못 미치면 막힘으로 본다. 0이면 빈 결과도 정상) */
      min: z.number().int().min(0).max(50).optional(),
    })
    .strict(),
  /** 이 탭의 사이트 안에서 데이터 요청 (JSON). pick = 결과에서 꺼낼 경로 (예: data.list) */
  z
    .object({
      fetch: z
        .object({
          url: Text(800),
          method: z.enum(['GET', 'POST']).optional(),
          body: z.string().max(4000).optional(),
          pick: z.string().max(200).optional(),
        })
        .strict(),
      as: Key,
    })
    .strict(),
  /** 목록 모양 바꾸기: from(변수 경로)의 줄마다 fields(새 이름 → 줄 안 경로) */
  z
    .object({
      map: z
        .object({ from: Text(200), fields: z.record(Key, Text(200)), limit: z.number().int().optional() })
        .strict(),
      as: Key,
    })
    .strict(),
  /** 이 말이 보이면 멈추고 알리기. login이면 연결(로그인) 안내로 돌려준다 */
  z.object({ stop_if: Text(300), say: Text(300), login: z.boolean().optional() }).strict(),
  /** 돈 내기·연락하기 도구의 마지막: 이 버튼을 누를지 사용자 승인을 받는다 (두리가 누르는 건 승인 뒤) */
  z
    .object({
      approve: z
        .object({
          text: Text(200),
          what: Text(200),
          where: Text(100),
          amount: z.string().max(100).optional(),
          cancel: z.string().max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  /** 정해진 순서로 하기 어려운 곳: 여기까지 데려온 탭을 AI에게 넘기고 할 일을 알려 준다 */
  z.object({ handoff_to_agent: Text(500) }).strict(),
])
export type Step = z.infer<typeof StepSchema>

export const STEP_KINDS = [
  'open',
  'wait',
  'find',
  'click',
  'type',
  'press',
  'sleep',
  'extract',
  'fetch',
  'map',
  'stop_if',
  'approve',
  'handoff_to_agent',
] as const
export type StepKind = (typeof STEP_KINDS)[number]
export function stepKind(s: Step): StepKind {
  return STEP_KINDS.find((k) => k in s) as StepKind
}

// ── 도구 ──

/** 도구 상태: 검증됨(YYYY-MM-DD …) / 초안 / 막힘(사유) */
const Status = z
  .string()
  .regex(/^(초안|검증됨\(\d{4}-\d{2}-\d{2}[^)]*\)|막힘\(.+\))$/, '초안 / 검증됨(YYYY-MM-DD) / 막힘(사유)')

export const ConnectorToolSchema = z
  .object({
    /** 서비스 안에서의 이름. 실제 도구 이름은 "<서비스>_<이름>" (catchtable_search) */
    name: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    /** 짧은 제목: "식당 찾기" */
    title: Text(30),
    /** AI가 보는 안내: 언제 쓰는지, 무엇을 돌려주는지, 다음에 무엇을 하면 되는지 */
    description: Text(600),
    tier: TierSchema,
    /** 로그인(연결)해야 쓸 수 있는 도구 */
    login: z.boolean().default(false),
    status: Status,
    input: InputSchema,
    output: z.record(Key, OutputFieldSchema),
    /** 입력 예시 (AI 안내에 붙고, 실제 사이트 시험의 입력이 된다) */
    examples: z
      .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])))
      .min(1)
      .max(3),
    steps: z.array(StepSchema).min(1).max(40),
    /** 돌려줄 값: 출력 칸 → 채우기 ("{{shops}}"처럼 하나만 있으면 값을 그대로) */
    result: z.record(Key, z.string().max(500)),
    /** 결과 글 끝에 붙일 다음 할 일 안내 (채우기 가능) */
    next: z.string().max(400).optional(),
    /** 같은 입력으로 다시 부를 수 있는 간격(초). 그 안에 다시 부르면 지난 결과를 돌려준다 */
    minIntervalSec: z.number().int().min(0).max(86_400).optional(),
  })
  .strict()
export type ConnectorTool = z.infer<typeof ConnectorToolSchema>

export const ConnectorSchema = z
  .object({
    /** 연결 카드(connect.json)의 id와 같게 */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    tools: z.array(ConnectorToolSchema).min(1).max(12),
  })
  .strict()
export type Connector = z.infer<typeof ConnectorSchema>

/** 실제 MCP 도구 이름: catchtable_search, cj_logistics_track */
export function connectorToolName(serviceId: string, name: string): string {
  return `${serviceId.replace(/-/g, '_')}_${name}`
}

/** 등급 → MCP 도구 힌트 */
export function tierAnnotations(tier: Tier) {
  const read = tier === '찾아보기'
  return {
    readOnlyHint: read,
    destructiveHint: tier === '돈 내기' || tier === '연락하기',
    idempotentHint: read,
    openWorldHint: true,
  }
}

// ── 채우기: "{{keyword|url}}" ──

export type Scope = Record<string, unknown>

/** 점 경로로 값 꺼내기: "shops.0.name", "data.list" */
export function pick(scope: unknown, path: string): unknown {
  let cur: unknown = scope
  for (const k of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

const FILTERS: Record<string, (v: string) => string> = {
  url: (v) => encodeURIComponent(v),
  digits: (v) => v.replace(/\D/g, ''),
  trim: (v) => v.trim(),
  /** 정규식 안에 그대로 넣기 */
  re: (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  /** 2026-11-27 → 261127 */
  yymmdd: (v) => v.replace(/\D/g, '').slice(2, 8),
  /** 2026-11-27 → 11.27 */
  mmdd: (v) => {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v)
    return m ? `${m[1]}.${m[2]}` : v
  },
  /** 19:30 → 오후 7:30 */
  ampm: (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(v)
    if (!m) return v
    const h = Number(m[1])
    return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${m[2]}`
  },
  json: (v) => JSON.stringify(v),
}
/** 실행할 때 늘 있는 이름: today = 오늘 날짜(한국, YYYY-MM-DD) */
export const BUILTIN_NAMES = ['today']
export const TEMPLATE_FILTERS = Object.keys(FILTERS)

const EXPR = /\{\{\s*([a-zA-Z_][\w.]*)((?:\s*\|\s*[a-z0-9]+)*)\s*\}\}/g

/** 글 속 {{이름|거르개}}를 채운다. 없는 값은 빈칸 */
export function fill(template: string, scope: Scope): string {
  return template.replace(EXPR, (_m, path: string, filters: string) => {
    const raw = pick(scope, path)
    let v = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : String(raw)
    for (const f of filters
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)) {
      // json은 원래 값(수·목록)을 그대로 JSON으로
      if (f === 'json') v = JSON.stringify(raw ?? null)
      else v = FILTERS[f]?.(v) ?? v
    }
    return v
  })
}

/** "{{shops}}"처럼 채우기 하나뿐이면 그 값을 그대로 (목록·수), 아니면 글로 */
export function fillValue(template: string, scope: Scope): unknown {
  const one = /^\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}$/.exec(template.trim())
  if (one?.[1]) return pick(scope, one[1])
  return fill(template, scope)
}

/** 채우기에 쓴 이름들 (검사용): "keyword", "shops.0.name" → 첫 마디 */
export function templateNames(template: string): { names: string[]; filters: string[] } {
  const names: string[] = []
  const filters: string[] = []
  for (const m of template.matchAll(EXPR)) {
    names.push((m[1] ?? '').split('.')[0] ?? '')
    for (const f of (m[2] ?? '')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean))
      filters.push(f)
  }
  return { names, filters }
}

// ── 검사 (레포 테스트와 본체가 불러올 때) ──

/** 사이트 주소인지: 채우기를 빼고 본 주소의 호스트가 site이거나 그 아래 */
export function onSite(url: string, site: string): boolean {
  try {
    const u = new URL(url.replace(EXPR, 'x'))
    const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(site)
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return false
    const host = local ? u.host : u.hostname
    const base = site.replace(/:\d+$/, '')
    return local ? host === site : host === base || host.endsWith(`.${base}`)
  } catch {
    return false
  }
}

/** 데이터 요청으로 해서는 안 되는 일 (결제·주문·보내기): 그런 일은 화면 버튼 + 승인으로만 */
const RISKY_FETCH =
  /\/(?:checkout|payments?|pay|orders?\/(?:create|place|submit)|purchase|send|delete|remove|withdraw|transfer)(?:[/?#.]|$)/i

export function riskyFetch(url: string, body?: string): string | undefined {
  if (RISKY_FETCH.test(url.replace(EXPR, 'x'))) return '결제·주문·보내기·삭제 주소'
  if (body && /\bmutation\b/.test(body)) return '데이터를 바꾸는 요청(mutation)'
  return undefined
}

const BANNED = [
  /(캡차|보안\s*문자|자동입력\s*방지|captcha|본인\s*인증|인증번호)[^\n]{0,20}(풀|우회|입력해|넣어|자동으로)/i,
  /(비밀번호|카드\s*번호|cvc|공동인증서\s*암호)[^\n]{0,15}(입력|넣)(?![^\n]*(사람|사용자|넘긴|하지 않))/i,
]

/** 커넥터 문제를 사람이 읽을 수 있는 목록으로. site = 연결 카드의 도메인 */
export function checkConnector(dir: string, raw: unknown, site?: string): string[] {
  const r = ConnectorSchema.safeParse(raw)
  if (!r.success) return r.error.issues.map((i) => `${i.path.join('.') || '(전체)'}: ${i.message}`)
  const c = r.data
  const problems: string[] = []
  if (c.id !== dir) problems.push(`id(${c.id})가 폴더 이름(${dir})과 달라요`)
  const seen = new Set<string>()
  for (const t of c.tools) {
    const at = `${t.name}:`
    const full = connectorToolName(c.id, t.name)
    // MCP 도구 이름은 실행기가 "mcp__dool2__"를 붙여 64자 안이어야 한다
    if (full.length > 50) problems.push(`${at} 도구 이름이 너무 길어요 (${full})`)
    if (seen.has(t.name)) problems.push(`${at} 같은 이름의 도구가 또 있어요`)
    seen.add(t.name)
    const inputs = Object.keys(t.input.properties)
    for (const k of t.input.required)
      if (!inputs.includes(k)) problems.push(`${at} required의 ${k}가 입력 칸에 없어요`)
    // 쓸 수 있는 이름: 입력 칸 + 앞 단계가 만든 이름
    const known = new Set<string>([...inputs, ...BUILTIN_NAMES])
    const useAll = (tpl: string, where: string) => {
      const { names, filters } = templateNames(tpl)
      for (const n of names) if (!known.has(n)) problems.push(`${at} ${where}의 {{${n}}}가 무엇인지 몰라요`)
      for (const f of filters)
        if (!TEMPLATE_FILTERS.includes(f)) problems.push(`${at} ${where}의 거르개 |${f}를 몰라요`)
    }
    const kinds = t.steps.map(stepKind)
    t.steps.forEach((s, i) => {
      const where = `${i + 1}단계`
      if ('open' in s) {
        useAll(s.open, where)
        if (site && !onSite(s.open, site))
          problems.push(`${at} ${where}: ${site} 주소만 열 수 있어요 (${s.open})`)
      }
      if ('click' in s) useAll(s.click.text, where)
      if ('type' in s) {
        useAll(s.type.text, where)
        useAll(s.type.field, where)
      }
      if ('wait' in s) for (const v of [s.wait.text, s.wait.gone]) if (v) useAll(v, where)
      if ('find' in s) for (const v of Object.values(s.find)) useAll(v, where)
      if ('stop_if' in s) useAll(s.stop_if, where)
      if ('fetch' in s) {
        useAll(s.fetch.url, where)
        if (s.fetch.body) useAll(s.fetch.body, where)
        if (site && !onSite(s.fetch.url, site))
          problems.push(`${at} ${where}: ${site} 주소에만 요청할 수 있어요 (${s.fetch.url})`)
        const bad = riskyFetch(s.fetch.url, s.fetch.body)
        if (bad) problems.push(`${at} ${where}: ${bad}는 데이터 요청으로 할 수 없어요 (화면 버튼 + 승인으로)`)
        if (s.fetch.method === 'POST' && t.tier !== '찾아보기' && t.tier !== '채워 두기')
          problems.push(`${at} ${where}: 돈 내기·연락하기 도구는 POST 요청을 쓸 수 없어요`)
      }
      if ('map' in s) useAll(`{{${s.map.from}}}`, where)
      if ('approve' in s) {
        for (const v of Object.values(s.approve)) if (v) useAll(v, where)
        if (t.tier !== '돈 내기' && t.tier !== '연락하기')
          problems.push(`${at} 승인 요청(approve)은 돈 내기·연락하기 도구에만 둘 수 있어요`)
        if (i !== t.steps.length - 1) problems.push(`${at} 승인 요청(approve)은 마지막 단계여야 해요`)
      }
      if ('handoff_to_agent' in s) {
        useAll(s.handoff_to_agent, where)
        if (i !== t.steps.length - 1) problems.push(`${at} AI에게 넘기기는 마지막 단계여야 해요`)
      }
      if ('as' in s && s.as) known.add(s.as)
    })
    if (!kinds.includes('open')) problems.push(`${at} 처음에 주소를 여는(open) 단계가 필요해요`)
    else if (kinds[0] !== 'open') problems.push(`${at} 첫 단계는 주소 열기(open)여야 해요`)
    const last = kinds.at(-1)
    if ((t.tier === '돈 내기' || t.tier === '연락하기') && last !== 'approve' && last !== 'handoff_to_agent')
      problems.push(`${at} 돈 내기·연락하기 도구는 승인 요청(approve)이나 AI에게 넘기기로 끝나야 해요`)
    for (const [k, tpl] of Object.entries(t.result)) {
      if (!(k in t.output)) problems.push(`${at} result의 ${k}가 output에 없어요`)
      useAll(tpl, `result.${k}`)
    }
    if (t.next) useAll(t.next, 'next')
    for (const [i, ex] of t.examples.entries()) {
      for (const k of t.input.required) if (!(k in ex)) problems.push(`${at} 예시 ${i + 1}에 ${k}가 없어요`)
      for (const k of Object.keys(ex))
        if (!inputs.includes(k)) problems.push(`${at} 예시 ${i + 1}의 ${k}는 입력 칸에 없어요`)
    }
    const words = [t.description, ...Object.values(t.input.properties).map((p) => p.description)].join('\n')
    for (const re of BANNED) {
      const m = re.exec(words)
      if (m) problems.push(`${at} 금지된 지시가 있어요: "${m[0]}" — 사람에게 넘기는 방식으로 적어 주세요`)
    }
  }
  return problems
}

/** 입력 검사 (실행 전에). 문제 목록 */
export function checkInput(input: ConnectorInput, args: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const k of input.required)
    if (args[k] === undefined || args[k] === null || args[k] === '') problems.push(`${k}가 필요해요`)
  for (const [k, v] of Object.entries(args)) {
    const p = input.properties[k]
    if (!p) {
      problems.push(`${k}라는 칸은 없어요`)
      continue
    }
    if (v === undefined || v === null) continue
    if (p.type === 'string' && typeof v !== 'string') problems.push(`${k}는 글이어야 해요`)
    if ((p.type === 'integer' || p.type === 'number') && typeof v !== 'number')
      problems.push(`${k}는 수여야 해요`)
    if (p.type === 'integer' && typeof v === 'number' && !Number.isInteger(v))
      problems.push(`${k}는 정수여야 해요`)
    if (p.type === 'boolean' && typeof v !== 'boolean') problems.push(`${k}는 참/거짓이어야 해요`)
    if (typeof v === 'string') {
      if (p.enum && !p.enum.includes(v)) problems.push(`${k}는 ${p.enum.join('·')} 중 하나여야 해요`)
      if (p.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v))
        problems.push(`${k}는 YYYY-MM-DD로 적어 주세요`)
      if (p.format === 'time' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v))
        problems.push(`${k}는 HH:MM으로 적어 주세요`)
      if (p.pattern && !new RegExp(p.pattern).test(v)) problems.push(`${k}의 형식이 맞지 않아요`)
      if (p.maxLength && v.length > p.maxLength) problems.push(`${k}가 너무 길어요`)
    }
    if (typeof v === 'number') {
      if (p.minimum !== undefined && v < p.minimum) problems.push(`${k}는 ${p.minimum} 이상이어야 해요`)
      if (p.maximum !== undefined && v > p.maximum) problems.push(`${k}는 ${p.maximum} 이하여야 해요`)
    }
  }
  return problems
}
