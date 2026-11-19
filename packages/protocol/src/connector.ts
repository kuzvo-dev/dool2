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
    /**
     * 사진 칸: 줄(또는 css 안)에서 가장 그럴듯한 사진 주소 하나. 늦게 그리는 사진(data-src·srcset·배경 그림)도 보고,
     * 아이콘·로고·배지·아주 작은 그림은 건너뛰고, http는 https로 바꾼다. 화면 카드(show_cards)에 쓴다
     */
    image: z.boolean().optional(),
  })
  .strict()

const As = { as: Key.optional() }
/** 이 단계가 실패해도 다음으로 (팝업 닫기처럼 있을 때만 하는 일) */
const Optional = { optional: z.boolean().optional() }
/**
 * 이 단계를 할지: 채운 글이 비면 건너뛴다. 예: "{{^found.0}}1{{/found.0}}" = 앞에서 아무것도 못 찾았을 때만
 * (앞 기간에서 찾으면 더 예전 기간은 열지 않기 같은 데 쓴다)
 */
const If = { if: z.string().max(400).optional() }
/** 목록이면 앞에서 같은 이름으로 모은 목록 뒤에 붙인다 (여러 기간·여러 쪽을 한 목록으로) */
const Append = { append: z.boolean().optional() }

export const StepSchema = z.union([
  /** 주소 열기 ({{keyword|url}} 같은 채우기). 이 서비스의 사이트 주소만 */
  z.object({ open: Text(500), ...If }).strict(),
  /** 이 말이 보일 때까지(또는 사라질 때까지) 기다리기 */
  z
    .object({
      wait: z
        .object({
          text: z.string().max(300).optional(),
          gone: z.string().max(300).optional(),
          items: z.string().max(300).optional(),
          timeoutMs: z.number().int().min(500).max(20_000).optional(),
          // soft면 시간이 지나도 멈추지 않고 그냥 다음 단계로 간다 (사이트 글이 바뀌어도 handoff에서 AI가 읽게)
          soft: z.boolean().optional(),
        })
        .strict(),
      ...Optional,
      ...If,
    })
    .strict(),
  /** 화면 글에서 찾기 (정규식, 묶음 1). 결과는 as 이름으로 */
  z.object({ find: z.record(Key, z.string().max(300)), ...As, ...If }).strict(),
  /** 화면 글자로 누르기 (본체 위험 판단을 거친다) */
  z.object({ click: z.object({ text: Text(200) }).strict(), ...Optional, ...If }).strict(),
  /** 입력칸에 쓰기. field = 입력칸 이름·안내 글의 정규식 */
  z
    .object({
      type: z.object({ field: Text(200), text: Text(500), submit: z.boolean().optional() }).strict(),
      ...If,
    })
    .strict(),
  /** 펼침 목록(정렬·목록 개수·옵션)에서 고르기. field = 선택 상자 이름의 정규식, option = 고를 항목 글 그대로 */
  z
    .object({
      choose: z.object({ field: Text(200), option: Text(100) }).strict(),
      ...Optional,
      ...If,
    })
    .strict(),
  z.object({ press: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown']), ...If }).strict(),
  z.object({ sleep: z.number().int().min(100).max(5_000), ...If }).strict(),
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
      ...If,
    })
    .strict(),
  /**
   * 화면에 박혀 있는 데이터(JSON) 읽기: 서버가 결과를 화면과 함께 보내는 사이트 (script#__NEXT_DATA__ 등).
   * css = 그 요소, pick = 꺼낼 경로
   */
  z
    .object({
      embedded: z
        .object({
          css: Text(300),
          pick: z.string().max(300).optional(),
          /** 스크립트 안 자바스크립트 변수면: 이 글자 뒤 첫 JSON 덩어리를 읽는다 (예: "__APOLLO_STATE__") */
          after: z.string().max(60).optional(),
        })
        .strict(),
      as: Key,
      ...Append,
      ...If,
    })
    .strict(),
  /**
   * 페이지가 스스로 받은 응답(JSON) 읽기. 두리가 요청을 보내지 않는다: 사람이 그 화면을 열 때 사이트가 받는 데이터 중
   * 주소가 url(정규식)에 맞는 마지막 응답을 읽고 pick 경로를 꺼낸다. 이 도구의 open이 응답 듣기를 켠다
   */
  z
    .object({
      capture: z
        .object({
          url: Text(300),
          pick: z.string().max(200).optional(),
          timeoutMs: z.number().int().min(500).max(30_000).optional(),
        })
        .strict(),
      as: Key,
      ...Append,
      ...If,
    })
    .strict(),
  /**
   * 목록 거르기: from의 줄 중 조건에 맞는 것만. value가 비면(입력을 안 줬으면) 거르지 않는다.
   * 예: { "from": "products", "where": "price", "op": "lte", "value": "{{max_price}}" }
   */
  z
    .object({
      filter: z
        .object({
          from: Text(200),
          where: Text(200),
          op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'has', 'not']),
          value: z.string().max(200).optional(),
        })
        .strict(),
      as: Key,
      ...If,
    })
    .strict(),
  /** 목록 모양 바꾸기: from(변수 경로)의 줄마다 fields(새 이름 → 줄 안 경로) */
  z
    .object({
      map: z
        .object({
          from: Text(200),
          fields: z.record(Key, Text(200)),
          /** 몇 줄까지 (수나 "{{limit}}") */
          limit: z.union([z.number().int().min(1).max(200), z.string().max(40)]).optional(),
        })
        .strict(),
      as: Key,
      ...If,
    })
    .strict(),
  /** 이 말이 (기다려도) 안 나오면 멈추고 알리기: "그 시간은 마감이에요" 같은 결과 (막힘이 아니다) */
  z
    .object({
      require: Text(300),
      say: Text(300),
      timeoutMs: z.number().int().min(500).max(20_000).optional(),
      ...If,
    })
    .strict(),
  /** 이 말이 보이면 멈추고 알리기. login이면 연결(로그인) 안내로, blocked면 사이트가 이 브라우저를 막은 것
   *  (고칠 커넥터 문제가 아니라서 점검에서 고장과 따로 센다) */
  z
    .object({
      stop_if: Text(300),
      say: Text(300),
      login: z.boolean().optional(),
      blocked: z.boolean().optional(),
      ...If,
    })
    .strict(),
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
      ...If,
    })
    .strict(),
  /** 정해진 순서로 하기 어려운 곳: 여기까지 데려온 탭을 AI에게 넘기고 할 일을 알려 준다 */
  z.object({ handoff_to_agent: Text(500), ...If }).strict(),
])
export type Step = z.infer<typeof StepSchema>

export const STEP_KINDS = [
  'open',
  'wait',
  'find',
  'click',
  'type',
  'choose',
  'press',
  'sleep',
  'extract',
  'capture',
  'embedded',
  'map',
  'filter',
  'stop_if',
  'require',
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
    /**
     * 건강 기준 (ADR 0020): 결과 목록이 적어도 rows줄(매일 점검에서만), filled 칸은 줄의 80% 넘게 채워져야 한다.
     * 못 미치면 "조용한 고장"(사이트가 바뀌어 칸이 비는 것)으로 본다
     */
    expect: z
      .object({
        rows: z.number().int().min(0).max(100).optional(),
        filled: z.array(Key).max(10).optional(),
      })
      .strict()
      .optional(),
    /** 같은 입력으로 다시 부를 수 있는 간격(초). 그 안에 다시 부르면 지난 결과를 돌려준다 */
    minIntervalSec: z.number().int().min(0).max(86_400).optional(),
    /**
     * false: 고를 후보 목록이 아니라 카드로 보여 주지 않는다 (극장 목록·상영 시간·가사·택배 단계 등).
     * 쇼핑·숙소·책·예매·영상 분야의 찾아보기 목록은 기본으로 사진(image)·링크(link) 칸이 있어야 한다
     */
    cards: z.boolean().optional(),
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

/**
 * 점 경로로 값 꺼내기: "shops.0.name", "data.list", 뒤에서 "events.-1.status",
 * 목록의 칸 모으기 "slots.*.time" → ["12:00", "19:30"],
 * 목록 중 칸 값이 같은 줄만 "chargers[powerType=급속|초급속][status=충전가능]" (|는 그중 하나, 뒤에 ".length"면 그 수)
 */
export function pick(scope: unknown, path: string): unknown {
  const keys = path.split('.').filter(Boolean)
  let cur: unknown = scope
  for (const [i, k] of keys.entries()) {
    if (cur === null || cur === undefined) return undefined
    const where = /^([^[]*)((?:\[\w+=[^\]]*\])+)$/.exec(k)
    if (where) {
      if (where[1]) cur = (cur as Record<string, unknown>)[where[1]]
      if (!Array.isArray(cur)) return undefined
      for (const [, f = '', v] of (where[2] ?? '').matchAll(/\[(\w+)=([^\]]*)\]/g))
        cur = (cur as unknown[]).filter(
          (x) =>
            x !== null &&
            typeof x === 'object' &&
            (v ?? '').split('|').includes(String((x as Record<string, unknown>)[f] ?? '')),
        )
      continue
    }
    if (k === '*') {
      // 칸 묶음(색상 코드별 사진 같은)이면 그 값들을 목록으로
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) cur = Object.values(cur)
      if (!Array.isArray(cur)) return undefined
      const rest = keys.slice(i + 1).join('.')
      const out = cur.map((x) => (rest ? pick(x, rest) : x)).filter((x) => x !== undefined && x !== null)
      // 별이 또 있으면(주문.*.묶음.*.상품) 한 목록으로 펼친다
      return rest.split('.').includes('*') ? out.flat() : out
    }
    if (Array.isArray(cur) && /^-\d+$/.test(k)) cur = cur.at(Number(k))
    else cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

const DOW = ['일', '월', '화', '수', '목', '금', '토']
/** 한국 날짜 (YYYY-MM-DD) */
function kstDate(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10)
}

const FILTERS: Record<string, (v: string) => string> = {
  url: (v) => encodeURIComponent(v),
  digits: (v) => v.replace(/\D/g, ''),
  trim: (v) => v.trim(),
  /** 정규식 안에 그대로 넣기 */
  re: (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  /** 수에서 1 빼기: 2026 → 2025 (지난해 주소: {{today|yyyy|dec}}). 수가 아니면 빈 글 */
  dec: (v) => (/^-?\d+$/.test(v.trim()) ? String(Number(v) - 1) : ''),
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
  /** 밀리초(1794493572000) → 한국 날짜 2026-11-12. 이미 날짜 글이면 그대로 */
  date: (v) => (/^\d{12,13}$/.test(v.trim()) ? kstDate(Number(v)) : v),
  /** 2026-11-28 → 그날 한국 0시의 밀리초 (1795791600000) */
  ms: (v) => {
    const t = Date.parse(`${v.slice(0, 10)}T00:00:00+09:00`)
    return Number.isNaN(t) ? '' : String(t)
  },
  /** 2026-11-27 → 2026 */
  yyyy: (v) => /^(\d{4})-/.exec(v)?.[1] ?? '',
  /** 2026-03-07 → 03 */
  mm: (v) => /^\d{4}-(\d{2})/.exec(v)?.[1] ?? '',
  /** 2026-03-07 → 3 */
  m: (v) => String(Number(/^\d{4}-(\d{2})/.exec(v)?.[1] ?? '') || ''),
  /** 2026-03-07 → 07 */
  dd: (v) => /^\d{4}-\d{2}-(\d{2})/.exec(v)?.[1] ?? '',
  /** 2026-03-07 → 7 */
  d: (v) => String(Number(/^\d{4}-\d{2}-(\d{2})/.exec(v)?.[1] ?? '') || ''),
  /** 2026-11-27 → 금 */
  dow: (v) => {
    const t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`)
    return Number.isNaN(t) ? '' : (DOW[new Date(t).getUTCDay()] ?? '')
  },
  /** 오늘·내일이면 그 말, 아니면 11.27 (예약 앱의 날짜 칸) */
  kday: (v) => {
    const now = Date.now()
    if (v.startsWith(kstDate(now))) return '오늘'
    if (v.startsWith(kstDate(now + 86_400_000))) return '내일'
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v)
    return m ? `${m[1]}.${m[2]}` : v
  },
  /** 날짜 줄 이름: 오늘이면 "오늘", 아니면 요일 (오늘을 "오늘 19"로 보이는 예매 화면) */
  daylabel: (v) => {
    if (v.startsWith(kstDate(Date.now()))) return '오늘'
    return FILTERS.dow?.(v) ?? v
  },
  /** 날짜 줄의 '일': 두 자리, 그 달 1일이면 "M.1" (12.1) */
  dd1: (v) => {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v)
    if (!m) return ''
    return m[2] === '01' ? `${Number(m[1])}.1` : (m[2] ?? '')
  },
}
/** 실행할 때 늘 있는 이름: today = 오늘 날짜(한국, YYYY-MM-DD) */
export const BUILTIN_NAMES = ['today']
export const TEMPLATE_FILTERS = Object.keys(FILTERS)

const EXPR = /\{\{\s*([a-zA-Z_][\w.]*)((?:\s*\|\s*[a-z0-9]+)*)\s*\}\}/g

/** 글 속 {{이름|거르개}}를 채운다. 없는 값은 빈칸 */
/** {{#name}}…{{/name}}: 값이 있을 때만, {{^name}}…{{/name}}: 값이 없을 때만 안을 채운다 (빈 입력이면 &fromPrice= 같은 칸을 빼기) */
const SECTION = /\{\{([#^])\s*([a-zA-Z_][\w.]*)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g
const present = (v: unknown) =>
  v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)

/** 묶음 표시 (안에 든 다른 묶음까지 세려고, 검사용) */
const SECTION_OPEN = /\{\{[#^]\s*([a-zA-Z_][\w.]*)\s*\}\}/g

export function fill(template: string, scope: Scope): string {
  // 묶음 안의 묶음({{#item}}{{^year}}…{{/year}}{{/item}})은 바깥부터 한 겹씩 푼다.
  // 값 채우기는 묶음을 다 푼 뒤라, 입력 글에 {{…}}가 있어도 묶음으로 읽히지 않는다
  let t = template
  for (let i = 0; i < 8; i++) {
    const next = t.replace(SECTION, (_m, kind: string, path: string, inner: string) =>
      present(pick(scope, path)) === (kind === '#') ? inner : '',
    )
    if (next === t) break
    t = next
  }
  return t.replace(EXPR, (_m, path: string, filters: string) => {
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
  for (const m of template.matchAll(SECTION_OPEN)) names.push((m[1] ?? '').split('.')[0] ?? '')
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
/** 여러 도메인 중 하나라도 맞으면 (연결 카드의 site + alsoSites) */
export function onSites(url: string, sites: string | string[]): boolean {
  return (Array.isArray(sites) ? sites : [sites]).some((x) => onSite(url, x))
}

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

const BANNED = [
  /(캡차|보안\s*문자|자동입력\s*방지|captcha|본인\s*인증|인증번호)[^\n]{0,20}(풀|우회|입력해|넣어|자동으로)/i,
  /(비밀번호|카드\s*번호|cvc|공동인증서\s*암호)[^\n]{0,15}(입력|넣)(?![^\n]*(사람|사용자|넘긴|하지 않))/i,
]

/** 커넥터 문제를 사람이 읽을 수 있는 목록으로. site = 연결 카드의 도메인 */
/** 고를 후보를 사진 카드로 보여 주는 분야 (연결 카드의 category) */
export const CARD_CATEGORIES = ['shopping', 'grocery', 'fashion', 'travel', 'tickets', 'media', 'books']

export function checkConnector(
  dir: string,
  raw: unknown,
  site?: string | string[],
  category?: string,
): string[] {
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
    // 사진 카드(show_cards): 이 분야의 찾아보기 목록은 사진·링크 칸이 있어야 카드로 보인다 (앞으로 만드는 도구도)
    const lists = Object.values(t.output).filter((o) => o.type === 'list')
    if (
      category &&
      CARD_CATEGORIES.includes(category) &&
      t.tier === '찾아보기' &&
      t.cards !== false &&
      lists.length
    ) {
      const has = (k: string) => lists.some((o) => o.type === 'list' && k in o.fields)
      if (!has('image') || !has('link'))
        problems.push(
          `${at} 고를 후보 목록이면 사진(image)·링크(link) 칸을 넣어요 (답에 사진 카드로 보여요). 사진은 extract의 {"image": true}나 데이터의 사진 경로. 카드가 안 맞는 목록이면 "cards": false`,
        )
    }
    const kinds = t.steps.map(stepKind)
    t.steps.forEach((s, i) => {
      const where = `${i + 1}단계`
      if (s.if !== undefined) useAll(s.if, `${where}의 if`)
      if ('open' in s) {
        useAll(s.open, where)
        if (site && !onSites(s.open, site))
          problems.push(`${at} ${where}: ${site} 주소만 열 수 있어요 (${s.open})`)
      }
      if ('click' in s) useAll(s.click.text, where)
      if ('type' in s) {
        useAll(s.type.text, where)
        useAll(s.type.field, where)
      }
      if ('choose' in s) {
        useAll(s.choose.field, where)
        useAll(s.choose.option, where)
      }
      if ('wait' in s) for (const v of [s.wait.text, s.wait.gone]) if (v) useAll(v, where)
      if ('find' in s) for (const v of Object.values(s.find)) useAll(v, where)
      if ('stop_if' in s) {
        useAll(s.stop_if, where)
        useAll(s.say, where)
      }
      if ('require' in s) {
        useAll(s.require, where)
        useAll(s.say, where)
      }
      if ('capture' in s) {
        useAll(s.capture.url, where)
        try {
          new RegExp(s.capture.url.replace(/\{\{[^}]*\}\}/g, 'x'))
        } catch {
          problems.push(`${at} ${where}: capture의 주소 패턴(정규식)이 틀렸어요`)
        }
      }
      if ('filter' in s) {
        useAll(`{{${s.filter.from}}}`, where)
        if (s.filter.value) useAll(s.filter.value, where)
      }
      if ('map' in s) {
        useAll(`{{${s.map.from}}}`, where)
        if (typeof s.map.limit === 'string') useAll(s.map.limit, where)
      }
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
    for (const k of t.expect?.filled ?? []) {
      const ok = Object.values(t.output).some((o) => o.type === 'list' && k in o.fields) || k in t.output
      if (!ok) problems.push(`${at} expect.filled의 ${k}가 output에 없어요`)
    }
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
      // 어떻게 고칠지 알게 칸 설명을 붙인다 (예: "'CGV'는 빼고 (예: 강남)")
      if (p.pattern && !new RegExp(p.pattern).test(v))
        problems.push(
          `${k}의 형식이 맞지 않아요(${JSON.stringify(v)})${p.description ? `: ${p.description}` : ''}`,
        )
      if (p.maxLength && v.length > p.maxLength) problems.push(`${k}가 너무 길어요`)
    }
    if (typeof v === 'number') {
      if (p.minimum !== undefined && v < p.minimum) problems.push(`${k}는 ${p.minimum} 이상이어야 해요`)
      if (p.maximum !== undefined && v > p.maximum) problems.push(`${k}는 ${p.maximum} 이하여야 해요`)
    }
  }
  return problems
}

/** 거르기 조건 하나 (filter 단계). want가 비면 늘 참 */
export function matches(v: unknown, op: string, want: string): boolean {
  if (op === 'has') return v !== undefined && v !== null && v !== '' && v !== false
  if (op === 'not') return v === undefined || v === null || v === '' || v === false
  if (want === '') return true
  const num = (x: unknown) => (typeof x === 'number' ? x : Number(String(x).replace(/[^\d.-]/g, '')))
  if (op === 'contains')
    return Array.isArray(v) ? v.some((x) => String(x).includes(want)) : String(v ?? '').includes(want)
  if (op === 'eq') return String(v ?? '') === want
  if (op === 'ne') return String(v ?? '') !== want
  const a = num(v)
  const b = num(want)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b
}

/**
 * 결과가 건강한지 (ADR 0020). 문제 목록 (없으면 건강).
 * canary면 목록 줄 수(expect.rows, 기본 1)도 본다. 실사용에서는 0줄이 정상일 수 있어 칸 채움만 본다
 */
export function healthProblems(tool: ConnectorTool, out: Record<string, unknown>, canary = false): string[] {
  const problems: string[] = []
  const lists = Object.entries(tool.output).filter(([, o]) => o.type === 'list')
  const filled = tool.expect?.filled ?? []
  for (const [k] of lists) {
    const rows = Array.isArray(out[k]) ? (out[k] as Record<string, unknown>[]) : []
    const min = tool.expect?.rows ?? 1
    if (canary && rows.length < min) problems.push(`${k}가 ${rows.length}줄이에요 (적어도 ${min}줄)`)
    if (!rows.length) continue
    for (const f of filled) {
      if (!(f in ((tool.output[k] as { fields?: Record<string, unknown> }).fields ?? {}))) continue
      const n = rows.filter((r) => {
        const v = r?.[f]
        return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)
      }).length
      if (n / rows.length < 0.8) problems.push(`${k}.${f} 칸이 ${rows.length}줄 중 ${n}줄만 채워졌어요`)
    }
  }
  for (const f of filled) {
    if (!(f in tool.output) || tool.output[f]?.type === 'list') continue
    const v = out[f]
    if (v === null || v === undefined || v === '') problems.push(`${f} 칸이 비었어요`)
  }
  return problems
}

/** 글에서 marker 뒤 첫 JSON 덩어리({…} 또는 […])를 꺼낸다. 따옴표 안 괄호는 센다에서 뺀다 */
export function jsonAfter(text: string, marker: string): string | undefined {
  const at = text.indexOf(marker)
  if (at < 0) return undefined
  let i = at + marker.length
  while (i < text.length && text[i] !== '{' && text[i] !== '[') i++
  const start = i
  let depth = 0
  let quote = ''
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}
