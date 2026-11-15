// 대화 안 로그인 카드 (ADR 0011 보탬). 금고에 없는 사이트에서 두리가 아이디·비밀번호를 부탁하면 여기에 요청을 만든다.
// 사용자가 PC나 폰의 카드에 넣은 값은 AI를 거치지 않고 금고(OS 키체인)에만 들어간다. AI는 "저장됐어요"만 알고 browser_login으로 채운다.
import { randomUUID } from 'node:crypto'
import type { LoginRequestView } from '@dool2/protocol'

export const LOGIN_TTL_MS = 30 * 60_000

export class LoginRequests {
  private items = new Map<string, LoginRequestView>()
  /** 새 요청이 생기면 (폰에 알리기) */
  onCreate?: (r: LoginRequestView) => void

  constructor(private readonly now: () => number = Date.now) {}

  create(n: { tabId: number; origin: string; site: string }): LoginRequestView {
    // 같은 사이트에 기다리는 요청이 있으면 새것으로 바꾼다
    for (const r of this.items.values())
      if (r.status === 'pending' && r.origin === n.origin) r.status = 'expired'
    const t = this.now()
    const r: LoginRequestView = {
      ...n,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + LOGIN_TTL_MS).toISOString(),
    }
    this.items.set(r.id, r)
    this.onCreate?.(r)
    return r
  }

  get(id: string): LoginRequestView | undefined {
    const r = this.items.get(id)
    if (r?.status === 'pending' && Date.parse(r.expiresAt) <= this.now()) r.status = 'expired'
    return r
  }

  list(): LoginRequestView[] {
    return [...this.items.keys()].map((id) => this.get(id) as LoginRequestView)
  }

  finish(id: string, status: 'saved' | 'cancelled', username?: string) {
    const r = this.get(id)
    if (!r || r.status !== 'pending') return false
    r.status = status
    if (username) r.username = username
    return true
  }
}
