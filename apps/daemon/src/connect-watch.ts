// 서비스 연결: 사용자가 로그인을 마쳤는지 화면 글자로 확인한다 (ADR 0014).
// AI를 부르지 않는다. 연결하려고 연 탭의 글자만 이 PC 안에서 읽고, 로그인한 사람에게만 보이는 말이 있으면 연결로 표시한다.
import type { ConnectCard } from '@dool2/protocol/connect'

/** 카드에 signedIn이 없을 때 쓰는 말: 대부분의 사이트가 로그인하면 위쪽에 보여 준다 */
export const DEFAULT_SIGNED_IN = ['로그아웃', 'Logout', 'Log out', 'Sign out']

/** 로그인 화면 주소에 흔한 말. 여기 있으면 아직 로그인 전이다 */
const LOGIN_URL = /\/(login|signin|sign-in|member\/login|auth)(\b|[/?#])/i

/** 화면 글자·주소로 로그인했는지 */
export function looksSignedIn(
  card: Pick<ConnectCard, 'signedIn'>,
  page: { url: string; text: string },
): boolean {
  // 로그인 화면 주소라도 비밀번호 칸이 사라지고 로그인한 사람의 말이 보이면 로그인됐다 (주소가 안 바뀌는 사이트)
  if (LOGIN_URL.test(page.url) && /비밀번호칸|type="?password/.test(page.text)) return false
  const marks = card.signedIn?.length ? card.signedIn : DEFAULT_SIGNED_IN
  return marks.some((m) => page.text.includes(m))
}

export interface LoginWatchDeps {
  snapshot(tabId: number): Promise<{ url: string; text: string }>
  /** 이미 연결로 표시됐으면 그만 본다 (사용자가 [로그인했어요]를 눌렀을 때) */
  connected(id: string): boolean
  onSignedIn(card: ConnectCard): void
}

/** 연결하려고 연 탭을 잠깐 지켜본다. 탭이 닫히거나, 확인되거나, 시간이 지나면 멈춘다 */
export class LoginWatch {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 서비스마다 지켜보는 탭 */
  private tabs = new Map<string, number>()
  tabOf(id: string): number | undefined {
    return this.tabs.get(id)
  }

  constructor(
    private readonly deps: LoginWatchDeps,
    private readonly every = 3_000,
    private readonly forMs = 10 * 60_000,
  ) {}

  start(card: ConnectCard, tabId: number) {
    this.stop(card.id)
    this.tabs.set(card.id, tabId)
    const until = Date.now() + this.forMs
    const tick = async () => {
      this.timers.delete(card.id)
      if (this.deps.connected(card.id) || Date.now() > until) return
      try {
        const page = await this.deps.snapshot(tabId)
        if (looksSignedIn(card, page)) {
          this.deps.onSignedIn(card)
          return
        }
      } catch {
        return // 탭이 닫혔거나 확장이 끊겼다
      }
      this.timers.set(
        card.id,
        setTimeout(() => void tick(), this.every),
      )
    }
    this.timers.set(
      card.id,
      setTimeout(() => void tick(), this.every),
    )
  }

  stop(id: string) {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
  }

  stopAll() {
    for (const id of [...this.timers.keys()]) this.stop(id)
  }

  watching(id: string): boolean {
    return this.timers.has(id)
  }
}
