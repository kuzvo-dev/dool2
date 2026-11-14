// 두리 스킬: 한국 서비스를 끝까지 처리하는 방법을 적은 문서 (skills/<id>/SKILL.md, CC BY-SA 4.0).
// 에이전트의 스킬 기능을 쓰지 않고 두리 도구(skill_find, skill_read)로 준다. 그래야 어느 AI든 같은 스킬을 쓴다
// (docs/architecture.md 3.1). 스킬은 읽을거리일 뿐, 승인 게이트는 스킬 밖 코드가 지킨다.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolResult } from './browser-tools.js'

export interface SkillInfo {
  name: string
  description: string
  /** 초안 / 검증됨(날짜) / 막힘(사유) */
  status: string
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const TIERS = ['찾아보기', '채워 두기', '돈 내기', '연락하기']

export function parseSkill(text: string): SkillInfo | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fm?.[1]) return undefined
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1] ?? '')?.[1]?.trim()
  const name = field('name')
  const description = field('description')
  if (!name || !description) return undefined
  const status = /^\|\s*상태\s*\|\s*([^|]+?)\s*\|/m.exec(text)?.[1] ?? '초안'
  return { name, description, status }
}

/** 스킬 안전 규칙 (skills/README.md). 문제 목록을 돌려준다 */
export function validateSkill(dir: string, text: string): string[] {
  const problems: string[] = []
  const info = parseSkill(text)
  if (!info) return ['맨 위에 name·description이 없어요']
  if (info.name !== dir) problems.push(`name(${info.name})이 폴더 이름(${dir})과 달라요`)
  if (!/^(초안|검증됨\(\d{4}-\d{2}-\d{2}[^)]*\)|막힘\(.+\))$/.test(info.status))
    problems.push(`상태는 초안 / 검증됨(YYYY-MM-DD) / 막힘(사유) 중 하나여야 해요: ${info.status}`)
  const steps = text.split(/^## 절차$/m)[1]?.split(/^## /m)[0] ?? ''
  if (!steps.trim()) problems.push('## 절차가 없어요')
  for (const line of steps.split('\n')) {
    if (!/^- /.test(line)) continue
    const tier = /^- \[([^\]]+)\]/.exec(line)?.[1]
    if (!tier || !TIERS.includes(tier)) problems.push(`단계에 권한 등급이 없어요: ${line.slice(0, 40)}`)
  }
  // 금지 지시: 캡차·본인인증 우회, 비밀값 입력
  const banned = [
    /(캡차|보안\s*문자|자동입력\s*방지|captcha|본인\s*인증|인증번호)[^\n]{0,20}(풀|우회|입력해|넣어|자동으로)/i,
    /(비밀번호|카드\s*번호|cvc|공동인증서\s*암호)[^\n]{0,15}(입력|넣)(?![^\n]*(사람|사용자|넘긴|하지 않))/i,
  ]
  for (const re of banned) {
    const m = re.exec(text)
    if (m) problems.push(`금지된 지시가 있어요: "${m[0]}" — 사람에게 넘기는 방식으로 적어 주세요`)
  }
  return problems
}

export class Skills {
  constructor(private readonly dir: string | undefined) {}

  async list(): Promise<SkillInfo[]> {
    if (!this.dir) return []
    const names = await readdir(this.dir).catch(() => [] as string[])
    const out: SkillInfo[] = []
    for (const n of names.sort()) {
      if (!NAME.test(n)) continue
      const text = await readFile(join(this.dir, n, 'SKILL.md'), 'utf8').catch(() => undefined)
      const info = text ? parseSkill(text) : undefined
      if (info) out.push(info)
    }
    return out
  }

  async read(name: string): Promise<string | undefined> {
    if (!this.dir || !NAME.test(name)) return undefined
    return readFile(join(this.dir, name, 'SKILL.md'), 'utf8').catch(() => undefined)
  }

  /** 두리 도구: skill_find, skill_read */
  async run(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const text = (t: string, isError = false): ToolResult => ({
      content: [{ type: 'text', text: t }],
      ...(isError ? { isError: true } : {}),
    })
    if (tool === 'find') {
      const all = await this.list()
      const words = String(a.query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0)
      const hit = all.filter((s) => {
        const hay = `${s.name} ${s.description}`.toLowerCase()
        return words.length === 0 || words.some((w) => hay.includes(w))
      })
      if (!hit.length)
        return text(
          '맞는 스킬이 없어요. 일반적인 방법으로 하되, 막히면 사람에게 넘겨 주세요. (스킬 목록: ' +
            (all.map((s) => s.name).join(', ') || '없음') +
            ')',
        )
      return text(hit.map((s) => `- ${s.name} [${s.status}]: ${s.description}`).join('\n'))
    }
    if (tool === 'read') {
      const body = await this.read(String(a.name ?? ''))
      if (!body) return text('그런 스킬이 없어요. skill_find로 이름을 확인해 주세요.', true)
      return text(body)
    }
    return text(`모르는 스킬 도구예요: ${tool}`, true)
  }
}
