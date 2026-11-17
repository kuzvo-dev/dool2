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

/**
 * 일 낱말 → 서비스 카드에 쓰인 말. "기념일 식당 찾아 줘"처럼 서비스 이름이 없어도 맞는 서비스를 찾게 한다
 */
const TASK_WORDS: [RegExp, string[]][] = [
  [
    /식당|맛집|레스토랑|기념일|데이트|회식|점심|저녁|오마카세|파인다이닝|룸\s?식당/,
    ['식당', '예약', '갈 만한 곳'],
  ],
  [/영화|상영|극장/, ['영화', '예매']],
  [/공연|뮤지컬|콘서트|연극|전시|티켓/, ['공연', '예매']],
  [/숙소|호텔|펜션|리조트|모텔|게스트하우스|에어비앤비|캠핑/, ['숙소', '예약']],
  [/비행기|항공|항공권|공항/, ['항공', '항공권']],
  [/장보기|우유|계란|과일|채소|반찬|생필품|식료품|새벽\s?배송/, ['장보기', '주문']],
  [/배달|치킨|피자|야식/, ['배달', '주문']],
  [/옷|신발|코디|패션|화장품|뷰티/, ['패션', '뷰티', '주문']],
  [/택배|배송\s?조회|송장/, ['택배', '배송']],
  [/책|도서|전자책/, ['책', '주문']],
  [/요금|데이터|휴대폰\s?요금|통신/, ['요금', '통신']],
  [/메일|일정|캘린더|회의/, ['메일', '일정']],
  [/로또|복권/, ['로또']],
]

export class Skills {
  /** 마지막으로 읽은 서비스 목록 (지침에 넣는 서비스 지도는 동기라 이것을 쓴다) */
  private last: ConnectionItem[] = []
  constructor(
    private readonly dir: string | undefined,
    /** 연결을 마친 서비스 id → 시각 (설정) */
    private readonly connected: () => Record<string, string> = () => ({}),
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
      const skill = skills.get(n)
      const at = connected[n]
      out.push({ card, ...(skill ? { skill } : {}), ...(at ? { connectedAt: at } : {}) })
    }
    const sorted = out.sort((x, y) => order.indexOf(x.card.category) - order.indexOf(y.card.category))
    this.last = sorted
    return sorted
  }

  /**
   * 부탁에 맞는 서비스 참고 (AI에게만, 기록에 안 남음). 일 낱말이 있을 때만:
   * "기념일 식당 찾아 줘" → (두리 참고: … 캐치테이블(catchtable, 연결 전): 식당 예약·갈 만한 곳 …)
   */
  routeHint(text: string): string | undefined {
    if (text.startsWith('[두리 앱 알림]')) return undefined
    const q = text.toLowerCase()
    const hits = TASK_WORDS.filter(([re]) => re.test(q))
    if (!hits.length) return undefined
    // 일의 핵심어(식당·장보기·숙소·영화…)가 맞아야 한다. "예약"처럼 흔한 말만 겹치는 서비스는 빼고
    const core = hits.map(([, w]) => w[0] as string)
    const extra = hits.flatMap(([, w]) => w.slice(1))
    const connected = this.connected()
    const scored = this.last
      .filter((it) => it.card.how !== 'device')
      .map((it) => {
        const body = [it.card.summary, ...it.card.abilities.map((a) => `${a.title} ${a.say}`)].join(' ')
        if (!core.some((w) => body.includes(w))) return { it, n: 0 }
        const n = 3 + extra.reduce((s, w) => s + (body.includes(w) ? 1 : 0), 0)
        return { it, n: n + (connected[it.card.id] ? 2 : 0) }
      })
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
    if (!scored.length) return undefined
    const list = scored
      .map(({ it }) => {
        const c = it.card
        const can = c.abilities
          .slice(0, 2)
          .map((a) => a.title)
          .join('·')
        return `${c.name}(${c.id}, ${connected[c.id] ? '연결됨' : '연결 전'}): ${can}`
      })
      .join(' / ')
    return `(두리 참고: 이 부탁에 맞는 서비스 — ${list}. 포털 검색보다 이 서비스에서 먼저 찾아보고, skill_read로 절차를 확인해요. 예약·주문에 로그인이 필요한데 연결 전이면 connect_ask.)`
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
      const can = c.abilities
        .slice(0, 3)
        .map((a) => a.title)
        .join('·')
      const line = `${c.name}(${c.id})${connected[c.id] ? '✓' : ''}: ${can}`
      const k = CONNECT_CATEGORIES[c.category]
      by.set(k, [...(by.get(k) ?? []), line])
    }
    if (!by.size) return ''
    return [
      '## 쓸 수 있는 서비스 (✓ = 연결됨)',
      ...[...by].map(([k, lines]) => `- ${k}: ${lines.join(' / ')}`),
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
      // 일 낱말로도 찾는다: "기념일 식당" → 식당·예약
      for (const [re, more] of TASK_WORDS) if (re.test(query)) words.push(...more)
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
