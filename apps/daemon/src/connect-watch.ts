// Service connect: checks from the page text whether the user finished signing in (ADR 0014).
// No AI is called. Only the text of the tab opened for connecting is read on this PC, and if words only a signed-in person sees are present, it is marked connected.
import type { ConnectCard } from '@dool2/protocol/connect'
import { accountIn } from './connect-account.js'
import {
  ACCOUNT_BUTTON,
  ACCOUNT_MENU,
  ANY_LINK,
  DEFAULT_SIGNED_IN,
  LOGIN_ENTRY,
  MY_INFO,
  NAME_BUTTON,
  PASSWORD_BOX,
  SIGNUP_STEP,
} from './region/kr/connect-watch-ui.js'

export { DEFAULT_SIGNED_IN }

/** Words common in sign-in page URLs. If present, the user is not signed in yet */
const LOGIN_URL = /\/(login|signin|sign-in|member\/login|auth)(\b|[/?#])/i

export function hasLoginEntry(text: string): boolean {
  return LOGIN_ENTRY.test(text)
}

/** Whether the URL is that service's own site (not a simple-login provider page or an intermediate callback domain) */
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
 * Whether signed in, judged from the page text and URL.
 * sawEntry: a login entry (sign-in link, password box) was already seen in this connection -> if it is gone after returning to the site, the user is signed in.
 * Many sites hide the Korean Logout text inside a menu (most of the 84 sites), so looking only for that text missed users who had finished signing in.
 * To avoid wrongly treating sites with no entry from the start (an app-like first screen) as signed in, this is used only after an entry was seen
 */
export function looksSignedIn(
  card: Pick<ConnectCard, 'signedIn'> & { site?: string },
  page: { url: string; text: string },
  opts: { sawEntry?: boolean } = {},
): boolean {
  return signedInHow(card, page, opts) !== undefined
}

/** Whether there is a sure sign only a signed-in person sees (Logout, name + honorific, account button) */
export function strongSignedIn(
  card: Pick<ConnectCard, 'signedIn'>,
  page: { url: string; text: string },
): boolean {
  // Even on a sign-in URL, once the password box is gone and words of a signed-in person show, the user is signed in (sites whose URL does not change)
  if (LOGIN_URL.test(page.url) && PASSWORD_BOX.test(page.text)) return false
  // Card words are added to the common ones (Logout): writing them on the card must not stop us from seeing the common marks
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
 * 'strong': there is a sure sign. 'inverse': the login entry was seen and then disappeared (a guess; confirm up to the my-page before marking
 * connected: measured CJ theMarket, Oasis, Campit and X were wrongly marked connected from this alone). Otherwise undefined
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
  // The page must be fully drawn (a blank page during a callback or redirect has no entry but we still cannot tell)
  const refs = page.text.match(/\[e\d+ /g)?.length ?? 0
  // After a simple login, signup, extra info, identity check and terms screens are not done even without an entry (link text is ignored: the footer terms link)
  const prose = page.text.replace(ANY_LINK, '')
  if (SIGNUP_STEP.test(prose)) return false
  return refs >= 20 && !hasLoginEntry(page.text)
}

export interface LoginWatchDeps {
  snapshot(tabId: number): Promise<{ url: string; text: string }>
  /** Stop watching if already marked connected (when the user pressed [I signed in]) */
  connected(id: string): boolean
  /** who: the account the page showed, for cards that say where the account shows (ADR 0041) */
  onSignedIn(card: ConnectCard, who?: string): void
  /** Do not mark from a guess alone (entry disappeared); confirm up to the my-page. Without this, guesses are not used */
  confirm?(card: ConnectCard): Promise<boolean>
  /** The watched tab closed (a simple-login popup closes itself after confirming): time to open the site anew and check */
  onClosed?(card: ConnectCard): void
}

/** Watches the tab opened for connecting for a while. Stops when the tab closes, it is confirmed, or time runs out */
export class LoginWatch {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Tab being watched per service */
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
    // URL where the entry was seen: not seeing the entry on that same page is not enough to guess (the URL must change to count as after login)
    let entryUrl: string | undefined
    let confirmed = 0
    const tick = async () => {
      this.timers.delete(card.id)
      if (this.deps.connected(card.id) || Date.now() > until) return
      try {
        const page = await this.deps.snapshot(tabId)
        // Cards where the person picks the account (Google): only the account itself, shown on the service's own
        // page, counts. The chooser and sign-in pages around it say nothing about which account it will be
        if (card.account?.pick) {
          const who = accountIn(card, page)
          if (who) {
            this.deps.onSignedIn(card, who)
            return
          }
          this.timers.set(
            card.id,
            setTimeout(() => void tick(), this.every),
          )
          return
        }
        const how = signedInHow(card, page, { sawEntry: entryUrl !== undefined && page.url !== entryUrl })
        if (how === 'strong') {
          this.deps.onSignedIn(card)
          return
        }
        // For a guess, confirm only once (twice at most); confirming opens the site anew
        if (how === 'inverse' && this.deps.confirm && confirmed < 2) {
          confirmed++
          if (await this.deps.confirm(card).catch(() => false)) {
            this.deps.onSignedIn(card)
            return
          }
        }
        if (hasLoginEntry(page.text)) entryUrl = page.url
      } catch {
        // The tab closed or the extension disconnected. A closed tab is not watched again; whether login happened is checked once through the site
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
