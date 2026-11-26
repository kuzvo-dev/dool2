// OpenCode v2 config and run environment (ADR 0010).
// Runs only in a Dool2-only folder and can use only Dool2 tools (MCP `dool2`). Measured on OpenCode v2.3.0, 2026-11-14.
import { join } from 'node:path'
import type { McpServerSpec } from '@dool2/engine'
import type { Lang } from '@dool2/i18n'
import type { PaygProvider } from '@dool2/protocol'
import { OPENCODE_TEXT } from './locales/opencode.js'

export const DOOL2_AGENT = 'dool2'
/** OpenCode names MCP tools `<server>_<tool>` */
export const DOOL2_TOOL_PREFIX = 'dool2_'

/** The last matching rule wins: block everything, then open only Dool2 tools */
const PERMISSIONS = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: `${DOOL2_TOOL_PREFIX}*`, resource: '*', effect: 'allow' },
] as const

/** A side job (judge, reviewer) has no tools at all: everything is blocked */
const NO_TOOLS = [{ action: '*', resource: '*', effect: 'deny' }] as const

export interface OpenCodeConfigInput {
  mcpServers: McpServerSpec[]
  systemPrompt: string
  /** A tool-less side job: no MCP servers and no tool allowed */
  sideJob?: boolean
}

export function buildOpenCodeConfig(input: OpenCodeConfigInput) {
  const permissions = input.sideJob ? NO_TOOLS : PERMISSIONS
  const servers = input.sideJob ? [] : input.mcpServers
  return {
    permissions,
    policies: [
      // OpenCode's own free models send the conversation to that company's servers. Use only the provider the user picked
      { action: 'provider.use', resource: 'opencode', effect: 'deny' },
      { action: 'websearch.use', resource: '*', effect: 'deny' },
      { action: 'skill.use', resource: '*', effect: 'deny' },
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      ...servers.map((s) => ({ action: 'mcp.use', resource: s.name, effect: 'allow' })),
    ],
    agents: {
      [DOOL2_AGENT]: {
        mode: 'primary',
        description: 'Dool2',
        system: input.systemPrompt,
        permissions,
      },
      // The built-in agents use shell and file tools, so turn them off
      build: { disabled: true },
      plan: { disabled: true },
      general: { disabled: true },
      explore: { disabled: true },
    },
    default_agent: DOOL2_AGENT,
    share: 'disabled',
    update: 'disable',
    snapshots: false,
    mcp: {
      servers: Object.fromEntries(
        servers.map((s) => [
          s.name,
          {
            type: 'local',
            command: [s.command, ...s.args],
            ...(s.env ? { environment: s.env } : {}),
            // With the default (true), MCP tools are wrapped in one code-execution tool, which the permission rules above block
            codemode: false,
          },
        ]),
      ),
    },
  }
}

/** Environment variable that carries the API key (by OpenCode provider ID) */
export const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

export interface OpenCodeEnvInput {
  /** Dool2-only OpenCode folder (config, data, state and cache all inside) */
  home: string
  password: string
  config: object
  provider: string
  apiKey: string
  base?: NodeJS.ProcessEnv
}

/** Points every folder at Dool2's side so the user's own OpenCode and Claude settings are never read */
export function buildOpenCodeEnv(input: OpenCodeEnvInput): NodeJS.ProcessEnv {
  const keyVar = PROVIDER_ENV[input.provider]
  if (!keyVar) throw new Error(`Unsupported AI provider: ${input.provider}`)
  const base = input.base ?? process.env
  const keep = [
    'PATH',
    'SystemRoot',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const k of keep) if (base[k]) env[k] = base[k]
  return {
    ...env,
    HOME: input.home,
    XDG_CONFIG_HOME: join(input.home, 'config'),
    XDG_DATA_HOME: join(input.home, 'data'),
    XDG_STATE_HOME: join(input.home, 'state'),
    XDG_CACHE_HOME: join(input.home, 'cache'),
    OPENCODE_CONFIG_DIR: join(input.home, 'opencode'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_PASSWORD: input.password,
    [keyVar]: input.apiKey,
  }
}

/** Providers and models people can pick on screen when the live list cannot be read (checked against the OpenCode v2.3.0 model list, 2026-11-26) */
export function paygProviders(lang: Lang = 'ko'): PaygProvider[] {
  const t = OPENCODE_TEXT[lang]
  return [
    // First: one key for many companies' models, the cheap ones included (Dool2 picks GLM)
    {
      id: 'openrouter',
      label: t.openRouter,
      keyUrl: 'https://openrouter.ai/keys',
      // The cheap ones first: people paying per use came for them (first-run test 11-26). The full list with prices
      // comes from the runner and OpenRouter (apps/daemon/src/payg-models.ts); this is what shows when neither answers
      models: [
        { id: '~z-ai/glm-latest', label: `GLM · ${t.recommended}` },
        { id: '~z-ai/glm-flash-latest', label: `GLM Flash · ${t.cheap}` },
        { id: '~deepseek/deepseek-flash-latest', label: `DeepSeek Flash · ${t.cheap}` },
        { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
        { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      models: [
        { id: 'claude-haiku-5-5', label: `Claude Haiku 5.5 · ${t.recommended}` },
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5', label: `Claude Opus 5.5 · ${t.smartest}` },
      ],
    },
    {
      id: 'openai',
      label: 'OpenAI (GPT)',
      keyUrl: 'https://platform.openai.com/api-keys',
      models: [
        { id: 'gpt-5.4-mini', label: `GPT-5.4 mini · ${t.recommended}` },
        { id: 'gpt-5.6', label: 'GPT-5.6' },
      ],
    },
    {
      id: 'google',
      label: 'Google (Gemini)',
      keyUrl: 'https://aistudio.google.com/apikey',
      models: [{ id: 'gemini-3.8-flash', label: `Gemini 3.8 Flash · ${t.recommended}` }],
    },
  ]
}

/** The provider list in Korean (kept for callers written before ADR 0029) */
export const PAYG_PROVIDERS: PaygProvider[] = paygProviders('ko')
