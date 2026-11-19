// 서비스 연결 카드 (skills/<id>/connect.json, ADR 0014)와 AI 지침에 넣는 서비스 지도.
// 서비스에서 실제로 일하는 도구는 같은 폴더의 tools.json(커넥터, ADR 0018)이고 connectors.ts가 실행한다.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONNECT_CATEGORIES,
  type ConnectCard,
  ConnectCardSchema,
  type ConnectionItem,
  type ConnectionTool,
} from '@dool2/protocol/connect'

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

export class Skills {
  /** 마지막으로 읽은 서비스 목록 (지침에 넣는 서비스 지도는 동기라 이것을 쓴다) */
  private last: ConnectionItem[] = []
  constructor(
    private readonly dir: string | undefined,
    /** 연결을 마친 서비스 id → 시각 (설정) */
    private readonly connected: () => Record<string, string> = () => ({}),
    /** 서비스 도구(tools.json) 상태 요약 (ADR 0018) */
    private readonly connector?: (id: string) => Promise<{ status?: string; tools?: ConnectionTool[] }>,
    /** 서비스 id → 마지막으로 연결한 방법 (설정 connectVia) */
    private readonly via: () => Record<string, string> = () => ({}),
    /** 공급자(kakao·naver·google) → 내 계정으로 확인한 계정들 (설정 socialAccounts) */
    private readonly accounts: () => Record<string, string[]> = () => ({}),
  ) {}

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
    const connected = this.connected()
    const via = this.via()
    const accounts = this.accounts()
    const order = Object.keys(CONNECT_CATEGORIES)
    const out: ConnectionItem[] = []
    for (const n of names) {
      const card = await this.card(n)
      if (!card) continue
      const c = (await this.connector?.(n).catch(() => undefined)) ?? {}
      const skill = c.status
      const at = connected[n]
      out.push({
        card,
        ...(skill ? { skill } : {}),
        ...(c.tools?.length ? { tools: c.tools } : {}),
        ...(at ? { connectedAt: at } : {}),
        ...(via[n] ? { via: via[n] } : {}),
        ...(accounts[n]?.length ? { account: maskAccount(accounts[n].at(-1) as string) } : {}),
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
      // 연결 전이어도 로그인 없이 되는 도구는 알려 둔다 (연결을 먼저 묻지 않게)
      const free = !connected[c.id] ? (it.tools ?? []).filter((t) => !t.login).map((t) => t.name) : []
      const line = `${c.name}(${c.id})${connected[c.id] ? '✓' : ''}${it.tools?.length ? '⚡' : ''} — ${c.summary} [${can}]${free.length ? ` (로그인 없이: ${free.join(', ')})` : ''}`
      const k = CONNECT_CATEGORIES[c.category]
      by.set(k, [...(by.get(k) ?? []), line])
    }
    if (!by.size) return ''
    return [
      '## 쓸 수 있는 서비스 (✓ = 연결됨, ⚡ = 두리 서비스 도구 있음, [ ] = 할 수 있는 일)',
      '부탁에 서비스 이름이 없어도 아래에서 그 일을 가장 잘 끝낼 수 있는 서비스를 직접 골라요.',
      ...[...by].map(([k, lines]) => `### ${k}\n${lines.map((l) => `- ${l}`).join('\n')}`),
    ].join('\n')
  }
}

/** 화면에 보일 계정: 이메일은 앞 한 글자만 ("felix@gmail.com" → "f***@gmail.com"), 아이디는 그대로 */
export function maskAccount(a: string): string {
  const m = /^([^@\s])[^@\s]*@(.+)$/.exec(a.trim())
  return m ? `${m[1]}***@${m[2]}` : a.trim().slice(0, 30)
}
