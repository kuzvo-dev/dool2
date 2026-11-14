// 두리 금고 (ADR 0011). 로그인 정보는 비밀값 보관소(PC 앱은 OS 키체인으로 암호화)에만 둔다.
// AI는 값을 받지 않는다: browser_login 도구는 "이 칸에 채워 줘"만 부탁하고, 본체가 주소를 확인한 뒤 확장에 직접 넘긴다.
import { randomUUID } from 'node:crypto'
import type { VaultEntry } from '@dool2/protocol'

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

  /** 본체 안에서만 쓴다: 지금 페이지 origin과 정확히 같은 항목 */
  async findForOrigin(
    origin: string,
  ): Promise<{ id: string; username: string; password: string } | undefined> {
    const e = (await this.load()).find((x) => x.origin === origin)
    return e ? { id: e.id, username: e.username, password: e.password } : undefined
  }

  async markUsed(id: string) {
    const list = await this.load()
    const e = list.find((x) => x.id === id)
    if (!e) return
    e.lastUsedAt = this.now().toISOString()
    await this.save(list)
  }
}
