// 서비스 도구 (ADR 0018): 서비스마다 타입 있는 도구 (catchtable_search, cj_logistics_track …).
// 두리 본체가 skills/<id>/tools.json을 읽어 실행한다. 이 서버는 본체가 알려 준 도구를 MCP 도구로 내보일 뿐이다.
//
// - 연결한 서비스(+로그인 없는 서비스)의 도구는 바로 보인다. 연결이 바뀌면 목록을 새로 알린다(tools/list_changed).
// - 나머지 서비스는 service_find로 찾고 service_call로 부른다 (도구 300개를 한꺼번에 내밀지 않는다).
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserClient, ToolResult } from './browser.js'

/** 본체가 알려 주는 도구 모양 (apps/daemon connectors.ts의 ServiceToolSpec) */
export interface ServiceToolSpec {
  name: string
  title: string
  description: string
  input: {
    properties: Record<
      string,
      {
        type: 'string' | 'integer' | 'number' | 'boolean'
        description: string
        enum?: string[]
        format?: 'date' | 'time'
        pattern?: string
        minimum?: number
        maximum?: number
        maxLength?: number
        default?: string | number | boolean
      }
    >
    required: string[]
  }
  output: Record<
    string,
    | { type: 'string' | 'integer' | 'number' | 'boolean' | 'strings'; description?: string }
    | {
        type: 'list'
        description?: string
        fields: Record<
          string,
          { type: 'string' | 'integer' | 'number' | 'boolean' | 'strings'; description?: string }
        >
      }
  >
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

type Prop = ServiceToolSpec['input']['properties'][string]

/** 입력 칸 → zod (MCP SDK가 JSON 스키마로 바꿔 AI에게 보인다) */
export function inputShape(input: ServiceToolSpec['input']): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {}
  for (const [k, p] of Object.entries(input.properties)) {
    let t: z.ZodType = prop(p)
    if (!input.required.includes(k)) t = t.optional()
    shape[k] = t.describe(p.description)
  }
  return shape
}

function prop(p: Prop): z.ZodType {
  if (p.type === 'boolean') return z.boolean()
  if (p.type === 'integer' || p.type === 'number') {
    let n = p.type === 'integer' ? z.number().int() : z.number()
    if (p.minimum !== undefined) n = n.min(p.minimum)
    if (p.maximum !== undefined) n = n.max(p.maximum)
    return n
  }
  if (p.enum?.length) return z.enum(p.enum as [string, ...string[]])
  let s = z.string()
  if (p.format === 'date') s = s.regex(/^\d{4}-\d{2}-\d{2}$/)
  else if (p.format === 'time') s = s.regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  else if (p.pattern) s = s.regex(new RegExp(p.pattern))
  if (p.maxLength) s = s.max(p.maxLength)
  return s
}

/** 출력 칸 → zod. 사이트에 따라 비는 칸이 있어 모두 비어도 되게 둔다 */
export function outputShape(output: ServiceToolSpec['output']): z.ZodRawShape {
  const scalar = (type: string) =>
    (type === 'strings'
      ? z.array(z.string())
      : type === 'number' || type === 'integer'
        ? z.number()
        : type === 'boolean'
          ? z.boolean()
          : z.string()
    ).nullable()
  const shape: Record<string, z.ZodType> = {}
  for (const [k, f] of Object.entries(output)) {
    const t =
      f.type === 'list'
        ? z.array(
            z.object(
              Object.fromEntries(
                Object.entries(f.fields).map(([kk, ff]) => [kk, scalar(ff.type).optional()]),
              ),
            ),
          )
        : scalar(f.type)
    shape[k] = (f.description ? t.describe(f.description) : t).optional()
  }
  return shape
}

/**
 * 본체 결과를 MCP 결과로. 구조화 결과가 있으면 AI는 글 대신 그걸 본다(실측: 구글 캘린더 넘기기 도구가 "{}"만 보여
 * AI가 "화면이 열렸는지 확인이 안 돼요"라고 했다). 그래서 출력 칸이 없는 도구는 구조화 결과를 빼고,
 * 출력 칸이 있는데 비어 온 결과(넘기기·멈춤)는 글을 text 칸에 담는다
 */
export const pass = (r: ToolResult & { structuredContent?: Record<string, unknown> }, hasOutput = true) => {
  const sc = r.structuredContent
  const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  const structured = !hasOutput || r.isError || !sc ? undefined : Object.keys(sc).length ? sc : { text }
  return {
    content: r.content,
    ...(structured ? { structuredContent: structured } : {}),
    ...(r.isError ? { isError: true } : {}),
  }
}

export interface ServiceTools {
  /** 본체에 바로 보일 도구를 다시 묻고 MCP 도구 목록을 맞춘다 */
  sync(): Promise<void>
  /** 지금 내보인 서비스 도구 이름 */
  names(): string[]
  stop(): void
}

export function registerServiceTools(
  server: McpServer,
  client: BrowserClient,
  opts: { pollMs?: number } = {},
): ServiceTools {
  const registered = new Map<string, { key: string; tool: RegisteredTool }>()
  let syncing: Promise<void> | undefined

  const sync = async () => {
    const r = (await client('catalog', {}).catch(() => undefined)) as unknown as
      | { tools?: ServiceToolSpec[] }
      | undefined
    if (!r || !Array.isArray(r.tools)) return
    const want = new Map(r.tools.map((t) => [t.name, t]))
    for (const [name, reg] of registered) {
      if (want.has(name)) continue
      reg.tool.remove()
      registered.delete(name)
    }
    for (const spec of want.values()) {
      const key = JSON.stringify(spec)
      const old = registered.get(spec.name)
      if (old?.key === key) continue
      old?.tool.remove()
      const hasOutput = Object.keys(spec.output ?? {}).length > 0
      try {
        const tool = server.registerTool(
          spec.name,
          {
            title: spec.title,
            description: spec.description,
            inputSchema: inputShape(spec.input),
            ...(hasOutput
              ? { outputSchema: { ...outputShape(spec.output), text: z.string().optional() } }
              : {}),
            annotations: { title: spec.title, ...spec.annotations },
          },
          async (args: Record<string, unknown>) =>
            pass(await client('call', { tool: spec.name, input: args }), hasOutput),
        )
        registered.set(spec.name, { key, tool })
      } catch (e) {
        // 형식이 틀린 도구 하나 때문에 나머지를 못 쓰면 안 된다
        console.error(`[두리] 서비스 도구 ${spec.name}을(를) 올리지 못했어요: ${(e as Error).message}`)
      }
    }
  }
  const once = () => {
    syncing ??= sync().finally(() => {
      syncing = undefined
    })
    return syncing
  }

  server.registerTool(
    'service_find',
    {
      title: '서비스 찾기',
      description:
        '부탁을 처리할 서비스(식당 예약, 택배 조회, 장보기, 기차 예매 등)와 그 서비스의 두리 도구를 찾는다. ' +
        '서비스마다 연결 여부, 도구 이름·등급·입력 칸, 연결하면 할 수 있는 일을 알려 준다. ' +
        '바로 보이는 도구 목록에 맞는 도구가 없을 때 먼저 쓴다. 도구가 없는 서비스면 브라우저 도구로 하는 요령을 준다.',
      inputSchema: {
        query: z
          .string()
          .max(100)
          .describe('서비스 이름이나 할 일 (예: "캐치테이블", "택배 조회", "성수 저녁 예약")'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      void once()
      return pass(await client('find', args), false)
    },
  )
  server.registerTool(
    'service_call',
    {
      title: '서비스 도구 쓰기',
      description:
        'service_find로 찾은 서비스 도구를 부른다 (바로 보이는 도구 목록에 그 도구가 없을 때). ' +
        '결제·예약 확정·보내기는 이 도구로도 사용자 승인 없이는 하지 않는다.',
      inputSchema: {
        tool: z.string().max(60).describe('도구 이름 (예: "catchtable_search")'),
        input: z.record(z.string(), z.unknown()).describe('그 도구의 입력 (service_find가 알려 준 칸)'),
      },
      annotations: { openWorldHint: true },
    },
    // 출력 칸이 도구마다 달라 구조화 결과는 넘기지 않는다 (글에 같은 내용이 줄로 들어 있다)
    async (args) => pass(await client('call', args), false),
  )

  const timer = setInterval(() => void once(), opts.pollMs ?? 30_000)
  timer.unref?.()
  return { sync: once, names: () => [...registered.keys()], stop: () => clearInterval(timer) }
}
