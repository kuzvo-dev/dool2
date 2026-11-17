// 두리 스킬: 한국 서비스를 끝까지 처리하는 방법을 적은 문서 (skills/<id>/SKILL.md, CC BY-SA 4.0).
// 에이전트의 스킬 기능을 쓰지 않고 두리 도구(skill_find, skill_read)로 준다. 그래야 어느 AI든 같은 스킬을 쓴다
// (docs/architecture.md 3.1). 스킬은 읽을거리일 뿐, 승인 게이트는 스킬 밖 코드가 지킨다.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONNECT_CATEGORIES,
  type ConnectCard,
  ConnectCardSchema,
  type ConnectionItem,
} from '@dool2/protocol/connect'
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

const HOW: Record<ConnectCard['how'], string> = {
  browser: '사용자 Chrome에서 로그인해 두고 씀',
  official: '공식 연동 (준비 전엔 사용자 Chrome에서)',
  open: '로그인 없이',
  device: '폰 권한',
}

/** 절차 문서가 없는 서비스: 카드에 적힌 할 수 있는 일을 AI가 읽을 글로 */
export function cardForAgent(card: ConnectCard, connectedAt?: string): string {
  const lines = [
    `# ${card.name}${card.site ? ` (${card.site})` : ''}`,
    '',
    `- 분류: ${CONNECT_CATEGORIES[card.category]} · 연결 방식: ${HOW[card.how]}${card.login ? ` · 로그인: ${card.login}` : ''}`,
    `- 연결: ${connectedAt ? `사용자가 연결함(${connectedAt.slice(0, 10)})` : card.how === 'browser' || card.how === 'official' ? '아직 연결 안 함 — 로그인이 풀려 있으면 browser_request_login이나 browser_handoff로 사람에게' : '필요 없음'}`,
    '',
    card.summary,
    '',
    '## 할 수 있는 일 (등급)',
    ...card.abilities.map((a) => `- [${a.tier}] ${a.title} — 예: "${a.say}"`),
    '',
    '절차 문서(SKILL.md)는 아직 없어요. 일반적인 방법으로 하되 등급을 지키고, 캡차·본인인증·막히는 곳은 사람에게 넘겨 주세요(browser_handoff).',
  ]
  return lines.join('\n')
}

export class Skills {
  /** 마지막으로 읽은 서비스 목록 (지침에 넣는 서비스 지도는 동기라 이것을 쓴다) */
  private last: ConnectionItem[] = []
  constructor(
    private readonly dir: string | undefined,
    /** 연결을 마친 서비스 id → 시각 (설정) */
    private readonly connected: () => Record<string, string> = () => ({}),
    /** 서비스 도구(tools.json) 상태 요약 (ADR 0018) */
    private readonly connector?: (id: string) => Promise<{ status?: string; tools?: string[] }>,
  ) {}

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

  /** 이 주소의 사이트에 절차(SKILL.md)가 있으면 그 스킬. 브라우저로 사이트를 열 때 요령을 먼저 읽게 알린다 */
  async forUrl(url: string): Promise<SkillInfo | undefined> {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return undefined
    }
    for (const info of await this.list()) {
      const site = (await this.card(info.name))?.site
      if (site && (host === site || host.endsWith(`.${site}`))) return info
    }
    return undefined
  }

  /** 연결 카드 (형식이 틀린 카드는 건너뛴다. 레포 테스트가 미리 잡는다) */
  async card(name: string): Promise<ConnectCard | undefined> {
    if (!this.dir || !NAME.test(name)) return undefined
    const raw = await readFile(join(this.dir, name, 'connect.json'), 'utf8').catch(() => undefined)
    if (!raw) return undefined
    try {
      const r = ConnectCardSchema.safeParse(JSON.parse(raw))
      return r.success && r.data.id === name ? r.data : undefined
    } catch {
      return undefined
    }
  }

  /** 연결 화면 목록: 카드가 있는 서비스 전부 (분류 순서, 같은 분류 안에서는 폴더 순서) */
  async connections(): Promise<ConnectionItem[]> {
    if (!this.dir) return []
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => NAME.test(n)).sort()
    const skills = new Map((await this.list()).map((s) => [s.name, s.status]))
    const connected = this.connected()
    const order = Object.keys(CONNECT_CATEGORIES)
    const out: ConnectionItem[] = []
    for (const n of names) {
      const card = await this.card(n)
      if (!card) continue
      const c = (await this.connector?.(n).catch(() => undefined)) ?? {}
      const skill = c.status ?? skills.get(n)
      const at = connected[n]
      out.push({
        card,
        ...(skill ? { skill } : {}),
        ...(c.tools?.length ? { tools: c.tools } : {}),
        ...(at ? { connectedAt: at } : {}),
      })
    }
    const sorted = out.sort((x, y) => order.indexOf(x.card.category) - order.indexOf(y.card.category))
    this.last = sorted
    return sorted
  }

  /**
   * AI 지침에 넣는 서비스 지도: 서비스 이름이 없는 부탁("기념일 식당 찾아 줘")에도 맞는 서비스를 고르게.
   * 분류마다 "이름(id)✓: 할 수 있는 일" 한 줄. ✓ = 연결됨 (로그인돼 있어 예약·주문까지 된다)
   */
  serviceMap(): string {
    const connected = this.connected()
    const by = new Map<string, string[]>()
    for (const it of this.last) {
      if (it.card.how === 'device') continue
      const c = it.card
      const can = c.abilities.map((a) => a.title).join('·')
      // 무엇을 하는 곳인지(소개)와 할 수 있는 일: AI가 부탁에 맞는 서비스를 스스로 고른다
      const line = `${c.name}(${c.id})${connected[c.id] ? '✓' : ''} — ${c.summary} [${can}]`
      const k = CONNECT_CATEGORIES[c.category]
      by.set(k, [...(by.get(k) ?? []), line])
    }
    if (!by.size) return ''
    return [
      '## 쓸 수 있는 서비스 (✓ = 연결됨, [ ] = 할 수 있는 일)',
      '부탁에 서비스 이름이 없어도 아래에서 그 일을 가장 잘 끝낼 수 있는 서비스를 직접 골라요.',
      ...[...by].map(([k, lines]) => `### ${k}\n${lines.map((l) => `- ${l}`).join('\n')}`),
    ].join('\n')
  }

  /** 두리 도구: skill_find, skill_read */
  async run(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const text = (t: string, isError = false): ToolResult => ({
      content: [{ type: 'text', text: t }],
      ...(isError ? { isError: true } : {}),
    })
    if (tool === 'find') {
      const all = await this.connections()
      // 카드 없이 절차만 있는 스킬도 찾을 수 있게
      const skills = await this.list()
      const query = String(a.query ?? '').toLowerCase()
      const words = query.split(/\s+/).filter((w) => w.length > 0)
      // 이름·도메인에 맞으면 크게, 소개·할 수 있는 일에 맞으면 작게. 절차가 있는 서비스를 앞으로
      const score = (it: ConnectionItem) => {
        const head = [it.card.id, it.card.name, it.card.site ?? ''].join(' ').toLowerCase()
        const body = [
          it.card.summary,
          CONNECT_CATEGORIES[it.card.category],
          skills.find((s) => s.name === it.card.id)?.description ?? '',
          ...it.card.abilities.flatMap((x) => [x.title, x.say]),
        ]
          .join(' ')
          .toLowerCase()
        const n = words.reduce((sum, w) => sum + (head.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0)
        return n > 0 ? n + (it.skill ? 2 : 0) + (it.connectedAt ? 3 : 0) : 0
      }
      const hit = (
        words.length === 0
          ? all
          : all
              .map((it) => ({ it, n: score(it) }))
              .filter((x) => x.n > 0)
              .sort((x, y) => y.n - x.n)
              .map((x) => x.it)
      ).slice(0, 10)
      const loose = skills.filter(
        (s) =>
          !all.some((it) => it.card.id === s.name) &&
          (words.length === 0 || words.some((w) => `${s.name} ${s.description}`.toLowerCase().includes(w))),
      )
      if (!hit.length && !loose.length)
        return text(
          '맞는 스킬이 없어요. 일반적인 방법으로 하되, 막히면 사람에게 넘겨 주세요. (서비스 목록: ' +
            (all.map((it) => it.card.id).join(', ') || '없음') +
            ')',
        )
      const line = (it: ConnectionItem) => {
        const tags = [
          it.connectedAt
            ? '연결됨'
            : it.card.how === 'browser' || it.card.how === 'official'
              ? '연결 전'
              : undefined,
          it.skill ? `절차 ${it.skill}` : '절차 없음',
        ].filter(Boolean)
        return `- ${it.card.id} ${it.card.name} [${tags.join(', ')}]: ${it.card.summary}`
      }
      return text(
        [
          ...hit.slice(0, 15).map(line),
          ...loose.map((s) => `- ${s.name} [${s.status}]: ${s.description}`),
        ].join('\n'),
      )
    }
    if (tool === 'read') {
      const name = String(a.name ?? '')
      const body = await this.read(name)
      if (body) return text(body)
      const card = await this.card(name)
      if (card) return text(cardForAgent(card, this.connected()[name]))
      return text('그런 스킬이 없어요. skill_find로 이름을 확인해 주세요.', true)
    }
    return text(`모르는 스킬 도구예요: ${tool}`, true)
  }
}
