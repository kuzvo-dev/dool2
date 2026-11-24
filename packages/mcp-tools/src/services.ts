// Service tools (ADR 0018): typed tools per service (catchtable_search, cj_logistics_track …).
// The Dool2 daemon reads skills/<id>/tools.json and runs them. This server only exposes the tools the daemon reports as MCP tools.
//
// - Tools of connected services (plus services without login) are visible right away. The list is fixed for a segment
//   (ADR 0032): a service connected meanwhile is used through service_call until the next segment.
// - Other services are found with service_find and called with service_call (we do not push 300 tools at once).
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserClient, ToolResult } from './browser.js'

/** Tool shape reported by the daemon (ServiceToolSpec in apps/daemon connectors.ts) */
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

/** Input fields → zod (the MCP SDK turns it into JSON Schema for the AI) */
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

/** Output fields → zod. Some sites leave fields empty, so every field may be empty */
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
 * Daemon result → MCP result. When there is a structured result the AI reads it instead of the text (measured: the
 * Google Calendar hand-off tool showed only "{}" and the AI said it could not tell whether the screen opened). So tools
 * without output fields drop the structured result, and an empty result from a tool with output fields (hand-off, stop)
 * carries the text in a `text` field.
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
  /** Asks the daemon again for the directly visible tools and syncs the MCP tool list */
  sync(): Promise<void>
  /** Names of the service tools exposed now */
  names(): string[]
  stop(): void
}

export function registerServiceTools(
  server: McpServer,
  client: BrowserClient,
  opts: { pollMs?: number; toolset?: string } = {},
): ServiceTools {
  const registered = new Map<string, { key: string; tool: RegisteredTool }>()
  let syncing: Promise<void> | undefined

  const sync = async () => {
    const r = (await client('catalog', opts.toolset ? { toolset: opts.toolset } : {}).catch(
      () => undefined,
    )) as unknown as { tools?: ServiceToolSpec[] } | undefined
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
        // One malformed tool must not make the rest unusable
        console.error(`[dool2] Could not register service tool ${spec.name}: ${(e as Error).message}`)
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
      title: 'Find a service',
      description:
        'Finds services that can handle the request (restaurant booking, parcel tracking, grocery shopping, train tickets, etc.) and their Dool2 tools. ' +
        'For each service it tells whether it is connected, the tool names, tiers and input fields, and what becomes possible once connected. ' +
        'Use this first when no tool in the directly visible list fits. For a service without tools it gives tips for doing the job with the browser tools.',
      inputSchema: {
        query: z
          .string()
          .max(100)
          .describe(
            'Service name or task, in the user\'s words (e.g. "CatchTable", "parcel tracking", "dinner booking in Seongsu")',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      void once()
      return pass(await client('find', args), false)
    },
  )
  server.registerTool(
    'orders_all',
    {
      title: 'All my orders',
      description:
        'Reads recent orders and delivery status from all connected shopping sites (Coupang, Naver Pay, Gmarket, 11st, etc.) at once. ' +
        "When it is unclear which shop is meant ('where is my parcel', 'the box arrived crushed', 'return what I bought last week', 'when does it arrive'), " +
        'use this first instead of calling each shop\'s order tool separately. Do not check just one shop and then ask "where did you buy it?".',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => pass(await client('orders_all', {}), false),
  )
  server.registerTool(
    'service_call',
    {
      title: 'Use a service tool',
      description:
        'Calls a service tool found with service_find (when that tool is not in the directly visible list). ' +
        "Payments, booking confirmations and sending are never done without the user's approval, through this tool either.",
      inputSchema: {
        tool: z.string().max(60).describe('Tool name (e.g. "catchtable_search")'),
        input: z
          .record(z.string(), z.unknown())
          .describe('Input for that tool (the fields service_find reported)'),
      },
      annotations: { openWorldHint: true },
    },
    // Output fields differ per tool, so no structured result is passed (the text has the same content line by line)
    async (args) => pass(await client('call', args), false),
  )

  const timer = setInterval(() => void once(), opts.pollMs ?? 30_000)
  timer.unref?.()
  return { sync: once, names: () => [...registered.keys()], stop: () => clearInterval(timer) }
}
