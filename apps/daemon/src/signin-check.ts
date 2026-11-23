// Checks whether we are signed in to a service right now (used by connection check and keep-alive).
// A clear sign on the first page (log out, a name, an account button) means signed in; a login entry means signed out.
// With neither, click "my page" and see whether it leads to a login screen. If still unsure, 'unknown' (not shown as connected).
// Measured (2026-11-19): on the first page alone, 12 of 30 sites had neither sign nor entry, and judging only by
// a missing entry marked CJ The Market, Oasis, Campit and X as connected by mistake
import type { ConnectCard } from '@dool2/protocol/connect'
import { hasLoginEntry, strongSignedIn } from './connect-watch.js'
import { MY_CONTENT, MY_LINK, PASSWORD_FIELD } from './region/kr/signin-check.js'

export interface CheckBrowser {
  call(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export type SigninState = 'in' | 'out' | 'unknown'
export interface SigninCheck {
  state: SigninState
  /** One line on how we knew (for the log) */
  why: string
}

type Snap = { url: string; text: string }

/** Login screen addresses */
const LOGIN_AT =
  /\/(login|signin|sign-in|sign_in|auth\/|member\/login|i\/flow\/login)(\b|[/?#._])|nidlogin|accounts\.kakao\.com\/login|accounts\.google\.com/i

export function judgeHome(card: Pick<ConnectCard, 'signedIn'>, page: Snap): SigninCheck | undefined {
  if (strongSignedIn(card, page)) return { state: 'in', why: 'sign of login on the first page' }
  if (hasLoginEntry(page.text) || LOGIN_AT.test(page.url))
    return { state: 'out', why: 'login entry on the first page' }
  return undefined
}

/** Judge from the screen after clicking "my page" */
export function judgeMyPage(card: Pick<ConnectCard, 'signedIn'>, before: Snap, after: Snap): SigninCheck {
  if (strongSignedIn(card, after)) return { state: 'in', why: 'sign of login on the my page' }
  if (LOGIN_AT.test(after.url) || PASSWORD_FIELD.test(after.text) || hasLoginEntry(after.text))
    return { state: 'out', why: 'my page led to a login screen' }
  // If the screen did not change (only a menu opened, or nothing happened), we cannot tell
  if (after.url === before.url)
    return { state: 'unknown', why: 'the screen stayed the same after clicking my page' }
  // A changed address alone tells nothing: one-page sites (Yogiyo, Watcha) change to #mypage even when signed out (measured 2026-11-19, wrongly connected).
  // Signed in only if content that appears only on a signed-in person's my page (orders, coupons, points, my info ...) is visible
  if (MY_CONTENT.test(after.text))
    return { state: 'in', why: 'my orders, coupons and info are visible on my page' }
  return { state: 'unknown', why: 'my page opened but no signed-in content is visible' }
}

export async function checkSignedIn(
  browser: CheckBrowser,
  card: Pick<ConnectCard, 'id' | 'signedIn' | 'site'>,
  opts: { wait?: number } = {},
): Promise<SigninCheck> {
  if (!card.site) return { state: 'unknown', why: 'no site address' }
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
    if (!my) return { state: 'unknown', why: 'no sign, entry or my page link on the first page' }
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
