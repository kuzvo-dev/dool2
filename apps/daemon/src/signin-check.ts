// 서비스에 지금 로그인돼 있는지 확인한다 (연결 확인·연결 유지가 같이 쓴다).
// 첫 화면에 확실한 표시(로그아웃·이름 님·계정 버튼)가 있으면 로그인됨, 로그인 입구가 있으면 풀림.
// 둘 다 없으면 '마이페이지'를 눌러 로그인 화면으로 가는지 본다. 그래도 모르면 'unknown' (연결로 표시하지 않는다).
// 실측(2026-11-19): 첫 화면만 보면 30곳 중 12곳은 표시도 입구도 없었고, 입구가 사라진 것만으로 판단해
// CJ더마켓·오아시스·캠핏·X를 연결로 잘못 표시했다
import type { ConnectCard } from '@dool2/protocol/connect'
import { hasLoginEntry, strongSignedIn } from './connect-watch.js'

export interface CheckBrowser {
  call(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export type SigninState = 'in' | 'out' | 'unknown'
export interface SigninCheck {
  state: SigninState
  /** 어떻게 알았는지 한 줄 (기록용) */
  why: string
}

type Snap = { url: string; text: string }

/** 마이페이지로 가는 링크·버튼 ("마이페이지", "MY", "마이 페이지ㆍ구매 내역", "마이리디", "HeaderButtonMyPage") */
const MY_LINK =
  /\[(e\d+) (?:링크|버튼) "((?:마이\s?페이지|마이|MY|My\s?page|MYPAGE|내\s?정보|HeaderButtonMyPage)[^"\]\n]{0,10}|마이\s?\S{1,4})"\]/i

/** 로그인한 사람의 마이페이지에 보이는 내용 */
const MY_CONTENT =
  /주문\s?(내역|목록|배송)|배송\s?(조회|현황)|구매\s?내역|예약\s?내역|쿠폰|적립금|포인트|마일리지|회원\s?정보\s?(수정|변경)|내\s?정보\s?(수정|관리)|개인\s?정보\s?(수정|변경)|비밀번호\s?변경|배송지\s?관리|찜한|위시\s?리스트|구독\s?(중|관리)|이용권|my orders|order history/i

/** 로그인 화면 주소 */
const LOGIN_AT =
  /\/(login|signin|sign-in|sign_in|auth\/|member\/login|i\/flow\/login)(\b|[/?#._])|nidlogin|accounts\.kakao\.com\/login|accounts\.google\.com/i

export function judgeHome(card: Pick<ConnectCard, 'signedIn'>, page: Snap): SigninCheck | undefined {
  if (strongSignedIn(card, page)) return { state: 'in', why: '첫 화면에 로그인 표시' }
  if (hasLoginEntry(page.text) || LOGIN_AT.test(page.url))
    return { state: 'out', why: '첫 화면에 로그인 입구' }
  return undefined
}

/** 마이페이지를 누른 뒤 화면으로 판단 */
export function judgeMyPage(card: Pick<ConnectCard, 'signedIn'>, before: Snap, after: Snap): SigninCheck {
  if (strongSignedIn(card, after)) return { state: 'in', why: '마이페이지에 로그인 표시' }
  if (LOGIN_AT.test(after.url) || /\[e\d+ 비밀번호칸/.test(after.text) || hasLoginEntry(after.text))
    return { state: 'out', why: '마이페이지가 로그인 화면으로 보냄' }
  // 화면이 바뀌지 않았으면(메뉴만 열렸거나 무반응) 알 수 없다
  if (after.url === before.url) return { state: 'unknown', why: '마이페이지를 눌러도 화면이 그대로' }
  // 주소만 바뀐 걸로는 모른다: 한 화면짜리 사이트(요기요·왓챠)는 로그인 안 해도 #mypage로 바뀐다 (실측 2026-11-19 잘못 연결).
  // 로그인한 사람의 마이페이지에만 있는 내용(주문·쿠폰·포인트·내 정보…)이 보여야 로그인됨
  if (MY_CONTENT.test(after.text)) return { state: 'in', why: '마이페이지에 내 주문·쿠폰·정보가 보임' }
  return { state: 'unknown', why: '마이페이지가 열렸지만 로그인한 내용이 안 보임' }
}

export async function checkSignedIn(
  browser: CheckBrowser,
  card: Pick<ConnectCard, 'id' | 'signedIn' | 'site'>,
  opts: { wait?: number } = {},
): Promise<SigninCheck> {
  if (!card.site) return { state: 'unknown', why: '사이트 주소 없음' }
  const wait = opts.wait ?? 2_500
  const snap = async (tabId: number) =>
    (await browser.call('snapshot', { tabId, maxChars: 30_000 }, 20_000)) as Snap
  const opened = (await browser.call('open', { url: `https://${card.site}/` }, 40_000)) as { tabId: number }
  const tabs = new Set([opened.tabId])
  try {
    await new Promise((r) => setTimeout(r, wait))
    const home = await snap(opened.tabId)
    const first = judgeHome(card, home)
    if (first) return first
    const my = MY_LINK.exec(home.text)
    if (!my) return { state: 'unknown', why: '첫 화면에 표시·입구·마이페이지 링크가 없음' }
    const clicked = (await browser
      .call('click', { tabId: opened.tabId, ref: my[1] }, 30_000)
      .catch(() => undefined)) as { newTabId?: number } | undefined
    const tab = clicked?.newTabId ?? opened.tabId
    tabs.add(tab)
    await new Promise((r) => setTimeout(r, wait))
    return judgeMyPage(card, home, await snap(tab))
  } finally {
    for (const t of tabs) await browser.call('close', { tabId: t }).catch(() => undefined)
  }
}
