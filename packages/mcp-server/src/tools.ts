// Advertise Dool2's few tools (@dool2/core TOOLS) to an MCP client in the shape `tools/list` returns: a name, the
// one-line description the model reads, and a JSON Schema for the arguments. The schemas mirror exactly what the
// engine's tool handler reads off each call (`code.code`, `ask.question`, `approve.label`, `task.title`, memory's
// free-form op), so a call the CLI makes maps straight onto a @dool2/core ToolCall with no guessing.

import type { ToolName, ToolSpec } from '@dool2/core'

/** A JSON Schema object, kept loose — we only ever emit plain object schemas here. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** One entry of an MCP `tools/list` response. */
export interface McpToolDef {
  name: string
  description: string
  inputSchema: JsonSchema
}

/** The argument schema for each tool, matching what the engine handler reads. */
const SCHEMAS: Record<ToolName, JsonSchema> = {
  code: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'JavaScript/TypeScript to run in the sandbox. The page/vault/pc/fs hands are in scope; acting calls pass the autonomy gate.',
      },
    },
    required: ['code'],
    additionalProperties: false,
  },
  ask: {
    type: 'object',
    properties: { question: { type: 'string', description: 'The question to put to the user.' } },
    required: ['question'],
    additionalProperties: false,
  },
  approve: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'What the user is approving, e.g. "Send 50,000 won".' },
    },
    required: ['label'],
    additionalProperties: false,
  },
  task: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short title for the background task or subagent.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  memory: {
    type: 'object',
    properties: {
      op: { type: 'string', description: 'search or write.' },
      text: { type: 'string', description: 'The query to search, or the note to write.' },
    },
    additionalProperties: true,
  },
}

/** Turn the shared TOOLS list into MCP tool defs with argument schemas. */
export function mcpToolDefs(tools: readonly ToolSpec[]): McpToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: SCHEMAS[t.name],
  }))
}
