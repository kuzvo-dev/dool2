// Tools on demand (ADR 0033). Every tool the AI can see is sent with every request, schema and all. Some Dool2
// tools are used a few times a week (videos, the picture AI, PDF merge, printing, moving files) yet their long
// descriptions rode along on every turn. These are kept off the visible list: tool_find shows them (with their input)
// and tool_call runs them through the very same handler, so the daemon, the approval gate and the records see exactly
// what they would see if the tool had been called directly.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * Picked from 6 days of the work log (2,771 turns, 2026-11-19 to 11-24): used 0 to 15 times, and not part of a
 * payment, approval, login or hand-off flow (those stay visible so they are never a step away)
 */
export const ON_DEMAND_TOOLS = [
  'video_style',
  'video_clip',
  'video_motion',
  'video_make',
  'image_make',
  'file_move',
  'file_convert',
  'file_print',
  'file_pdf',
  'file_trash',
  'file_download',
  'pc_screen',
  'browser_hover',
  'browser_upload',
  'show_route',
  'goal_delete',
] as const

interface Held {
  title: string
  description: string
  // biome-ignore lint/suspicious/noExplicitAny: zod input shape of the MCP SDK
  inputSchema: Record<string, any>
  // biome-ignore lint/suspicious/noExplicitAny: MCP tool handler
  handler: (args: any, extra: any) => any
}

/**
 * Wraps the server: registering a tool in ON_DEMAND_TOOLS holds it instead of listing it. Call `finish()` after all
 * tools are registered to add tool_find and tool_call
 */
export function onDemand(server: McpServer, names: readonly string[] = ON_DEMAND_TOOLS) {
  const want = new Set(names)
  const held = new Map<string, Held>()
  const proxy = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool')
        // biome-ignore lint/suspicious/noExplicitAny: same signature as McpServer.registerTool
        return (name: string, config: any, handler: any) => {
          if (!want.has(name)) return target.registerTool(name, config, handler)
          held.set(name, {
            title: config.title ?? name,
            description: config.description ?? '',
            inputSchema: config.inputSchema ?? {},
            handler,
          })
          return undefined
        }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as McpServer

  const finish = () => {
    if (!held.size) return
    const index = [...held].map(([n, h]) => `${n} (${h.title})`).join(', ')
    server.registerTool(
      'tool_find',
      {
        title: 'Find more Dool2 tools',
        description:
          `Dool2 has more tools than the ones listed, kept aside because they are used less often: ${index}. ` +
          'When a request needs one (a video, a picture made by the image AI, merging or splitting PDFs, printing, moving, converting or restoring files, downloading, locking the PC, a route map, uploading a file to a site, deleting a goal), ' +
          'call this with its name or a few words to get its full description and input, then run it with tool_call. When another tool\'s description or result names one of these (e.g. "use image_make"), it means this way. Never say Dool2 cannot do these.',
        inputSchema: {
          query: z
            .string()
            .max(80)
            .optional()
            .describe(
              'Tool name or words (e.g. "video_motion", "pdf", "print"). Empty = all of them, briefly',
            ),
        },
        annotations: { readOnlyHint: true },
      },
      async (args: { query?: string }) => {
        const q = (args.query ?? '').trim().toLowerCase()
        const hits = [...held].filter(
          ([n, h]) => !q || n === q || `${n} ${h.title} ${h.description}`.toLowerCase().includes(q),
        )
        if (!hits.length)
          return { content: [{ type: 'text' as const, text: `No such tool. These are available: ${index}` }] }
        const full = hits.length <= 3
        const text = hits
          .map(([n, h]) =>
            full
              ? `## ${n} — ${h.title}\n${h.description}\nInput (JSON schema): ${JSON.stringify(z.toJSONSchema(z.object(h.inputSchema)))}`
              : `- ${n} — ${h.title}`,
          )
          .join('\n\n')
        return {
          content: [
            {
              type: 'text' as const,
              text: full
                ? `${text}\n\nRun it with tool_call({ tool: '<name>', input: { … } }).`
                : `${text}\n\nCall tool_find with one name to see its description and input.`,
            },
          ],
        }
      },
    )
    server.registerTool(
      'tool_call',
      {
        title: 'Run a Dool2 tool found with tool_find',
        description:
          'Runs one of the tools kept aside (see tool_find) with its input, exactly as if it were called directly: the same approvals and records apply. Look at its input with tool_find first.',
        inputSchema: {
          tool: z.string().max(60).describe('Tool name from tool_find (e.g. "file_pdf")'),
          input: z.record(z.string(), z.unknown()).optional().describe('Its input, as tool_find describes'),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: MCP handler extra
      async (args: { tool: string; input?: Record<string, unknown> }, extra: any) => {
        const h = held.get(args.tool)
        if (!h)
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `No such tool: ${args.tool}. These are available: ${index}` },
            ],
          }
        const parsed = z.object(h.inputSchema).safeParse(args.input ?? {})
        if (!parsed.success)
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Fix the input for ${args.tool}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}. See tool_find('${args.tool}').`,
              },
            ],
          }
        return h.handler(parsed.data, extra)
      },
    )
  }
  return { server: proxy, finish, held }
}
