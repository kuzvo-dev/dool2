// 서비스 연결: 사용자가 로그인을 마쳤는지 화면 글자로 확인한다 (ADR 0014).
// AI를 부르지 않는다. 연결하려고 연 탭의 글자만 이 PC 안에서 읽고, 로그인한 사람에게만 보이는 말이 있으면 연결로 표시한다.
import type { ConnectCard } from '@dool2/protocol/connect'

/** 카드에 signedIn이 없을 때 쓰는 말: 대부분의 사이트가 로그인하면 위쪽에 보여 준다 */
export const DEFAULT_SIGNED_IN = ['로그아웃', 'Logout', 'Log out', 'Sign out']

/** 로그인 화면 주소에 흔한 말. 여기 있으면 아직 로그인 전이다 */
const LOGIN_URL = /\/(login|signin|sign-in|member\/login|auth)(\b|[/?#])/i

/** 이름 + 님이 적힌 버튼·링크 ("주*돈 님", "홍길동님"): 로그아웃을 마우스를 올려야 펼치는 메뉴에 숨긴
 *  한국 사이트(컬리 등)는 위쪽에 이것만 보인다. "고객님"·"회원님" 같은 부름말은 빼고 */
const NAME_BUTTON =
  /\[e\d+ (?:버튼|링크) "(?![^"]*(?:고객|회원|손님|사장)님)(?!고객|회원|손님)[^"\]\n]{1,20}?\s?님"\]/

/** "○○ 님의 계정 메뉴" 같은 계정 메뉴 버튼 (실측 부킹닷컴: "지니어스 레벨 일, myeongdon joo 님의 계정 메뉴") */
const ACCOUNT_MENU = /\[e\d+ (?:버튼|링크) "[^"\]\n]{1,60}님의\s?(계정|프로필|마이)[^"\]\n]{0,20}"\]/

/** 계정 버튼 ("Google 계정: 이름 (메일)"): 구글 서비스는 로그아웃을 계정 메뉴 안에 숨긴다 */
const ACCOUNT_BUTTON = /\[e\d+ (?:버튼|링크) "(?:Google 계정|Google Account): [^"]+"/

/** 아이디 + "내정보 보기" 링크 (네이버 위쪽 줄: "wwd 내정보 보기"): 로그아웃은 그 메뉴 안에 숨어 있다 */
const MY_INFO = /\[e\d+ (?:버튼|링크) "[^"\]\n]{1,30}\s내\s?정보\s?보기"\]/

/**
 * 로그인 입구: 로그인·가입하라는 짧은 링크·버튼 ("로그인", "로그인/회원가입", "카카오 로그인", "Sign in"),
 * 또는 비밀번호 칸. 로그인하면 사라진다
 */
const LOGIN_ENTRY =
  /\[e\d+ (?:링크|버튼) "[^"\]\n]{0,10}(?:로그인|log\s?in|sign\s?in|sign\s?up|회원\s?가입|가입하기|계정\s?만들기|create (?:an )?account)[^"\]\n]{0,10}"\]|\[e\d+ (?:링크|버튼) "[^"\]\n]{1,20}(?:으로|로)\s?계속하기[^"\]\n]{0,12}"\]|\[e\d+ (?:링크|버튼) "Continue with [^"\]\n]{1,20}"\]|\[e\d+ 비밀번호칸/i
export function hasLoginEntry(text: string): boolean {
  return LOGIN_ENTRY.test(text)
}

/** 그 서비스 사이트 주소인지 (간편 로그인 공급자 화면·중간 콜백 도메인이 아니라) */
function onSite(site: string | undefined, url: string): boolean {
  if (!site) return false
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const s = site.replace(/^www\./, '').split('/')[0] ?? ''
    return host === s || host.endsWith(`.${s}`)
  } catch {
    return false
  }
}

/**
 * 화면 글자·주소로 로그인했는지.
 * sawEntry: 이 연결에서 로그인 입구(로그인 링크·비밀번호 칸)를 이미 봤다 → 사이트로 돌아와 입구가 사라졌으면 로그인된 것.
 * '로그아웃'을 메뉴 속에 숨기는 사이트가 많아(84곳 중 대부분) 그 글자만 보면 사용자가 로그인을 마쳐도 못 알아봤다.
 * 처음부터 입구가 없는 사이트(앱 같은 첫 화면)를 로그인됨으로 잘못 보지 않게, 입구를 본 뒤에만 쓴다
 */
export function looksSignedIn(
  card: Pick<ConnectCard, 'signedIn'> & { site?: string },
  page: { url: string; text: string },
  opts: { sawEntry?: boolean } = {},
): boolean {
  return signedInHow(card, page, opts) !== undefined
}

/** 로그인한 사람에게만 보이는 확실한 표시가 있는지 (로그아웃·이름 님·계정 버튼) */
export function strongSignedIn(
  card: Pick<ConnectCard, 'signedIn'>,
  page: { url: string; text: string },
): boolean {
  // 로그인 화면 주소라도 비밀번호 칸이 사라지고 로그인한 사람의 말이 보이면 로그인됐다 (주소가 안 바뀌는 사이트)
  if (LOGIN_URL.test(page.url) && /비밀번호칸|type="?password/.test(page.text)) return false
  // 카드의 말은 흔한 말(로그아웃)에 더한다: 카드에 적었다고 흔한 표시를 못 보면 안 된다
  const marks = [...DEFAULT_SIGNED_IN, ...(card.signedIn ?? [])]
  return (
    marks.some((m) => page.text.includes(m)) ||
    NAME_BUTTON.test(page.text) ||
    ACCOUNT_BUTTON.test(page.text) ||
    ACCOUNT_MENU.test(page.text) ||
    MY_INFO.test(page.text)
  )
}

/**
 * 'strong': 확실한 표시가 있다. 'inverse': 로그인 입구를 본 뒤 그 입구가 사라졌을 뿐이다 (짐작 — 연결로 표시하기 전에
 * 마이페이지까지 확인해야 한다: 실측 CJ더마켓·오아시스·캠핏·X를 이것만으로 연결로 잘못 표시했다). 아니면 undefined
 */
export function signedInHow(
  card: Pick<ConnectCard, 'signedIn'> & { site?: string },
  page: { url: string; text: string },
  opts: { sawEntry?: boolean } = {},
): 'strong' | 'inverse' | undefined {
  if (strongSignedIn(card, page)) return 'strong'
  return inverseSignedIn(card, page, opts) ? 'inverse' : undefined
}

function inverseSignedIn(
  card: Pick<ConnectCard, 'signedIn'> & { site?: string },
  page: { url: string; text: string },
  opts: { sawEntry?: boolean },
): boolean {
  if (!opts.sawEntry || !onSite(card.site, page.url) || LOGIN_URL.test(page.url)) return false
  // 다 그려진 화면이어야 한다 (콜백·이동 중인 빈 화면은 입구가 없어도 아직 모른다)
  const refs = page.text.match(/\[e\d+ /g)?.length ?? 0
  // 간편 로그인 뒤 가입·추가 정보·본인인증·약관 동의 화면은 입구가 없어도 아직이다 (링크 글자는 빼고 본다: 바닥 '이용약관' 링크)
  const prose = page.text.replace(/\[e\d+ 링크 "[^"]*"\]/g, '')
  if (
    /약관|본인\s?인증|추가\s?정보|정보\s?입력|회원\s?가입|가입\s?(하기|완료|정보)|인증\s?번호|필수/.test(
      prose,
    )
  )
    return false
  return refs >= 20 && !hasLoginEntry(page.text)
}

export interface LoginWatchDeps {
  snapshot(tabId: number): Promise<{ url: string; text: string }>
  /** 이미 연결로 표시됐으면 그만 본다 (사용자가 [로그인했어요]를 눌렀을 때) */
  connected(id: string): boolean
  onSignedIn(card: ConnectCard): void
  /** 짐작(입구가 사라짐)만으로는 표시하지 않고 마이페이지까지 확인한다. 없으면 짐작은 쓰지 않는다 */
  confirm?(card: ConnectCard): Promise<boolean>
  /** 지켜보던 탭이 닫혔다 (간편 로그인 팝업은 확인 뒤 스스로 닫힌다): 사이트를 새로 열어 확인해 볼 차례 */
  onClosed?(card: ConnectCard): void
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
    // 입구를 본 주소: 그 화면에서 입구가 안 보이는 것만으로는 짐작하지 않는다 (주소가 바뀌어야 로그인 뒤로 본다)
    let entryUrl: string | undefined
    let confirmed = 0
    const tick = async () => {
      this.timers.delete(card.id)
      if (this.deps.connected(card.id) || Date.now() > until) return
      try {
        const page = await this.deps.snapshot(tabId)
        const how = signedInHow(card, page, { sawEntry: entryUrl !== undefined && page.url !== entryUrl })
        if (how === 'strong') {
          this.deps.onSignedIn(card)
          return
        }
        // 짐작이면 확인을 한 번(많아야 두 번)만 한다 (확인은 사이트를 새로 연다)
        if (how === 'inverse' && this.deps.confirm && confirmed < 2) {
          confirmed++
          if (await this.deps.confirm(card).catch(() => false)) {
            this.deps.onSignedIn(card)
            return
          }
        }
        if (hasLoginEntry(page.text)) entryUrl = page.url
      } catch {
        // 탭이 닫혔거나 확장이 끊겼다. 닫힌 탭은 다시 지켜보지 않고, 로그인이 됐는지는 사이트로 한 번 확인한다
        this.tabs.delete(card.id)
        this.deps.onClosed?.(card)
        return
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
