// 로그인 중 화면이 묻는 것(인증번호·휴대폰 번호 등)을 폰 입력 화면으로 받는다.
// 원격 화면으로 PC 칸을 찾아 치는 것보다 빠르고 편하다. 값은 AI·대화 기록에 남기지 않고 그 칸에만 넣는다.
import { randomUUID } from 'node:crypto'
import type { InfoRequestView } from '@dool2/protocol'

export const INFO_TTL_MS = 5 * 60_000

export class InfoRequests {
  private items = new Map<string, { view: InfoRequestView; done: (v: string | undefined) => void }>()
  /** 새 요청 (폰에 보내기) */
  onCreate?: (r: InfoRequestView) => void
  /** 끝남 (폰의 입력 화면 닫기) */
  onDone?: (id: string) => void

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttl = INFO_TTL_MS,
  ) {}

  /** 묻고 답을 기다린다. 취소·시간 초과면 undefined */
  ask(n: Omit<InfoRequestView, 'id' | 'status' | 'expiresAt'>): Promise<string | undefined> {
    const id = randomUUID()
    const view: InfoRequestView = {
      ...n,
      id,
      status: 'pending',
      expiresAt: new Date(this.now() + this.ttl).toISOString(),
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'expired'), this.ttl)
      this.items.set(id, {
        view,
        done: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
      })
      this.onCreate?.(view)
    })
  }

  answer(id: string, value: string | undefined): boolean {
    const v = value?.trim()
    return this.finish(id, v ? 'answered' : 'cancelled', v ? v.slice(0, 200) : undefined)
  }

  pending(): InfoRequestView[] {
    return [...this.items.values()].map((x) => x.view).filter((v) => v.status === 'pending')
  }

  private finish(id: string, status: InfoRequestView['status'], value?: string): boolean {
    const it = this.items.get(id)
    if (!it || it.view.status !== 'pending') return false
    it.view.status = status
    this.items.delete(id)
    it.done(value)
    this.onDone?.(id)
    return true
  }
}
