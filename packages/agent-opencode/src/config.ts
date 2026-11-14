// OpenCode v2 설정과 실행 환경 (ADR 0010).
// 두리 전용 폴더에서만 돌고, 두리 도구(MCP `dool2`)만 쓸 수 있게 묶는다. 실측: OpenCode v2.3.0, 2026-11-14.
import { join } from 'node:path'
import type { McpServerSpec } from '@dool2/engine'

export const DOOL2_AGENT = 'dool2'
/** OpenCode는 MCP 도구 이름을 `<서버>_<도구>`로 만든다 */
export const DOOL2_TOOL_PREFIX = 'dool2_'

/** 마지막에 맞는 규칙이 이긴다: 모두 막고 두리 도구만 연다 */
const PERMISSIONS = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: `${DOOL2_TOOL_PREFIX}*`, resource: '*', effect: 'allow' },
] as const

export interface OpenCodeConfigInput {
  mcpServers: McpServerSpec[]
  systemPrompt: string
}

export function buildOpenCodeConfig(input: OpenCodeConfigInput) {
  return {
    permissions: PERMISSIONS,
    policies: [
      // OpenCode 자체 무료 모델은 대화를 그 회사 서버로 보낸다. 사용자가 고른 제공자만 쓴다
      { action: 'provider.use', resource: 'opencode', effect: 'deny' },
      { action: 'websearch.use', resource: '*', effect: 'deny' },
      { action: 'skill.use', resource: '*', effect: 'deny' },
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      ...input.mcpServers.map((s) => ({ action: 'mcp.use', resource: s.name, effect: 'allow' })),
    ],
    agents: {
      [DOOL2_AGENT]: {
        mode: 'primary',
        description: '두리',
        system: input.systemPrompt,
        permissions: PERMISSIONS,
      },
      // 기본 에이전트들은 셸·파일 도구를 쓰므로 끈다
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
        input.mcpServers.map((s) => [
          s.name,
          {
            type: 'local',
            command: [s.command, ...s.args],
            ...(s.env ? { environment: s.env } : {}),
            // 기본값(true)이면 MCP 도구를 코드 실행 도구 하나로 감싸서, 위 권한 규칙에 막힌다
            codemode: false,
          },
        ]),
      ),
    },
  }
}

/** API 키를 넘길 환경 변수 이름 (OpenCode 제공자 ID 기준) */
export const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

export interface OpenCodeEnvInput {
  /** 두리 전용 OpenCode 폴더 (설정·데이터·상태·캐시를 모두 이 안에) */
  home: string
  password: string
  config: object
  provider: string
  apiKey: string
  base?: NodeJS.ProcessEnv
}

/** 사용자 본인의 OpenCode·Claude 설정을 읽지 않게, 모든 폴더를 두리 쪽으로 돌린다 */
export function buildOpenCodeEnv(input: OpenCodeEnvInput): NodeJS.ProcessEnv {
  const keyVar = PROVIDER_ENV[input.provider]
  if (!keyVar) throw new Error(`지원하지 않는 AI 제공자예요: ${input.provider}`)
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
