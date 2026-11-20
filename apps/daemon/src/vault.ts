// 두리 금고 (ADR 0011). 로그인 정보는 비밀값 보관소(PC 앱은 OS 키체인으로 암호화)에만 둔다.
// AI는 값을 받지 않는다: browser_login 도구는 "이 칸에 채워 줘"만 부탁하고, 본체가 주소를 확인한 뒤 확장에 직접 넘긴다.
import { randomUUID } from 'node:crypto'
import type { VaultEntry } from '@dool2/protocol'
import { findCard } from '@dool2/protocol/connect-text'

export interface SecretStoreLike {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string | undefined): Promise<void>
}

interface Stored extends VaultEntry {
  password: string
}

const KEY = 'vault.entries'

/** 저장할 사이트 주소. https만 받는다 (이 PC 안의 시험용 주소는 http도) */
export function vaultOrigin(raw: string): string {
  let s = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('사이트 주소가 올바르지 않아요')
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))
    throw new Error('https로 시작하는 사이트만 저장할 수 있어요')
  return u.origin
}

export class Vault {
  constructor(
    private readonly secrets: SecretStoreLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<Stored[]> {
    const raw = await this.secrets.get(KEY)
    if (!raw) return []
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? (v as Stored[]) : []
    } catch {
      return []
    }
  }

  private async save(list: Stored[]) {
    await this.secrets.set(KEY, list.length ? JSON.stringify(list) : undefined)
  }

  /** 비밀번호를 뺀 목록 */
  async list(): Promise<VaultEntry[]> {
    return (await this.load()).map(({ password: _p, ...e }) => e)
  }

  /** 같은 사이트·같은 아이디면 비밀번호를 바꾼다 */
  async add(input: { url: string; username: string; password: string }): Promise<VaultEntry> {
    const origin = vaultOrigin(input.url)
    const list = await this.load()
    const old = list.find((e) => e.origin === origin && e.username === input.username)
    const entry: Stored = old
      ? { ...old, password: input.password }
      : {
          id: randomUUID(),
          origin,
          username: input.username,
          password: input.password,
          createdAt: this.now().toISOString(),
        }
    await this.save([...list.filter((e) => e !== old), entry])
    const { password: _p, ...view } = entry
    return view
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.load()
    const next = list.filter((e) => e.id !== id)
    if (next.length === list.length) return false
    await this.save(next)
    return true
  }

  /**
   * 본체 안에서만 쓴다: 지금 페이지 origin과 정확히 같은 항목.
   * 같은 사이트에 여러 개면 가장 나중에 넣은 것 (add가 새로 넣거나 고친 항목을 맨 뒤에 둔다).
   * 처음 것을 주면, 아이디를 잘못 쳤다가 고쳐 넣은 뒤에도 예전의 틀린 계정으로 계속 로그인을 시도한다
   */
  async findForOrigin(
    origin: string,
  ): Promise<{ id: string; username: string; password: string } | undefined> {
    const e = (await this.load()).findLast((x) => x.origin === origin)
    return e ? { id: e.id, username: e.username, password: e.password } : undefined
  }

  /**
   * 사용자가 화면(폰·PC)에서 볼 때만: 비밀번호 하나 (ADR 0026). AI 도구·기록으로는 나가지 않는다.
   * 폰은 기기 잠금 확인 뒤에 부탁하고, 본체는 일한 기록에 사이트만 남긴다
   */
  async reveal(id: string): Promise<{ origin: string; username: string; password: string } | undefined> {
    const e = (await this.load()).find((x) => x.id === id)
    return e ? { origin: e.origin, username: e.username, password: e.password } : undefined
  }

  /** 사용자가 고친다: 아이디·비밀번호 (빈 값은 그대로 둔다) */
  async update(id: string, patch: { username?: string; password?: string }): Promise<VaultEntry | undefined> {
    const list = await this.load()
    const e = list.find((x) => x.id === id)
    if (!e) return undefined
    const username = patch.username?.trim()
    if (username) e.username = username.slice(0, 200)
    if (patch.password) e.password = patch.password.slice(0, 200)
    // 고친 항목을 맨 뒤로: 같은 사이트에 여러 개면 findForOrigin이 이것을 쓴다
    await this.save([...list.filter((x) => x !== e), e])
    const { password: _p, ...view } = e
    return view
  }

  /** 두리가 만든 새 비밀번호를 저장한다 (가입·비번 변경). origin은 이미 origin 형태 */
  async savePassword(origin: string, username: string, password: string) {
    await this.add({ url: origin, username, password })
  }

  async markUsed(id: string) {
    const list = await this.load()
    const e = list.find((x) => x.id === id)
    if (!e) return
    e.lastUsedAt = this.now().toISOString()
    await this.save(list)
  }
}

// ── AI 도구 vault_find: 금고에 어느 사이트 로그인이 있는지만. 비밀번호는 절대, 아이디는 가려서 ──

/** 금고 목록에 이름을 붙이고 이름으로 찾을 때 쓰는 연결 카드 */
export interface VaultSiteCard {
  id: string
  name: string
  site?: string
  /** 연결돼 있는지 */
  connected?: boolean
  /** 간편 로그인으로 연결했으면 그 공급자 이름 (예: "카카오") */
  social?: string
}

/**
 * AI에게 보일 아이디: 이메일은 앞 한 글자, 그 밖은 앞 두 글자만
 * ("felix990810@gmail.com" → "f***@gmail.com", "duri1234" → "du******", "ab" → "a***")
 */
export function maskUsername(u: string): string {
  const s = u.trim()
  const m = /^([^@\s])[^@\s]*@(.+)$/.exec(s)
  if (m) return `${m[1]}***@${m[2]}`
  if (s.length <= 2) return `${s.slice(0, 1)}***`
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(Math.max(s.length - 2, 3), 6))}`
}

/** 보일 사이트 이름: "https://www.coupang.com" → "coupang.com" */
function siteOf(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, '')
  } catch {
    return origin
  }
}

/** 같은 사이트인지 (하위 주소 포함: login.coupang.com ↔ coupang.com) */
function sameSite(host: string, site: string): boolean {
  const s = site.replace(/^www\./, '')
  return host === s || host.endsWith(`.${s}`) || s.endsWith(`.${host}`)
}

/** 한국 시간 YYYY-MM-DD */
function day(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '날짜 모름' : new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 받침에 맞는 "은/는" ("쿠팡은", "야놀자는", "SRT(은)는") */
function eun(word: string): string {
  const c = word.charCodeAt(word.length - 1)
  if (c < 0xac00 || c > 0xd7a3) return `${word}(은)는`
  return `${word}${(c - 0xac00) % 28 ? '은' : '는'}`
}

/**
 * 금고 보기 (vault_find 도구). query가 없으면 저장된 사이트 전부, 있으면 그 사이트가 있는지 예/아니요로.
 * 받는 목록은 이미 비밀번호를 뺀 것(Vault.list)이고, 아이디도 여기서 가린다
 */
export function vaultSitesText(
  entries: VaultEntry[],
  opts: { query?: string; cards?: VaultSiteCard[] } = {},
): string {
  const cards = opts.cards ?? []
  const rows = entries
    .map((e) => {
      const host = siteOf(e.origin)
      return { e, host, card: cards.find((c) => c.site && sameSite(host, c.site)) }
    })
    .sort((x, y) => (y.e.lastUsedAt ?? y.e.createdAt).localeCompare(x.e.lastUsedAt ?? x.e.createdAt))
  const line = (r: (typeof rows)[number], i: number) =>
    [
      `${i + 1}. ${r.card ? `${r.card.name} · ` : ''}${r.host}`,
      `아이디 ${maskUsername(r.e.username)}`,
      r.e.lastUsedAt ? `마지막 사용 ${day(r.e.lastUsedAt)}` : '아직 두리가 쓴 적 없음',
      `저장 ${day(r.e.createdAt)}`,
    ].join(' · ')
  const safe =
    '비밀번호는 두리(AI)도 볼 수 없고 아이디는 가려서 보여요. 비밀번호를 대화로 묻거나 알려 주지 않아요.'
  const use =
    '로그인이 필요하면 그 사이트 로그인 화면에서 browser_login이 금고 값을 직접 채워요(값은 두리에게 오지 않아요). 연결 카드가 있는 서비스는 connect_ask가 이 계정으로 다시 로그인해요.'

  const q = (opts.query ?? '').replace(/\s+/g, ' ').trim()
  if (!q) {
    if (!rows.length)
      return [
        '금고에 저장된 로그인이 없어요.',
        '다음: 로그인이 필요한 서비스면 connect_ask로 연결 카드를 띄워요. 사용자가 카드에 넣은 아이디·비밀번호는 PC 금고에만 암호화해 저장돼요. 비밀번호를 대화로 묻지 않아요.',
      ].join('\n')
    const shown = rows.slice(0, 30)
    return [
      `금고에 로그인이 저장된 사이트 ${rows.length}곳이에요${rows.length > shown.length ? ` (최근 ${shown.length}곳만)` : ''}. ${safe}`,
      '',
      ...shown.map(line),
      '',
      `다음: ${use} 저장·지우기는 사용자가 PC 앱 설정의 두리 금고에서 해요.`,
    ].join('\n')
  }

  // 찾기: 연결 카드 이름("쿠팡")이나 주소("coupang.com")로 그 사이트를 정하고, 아니면 낱말로
  let card = findCard(cards, q)
  let target = card?.site
  if (!target && /\.[a-z]{2,}/i.test(q)) {
    try {
      target = siteOf(vaultOrigin(q))
      card ??= cards.find((c) => c.site && target && sameSite(target, c.site))
    } catch {
      // 주소가 아니면 낱말로 찾는다
    }
  }
  const hit = rows.filter((r) =>
    target
      ? sameSite(r.host, target)
      : squash(r.host).includes(squash(q)) || (r.card ? squash(r.card.name).includes(squash(q)) : false),
  )
  const label = card ? `${card.name}(${card.site ?? card.id})` : `'${q}'`
  if (hit.length)
    return [
      `네, ${label} 로그인이 금고에 저장돼 있어요${hit.length > 1 ? ` (${hit.length}개, 두리는 가장 최근에 넣은 것을 써요)` : ''}. ${safe}`,
      '',
      ...hit.map(line),
      '',
      `다음: ${use}`,
    ].join('\n')

  const others = rows.length
    ? `금고에 저장된 사이트 ${rows.length}곳: ${rows
        .slice(0, 10)
        .map((r) => (r.card ? `${r.card.name}(${r.host})` : r.host))
        .join(', ')}${rows.length > 10 ? ' 등' : ''}.`
    : '금고가 비어 있어요.'
  const conn = card?.connected
    ? card.social
      ? `다만 ${eun(card.name)} ${card.social} 간편 로그인으로 연결돼 있어 금고 없이도 두리가 로그인해요.`
      : `${eun(card.name)} 연결돼 있어요(PC Chrome에 로그인 유지). 로그인이 풀리면 그때 연결 카드를 띄워요.`
    : ''
  const next = card?.social
    ? `다음: 로그인이 풀리면 connect_ask("${card.id}")가 ${card.social} 간편 로그인으로 다시 로그인해요. 비밀번호를 대화로 묻지 않아요.`
    : card
      ? `다음: 로그인이 필요해지면 connect_ask("${card.id}")로 연결 카드를 띄워요. 사용자가 카드에 넣은 아이디·비밀번호는 PC 금고에만 저장돼요. 비밀번호를 대화로 묻지 않아요.`
      : '다음: 연결 카드가 없는 사이트면 그 사이트 로그인 화면에서 browser_login을 쓰고, "금고에 없어요"면 browser_request_login으로 로그인 카드를 띄워요. 서비스 이름이면 connect_ask로 연결 카드를 찾아봐요. 비밀번호를 대화로 묻지 않아요.'
  return [`아니요, ${label} 로그인은 금고에 없어요.${conn ? ` ${conn}` : ''}`, others, next].join('\n')
}
